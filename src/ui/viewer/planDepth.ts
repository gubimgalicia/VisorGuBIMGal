import type { SpatialNode, SpatialTree } from '../../domain/kernel/KernelPort';
import { t } from '../i18n';

/** Depth used when no storey lies under the cut. Metres. */
export const FALLBACK_PLAN_DEPTH = 3;
/** Below the storey's level, so the floor's own top face and edges are still drawn. Metres. */
export const FLOOR_MARGIN = 0.05;

export interface PlanDepth {
  /** Metres below the cut. */
  depth: number;
  /** The storey the cut stands in, or null when the fallback was used. */
  storey: { name: string; level: number } | null;
}

/** Every storey with a level, from every tree given. */
export function storeyLevels(trees: ReadonlyArray<SpatialTree | null | undefined>): Array<{ name: string; level: number }> {
  const out: Array<{ name: string; level: number }> = [];
  const visit = (node: SpatialNode) => {
    if (node.type.toLowerCase() === 'ifcbuildingstorey' && typeof node.level === 'number' && Number.isFinite(node.level)) {
      out.push({ name: node.name || node.longName || `#${node.expressId}`, level: node.level });
    }
    node.children.forEach(visit);
  };
  for (const tree of trees) if (tree) visit(tree.root);
  return out;
}

/** Where a plan's view range ends below the cut. */
export type PlanBottom =
  | { kind: 'storey' } // The floor of the storey the cut stands in (defaultPlanDepth).
  | { kind: 'height'; height: number } // An absolute height, metres, model coordinates.
  | { kind: 'none' }; // Everything below the cut.

export interface PlanRange {
  /** Metres below the cut, or undefined for no limit. */
  depth?: number;
  /** The bottom's absolute height, or null with no limit. */
  bottom: number | null;
  /** The storey the default bottom came from, if it did. */
  storey: { name: string; level: number } | null;
  /** Why the range cannot be drawn, in Spanish for the panel; null when it can. */
  error: string | null;
}

/** A plan's view range from its top (the cut) and its bottom. */
export function planRange(top: number, bottom: PlanBottom, trees: ReadonlyArray<SpatialTree | null | undefined>): PlanRange {
  if (!Number.isFinite(top)) return { bottom: null, storey: null, error: t('sectionDxf.planDepthErrorTopNaN') };
  if (bottom.kind === 'none') return { bottom: null, storey: null, error: null };
  if (bottom.kind === 'height') {
    if (!Number.isFinite(bottom.height)) {
      return { bottom: null, storey: null, error: t('sectionDxf.planDepthErrorBottomNaN') };
    }
    if (bottom.height >= top) {
      return { bottom: bottom.height, storey: null, error: t('sectionDxf.planDepthErrorBottomAboveTop') };
    }
    return { depth: top - bottom.height, bottom: bottom.height, storey: null, error: null };
  }
  const { depth, storey } = defaultPlanDepth(top, trees);
  return { depth, bottom: top - depth, storey, error: null };
}

/**
 * A plan's default projection depth, like a CAD view range: from the cut down to the level of
 * the storey the cut stands in (the highest storey level at or below the cut), plus
 * FLOOR_MARGIN. Without such a storey, FALLBACK_PLAN_DEPTH.
 */
export function defaultPlanDepth(cutElevation: number, trees: ReadonlyArray<SpatialTree | null | undefined>): PlanDepth {
  if (!Number.isFinite(cutElevation)) return { depth: FALLBACK_PLAN_DEPTH, storey: null };
  let best: { name: string; level: number } | null = null;
  for (const storey of storeyLevels(trees)) {
    if (storey.level <= cutElevation && (!best || storey.level > best.level)) best = storey;
  }
  if (!best) return { depth: FALLBACK_PLAN_DEPTH, storey: null };
  return { depth: cutElevation - best.level + FLOOR_MARGIN, storey: best };
}
