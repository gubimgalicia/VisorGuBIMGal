import {
  diffModels,
  type ElementChange,
  type ElementSnapshot,
  type ModelDiff
} from '../../domain/compare/modelDiff';
import type { ElementRef, ModelId } from '../../domain/models/ModelRecord';
import {
  hexToRgbaU32,
  type ColorLegendItem,
  type ColorSchemeResult
} from './colorByProperty';

export type CompareCategory = 'added' | 'removed' | 'changed';
export type CompareStatus = CompareCategory | 'unchanged';

export const CHANGE_KIND_ORDER: readonly ElementChange[] = [
  'type',
  'name',
  'properties',
  'geometry'
];

export const COMPARE_CATEGORY_ORDER: readonly CompareCategory[] = [
  'added',
  'removed',
  'changed'
];

export const COMPARE_STATUS_ORDER: readonly CompareStatus[] = [
  'added',
  'removed',
  'changed',
  'unchanged'
];

/** Status-to-colour map: added green, removed red, changed amber, unchanged faded slate. */
export const COMPARE_STATUS_HEX: Readonly<Record<CompareStatus, string>> = {
  added: '#22c55e',
  removed: '#ef4444',
  changed: '#f59e0b',
  unchanged: '#64748b'
};

export const COMPARE_STATUS_RGBA: Readonly<Record<CompareStatus, number>> = {
  added: hexToRgbaU32(COMPARE_STATUS_HEX.added),
  removed: hexToRgbaU32(COMPARE_STATUS_HEX.removed),
  changed: hexToRgbaU32(COMPARE_STATUS_HEX.changed),
  unchanged: hexToRgbaU32(COMPARE_STATUS_HEX.unchanged)
};

export interface CompareCounts {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  duplicates: number;
  byChangeKind: Record<ElementChange, number>;
}

export interface CompareEntry {
  category: CompareCategory;
  globalId: string;
  /** Target element in the model where it lives (after for added/changed, before for removed). */
  ref: ElementRef;
  /** Counterpart in the before model for changed elements. */
  beforeRef?: ElementRef;
  ifcType: string;
  beforeIfcType?: string;
  name?: string;
  beforeName?: string;
  changes: readonly ElementChange[];
  properties: readonly { key: string; before?: string; after?: string }[];
}

export interface CompareGroup {
  category: CompareCategory;
  entries: CompareEntry[];
}

export interface CompareResultView {
  beforeModelId: ModelId;
  afterModelId: ModelId;
  diff: ModelDiff;
  counts: CompareCounts;
  groups: CompareGroup[];
  colorScheme: ColorSchemeResult;
}

const DEFAULT_STATUS_LABELS: Readonly<Record<CompareStatus, string>> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  unchanged: 'Unchanged'
};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Counts elements per comparison category and breaks down changed elements by change kind. */
export function summarizeCompareCounts(diff: ModelDiff): CompareCounts {
  const byChangeKind: Record<ElementChange, number> = {
    type: 0,
    name: 0,
    properties: 0,
    geometry: 0
  };
  for (const pair of diff.changed) {
    for (const kind of pair.changes) {
      byChangeKind[kind]++;
    }
  }
  return {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged,
    duplicates: diff.duplicates.length,
    byChangeKind
  };
}

/** Deterministic sort: IFC class ascending, then display name (case-insensitive), then GlobalId. */
export function sortCompareEntries(entries: readonly CompareEntry[]): CompareEntry[] {
  return [...entries].sort((a, b) => {
    const typeCmp = compareText(a.ifcType, b.ifcType);
    if (typeCmp !== 0) return typeCmp;
    const nameCmp = compareText((a.name ?? '').toLowerCase(), (b.name ?? '').toLowerCase());
    if (nameCmp !== 0) return nameCmp;
    return compareText(a.globalId, b.globalId);
  });
}

