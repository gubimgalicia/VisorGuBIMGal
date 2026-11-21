import type { ElementRef, ModelBounds, ModelId } from '../models/ModelRecord';
import type { KernelDiagnostic, Vec3d } from '../kernel/KernelPort';

/** Elements from one open model participating in one side of a clash check. */
export interface ClashSetSpec {
  modelId: ModelId;
  /** ExpressIds to include (already filtered by IFC class / storey). */
  expressIds: readonly number[];
}

/** Kernel request for hard/soft clash detection across one or more models (`docs/11_clash.md`). */
export interface ClashRequest {
  setA: readonly ClashSetSpec[];
  setB: readonly ClashSetSpec[];
  /** Metres: 0 = hard clashes only; > 0 = hard + soft clashes within this clearance. */
  clearanceM: number;
  /** Optional upper cap on reported clashes (default 5000). */
  maxResults?: number;
}

export type ClashKind = 'hard' | 'soft';

/** One confirmed hard or soft clash pair in absolute model coordinates (metres, IFC Z-up). */
export interface ClashResultItem {
  elementA: ElementRef;
  elementB: ElementRef;
  kind: ClashKind;
  /** Penetration depth in metres (> 0) for hard clashes; 0 for soft clashes. */
  penetrationM: number;
  /** Minimum surface-to-surface gap in metres for soft clashes; 0 for hard clashes. */
  gapM: number;
  /** Exact CSG intersection volume in m³ when computed for closed hard clashes. */
  volumeM3?: number;
  /** Representative 3D point of the clash in absolute model coordinates. */
  point: Vec3d;
  /** Combined world AABB of the colliding pair, for framing/zoom. */
  bounds: ModelBounds;
}

export interface ClashReport {
  clashes: ClashResultItem[];
  broadPhasePairs: number;
  testedPairs: number;
  truncated: boolean;
  elapsedMs: number;
  diagnostics: KernelDiagnostic[];
}

/** Rule filter for one side of a clash test in the UI. */
export interface ClashFilter {
  /** Concrete ModelId or '*' for all ready models. */
  modelId: ModelId | '*';
  /** Allowed IFC classes; empty means all drawable classes except IfcSpace. */
  ifcClasses: string[];
  /** Allowed storey names; empty means all storeys. */
  storeys: string[];
}

/** User-configured clash detection rule. */
export interface ClashRule {
  name: string;
  setA: ClashFilter;
  setB: ClashFilter;
  /** Clearance in millimetres (0 = hard clashes only). */
  clearanceMm: number;
}
