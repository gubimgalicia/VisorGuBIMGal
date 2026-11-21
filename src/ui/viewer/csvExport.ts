import type { ElementDetails, ElementMesh, SpatialNode, SpatialTree } from '../../domain/kernel/KernelPort';
import type { ModelId } from '../../domain/models/ModelRecord';
import { formatFixed, getIntlLocale, t } from '../i18n';

export type CsvGroupBy = 'class' | 'storey';

export interface SpatialElementEntry {
  modelId: ModelId;
  modelName: string;
  expressId: number;
  ifcClass: string;
  name: string;
  storey: string;
}

export interface ElementQuantities {
  length: number;
  area: number;
  volume: number;
}

export interface ElementQuantityRow extends SpatialElementEntry, ElementQuantities {}

export interface MedicionGroupRow {
  group: string;
  count: number;
  length: number;
  area: number;
  volume: number;
}

const LENGTH_KEYS: readonly string[] = [
  'netlength',
  'length',
  'grosslength',
  'height',
  'depth',
  'width',
  'perimeter'
];

const AREA_KEYS: readonly string[] = [
  'netarea',
  'netsidearea',
  'netfootprintarea',
  'area',
  'grossarea',
  'grosssidearea',
  'grossfootprintarea'
];

const VOLUME_KEYS: readonly string[] = ['netvolume', 'volume', 'grossvolume'];

/**
 * Walks the spatial tree of a model and returns every primary (`via === 'contains'`) element
 * tagged with its enclosing `IfcBuildingStorey` name (or `'Sin planta'` when outside any storey).
 */
export function extractSpatialElements(
  modelId: ModelId,
  modelName: string,
  tree: SpatialTree | undefined
): SpatialElementEntry[] {
  if (!tree) return [];
  const entries: SpatialElementEntry[] = [];

  const visit = (node: SpatialNode, currentStorey: string | null) => {
    const nextStorey =
      node.type === 'IfcBuildingStorey'
        ? node.name?.trim() || t('tree.storeyFallback', { id: node.expressId })
        : currentStorey;

    for (const elem of node.elements) {
      if (elem.via !== 'contains') continue;
      entries.push({
        modelId,
        modelName,
        expressId: elem.expressId,
        ifcClass: elem.type,
        name: elem.name ?? '',
        storey: nextStorey ?? t('csv.noStorey')
      });
    }

    for (const child of node.children) {
      visit(child, nextStorey);
    }
  };

  visit(tree.root, null);

  for (const elem of tree.unassigned) {
    if (elem.via !== 'contains') continue;
    entries.push({
      modelId,
      modelName,
      expressId: elem.expressId,
      ifcClass: elem.type,
      name: elem.name ?? '',
      storey: t('csv.noStorey')
    });
  }

  return entries;
}

/**
 * Computes exact surface area (m²) and signed volume (m³) from an element's evaluated f64 mesh.
 */
export function computeMeshQuantities(
  mesh: ElementMesh | null | undefined
): { area: number; volume: number } {
  if (!mesh || mesh.positions.length < 9 || mesh.indices.length < 3) {
    return { area: 0, volume: 0 };
  }
  const pos = mesh.positions;
  const idx = mesh.indices;
  const refX = pos[0];
  const refY = pos[1];
  const refZ = pos[2];

  let area = 0;
  let sixVolume = 0;

  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;

    const ax = pos[a];
    const ay = pos[a + 1];
    const az = pos[a + 2];
    const bx = pos[b];
    const by = pos[b + 1];
    const bz = pos[b + 2];
    const cx = pos[c];
    const cy = pos[c + 1];
    const cz = pos[c + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    area += 0.5 * Math.hypot(crossX, crossY, crossZ);

    const rax = ax - refX;
    const ray = ay - refY;
    const raz = az - refZ;
    const rbx = bx - refX;
    const rby = by - refY;
    const rbz = bz - refZ;
    const rcx = cx - refX;
    const rcy = cy - refY;
    const rcz = cz - refZ;

    sixVolume +=
      rax * (rby * rcz - rbz * rcy) +
      ray * (rbz * rcx - rbx * rcz) +
      raz * (rbx * rcy - rby * rcx);
  }

  return {
    area,
    volume: Math.abs(sixVolume) / 6.0
  };
}

