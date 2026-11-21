import type { SpatialTree } from '../../domain/kernel/KernelPort';
import type { CameraPose } from '../../domain/kernel/RendererPort';
import type { ModelBounds } from '../../domain/models/ModelRecord';
import { eyeOf } from './minimap';
import { storeyLevels } from './planDepth';

/**
 * C24, walking a storey: the storeys a user can pick, and where the eye stands on the one picked.
 * The camera then holds the eye at that height (Camera.walkAt) and the minimap shows that storey.
 */

/** Height of the eye above the storey's level, metres: a standing person. */
export const EYE_HEIGHT = 1.6;

export interface WalkStorey {
  name: string;
  level: number;
}

/**
 * The storeys of the open models, lowest first. Federated models often repeat a storey: one
 * entry per name and level.
 */
export function walkStoreys(trees: ReadonlyArray<SpatialTree | null | undefined>): WalkStorey[] {
  const seen = new Set<string>();
  const out: WalkStorey[] = [];
  for (const storey of storeyLevels(trees)) {
    const key = `${storey.name}\u0000${storey.level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(storey);
  }
  return out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

/**
 * Where the eye stands on `level`: above where the camera's eye is now, if that is over the
 * models, or else above their centre; `EYE_HEIGHT` over the level.
 */
export function walkStart(
  pose: CameraPose | null,
  bounds: ModelBounds | null,
  level: number
): { x: number; y: number; z: number } {
  const z = level + EYE_HEIGHT;
  const eye = pose ? eyeOf(pose) : null;
  if (!bounds) return { x: eye?.[0] ?? 0, y: eye?.[1] ?? 0, z };
  const over =
    eye !== null &&
    eye[0] >= bounds.min.x &&
    eye[0] <= bounds.max.x &&
    eye[1] >= bounds.min.y &&
    eye[1] <= bounds.max.y;
  if (over) return { x: eye[0], y: eye[1], z };
  return { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z };
}