/** Groups diff items into added, removed and changed lists with each entry bound to its model. */
export function groupCompareEntries(
  diff: ModelDiff,
  beforeModelId: ModelId,
  afterModelId: ModelId
): CompareGroup[] {
  const addedEntries: CompareEntry[] = diff.added.map((el) => ({
    category: 'added',
    globalId: el.globalId,
    ref: { modelId: afterModelId, expressId: el.expressId, globalId: el.globalId },
    ifcType: el.ifcType,
    name: el.name,
    changes: [],
    properties: []
  }));

  const removedEntries: CompareEntry[] = diff.removed.map((el) => ({
    category: 'removed',
    globalId: el.globalId,
    ref: { modelId: beforeModelId, expressId: el.expressId, globalId: el.globalId },
    ifcType: el.ifcType,
    name: el.name,
    changes: [],
    properties: []
  }));

  const changedEntries: CompareEntry[] = diff.changed.map((pair) => ({
    category: 'changed',
    globalId: pair.after.globalId,
    ref: { modelId: afterModelId, expressId: pair.after.expressId, globalId: pair.after.globalId },
    beforeRef: {
      modelId: beforeModelId,
      expressId: pair.before.expressId,
      globalId: pair.before.globalId
    },
    ifcType: pair.after.ifcType,
    beforeIfcType: pair.before.ifcType,
    name: pair.after.name,
    beforeName: pair.before.name,
    changes: [...pair.changes],
    properties: pair.properties.map((prop) => ({ ...prop }))
  }));

  return [
    { category: 'added', entries: sortCompareEntries(addedEntries) },
    { category: 'removed', entries: sortCompareEntries(removedEntries) },
    { category: 'changed', entries: sortCompareEntries(changedEntries) }
  ];
}

/**
 * Builds the ColorSchemeResult (legend + per-model expressId -> RGBA map) for ColorByBar and
 * `RendererPort.setElementColors`.
 */
export function buildCompareColorScheme(
  diff: ModelDiff,
  beforeModelId: ModelId,
  afterModelId: ModelId,
  beforeSnapshots: readonly ElementSnapshot[],
  afterSnapshots: readonly ElementSnapshot[],
  labels?: Partial<Record<CompareStatus, string>>
): ColorSchemeResult {
  const colorsByModel = new Map<ModelId, Map<number, number>>();
  const ensureModelMap = (modelId: ModelId): Map<number, number> => {
    let map = colorsByModel.get(modelId);
    if (!map) {
      map = new Map<number, number>();
      colorsByModel.set(modelId, map);
    }
    return map;
  };

  const beforeMap = ensureModelMap(beforeModelId);
  const afterMap = ensureModelMap(afterModelId);

  for (const el of beforeSnapshots) {
    beforeMap.set(el.expressId, COMPARE_STATUS_RGBA.unchanged);
  }
  for (const el of afterSnapshots) {
    afterMap.set(el.expressId, COMPARE_STATUS_RGBA.unchanged);
  }
  for (const el of diff.removed) {
    beforeMap.set(el.expressId, COMPARE_STATUS_RGBA.removed);
  }
  for (const el of diff.added) {
    afterMap.set(el.expressId, COMPARE_STATUS_RGBA.added);
  }
  for (const pair of diff.changed) {
    beforeMap.set(pair.before.expressId, COMPARE_STATUS_RGBA.changed);
    afterMap.set(pair.after.expressId, COMPARE_STATUS_RGBA.changed);
  }

  const statusCounts: Record<CompareStatus, number> = {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged
  };

  const legend: ColorLegendItem[] = [];
  for (const status of COMPARE_STATUS_ORDER) {
    const count = statusCounts[status];
    if (count === 0) continue;
    legend.push({
      label: labels?.[status] ?? DEFAULT_STATUS_LABELS[status],
      hex: COMPARE_STATUS_HEX[status],
      rgba: COMPARE_STATUS_RGBA[status],
      count
    });
  }

  return { legend, colorsByModel };
}

/** Runs `diffModels` and builds counts, grouped entries and the view colour scheme. */
export function buildCompareView(
  beforeModelId: ModelId,
  afterModelId: ModelId,
  beforeSnapshots: readonly ElementSnapshot[],
  afterSnapshots: readonly ElementSnapshot[],
  labels?: Partial<Record<CompareStatus, string>>
): CompareResultView {
  const diff = diffModels(beforeSnapshots, afterSnapshots);
  return {
    beforeModelId,
    afterModelId,
    diff,
    counts: summarizeCompareCounts(diff),
    groups: groupCompareEntries(diff, beforeModelId, afterModelId),
    colorScheme: buildCompareColorScheme(
      diff,
      beforeModelId,
      afterModelId,
      beforeSnapshots,
      afterSnapshots,
      labels
    )
  };
}

/** Keeps the before/after model selectors valid as models are opened or removed. */
export function defaultComparePair(
  models: ReadonlyArray<{ id: ModelId; status: string }>,
  currentBefore: ModelId,
  currentAfter: ModelId
): { beforeId: ModelId; afterId: ModelId } {
  const ready = models.filter((m) => m.status === 'ready');
  const hasBefore = ready.some((m) => m.id === currentBefore);
  const beforeId = hasBefore ? currentBefore : (ready[0]?.id ?? '');
  const hasAfter = ready.some((m) => m.id === currentAfter && m.id !== beforeId);
  const afterId = hasAfter ? currentAfter : (ready.find((m) => m.id !== beforeId)?.id ?? '');
  return { beforeId, afterId };
}
