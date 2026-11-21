import type { SpatialTree } from '../../domain/kernel/KernelPort';
import { MAX_SECTION_PLANES, type CameraPose, type SectionPlane } from '../../domain/kernel/RendererPort';
import type { ElementRef, ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import { newGuid, type BcfCamera, type BcfColoring, type BcfComponent, type BcfViewpoint, type Vec3 } from './bcf';
import { SHOW_ALL, targetMembers, type DisplayRule } from './displayRule';
import { NO_SECTION, SECTION_AXES, type AxisValues, type SectionAxis, type SectionState } from './section';
import { t } from '../i18n';

const DEFAULT_FOV_DEG = 45;
const HALF_FOV_RAD = (DEFAULT_FOV_DEG * Math.PI) / 360; // pi / 8
const TAN_HALF_FOV = Math.tan(HALF_FOV_RAD);

/**
 * Converts a viewer `CameraPose` (IFC Z-up orbit/first-person camera) into a BCF 2.1/3.0
 * `PerspectiveCamera` or `OrthogonalCamera`.
 */
export function cameraPoseToBcfCamera(pose: CameraPose, aspectRatio = 16 / 9): BcfCamera {
  const cosPhi = Math.cos(pose.elevation);
  const sinPhi = Math.sin(pose.elevation);
  const cosTheta = Math.cos(pose.azimuth);
  const sinTheta = Math.sin(pose.azimuth);

  const eye: Vec3 = [
    pose.target[0] + pose.distance * cosPhi * cosTheta,
    pose.target[1] + pose.distance * cosPhi * sinTheta,
    pose.target[2] + pose.distance * sinPhi
  ];
  const forward: Vec3 = [-cosPhi * cosTheta, -cosPhi * sinTheta, -sinPhi];
  const up: Vec3 = [-sinPhi * cosTheta, -sinPhi * sinTheta, cosPhi];
  const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;

  if (pose.projection === 'orthographic') {
    const halfH = Math.max(0.05, pose.distance * TAN_HALF_FOV);
    return {
      kind: 'orthogonal',
      viewPoint: eye,
      direction: forward,
      up,
      viewToWorldScale: 2 * halfH,
      aspectRatio: aspect
    };
  }

  return {
    kind: 'perspective',
    viewPoint: eye,
    direction: forward,
    up,
    fieldOfView: DEFAULT_FOV_DEG,
    aspectRatio: aspect
  };
}

/**
 * Converts a BCF `PerspectiveCamera` or `OrthogonalCamera` into a viewer `CameraPose`
 * in IFC Z-up coordinates.
 *
 * When `referenceTarget` lies in front of `camera.viewPoint` (in perspective mode), the orbit
 * distance is chosen so the target projects to the same depth along `direction`, preserving
 * `pose.target` across capture -> apply round-trips while keeping `eye === viewPoint`.
 */
export function bcfCameraToCameraPose(
  camera: BcfCamera,
  fallbackDistance = 12,
  referenceTarget?: readonly [number, number, number]
): CameraPose {
  const [dx, dy, dz] = camera.direction;
  const dLen = Math.hypot(dx, dy, dz);
  const fx = dLen > 1e-12 ? dx / dLen : -1 / Math.SQRT2;
  const fy = dLen > 1e-12 ? dy / dLen : 1 / Math.SQRT2;
  const fz = dLen > 1e-12 ? dz / dLen : -1 / Math.sqrt(3);

  const sinPhi = Math.max(-1, Math.min(1, -fz));
  const elevation = Math.asin(sinPhi);
  const xyLen = Math.hypot(fx, fy);

  let azimuth: number;
  if (xyLen > 1e-6) {
    azimuth = Math.atan2(-fy, -fx);
  } else {
    const [ux, uy] = camera.up;
    azimuth = sinPhi >= 0 ? Math.atan2(-uy, -ux) : Math.atan2(uy, ux);
  }

  const safeFallback = Number.isFinite(fallbackDistance) && fallbackDistance > 0 ? fallbackDistance : 12;
  let distance: number;

  if (camera.kind === 'orthogonal') {
    const scale =
      camera.viewToWorldScale !== undefined && camera.viewToWorldScale > 0
        ? camera.viewToWorldScale
        : 2 * safeFallback * TAN_HALF_FOV;
    distance = Math.max(0.05, Math.min(500000, (scale * 0.5) / TAN_HALF_FOV));
  } else if (referenceTarget && referenceTarget.every(Number.isFinite)) {
    const along =
      (referenceTarget[0] - camera.viewPoint[0]) * fx +
      (referenceTarget[1] - camera.viewPoint[1]) * fy +
      (referenceTarget[2] - camera.viewPoint[2]) * fz;
    distance = along >= 0.05 ? Math.min(500000, along) : safeFallback;
  } else {
    distance = Math.max(0.05, Math.min(500000, safeFallback));
  }

  const cosPhi = Math.cos(elevation);
  const cosTheta = Math.cos(azimuth);
  const sinTheta = Math.sin(azimuth);
  const forwardX = -cosPhi * cosTheta;
  const forwardY = -cosPhi * sinTheta;
  const forwardZ = -Math.sin(elevation);

  const target: [number, number, number] = [
    camera.viewPoint[0] + distance * forwardX,
    camera.viewPoint[1] + distance * forwardY,
    camera.viewPoint[2] + distance * forwardZ
  ];

  return {
    target,
    distance,
    azimuth,
    elevation,
    projection: camera.kind === 'orthogonal' ? 'orthographic' : 'perspective'
  };
}

/**
 * Converts viewer `SectionPlane` half-spaces (`dot(normal, p) <= offset` kept) into BCF
 * `ClippingPlane` entries (`location` on the plane, `direction` pointing into the clipped half-space).
 */
export function sectionPlanesToBcfClipping(
  planes: readonly SectionPlane[],
  anchor: Vec3 = [0, 0, 0]
): { location: Vec3; direction: Vec3 }[] {
  const safeAnchor: Vec3 = anchor.every(Number.isFinite) ? anchor : [0, 0, 0];
  const out: { location: Vec3; direction: Vec3 }[] = [];

  for (const plane of planes.slice(0, MAX_SECTION_PLANES)) {
    const [nx, ny, nz] = plane.normal;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12) || !Number.isFinite(plane.offset)) continue;
    const ux = nx / len;
    const uy = ny / len;
    const uz = nz / len;
    const scaledOffset = plane.offset / len;
    const signedDist = ux * safeAnchor[0] + uy * safeAnchor[1] + uz * safeAnchor[2] - scaledOffset;
    out.push({
      location: [
        safeAnchor[0] - signedDist * ux,
        safeAnchor[1] - signedDist * uy,
        safeAnchor[2] - signedDist * uz
      ],
      direction: [ux, uy, uz]
    });
  }
  return out;
}

