// T-159 (C13): the pure comparison behind "compare two versions of a model".
// Elements are matched by GlobalId only: expressIds are reassigned by every export.

export interface ElementSnapshot {
  globalId: string;
  expressId: number;
  ifcType: string;
  name?: string;
  properties: Readonly<Record<string, string>>;   // 'PsetName.PropertyName' -> value as text
  geometryHash?: string;
}

export type ElementChange = 'type' | 'name' | 'properties' | 'geometry';

export interface ModelDiff {
  added: ElementSnapshot[];
  removed: ElementSnapshot[];
  changed: {
    before: ElementSnapshot;
    after: ElementSnapshot;
    changes: ElementChange[];
    properties: { key: string; before?: string; after?: string }[];
  }[];
  unchanged: number;
  duplicates: { side: 'before' | 'after'; globalId: string; expressIds: number[] }[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Group by GlobalId, keeping the input order inside each group and never touching the input. */
function groupByGlobalId(elements: readonly ElementSnapshot[]): Map<string, ElementSnapshot[]> {
  const groups = new Map<string, ElementSnapshot[]>();
  for (const element of elements) {
    const group = groups.get(element.globalId);
    if (group) group.push(element);
    else groups.set(element.globalId, [element]);
  }
  return groups;
}

function comparePair(
  before: ElementSnapshot,
  after: ElementSnapshot
): { changes: ElementChange[]; properties: { key: string; before?: string; after?: string }[] } {
  const changes: ElementChange[] = [];
  if (before.ifcType !== after.ifcType) changes.push('type');
  if (before.name !== after.name) changes.push('name');

  const keys = new Set([...Object.keys(before.properties), ...Object.keys(after.properties)]);
  const properties: { key: string; before?: string; after?: string }[] = [];
  for (const key of [...keys].sort(compareText)) {
    const hasBefore = Object.prototype.hasOwnProperty.call(before.properties, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after.properties, key);
    if (!hasBefore || !hasAfter || before.properties[key] !== after.properties[key]) {
      const difference: { key: string; before?: string; after?: string } = { key };
      if (hasBefore) difference.before = before.properties[key];
      if (hasAfter) difference.after = after.properties[key];
      properties.push(difference);
    }
  }
  if (properties.length > 0) changes.push('properties');

  // A hash on one side only is not evidence of a geometry change; only two different hashes are.
  if (before.geometryHash !== undefined && after.geometryHash !== undefined && before.geometryHash !== after.geometryHash) {
    changes.push('geometry');
  }

  return { changes, properties };
}

export function diffModels(before: readonly ElementSnapshot[], after: readonly ElementSnapshot[]): ModelDiff {
  const beforeById = groupByGlobalId(before);
  const afterById = groupByGlobalId(after);

  const added: ElementSnapshot[] = [];
  const removed: ElementSnapshot[] = [];
  const changed: ModelDiff['changed'] = [];
  const duplicates: ModelDiff['duplicates'] = [];
  let unchanged = 0;

  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];
  for (const id of ids) {
    const beforeGroup = beforeById.get(id) ?? [];
    const afterGroup = afterById.get(id) ?? [];

    if (beforeGroup.length > 1 || afterGroup.length > 1) {
      if (beforeGroup.length > 1) {
        duplicates.push({ side: 'before', globalId: id, expressIds: beforeGroup.map((element) => element.expressId) });
      }
      if (afterGroup.length > 1) {
        duplicates.push({ side: 'after', globalId: id, expressIds: afterGroup.map((element) => element.expressId) });
      }
      continue;
    }

    if (afterGroup.length === 0) {
      removed.push(beforeGroup[0]);
    } else if (beforeGroup.length === 0) {
      added.push(afterGroup[0]);
    } else {
      const pair = comparePair(beforeGroup[0], afterGroup[0]);
      if (pair.changes.length === 0) unchanged++;
      else changed.push({ before: beforeGroup[0], after: afterGroup[0], ...pair });
    }
  }

  const byGlobalId = (a: { globalId: string }, b: { globalId: string }): number => compareText(a.globalId, b.globalId);
  added.sort(byGlobalId);
  removed.sort(byGlobalId);
  changed.sort((a, b) => byGlobalId(a.before, b.before));
  duplicates.sort(byGlobalId);

  return { added, removed, changed, unchanged, duplicates };
}
