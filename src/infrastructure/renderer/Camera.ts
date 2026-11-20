import type { ModelBounds } from '../../domain/models/ModelRecord';
import type { CameraPose, CameraProjection, SectionPlane, ViewPreset } from '../../domain/kernel/RendererPort';
import type { Ray, Vec3 } from '../../domain/measure/geometry';
import { WHOLE_VIEW, type Frustum, type ViewWindow } from './frustum';

const ISO_AZIMUTH = -Math.PI / 4; // +X, -Y (front-right in IFC Z-up)
const ISO_ELEVATION = Math.atan(1 / Math.SQRT2); // ~35.264 deg above horizontal

/**
 * Computes the CSS `transform` string (`rotateX(...) rotateY(...)`) that aligns the 3D ViewCube
 * with the IFC Z-up camera's `azimuth` and `elevation`.
 */
export function computeViewCubeTransform(pose: CameraPose | null): string {
  const azimuth = pose?.azimuth ?? ISO_AZIMUTH;
  const elevation = pose?.elevation ?? ISO_ELEVATION;
  const rotXDeg = -(elevation * 180) / Math.PI || 0;
  const rotYDeg = -((azimuth + Math.PI / 2) * 180) / Math.PI || 0;
  return `rotateX(${rotXDeg.toFixed(2)}deg) rotateY(${rotYDeg.toFixed(2)}deg)`;
}

/**
 * Slab intersection distance along `ray` (`origin + t * direction`, `t >= 0`) to an axis-aligned
 * bounding box `[min, max]`. Returns the entry distance `t >= 0` (or exit distance if the ray
 * origin starts inside the box), or `null` when the ray misses the box.
 */
export function rayBoxIntersectionDistance(ray: Ray, min: Vec3, max: Vec3): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const o = ray.origin[axis];
    const d = ray.direction[axis];
    const bMin = min[axis];
    const bMax = max[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < bMin || o > bMax) return null;
    } else {
      const invD = 1 / d;
      let t1 = (bMin - o) * invD;
      let t2 = (bMax - o) * invD;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return null;
    }
  }
  if (tMax < 0) return null;
  return tMin >= 0 ? tMin : tMax;
}

export interface OrbitCullableModel {
  visible: boolean;
  batches: ReadonlyArray<{ min: Vec3; max: Vec3 }>;
}

export interface SurfacePickSample {
  /**
   * Whether a visible surface fragment covered the pixel (`true`), the pixel was background (`false`),
   * or the GPU pick readback could not be obtained (`null`).
   */
  hit: boolean | null;
  /** Reverse-Z depth in `(0, 1]` read from the pick pass when `hit` is `true`. */
  depth?: number;
}

/**
 * Returns `true` when `point` lies on the clipped side (`dot(normal, point) > offset + tolerance`)
 * of any plane in `sectionPlanes`.
 */