/**
 * Converts BCF `ClippingPlane` entries into viewer `SectionPlane` half-spaces.
 */
export function bcfClippingToSectionPlanes(
  clippingPlanes: readonly { location: Vec3; direction: Vec3 }[]
): SectionPlane[] {
  const out: SectionPlane[] = [];
  for (const plane of clippingPlanes) {
    if (out.length >= MAX_SECTION_PLANES) break;
    const [dx, dy, dz] = plane.direction;
    const [lx, ly, lz] = plane.location;
    if (![dx, dy, dz, lx, ly, lz].every(Number.isFinite)) continue;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-12)) continue;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    const offset = nx * lx + ny * ly + nz * lz;
    out.push({ normal: [nx, ny, nz], offset });
  }
  return out;
}

/**
 * Infers a UI `SectionState` (`off`, single axis `plane`, or 6-plane `box`) from `SectionPlane[]`.
 */
export function sectionPlanesToSectionState(planes: readonly SectionPlane[]): SectionState {
  if (planes.length === 0) return { ...NO_SECTION };

  if (planes.length === 6) {
    const boxMin: Partial<AxisValues> = {};
    const boxMax: Partial<AxisValues> = {};
    for (const plane of planes) {
      const [nx, ny, nz] = plane.normal;
      if (Math.abs(nx) > 0.999) {
        if (nx > 0) boxMax.x = plane.offset / nx;
        else boxMin.x = plane.offset / nx;
      } else if (Math.abs(ny) > 0.999) {
        if (ny > 0) boxMax.y = plane.offset / ny;
        else boxMin.y = plane.offset / ny;
      } else if (Math.abs(nz) > 0.999) {
        if (nz > 0) boxMax.z = plane.offset / nz;
        else boxMin.z = plane.offset / nz;
      }
    }
    if (SECTION_AXES.every((axis) => boxMin[axis] !== undefined && boxMax[axis] !== undefined)) {
      return {
        mode: 'box',
        axis: 'z',
        position: null,
        flip: false,
        boxMin: boxMin as AxisValues,
        boxMax: boxMax as AxisValues
      };
    }
  }

  const first = planes[0];
  const [nx, ny, nz] = first.normal;
  const absX = Math.abs(nx);
  const absY = Math.abs(ny);
  const absZ = Math.abs(nz);
  const maxAbs = Math.max(absX, absY, absZ);
  if (maxAbs <= 0.999) {
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      const ux = nx / len;
      const uy = ny / len;
      const uz = nz / len;
      const d = first.offset / len;
      return {
        mode: 'face',
        axis: 'z',
        position: null,
        flip: false,
        boxMin: null,
        boxMax: null,
        face: {
          origin: [ux * d, uy * d, uz * d],
          normal: [-ux, -uy, -uz],
          offset: 0
        }
      };
    }
  }
  let axis: SectionAxis = 'z';
  let comp = nz;
  if (absX >= absY && absX >= absZ) {
    axis = 'x';
    comp = nx;
  } else if (absY >= absX && absY >= absZ) {
    axis = 'y';
    comp = ny;
  }
  const flip = comp < 0;
  const position = Math.abs(comp) > 1e-6 ? first.offset / comp : first.offset;
  return {
    mode: 'plane',
    axis,
    position,
    flip,
    boxMin: null,
    boxMax: null,
    face: null
  };
}

