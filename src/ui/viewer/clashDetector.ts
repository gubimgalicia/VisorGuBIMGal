import type {
  ClashFilter,
  ClashKind,
  ClashReport,
  ClashRequest,
  ClashResultItem,
  ClashRule,
  ClashSetSpec
} from '../../domain/clash/ClashTypes';
import type { SpatialNode, SpatialTree } from '../../domain/kernel/KernelPort';
import type { ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import type { BcfTopic, BcfViewpoint } from './bcf';
import type { DisplayTarget } from './displayRule';

export type ClashPresetId = 'all-vs-all' | 'pipes-vs-structure' | 'custom';

export const PIPE_CLASH_CLASSES: readonly string[] = [
  'IfcFlowSegment',
  'IfcFlowFitting',
  'IfcFlowController',
  'IfcFlowTerminal',
  'IfcPipeSegment',
  'IfcPipeFitting',
  'IfcDuctSegment',
  'IfcDuctFitting'
];

export const STRUCTURE_CLASH_CLASSES: readonly string[] = [
  'IfcWall',
  'IfcWallStandardCase',
  'IfcSlab',
  'IfcBeam',
  'IfcColumn',
  'IfcRoof',
  'IfcStair',
  'IfcStairFlight',
  'IfcRailing',
  'IfcFooting',
  'IfcPile',
  'IfcMember',
  'IfcPlate'
];

/** Packed RGBA colors (`0xRRGGBBAA`) used when highlighting an isolated clash pair. */
export const CLASH_COLOR_A_RGBA = 0xef4444ff; // red
export const CLASH_COLOR_B_RGBA = 0xf97316ff; // orange

export interface ClashElementMeta {
  modelId: ModelId;
  modelName: string;
  expressId: number;
  type: string;
  name: string;
  storey: string;
}

export interface ClashCatalog {
  elementsByKey: Map<string, ClashElementMeta>;
  classes: string[];
  storeys: string[];
}

export interface ClashDisplayEntry extends ClashResultItem {
  id: string;
  metaA: ClashElementMeta;
  metaB: ClashElementMeta;
}

export interface ClashSummary {
  total: number;
  hard: number;
  soft: number;
}

export const clashElementKey = (modelId: ModelId, expressId: number): string =>
  `${modelId}:${expressId}`;

/** Collects drawable elements (excluding `IfcSpace`), IFC classes and storeys across ready models. */
export function collectClashCatalog(
  models: readonly ModelRecord[],
  spatialTrees: Readonly<Record<ModelId, SpatialTree | undefined>>
): ClashCatalog {
  const elementsByKey = new Map<string, ClashElementMeta>();
  const classSet = new Set<string>();
  const storeySet = new Set<string>();

  for (const model of models) {
    if (model.status !== 'ready') continue;
    const tree = spatialTrees[model.id];
    if (!tree) continue;

    const visit = (node: SpatialNode, currentStorey: string) => {
      const nextStorey =
        node.type === 'IfcBuildingStorey'
          ? (node.name?.trim() || `#${node.expressId}`)
          : currentStorey;
      if (node.type === 'IfcBuildingStorey') {
        storeySet.add(nextStorey);
      }
      for (const el of node.elements) {
        if (el.type === 'IfcSpace') continue;
        const key = clashElementKey(model.id, el.expressId);
        if (!elementsByKey.has(key)) {
          elementsByKey.set(key, {
            modelId: model.id,
            modelName: model.fileName,
            expressId: el.expressId,
            type: el.type,
            name: el.name?.trim() || `${el.type} #${el.expressId}`,
            storey: nextStorey
          });
          classSet.add(el.type);
        }
      }
      for (const child of node.children) {
        visit(child, nextStorey);
      }
    };

    visit(tree.root, '');
    for (const el of tree.unassigned) {
      if (el.type === 'IfcSpace') continue;
      const key = clashElementKey(model.id, el.expressId);
      if (!elementsByKey.has(key)) {
        elementsByKey.set(key, {
          modelId: model.id,
          modelName: model.fileName,
          expressId: el.expressId,
          type: el.type,
          name: el.name?.trim() || `${el.type} #${el.expressId}`,
          storey: ''
        });
        classSet.add(el.type);
      }
    }
  }

  return {
    elementsByKey,
    classes: [...classSet].sort((a, b) => a.localeCompare(b)),
    storeys: [...storeySet].sort((a, b) => a.localeCompare(b))
  };
}

/** Resolves a `ClashFilter` into per-model ascending `expressIds` using the catalog. */
export function resolveClashSetSpecs(
  filter: ClashFilter,
  models: readonly ModelRecord[],
  catalog: ClashCatalog
): ClashSetSpec[] {
  const allowedClasses = filter.ifcClasses.length > 0 ? new Set(filter.ifcClasses) : null;
  const allowedStoreys = filter.storeys.length > 0 ? new Set(filter.storeys) : null;
  const byModel = new Map<ModelId, number[]>();

  for (const model of models) {
    if (model.status !== 'ready') continue;
    if (filter.modelId !== '*' && model.id !== filter.modelId) continue;
    byModel.set(model.id, []);
  }

  for (const meta of catalog.elementsByKey.values()) {
    const list = byModel.get(meta.modelId);
    if (!list) continue;
    if (allowedClasses && !allowedClasses.has(meta.type)) continue;
    if (allowedStoreys && !allowedStoreys.has(meta.storey)) continue;
    list.push(meta.expressId);
  }

  const specs: ClashSetSpec[] = [];
  for (const [modelId, ids] of byModel.entries()) {
    if (ids.length === 0) continue;
    ids.sort((a, b) => a - b);
    specs.push({ modelId, expressIds: ids });
  }
  return specs;
}

/** Builds a `ClashRequest` from a user rule and ready models. */
export function buildClashRequest(
  rule: ClashRule,
  models: readonly ModelRecord[],
  catalog: ClashCatalog,
  maxResults = 5000
): ClashRequest {
  const clearanceMm = Number.isFinite(rule.clearanceMm) && rule.clearanceMm > 0 ? rule.clearanceMm : 0;
  return {
    setA: resolveClashSetSpecs(rule.setA, models, catalog),
    setB: resolveClashSetSpecs(rule.setB, models, catalog),
    clearanceM: clearanceMm / 1000,
    maxResults
  };
}

/** Picks sensible default models for a preset (federated pair when 2+ models are open). */
export function createPresetRule(
  preset: ClashPresetId,
  models: readonly ModelRecord[],
  availableClasses: readonly string[]
): ClashRule {
  const ready = models.filter((m) => m.status === 'ready');
  const firstId: ModelId | '*' = ready[0]?.id ?? '*';
  const secondId: ModelId | '*' = ready[1]?.id ?? firstId;

  if (preset === 'pipes-vs-structure') {
    const classSet = new Set(availableClasses);
    const pipeClasses = PIPE_CLASH_CLASSES.filter((c) => classSet.has(c));
    const structClasses = STRUCTURE_CLASH_CLASSES.filter((c) => classSet.has(c));
    return {
      name: preset,
      setA: { modelId: '*', ifcClasses: pipeClasses, storeys: [] },
      setB: { modelId: '*', ifcClasses: structClasses, storeys: [] },
      clearanceMm: 0
    };
  }

  return {
    name: preset,
    setA: { modelId: firstId, ifcClasses: [], storeys: [] },
    setB: { modelId: secondId, ifcClasses: [], storeys: [] },
    clearanceMm: 0
  };
}

/** Enriches kernel clash items with metadata and sorts hard-first by severity. */
export function buildClashDisplayEntries(
  report: ClashReport,
  catalog: ClashCatalog
): ClashDisplayEntry[] {
  const fallback = (modelId: ModelId, expressId: number): ClashElementMeta => ({
    modelId,
    modelName: modelId,
    expressId,
    type: 'IfcProduct',
    name: `#${expressId}`,
    storey: ''
  });

  const entries: ClashDisplayEntry[] = report.clashes.map((item) => {
    const metaA =
      catalog.elementsByKey.get(clashElementKey(item.elementA.modelId, item.elementA.expressId)) ??
      fallback(item.elementA.modelId, item.elementA.expressId);
    const metaB =
      catalog.elementsByKey.get(clashElementKey(item.elementB.modelId, item.elementB.expressId)) ??
      fallback(item.elementB.modelId, item.elementB.expressId);
    return {
      ...item,
      id: `${item.elementA.modelId}:${item.elementA.expressId}|${item.elementB.modelId}:${item.elementB.expressId}`,
      metaA,
      metaB
    };
  });

  entries.sort((x, y) => {
    if (x.kind !== y.kind) return x.kind === 'hard' ? -1 : 1;
    if (x.kind === 'hard') {
      if (y.penetrationM !== x.penetrationM) return y.penetrationM - x.penetrationM;
    } else if (x.gapM !== y.gapM) {
      return x.gapM - y.gapM;
    }
    return x.id.localeCompare(y.id);
  });
  return entries;
}

export function summarizeClashes(entries: readonly ClashDisplayEntry[]): ClashSummary {
  let hard = 0;
  let soft = 0;
  for (const e of entries) {
    if (e.kind === 'hard') hard++;
    else soft++;
  }
  return { total: entries.length, hard, soft };
}

/** Builds a DisplayTarget isolating exactly the two colliding elements and coloring A red, B orange. */
export function buildClashPairIsolation(
  entry: ClashDisplayEntry,
  label: string
): {
  displayTarget: DisplayTarget;
  colorsByModel: Map<ModelId, Map<number, number>>;
} {
  const matches: Record<ModelId, number[]> = {};
  const addId = (modelId: ModelId, expressId: number) => {
    let list = matches[modelId];
    if (!list) {
      list = [];
      matches[modelId] = list;
    }
    if (!list.includes(expressId)) list.push(expressId);
  };
  addId(entry.elementA.modelId, entry.elementA.expressId);
  addId(entry.elementB.modelId, entry.elementB.expressId);

  const colorsByModel = new Map<ModelId, Map<number, number>>();
  const setColor = (modelId: ModelId, expressId: number, rgba: number) => {
    let map = colorsByModel.get(modelId);
    if (!map) {
      map = new Map<number, number>();
      colorsByModel.set(modelId, map);
    }
    map.set(expressId, rgba);
  };
  setColor(entry.elementA.modelId, entry.elementA.expressId, CLASH_COLOR_A_RGBA);
  setColor(entry.elementB.modelId, entry.elementB.expressId, CLASH_COLOR_B_RGBA);

  return {
    displayTarget: { by: 'search', label, matches },
    colorsByModel
  };
}

export interface ClashBcfTopicLabels {
  title: string;
  description: string;
  author?: string;
}

/** Creates a BCF 3.0 topic of type `'Clash'` with the captured pair viewpoint. */
export function buildClashBcfTopic(
  entry: ClashDisplayEntry,
  viewpoint: BcfViewpoint | null,
  guid: string,
  index: number,
  labels: ClashBcfTopicLabels
): BcfTopic {
  const kind: ClashKind = entry.kind;
  return {
    guid,
    topicType: 'Clash',
    topicStatus: 'Open',
    referenceLinks: [],
    title: labels.title,
    priority: kind === 'hard' ? 'High' : 'Normal',
    index,
    labels: [kind === 'hard' ? 'HardClash' : 'SoftClash'],
    creationDate: new Date().toISOString(),
    creationAuthor: labels.author ?? 'guBIM',
    description: labels.description,
    documentReferences: [],
    relatedTopics: [],
    comments: [],
    viewpoints: viewpoint ? [viewpoint] : [],
    files: []
  };
}