export function isPointSectioned(
  point: Vec3,
  sectionPlanes: readonly SectionPlane[],
  tolerance = 0
): boolean {
  for (const plane of sectionPlanes) {
    if (
      plane.normal[0] * point[0] + plane.normal[1] * point[1] + plane.normal[2] * point[2] >
      plane.offset + tolerance
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Finds the nearest 3D surface entry point along `ray` across all visible batch bounding boxes
 * that is not clipped away by `sectionPlanes`. Returns `null` over background.
 */
export function pickBatchOrbitPivot(
  ray: Ray | null,
  models: Iterable<OrbitCullableModel>,
  sectionPlanes: readonly SectionPlane[] = []
): Vec3 | null {
  if (!ray) return null;
  let bestT = Infinity;
  let bestPoint: Vec3 | null = null;
  for (const model of models) {
    if (!model.visible) continue;
    for (const batch of model.batches) {
      const t = rayBoxIntersectionDistance(ray, batch.min, batch.max);
      if (t === null || t >= bestT) continue;
      const candidate: Vec3 = [
        ray.origin[0] + t * ray.direction[0],
        ray.origin[1] + t * ray.direction[1],
        ray.origin[2] + t * ray.direction[2]
      ];
      if (!isPointSectioned(candidate, sectionPlanes, 0)) {
        bestT = t;
        bestPoint = candidate;
      }
    }
  }
  return bestPoint;
}

/**
 * Resolves the 3D world orbit pivot at `(ndcX, ndcY)` from one or more pick-pass depth samples:
 * 1. First visible surface sample whose unprojected point is not clipped by `sectionPlanes`.
 * 2. Over confirmed background (`hit: false` with no unclipped surface), returns `null` (no pivot change).
 * 3. When the surface point cannot be had (`sample` null/unavailable, or `hit: true` with unusable depth),
 *    falls back to `pickBatchOrbitPivot` across visible batch bounding boxes.
 */
export function resolveOrbitPivot(
  camera: Camera,
  ndcX: number,
  ndcY: number,
  sample: SurfacePickSample | readonly SurfacePickSample[] | null | undefined,
  models: Iterable<OrbitCullableModel>,
  sectionPlanes: readonly SectionPlane[] = []
): Vec3 | null {
  const samples: readonly SurfacePickSample[] = Array.isArray(sample)
    ? sample
    : sample
      ? [sample]
      : [];

  let sawBackground = false;
  let sawCorruptedHit = false;

  for (const s of samples) {
    if (!s || s.hit === null) continue;
    if (s.hit === false) {
      sawBackground = true;
      continue;
    }
    if (typeof s.depth === 'number') {
      const point = camera.unproject(ndcX, ndcY, s.depth);
      if (point) {
        if (!isPointSectioned(point, sectionPlanes, 1e-3)) {
          return point;
        }
        sawBackground = true;
        continue;
      }
    }
    sawCorruptedHit = true;
  }

  if (sawBackground && !sawCorruptedHit) {
    return null;
  }

  const ray = camera.rayAt(ndcX, ndcY);
  return pickBatchOrbitPivot(ray, models, sectionPlanes);
}

/**
 * Computes the axis-aligned `ModelBounds` of an element's `f64` vertex positions (`x, y, z` triples).
 */
export function computeElementMeshBounds(positions: Float64Array): ModelBounds | null {
  if (!positions || positions.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return null;
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ }
  };
}

/** C24: distance to the target while walking a storey: first-person steps scale with it. */
export const WALK_DISTANCE = 5;

/**
 * Orbit and first-person camera operating in IFC Z-up f64 world coordinates.
 * Produces a rotation-only view matrix at the camera eye (for RTC rendering)
 * and a Reverse-Z perspective or orthographic projection matrix (depth 1 at near, 0 at far).
 */
export class Camera {
  /** Target point in IFC Z-up f64 metres. */
  private target: [number, number, number] = [0, 0, 0];
  /** Distance from target to eye in f64 metres. */
  private distance = 12;
  /** Horizontal angle in the X-Y plane from +X towards +Y (radians). */
  private azimuth = ISO_AZIMUTH;
  /** Vertical angle from the X-Y plane towards +Z (radians, in [-pi/2, +pi/2]). */
  private elevation = ISO_ELEVATION;
  /** C24: the height the eye is held at while walking a storey, or null. */
  private eyeLock: number | null = null;
  /** Viewport aspect ratio (width / height). */
  private aspect = 16 / 9;
  /** Vertical field of view in radians (45 deg). */
  private readonly fovY = Math.PI / 4;
  /** Perspective or orthographic projection. */
  private projection: CameraProjection = 'perspective';

  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) {
      this.aspect = aspect;
    }
  }

  getProjection(): CameraProjection {
    return this.projection;
  }

  /**
   * C17: how much depth a pixel's step changes per unit of tangent slope, for the edge pass
   * (edges.ts). Perspective: relative to the depth, the angle one pixel row spans. Orthographic:
   * the metres one pixel row spans, over the depth range.
   */
  edgeDepthScale(heightPx: number): { scale: number; relative: boolean } {
    const rows = Math.max(1, heightPx);
    if (this.projection === 'orthographic') {
      return { scale: (2 * this.orthoHalfExtents().halfH) / rows / (this.far() - this.near()), relative: false };
    }
    return { scale: (2 * Math.tan(this.fovY * 0.5)) / rows, relative: true };
  }

  setProjection(projection: CameraProjection): void {
    if (projection === 'perspective' || projection === 'orthographic') {
      this.projection = projection;
    }
  }

  /** Returns camera eye position in IFC Z-up f64 coordinates. */
  getEye(): [number, number, number] {
    const cosPhi = Math.cos(this.elevation);
    const sinPhi = Math.sin(this.elevation);
    const cosTheta = Math.cos(this.azimuth);
    const sinTheta = Math.sin(this.azimuth);

    return [
      this.target[0] + this.distance * cosPhi * cosTheta,
      this.target[1] + this.distance * cosPhi * sinTheta,
      this.target[2] + this.distance * sinPhi
    ];
  }

  /** C24: the height the eye is held at, or null when it moves freely. */
  getEyeLock(): number | null {
    return this.eyeLock;
  }

  /**
   * C24: stands the eye at `(x, y, z)`, looking level along the current heading, and holds it at
   * height `z` from then on: walking moves it across the floor only, and looking, panning and
   * zooming never raise or lower it. Fitting, a view preset or a pose release it.
   */
  walkAt(x: number, y: number, z: number): void {
    if (![x, y, z].every(Number.isFinite)) return;
    this.elevation = 0;
    this.distance = WALK_DISTANCE;
    const { forward } = this.axes();
    this.target = [x + this.distance * forward[0], y + this.distance * forward[1], z];
    this.eyeLock = z;
  }

  /** C24: lets the eye move freely again, where it is. */
  releaseEyeLock(): void {
    this.eyeLock = null;
  }

  /** Keeps the eye at the locked height by moving the target, which the eye is measured from. */
  private holdEye(): void {
    if (this.eyeLock === null) return;
    this.target[2] = this.eyeLock - this.distance * Math.sin(this.elevation);
  }

  getTarget(): [number, number, number] {
    return [this.target[0], this.target[1], this.target[2]];
  }

  getDistance(): number {
    return this.distance;
  }

  getPose(): CameraPose {
    return {
      target: [this.target[0], this.target[1], this.target[2]],
      distance: this.distance,
      azimuth: this.azimuth,
      elevation: this.elevation,
      projection: this.projection
    };
  }

  setPose(pose: CameraPose): void {
    if (
      !pose ||
      !Array.isArray(pose.target) ||
      pose.target.length !== 3 ||
      !pose.target.every(Number.isFinite) ||
      !Number.isFinite(pose.distance) ||
      pose.distance <= 0 ||
      !Number.isFinite(pose.azimuth) ||
      !Number.isFinite(pose.elevation)
    ) {
      return;
    }
    this.eyeLock = null;
    this.target = [pose.target[0], pose.target[1], pose.target[2]];
    this.distance = Math.max(0.05, Math.min(500000, pose.distance));
    this.azimuth = pose.azimuth;
    const maxElev = Math.PI / 2;
    this.elevation = Math.max(-maxElev, Math.min(maxElev, pose.elevation));
    if (pose.projection === 'perspective' || pose.projection === 'orthographic') {
      this.projection = pose.projection;
    }
  }

  orbit(dx: number, dy: number): void {
    this.azimuth -= dx * 0.007;
    const nextElev = this.elevation + dy * 0.007;
    const maxElev = Math.PI / 2;
    this.elevation = Math.max(-maxElev, Math.min(maxElev, nextElev));
    this.holdEye();
  }

  /**
   * Orbits the camera around an arbitrary 3D world `pivot` point while keeping the camera-space
   * offset of `(eye - pivot)` invariant, so `pivot` stays pinned in the view without any jump.
   */
  orbitAround(pivot: Vec3, dx: number, dy: number): void {
    if (!pivot.every(Number.isFinite)) {
      this.orbit(dx, dy);
      return;
    }
    const eye0 = this.getEye();
    const { forward: f0, right: r0, up: u0 } = this.axes();
    const vx = eye0[0] - pivot[0];
    const vy = eye0[1] - pivot[1];
    const vz = eye0[2] - pivot[2];
    const cf = vx * f0[0] + vy * f0[1] + vz * f0[2];
    const cr = vx * r0[0] + vy * r0[1] + vz * r0[2];
    const cu = vx * u0[0] + vy * u0[1] + vz * u0[2];

    this.orbit(dx, dy);

    const { forward: f1, right: r1, up: u1 } = this.axes();
    const eye1x = pivot[0] + cf * f1[0] + cr * r1[0] + cu * u1[0];
    const eye1y = pivot[1] + cf * f1[1] + cr * r1[1] + cu * u1[1];
    const eye1z = pivot[2] + cf * f1[2] + cr * r1[2] + cu * u1[2];

    this.target = [
      eye1x + this.distance * f1[0],
      eye1y + this.distance * f1[1],
      eye1z + this.distance * f1[2]
    ];
  }

  /**
   * First-person look-around: rotates `azimuth` and `elevation` while keeping the camera `eye`
   * fixed in world space.
   */
  look(dx: number, dy: number): void {
    const eye = this.getEye();
    this.azimuth -= dx * 0.005;
    const nextElev = this.elevation - dy * 0.005;
    const maxElev = Math.PI / 2 - 0.01;
    this.elevation = Math.max(-maxElev, Math.min(maxElev, nextElev));
    const { forward } = this.axes();
    this.target = [
      eye[0] + this.distance * forward[0],
      eye[1] + this.distance * forward[1],
      eye[2] + this.distance * forward[2]
    ];
    this.holdEye();
  }

  /**
   * First-person walk/fly translation in metres along the camera's forward, right, and world-Z up axes.
   */
  walk(forwardMeters: number, rightMeters: number, upMeters = 0): void {
    if (this.eyeLock !== null) {
      // Walking a storey: forward is the heading across the floor, whatever the pitch, and no climbing.
      const heading: Vec3 = [-Math.cos(this.azimuth), -Math.sin(this.azimuth), 0];
      const { right } = this.axes();
      const dx = heading[0] * forwardMeters + right[0] * rightMeters;
      const dy = heading[1] * forwardMeters + right[1] * rightMeters;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      this.target[0] += dx;
      this.target[1] += dy;
      this.holdEye();
      return;
    }
    const { forward, right } = this.axes();
    const dx = forward[0] * forwardMeters + right[0] * rightMeters;
    const dy = forward[1] * forwardMeters + right[1] * rightMeters;
    const dz = forward[2] * forwardMeters + right[2] * rightMeters + upMeters;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return;
    this.target[0] += dx;
    this.target[1] += dy;
    this.target[2] += dz;
  }

  pan(dx: number, dy: number): void {
    const cosPhi = Math.cos(this.elevation);
    const sinPhi = Math.sin(this.elevation);
    const cosTheta = Math.cos(this.azimuth);
    const sinTheta = Math.sin(this.azimuth);

    // Orthonormal right (r) and up (u) vectors in IFC Z-up
    const rx = -sinTheta;
    const ry = cosTheta;
    const rz = 0;

    const ux = -sinPhi * cosTheta;
    const uy = -sinPhi * sinTheta;
    const uz = cosPhi;

    const panScale = this.distance * 0.0014;
    const moveRight = -dx * panScale;
    const moveUp = dy * panScale;

    this.target[0] += rx * moveRight + ux * moveUp;
    this.target[1] += ry * moveRight + uy * moveUp;
    this.target[2] += rz * moveRight + uz * moveUp;
    this.holdEye();
  }

  zoom(deltaY: number): void {
    this.zoomBy(deltaY > 0 ? 1.12 : 1 / 1.12);
  }

  /** Multiplies the distance to the target: below 1 moves closer. */
  zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.distance = Math.max(0.05, Math.min(500000, this.distance * factor));
    this.holdEye();
  }

  fitToBounds(bounds: ModelBounds, keepAngles = false): void {
    this.eyeLock = null;
    const cx = (bounds.min.x + bounds.max.x) * 0.5;
    const cy = (bounds.min.y + bounds.max.y) * 0.5;
    const cz = (bounds.min.z + bounds.max.z) * 0.5;

    const dx = Math.max(0.1, bounds.max.x - bounds.min.x);
    const dy = Math.max(0.1, bounds.max.y - bounds.min.y);
    const dz = Math.max(0.1, bounds.max.z - bounds.min.z);
    const radius = 0.5 * Math.hypot(dx, dy, dz);

    this.target = [cx, cy, cz];
    const halfFov = this.fovY * 0.5;
    const fitScale = this.aspect < 1 ? 1 / Math.max(0.25, this.aspect) : 1;
    this.distance = Math.max(1.0, (radius / Math.tan(halfFov)) * 1.25 * fitScale);
    if (!keepAngles) {
      this.azimuth = ISO_AZIMUTH;
      this.elevation = ISO_ELEVATION;
    }
  }

  setPreset(preset: ViewPreset, bounds: ModelBounds | null): void {
    this.eyeLock = null;
    if (bounds) {
      this.target = [
        (bounds.min.x + bounds.max.x) * 0.5,
        (bounds.min.y + bounds.max.y) * 0.5,
        (bounds.min.z + bounds.max.z) * 0.5
      ];
      const dx = Math.max(0.1, bounds.max.x - bounds.min.x);
      const dy = Math.max(0.1, bounds.max.y - bounds.min.y);
      const dz = Math.max(0.1, bounds.max.z - bounds.min.z);
      const maxDim = Math.max(dx, dy, dz);
      this.distance = Math.max(1.5, maxDim * 2.1);
    }

    switch (preset) {
      case 'iso':
        this.azimuth = ISO_AZIMUTH;
        this.elevation = ISO_ELEVATION;
        break;
      case 'top':
        // Looking straight down (-Z_ifc) with +Y_ifc (North) up and +X_ifc (East) right
        this.azimuth = -Math.PI / 2;
        this.elevation = Math.PI / 2;
        break;
      case 'bottom':
        // Looking straight up (+Z_ifc)
        this.azimuth = -Math.PI / 2;
        this.elevation = -Math.PI / 2;
        break;
      case 'front':
        // Looking from -Y_ifc (South) towards +Y_ifc (North) with +Z_ifc up and +X_ifc right
        this.azimuth = -Math.PI / 2;
        this.elevation = 0;
        break;
      case 'back':
        // Looking from +Y_ifc (North) towards -Y_ifc (South) with +Z_ifc up and -X_ifc right
        this.azimuth = Math.PI / 2;
        this.elevation = 0;
        break;
      case 'side':
      case 'right':
        // Looking from +X_ifc (East) towards -X_ifc (West) with +Z_ifc up and +Y_ifc right
        this.azimuth = 0;
        this.elevation = 0;
        break;
      case 'left':
        // Looking from -X_ifc (West) towards +X_ifc (East) with +Z_ifc up and -Y_ifc right
        this.azimuth = Math.PI;
        this.elevation = 0;
        break;
    }
  }

  private near(): number {
    return Math.max(0.01, Math.min(2.0, this.distance * 0.002));
  }

  private far(): number {
    return Math.max(50000.0, this.distance * 250.0);
  }

  /** Half-width and half-height in metres of the orthographic view volume at `distance`. */
  private orthoHalfExtents(): { halfW: number; halfH: number } {
    const halfH = Math.max(0.05, this.distance * Math.tan(this.fovY * 0.5));
    const halfW = halfH * this.aspect;
    return { halfW, halfH };
  }

  /** Forward, right and up unit vectors in IFC Z-up; see writeUniforms. */
  private axes(): { forward: Vec3; right: Vec3; up: Vec3 } {
    const cosPhi = Math.cos(this.elevation);
    const sinPhi = Math.sin(this.elevation);
    const cosTheta = Math.cos(this.azimuth);
    const sinTheta = Math.sin(this.azimuth);
    return {
      forward: [-cosPhi * cosTheta, -cosPhi * sinTheta, -sinPhi],
      right: [-sinTheta, cosTheta, 0],
      up: [-sinPhi * cosTheta, -sinPhi * sinTheta, cosPhi]
    };
  }

  /**
   * Where a point shows, in normalised device coordinates (x right, y up, -1 to 1 across the
   * view), in f64. Null in front of the near plane or behind the eye.
   */
  project(point: Vec3): { x: number; y: number } | null {
    const eye = this.getEye();
    const { forward, right, up } = this.axes();
    const d: Vec3 = [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]];
    const along = (axis: Vec3) => d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    const depth = along(forward);
    if (!(depth >= this.near()) || depth > this.far()) return null;
    if (this.projection === 'orthographic') {
      const { halfW, halfH } = this.orthoHalfExtents();
      return { x: along(right) / halfW, y: along(up) / halfH };
    }
    const h = 1.0 / Math.tan(this.fovY * 0.5);
    return { x: ((h / this.aspect) * along(right)) / depth, y: (h * along(up)) / depth };
  }

  /**
   * Unprojects normalised device coordinates `(ndcX, ndcY)` and a Reverse-Z depth (`1` at near,
   * `0` at far) into IFC Z-up f64 world coordinates relative to the camera eye. Returns `null`
   * over cleared background (`reverseZDepth <= 0`) or out-of-range inputs.
   */
  unproject(ndcX: number, ndcY: number, reverseZDepth: number): Vec3 | null {
    if (
      !Number.isFinite(ndcX) ||
      !Number.isFinite(ndcY) ||
      !Number.isFinite(reverseZDepth) ||
      !(reverseZDepth > 0 && reverseZDepth <= 1)
    ) {
      return null;
    }
    const near = this.near();
    const far = this.far();
    const eye = this.getEye();
    const { forward, right, up } = this.axes();

    let viewDepth: number;
    let xCam: number;
    let yCam: number;

    if (this.projection === 'orthographic') {
      viewDepth = far - reverseZDepth * (far - near);
      const { halfW, halfH } = this.orthoHalfExtents();
      xCam = ndcX * halfW;
      yCam = ndcY * halfH;
    } else {
      viewDepth = (near * far) / (near + reverseZDepth * (far - near));
      const h = 1.0 / Math.tan(this.fovY * 0.5);
      xCam = (ndcX * this.aspect * viewDepth) / h;
      yCam = (ndcY * viewDepth) / h;
    }

    return [
      eye[0] + forward[0] * viewDepth + right[0] * xCam + up[0] * yCam,
      eye[1] + forward[1] * viewDepth + right[1] * xCam + up[1] * yCam,
      eye[2] + forward[2] * viewDepth + right[2] * xCam + up[2] * yCam
    ];
  }

  /** The ray from the eye through a point in normalised device coordinates. */
  rayAt(ndcX: number, ndcY: number): Ray {
    const { forward, right, up } = this.axes();
    const eye = this.getEye();
    if (this.projection === 'orthographic') {
      const { halfW, halfH } = this.orthoHalfExtents();
      const ox = eye[0] + right[0] * (ndcX * halfW) + up[0] * (ndcY * halfH);
      const oy = eye[1] + right[1] * (ndcX * halfW) + up[1] * (ndcY * halfH);
      const oz = eye[2] + right[2] * (ndcX * halfW) + up[2] * (ndcY * halfH);
      return { origin: [ox, oy, oz], direction: [forward[0], forward[1], forward[2]] };
    }
    const h = 1.0 / Math.tan(this.fovY * 0.5);
    const a = (ndcX * this.aspect) / h;
    const b = ndcY / h;
    const v: Vec3 = [
      forward[0] + right[0] * a + up[0] * b,
      forward[1] + right[1] * a + up[1] * b,
      forward[2] + right[2] * a + up[2] * b
    ];
    const l = Math.hypot(v[0], v[1], v[2]);
    return { origin: eye, direction: [v[0] / l, v[1] / l, v[2] / l] };
  }

  /**
   * What `writeUniforms` lets through a window of the view, as planes in absolute coordinates:
   * depth between near and far, and each side of the window, where a camera coordinate times
   * its projection scale equals the depth times the window's edge (or a constant offset in ortho).
   */
  frustum(window: ViewWindow = WHOLE_VIEW): Frustum {
    const eye = this.getEye();
    const { forward, right, up } = this.axes();
    const planes = new Float64Array(24);
    const put = (at: number, n: Vec3, offset: number) => {
      planes.set(n, at);
      planes[at + 3] = offset - (n[0] * eye[0] + n[1] * eye[1] + n[2] * eye[2]);
    };
    put(0, forward, -this.near());
    put(4, [-forward[0], -forward[1], -forward[2]], this.far());

    if (this.projection === 'orthographic') {
      const { halfW, halfH } = this.orthoHalfExtents();
      put(8, [-right[0], -right[1], -right[2]], window.right * halfW);
      put(12, right, -window.left * halfW);
      put(16, [-up[0], -up[1], -up[2]], window.top * halfH);
      put(20, up, -window.bottom * halfH);
      return planes;
    }

    const h = 1.0 / Math.tan(this.fovY * 0.5);
    const w = h / this.aspect;
    // edge·forward − scale·side: inside when the side coordinate shows at or before the edge.
    const tilt = (edge: number, scale: number, side: Vec3): Vec3 => [
      edge * forward[0] - scale * side[0],
      edge * forward[1] - scale * side[1],
      edge * forward[2] - scale * side[2]
    ];
    put(8, tilt(window.right, w, right), 0);
    put(12, tilt(-window.left, -w, right), 0);
    put(16, tilt(window.top, h, up), 0);
    put(20, tilt(-window.bottom, -h, up), 0);
    return planes;
  }

  /**
   * Writes column-major Reverse-Z projection (floats 0..15) and
   * rotation-only view matrix at the camera eye (floats 16..31).
   */
  writeUniforms(out: Float32Array): void {
    const near = this.near();
    const far = this.far();

    if (this.projection === 'orthographic') {
      // Reverse-Z orthographic projection: z_view = -near -> z_clip = 1, z_view = -far -> z_clip = 0, w_clip = 1
      const { halfW, halfH } = this.orthoHalfExtents();
      const invDepth = 1.0 / (far - near);

      out[0] = 1.0 / halfW;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;

      out[4] = 0;
      out[5] = 1.0 / halfH;
      out[6] = 0;
      out[7] = 0;

      out[8] = 0;
      out[9] = 0;
      out[10] = invDepth;
      out[11] = 0;

      out[12] = 0;
      out[13] = 0;
      out[14] = far * invDepth;
      out[15] = 1;
    } else {
      // Reverse-Z perspective projection matrix (clip z in [0, w], near -> 1, far -> 0)
      const h = 1.0 / Math.tan(this.fovY * 0.5);
      const w = h / this.aspect;
      const a = near / (far - near);
      const b = (far * near) / (far - near);

      out[0] = w;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;

      out[4] = 0;
      out[5] = h;
      out[6] = 0;
      out[7] = 0;

      out[8] = 0;
      out[9] = 0;
      out[10] = a;
      out[11] = -1;

      out[12] = 0;
      out[13] = 0;
      out[14] = b;
      out[15] = 0;
    }

    // 2. Rotation-only view matrix at camera eye (maps IFC Z-up into camera space: +X right, +Y up, -Z forward)
    const cosPhi = Math.cos(this.elevation);
    const sinPhi = Math.sin(this.elevation);
    const cosTheta = Math.cos(this.azimuth);
    const sinTheta = Math.sin(this.azimuth);

    // Forward f = (-cosPhi*cosTheta, -cosPhi*sinTheta, -sinPhi)
    // Right   r = (-sinTheta, cosTheta, 0)
    // Up      u = r x f = (-sinPhi*cosTheta, -sinPhi*sinTheta, cosPhi)
    const rx = -sinTheta;
    const ry = cosTheta;
    const rz = 0;

    const ux = -sinPhi * cosTheta;
    const uy = -sinPhi * sinTheta;
    const uz = cosPhi;

    const negFx = cosPhi * cosTheta;
    const negFy = cosPhi * sinTheta;
    const negFz = sinPhi;

    // Column 0 (X_ifc basis in camera space)
    out[16] = rx;
    out[17] = ux;
    out[18] = negFx;
    out[19] = 0;

    // Column 1 (Y_ifc basis in camera space)
    out[20] = ry;
    out[21] = uy;
    out[22] = negFy;
    out[23] = 0;

    // Column 2 (Z_ifc basis in camera space)
    out[24] = rz;
    out[25] = uz;
    out[26] = negFz;
    out[27] = 0;

    // Column 3 (zero translation — RTC offset is applied per batch in f64 on the CPU)
    out[28] = 0;
    out[29] = 0;
    out[30] = 0;
    out[31] = 1;
  }
}