/**
 * Formats a packed `u32` `(r << 24) | (g << 16) | (b << 8) | a` into a 6-digit uppercase BCF hex
 * string (`RRGGBB`), or 8-digit (`RRGGBBAA`) when `a !== 0xff`.
 */
export function rgbaU32ToBcfHex(rgba: number): string {
  const u = rgba >>> 0;
  const r = ((u >>> 24) & 0xff).toString(16).padStart(2, '0');
  const g = ((u >>> 16) & 0xff).toString(16).padStart(2, '0');
  const b = ((u >>> 8) & 0xff).toString(16).padStart(2, '0');
  const a = u & 0xff;
  if (a !== 0xff) {
    return `${r}${g}${b}${a.toString(16).padStart(2, '0')}`.toUpperCase();
  }
  return `${r}${g}${b}`.toUpperCase();
}

/**
 * Parses a 6-digit (`RRGGBB`) or 8-digit (`RRGGBBAA`) BCF hex color string into a packed `u32`.
 */
export function bcfHexToRgbaU32(color: string): number {
  const clean = color.trim().replace(/^#/, '');
  if (!/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(clean)) return 0x64748bff;
  const r = parseInt(clean.slice(0, 2), 16) & 0xff;
  const g = parseInt(clean.slice(2, 4), 16) & 0xff;
  const b = parseInt(clean.slice(4, 6), 16) & 0xff;
  const a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) & 0xff : 0xff;
  return (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}

/**
 * Collects the element references that act as visibility exceptions for the current `DisplayRule`:
 * - When `rule.isolate` is set, `mode` is `'isolate'` (`defaultVisibility: false`) and `refs` are
 *   the visible isolated elements (excluding any explicitly hidden).
 * - When `rule.hidden` is non-empty and `rule.isolate` is null, `mode` is `'hide'`
 *   (`defaultVisibility: true`) and `refs` are the hidden elements.
 * - Otherwise `mode` is `'all'` (`defaultVisibility: true`, no exceptions).
 */
export function collectDisplayExceptionRefs(
  rule: DisplayRule,
  models: ReadonlyArray<Pick<ModelRecord, 'id' | 'visible' | 'status'>>,
  spatialTrees: Readonly<Record<ModelId, SpatialTree>>
): { mode: 'all' | 'isolate' | 'hide'; refs: ElementRef[] } {
  const activeModels = models.filter((m) => m.status === 'ready' && m.visible);
  if (rule.isolate) {
    const refs: ElementRef[] = [];
    for (const model of activeModels) {
      const tree = spatialTrees[model.id];
      const isolated = new Set(targetMembers(rule.isolate, model.id, tree));
      for (const hiddenTarget of rule.hidden) {
        for (const id of targetMembers(hiddenTarget, model.id, tree)) {
          isolated.delete(id);
        }
      }
      for (const expressId of isolated) {
        refs.push({ modelId: model.id, expressId });
      }
    }
    return { mode: 'isolate', refs };
  }

  if (rule.hidden.length > 0) {
    const refs: ElementRef[] = [];
    for (const model of activeModels) {
      const tree = spatialTrees[model.id];
      const hidden = new Set<number>();
      for (const hiddenTarget of rule.hidden) {
        for (const id of targetMembers(hiddenTarget, model.id, tree)) {
          hidden.add(id);
        }
      }
      for (const expressId of hidden) {
        refs.push({ modelId: model.id, expressId });
      }
    }
    return { mode: 'hide', refs };
  }

  return { mode: 'all', refs: [] };
}

export interface BuildBcfViewpointInput {
  guid?: string;
  index?: number;
  camera: CameraPose | null;
  aspectRatio?: number;
  selectedGuids?: readonly string[];
  visibility?: {
    mode: 'all' | 'isolate' | 'hide';
    exceptionGuids: readonly string[];
    spacesVisible?: boolean;
    spaceBoundariesVisible?: boolean;
    openingsVisible?: boolean;
  };
  coloring?: ReadonlyArray<{ color: string; ifcGuids: readonly string[] }>;
  sectionPlanes?: readonly SectionPlane[];
  snapshot?: { bytes: Uint8Array; format: 'png' | 'jpg' };
}

/**
 * Constructs a `BcfViewpoint` from resolved viewer state.
 */
export function buildBcfViewpoint(input: BuildBcfViewpointInput): BcfViewpoint {
  const guid = (input.guid ?? newGuid()).toLowerCase();
  const selection: BcfComponent[] = (input.selectedGuids ?? [])
    .filter((id) => id.trim().length > 0)
    .map((ifcGuid) => ({ ifcGuid }));

  const visMode = input.visibility?.mode ?? 'all';
  const exceptionComponents: BcfComponent[] = (input.visibility?.exceptionGuids ?? [])
    .filter((id) => id.trim().length > 0)
    .map((ifcGuid) => ({ ifcGuid }));

  const coloring: BcfColoring[] = (input.coloring ?? [])
    .map((entry) => ({
      color: entry.color.trim().replace(/^#/, '').toUpperCase(),
      components: entry.ifcGuids.filter((id) => id.trim().length > 0).map((ifcGuid) => ({ ifcGuid }))
    }))
    .filter((entry) => /^[0-9A-F]{6}([0-9A-F]{2})?$/.test(entry.color) && entry.components.length > 0);

  const anchor: Vec3 = input.camera
    ? [input.camera.target[0], input.camera.target[1], input.camera.target[2]]
    : [0, 0, 0];

  return {
    guid,
    index: input.index,
    camera: input.camera ? cameraPoseToBcfCamera(input.camera, input.aspectRatio) : null,
    selection,
    visibility: {
      defaultVisibility: visMode !== 'isolate',
      exceptions: exceptionComponents,
      spacesVisible: input.visibility?.spacesVisible ?? false,
      spaceBoundariesVisible: input.visibility?.spaceBoundariesVisible ?? false,
      openingsVisible: input.visibility?.openingsVisible ?? false
    },
    coloring,
    lines: [],
    clippingPlanes: sectionPlanesToBcfClipping(input.sectionPlanes ?? [], anchor),
    bitmaps: [],
    snapshot: input.snapshot
  };
}

export interface InterpretedBcfViewpoint {
  camera: CameraPose | null;
  selectedRef: ElementRef | null;
  displayRule: DisplayRule;
  colorsByModel: Map<ModelId, Map<number, number>>;
  sectionPlanes: SectionPlane[];
  sectionState: SectionState;
}

/**
 * Translates a `BcfViewpoint` into viewer state (`CameraPose`, `selectedRef`, `DisplayRule`,
 * per-model color overrides, `SectionPlane[]`, and `SectionState`).
 */
export function interpretBcfViewpoint(
  viewpoint: BcfViewpoint,
  resolveGuid: (ifcGuid: string) => ElementRef | null,
  options?: {
    fallbackDistance?: number;
    referenceTarget?: readonly [number, number, number];
    ghost?: boolean;
  }
): InterpretedBcfViewpoint {
  const camera = viewpoint.camera
    ? bcfCameraToCameraPose(viewpoint.camera, options?.fallbackDistance, options?.referenceTarget)
    : null;

  let selectedRef: ElementRef | null = null;
  for (const comp of viewpoint.selection) {
    if (!comp.ifcGuid) continue;
    const resolved = resolveGuid(comp.ifcGuid);
    if (resolved) {
      selectedRef = resolved;
      break;
    }
  }

  let displayRule: DisplayRule = { ...SHOW_ALL, ghost: options?.ghost ?? false };
  if (viewpoint.visibility) {
    const matches: Record<ModelId, number[]> = {};
    let matchCount = 0;
    for (const comp of viewpoint.visibility.exceptions) {
      if (!comp.ifcGuid) continue;
      const resolved = resolveGuid(comp.ifcGuid);
      if (!resolved) continue;
      if (!matches[resolved.modelId]) matches[resolved.modelId] = [];
      if (!matches[resolved.modelId].includes(resolved.expressId)) {
        matches[resolved.modelId].push(resolved.expressId);
        matchCount++;
      }
    }
    if (!viewpoint.visibility.defaultVisibility) {
      if (matchCount > 0) {
        displayRule = {
          isolate: { by: 'search', label: t('bcf.viewpointDefaultLabel'), matches },
          hidden: [],
          ghost: options?.ghost ?? false
        };
      }
    } else if (matchCount > 0) {
      displayRule = {
        isolate: null,
        hidden: [{ by: 'search', label: t('bcf.hiddenDefaultLabel'), matches }],
        ghost: options?.ghost ?? false
      };
    }
  }

  const colorsByModel = new Map<ModelId, Map<number, number>>();
  for (const group of viewpoint.coloring) {
    const rgba = bcfHexToRgbaU32(group.color);
    for (const comp of group.components) {
      if (!comp.ifcGuid) continue;
      const resolved = resolveGuid(comp.ifcGuid);
      if (!resolved) continue;
      let modelMap = colorsByModel.get(resolved.modelId);
      if (!modelMap) {
        modelMap = new Map<number, number>();
        colorsByModel.set(resolved.modelId, modelMap);
      }
      modelMap.set(resolved.expressId, rgba);
    }
  }

  const sectionPlanes = bcfClippingToSectionPlanes(viewpoint.clippingPlanes);
  const sectionState = sectionPlanesToSectionState(sectionPlanes);

  return {
    camera,
    selectedRef,
    displayRule,
    colorsByModel,
    sectionPlanes,
    sectionState
  };
}
