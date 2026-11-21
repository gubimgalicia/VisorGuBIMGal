import { MAX_SECTION_PLANES, type SectionPlane } from '../../domain/kernel/RendererPort';

/** Floats the shaders read: MAX_SECTION_PLANES vec4 of (normal, offset), relative to the eye. */
export const SECTION_FLOATS = MAX_SECTION_PLANES * 4;

/** Copies the planes, dropping those past the limit and any that are not finite. */
export function keptSectionPlanes(planes: readonly SectionPlane[]): SectionPlane[] {
  return planes
    .filter((plane) => [...plane.normal, plane.offset].every(Number.isFinite))
    .slice(0, MAX_SECTION_PLANES)
    .map((plane) => ({ normal: [...plane.normal] as [number, number, number], offset: plane.offset }));
}

/**
 * Writes the planes for this frame's eye at `out[at...]`. Shaders see positions relative to the
 * eye, so each offset moves by dot(normal, eye), in f64 before the f32 store. Unused slots keep
 * everything: a zero normal against offset 1.
 */
export function writeSectionPlanes(
  planes: readonly SectionPlane[],
  eye: readonly [number, number, number],
  out: Float32Array,
  at: number
): void {
  for (let i = 0; i < MAX_SECTION_PLANES; i++) {
    const base = at + i * 4;
    const plane = planes[i];
    if (!plane) {
      out[base] = 0;
      out[base + 1] = 0;
      out[base + 2] = 0;
      out[base + 3] = 1;
      continue;
    }
    const [nx, ny, nz] = plane.normal;
    out[base] = nx;
    out[base + 1] = ny;
    out[base + 2] = nz;
    out[base + 3] = plane.offset - (nx * eye[0] + ny * eye[1] + nz * eye[2]);
  }
}
