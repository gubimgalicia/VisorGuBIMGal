import type { SectionPlane } from '../../domain/kernel/RendererPort';
import type { ModelBounds, ModelRecord } from '../../domain/models/ModelRecord';

export type SectionAxis = 'x' | 'y' | 'z';
export const SECTION_AXES: readonly SectionAxis[] = ['x', 'y', 'z'];
export type AxisValues = Record<SectionAxis, number>;

export interface FaceSection {
  /** Picked point on the face, absolute model coordinates in metres. */
  origin: [number, number, number];
  /** Unit normal pointing into the cut (look direction when `flip` is false). */
  normal: [number, number, number];
  /** Displacement in metres from `origin` along `normal`. */
  offset: number;
}

/**
 * The section the user set. A value left null follows the models: the plane sits in the middle
 * of the axis, the box spans everything.
 */
export interface SectionState {
  mode: 'off' | 'plane' | 'box' | 'face';
  axis: SectionAxis;
  /** Plane position along the axis, absolute model coordinates in metres. */
  position: number | null;
  /** False keeps what lies below the plane on its axis, true what lies above. */
  flip: boolean;
  boxMin: AxisValues | null;
  boxMax: AxisValues | null;
  face?: FaceSection | null;
}

export const NO_SECTION: SectionState = {
  mode: 'off',
  axis: 'z',
  position: null,
  flip: false,
  boxMin: null,
  boxMax: null,
  face: null
};

/** The box around every model with bounds, or null before any has finished loading. */
export function sceneBounds(models: readonly ModelRecord[]): ModelBounds | null {
  let out: ModelBounds | null = null;
  for (const { bounds } of models) {
    if (!bounds) continue;
    out = out
      ? {
          min: {
            x: Math.min(out.min.x, bounds.min.x),
            y: Math.min(out.min.y, bounds.min.y),
            z: Math.min(out.min.z, bounds.min.z)
          },
          max: {
            x: Math.max(out.max.x, bounds.max.x),
            y: Math.max(out.max.y, bounds.max.y),
            z: Math.max(out.max.z, bounds.max.z)
          }
        }
      : { min: { ...bounds.min }, max: { ...bounds.max } };
  }
  return out;
}

export function planePosition(section: SectionState, bounds: ModelBounds): number {
  const { axis } = section;
  return section.position ?? (bounds.min[axis] + bounds.max[axis]) / 2;
}

export function boxCorners(section: SectionState, bounds: ModelBounds): { min: AxisValues; max: AxisValues } {
  return { min: section.boxMin ?? { ...bounds.min }, max: section.boxMax ?? { ...bounds.max } };
}

const UNIT: Record<SectionAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1]
};
const negated = ([x, y, z]: [number, number, number]): [number, number, number] => [-x, -y, -z];

/**
 * Resolves the shifted origin and effective look normal of a picked-face section, or null when no
 * usable face is set.
 */
export function faceCutPlane(
  section: SectionState
): { origin: [number, number, number]; normal: [number, number, number] } | null {
  const face = section.face;
  if (!face) return null;
  const [nx, ny, nz] = face.normal;
  const [ox, oy, oz] = face.origin;
  if (![nx, ny, nz, ox, oy, oz, face.offset].every(Number.isFinite)) return null;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-12)) return null;
  const ux = nx / len;
  const uy = ny / len;
  const uz = nz / len;
  const origin: [number, number, number] = [
    ox + face.offset * ux,
    oy + face.offset * uy,
    oz + face.offset * uz
  ];
  const normal: [number, number, number] = section.flip ? [-ux, -uy, -uz] : [ux, uy, uz];
  return { origin, normal };
}

/** The renderer's planes for a section; none while it is off or no model has bounds. */
export function sectionPlanes(section: SectionState, bounds: ModelBounds | null): SectionPlane[] {
  if (section.mode === 'off') return [];
  if (section.mode === 'face') {
    const resolved = faceCutPlane(section);
    if (!resolved) return [];
    // Renderer keeps dot(normal, p) <= offset; faceCutPlane.normal points into the kept half-space.
    const clipNormal = negated(resolved.normal);
    const clipOffset =
      clipNormal[0] * resolved.origin[0] +
      clipNormal[1] * resolved.origin[1] +
      clipNormal[2] * resolved.origin[2];
    return [{ normal: clipNormal, offset: clipOffset }];
  }
  if (!bounds) return [];
  if (section.mode === 'plane') {
    const position = planePosition(section, bounds);
    const normal = UNIT[section.axis];
    return [section.flip ? { normal: negated(normal), offset: -position } : { normal, offset: position }];
  }
  const { min, max } = boxCorners(section, bounds);
  return SECTION_AXES.flatMap((axis) => [
    { normal: UNIT[axis], offset: max[axis] },
    { normal: negated(UNIT[axis]), offset: -min[axis] }
  ]);
}
