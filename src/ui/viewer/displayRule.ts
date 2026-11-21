import type { SpatialNode, SpatialTree } from '../../domain/kernel/KernelPort';
import type { ElementDisplay } from '../../domain/kernel/RendererPort';
import type { ElementRef, ModelId } from '../../domain/models/ModelRecord';

/** What an isolate or hide action applies to. A class spans every model. */
export type DisplayTarget =
  | { by: 'class'; type: string }
  | { by: 'spatial'; modelId: ModelId; expressId: number; name: string }
  | { by: 'element'; ref: ElementRef }
  /** The results of a search when it was applied: a model loaded later is not part of it. */
  | { by: 'search'; label: string; matches: Readonly<Record<ModelId, readonly number[]>> };

export interface DisplayRule {
  /** Only its members are drawn as usual; the rest are hidden, or ghosts with `ghost`. */
  isolate: DisplayTarget | null;
  /** Hidden whatever the isolation says. */
  hidden: DisplayTarget[];
  ghost: boolean;
}

export const SHOW_ALL: DisplayRule = { isolate: null, hidden: [], ghost: false };

export interface ClassCount {
  type: string;
  count: number;
}

/** Every node below and including `root`, without recursion. */
function spatialNodes(root: SpatialNode): SpatialNode[] {
  const out: SpatialNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    out.push(node);
    for (const child of node.children) pending.push(child);
  }
  return out;
}

/** Each spatial node and element of the tree once, by expressId, with its IFC type. */
function typedMembers(tree: SpatialTree): Map<number, string> {
  const types = new Map<number, string>();
  for (const node of spatialNodes(tree.root)) {
    if (node !== tree.root) types.set(node.expressId, node.type);
    for (const element of node.elements) types.set(element.expressId, element.type);
  }
  for (const element of tree.unassigned) types.set(element.expressId, element.type);
  return types;
}

/** A storey, building or other spatial node: its contents and spatial children, not itself. */
function spatialMembers(tree: SpatialTree, nodeId: number): number[] {
  const container = spatialNodes(tree.root).find((node) => node.expressId === nodeId);
  if (!container) return [];
  const members = new Set<number>();
  for (const node of spatialNodes(container)) {
    if (node !== container) members.add(node.expressId);
    for (const element of node.elements) members.add(element.expressId);
  }
  return [...members];
}

/** The target's expressIds in one model. */
export function targetMembers(
  target: DisplayTarget,
  modelId: ModelId,
  tree: SpatialTree | undefined
): number[] {
  if (target.by === 'element') return target.ref.modelId === modelId ? [target.ref.expressId] : [];
  if (target.by === 'search') return [...(target.matches[modelId] ?? [])];
  if (!tree) return [];
  if (target.by === 'spatial') {
    return target.modelId === modelId ? spatialMembers(tree, target.expressId) : [];
  }
  const members: number[] = [];
  for (const [expressId, type] of typedMembers(tree)) {
    if (type === target.type) members.push(expressId);
  }
  return members;
}

/** How the rule draws one model, in the form RendererPort.setElementDisplay takes. */
export function modelDisplay(
  rule: DisplayRule,
  modelId: ModelId,
  tree: SpatialTree | undefined
): { others: ElementDisplay; entries: Map<number, ElementDisplay> } {
  const entries = new Map<number, ElementDisplay>();
  let others: ElementDisplay = 'default';
  if (rule.isolate) {
    others = rule.ghost ? 'ghost' : 'hidden';
    // A storey or other spatial node keeps its spaces hidden as usual; naming a class or an
    // element shows it even so.
    const shown: ElementDisplay = rule.isolate.by === 'spatial' ? 'default' : 'visible';
    for (const expressId of targetMembers(rule.isolate, modelId, tree)) entries.set(expressId, shown);
  }
  for (const target of rule.hidden) {
    for (const expressId of targetMembers(target, modelId, tree)) entries.set(expressId, 'hidden');
  }
  return { others, entries };
}

/** IFC classes present in the trees, with how many members each has, by name. */
export function classCounts(trees: readonly SpatialTree[]): ClassCount[] {
  const counts = new Map<string, number>();
  for (const tree of trees) {
    for (const type of typedMembers(tree).values()) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/** Drops whatever points into a model that is gone. */
export function withoutModel(rule: DisplayRule, modelId: ModelId): DisplayRule {
  const keeps = (target: DisplayTarget) =>
    target.by === 'class' ||
    target.by === 'search' ||
    (target.by === 'spatial' ? target.modelId !== modelId : target.ref.modelId !== modelId);
  // A search keeps its results in the other models.
  const trimmed = (target: DisplayTarget): DisplayTarget => {
    if (target.by !== 'search' || !(modelId in target.matches)) return target;
    const matches = { ...target.matches };
    delete matches[modelId];
    return { ...target, matches };
  };
  // One with no results left would isolate nothing and hide every model, later ones included.
  const live = (target: DisplayTarget) =>
    target.by !== 'search' || Object.values(target.matches).some((ids) => ids.length > 0);
  const isolate = rule.isolate && keeps(rule.isolate) ? trimmed(rule.isolate) : null;
  return {
    ...rule,
    isolate: isolate && live(isolate) ? isolate : null,
    hidden: rule.hidden.filter(keeps).map(trimmed).filter(live)
  };
}

export function sameTarget(a: DisplayTarget, b: DisplayTarget): boolean {
  if (a.by === 'class' && b.by === 'class') return a.type === b.type;
  if (a.by === 'spatial' && b.by === 'spatial') {
    return a.modelId === b.modelId && a.expressId === b.expressId;
  }
  if (a.by === 'element' && b.by === 'element') {
    return a.ref.modelId === b.ref.modelId && a.ref.expressId === b.ref.expressId;
  }
  if (a.by === 'search' && b.by === 'search') {
    const models = Object.keys(a.matches);
    return (
      a.label === b.label &&
      models.length === Object.keys(b.matches).length &&
      models.every((modelId) => {
        const left = a.matches[modelId];
        const right = b.matches[modelId];
        return right !== undefined && left.length === right.length && left.every((id, at) => id === right[at]);
      })
    );
  }
  return false;
}

export function describeTarget(target: DisplayTarget): string {
  if (target.by === 'class') return target.type;
  if (target.by === 'spatial') return target.name;
  if (target.by === 'search') return target.label;
  return `#${target.ref.expressId}`;
}
