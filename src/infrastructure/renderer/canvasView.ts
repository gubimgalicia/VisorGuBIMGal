import type { Ray, Vec3 } from '../../domain/measure/geometry';
import type { Camera } from './Camera';

/** The ray through a canvas point in CSS pixels from its top left; null while it has no size. */
export function canvasRay(camera: Camera, canvas: HTMLCanvasElement, x: number, y: number): Ray | null {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (!width || !height) return null;
  return camera.rayAt((2 * x) / width - 1, 1 - (2 * y) / height);
}

/** Where a point shows on the canvas, CSS pixels from its top left; null behind the eye. */
export function canvasPoint(
  camera: Camera,
  canvas: HTMLCanvasElement,
  point: Vec3
): { x: number; y: number } | null {
  const { clientWidth: width, clientHeight: height } = canvas;
  const ndc = width && height ? camera.project(point) : null;
  return ndc && { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
}