function pickByPriority(
  candidates: ReadonlyMap<string, number>,
  priorityKeys: readonly string[]
): number | undefined {
  for (const key of priorityKeys) {
    const value = candidates.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Extracts explicit IFC quantities (`kind === 'quantity'`) from an element's property sets,
 * preferring Net over Gross quantities.
 */
export function extractExplicitQuantities(
  details: Pick<ElementDetails, 'propertySets'> | null | undefined
): Partial<ElementQuantities> {
  if (!details?.propertySets) return {};
  const byName = new Map<string, number>();

  for (const pset of details.propertySets) {
    for (const prop of pset.properties) {
      if (prop.kind !== 'quantity') continue;
      if (typeof prop.value !== 'number' || !Number.isFinite(prop.value) || prop.value < 0) continue;
      const key = prop.name.trim().toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, prop.value);
      }
    }
  }

  const result: Partial<ElementQuantities> = {};
  const length = pickByPriority(byName, LENGTH_KEYS);
  const area = pickByPriority(byName, AREA_KEYS);
  const volume = pickByPriority(byName, VOLUME_KEYS);
  if (length !== undefined) result.length = length;
  if (area !== undefined) result.area = area;
  if (volume !== undefined) result.volume = volume;
  return result;
}

/**
 * Resolves an element's length, area, and volume, preferring explicit IFC quantities when
 * declared and falling back to the evaluated 3D mesh surface area and volume.
 */
export function resolveElementQuantities(
  details: Pick<ElementDetails, 'propertySets'> | null | undefined,
  mesh: ElementMesh | null | undefined
): ElementQuantities {
  const explicit = extractExplicitQuantities(details);
  const fromMesh =
    explicit.area === undefined || explicit.volume === undefined
      ? computeMeshQuantities(mesh)
      : { area: 0, volume: 0 };

  return {
    length: explicit.length ?? 0,
    area: explicit.area ?? fromMesh.area,
    volume: explicit.volume ?? fromMesh.volume
  };
}

/**
 * Aggregates element quantity rows by IFC class (`'class'`) or building storey (`'storey'`).
 */
export function aggregateMediciones(
  rows: readonly ElementQuantityRow[],
  groupBy: CsvGroupBy
): MedicionGroupRow[] {
  const map = new Map<string, MedicionGroupRow>();

  for (const row of rows) {
    const key = (groupBy === 'class' ? row.ifcClass : row.storey).trim() || t('csv.unclassified');
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.length += row.length;
      existing.area += row.area;
      existing.volume += row.volume;
    } else {
      map.set(key, {
        group: key,
        count: 1,
        length: row.length,
        area: row.area,
        volume: row.volume
      });
    }
  }

  const intlLocale = getIntlLocale();
  return Array.from(map.values()).sort((a, b) => a.group.localeCompare(b.group, intlLocale));
}

export function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Formats aggregated element quantities as a UTF-8 CSV document (with BOM) grouped by class or storey.
 */
export function buildMedicionesCsv(
  rows: readonly ElementQuantityRow[],
  groupBy: CsvGroupBy
): string {
  const groups = aggregateMediciones(rows, groupBy);
  const firstCol = groupBy === 'class' ? t('csv.colClass') : t('csv.colStorey');
  const lines: string[] = [
    [
      firstCol,
      t('csv.colElements'),
      t('csv.colLength'),
      t('csv.colArea'),
      t('csv.colVolume')
    ]
      .map(escapeCsvCell)
      .join(',')
  ];

  let totalCount = 0;
  let totalLength = 0;
  let totalArea = 0;
  let totalVolume = 0;

  for (const g of groups) {
    totalCount += g.count;
    totalLength += g.length;
    totalArea += g.area;
    totalVolume += g.volume;
    lines.push(
      [
        escapeCsvCell(g.group),
        String(g.count),
        formatFixed(g.length, 3),
        formatFixed(g.area, 3),
        formatFixed(g.volume, 3)
      ].join(',')
    );
  }

  lines.push(
    [
      t('csv.totalRow'),
      String(totalCount),
      formatFixed(totalLength, 3),
      formatFixed(totalArea, 3),
      formatFixed(totalVolume, 3)
    ].join(',')
  );

  return `\uFEFF${lines.join('\r\n')}`;
}
