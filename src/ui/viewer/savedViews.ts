import type { CameraPose, CameraProjection } from '../../domain/kernel/RendererPort';
import type { ElementRef, ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import { withoutModel, type DisplayRule, type DisplayTarget } from './displayRule';
import type { SectionState } from './section';

export interface SavedView {
  id: string;
  name: string;
  camera: {
    target: [number, number, number];
    distance: number;
    azimuth: number;
    elevation: number;
    projection?: CameraProjection;
  };
  hiddenModelIds: ModelId[];
  displayRule: DisplayRule;
  section: SectionState;
  selectedRef: ElementRef | null;
}

export interface CaptureSavedViewInput {
  id: string;
  name: string;
  index: number;
  camera: CameraPose;
  models: ReadonlyArray<Pick<ModelRecord, 'id' | 'visible'>>;
  displayRule: DisplayRule;
  section: SectionState;
  selectedRef: ElementRef | null;
}

export interface AppliedSavedView {
  camera: {
    target: [number, number, number];
    distance: number;
    azimuth: number;
    elevation: number;
    projection?: CameraProjection;
  };
  modelVisibilities: Map<ModelId, boolean>;
  displayRule: DisplayRule;
  section: SectionState;
  selectedRef: ElementRef | null;
}

function cloneRef(ref: ElementRef): ElementRef {
  return ref.globalId !== undefined
    ? { modelId: ref.modelId, expressId: ref.expressId, globalId: ref.globalId }
    : { modelId: ref.modelId, expressId: ref.expressId };
}

function cloneTarget(target: DisplayTarget): DisplayTarget {
  if (target.by === 'class') return { by: 'class', type: target.type };
  if (target.by === 'spatial') {
    return { by: 'spatial', modelId: target.modelId, expressId: target.expressId, name: target.name };
  }
  if (target.by === 'element') return { by: 'element', ref: cloneRef(target.ref) };
  const matches: Record<ModelId, number[]> = {};
  for (const [modelId, ids] of Object.entries(target.matches)) {
    matches[modelId] = [...ids];
  }
  return { by: 'search', label: target.label, matches };
}

function cloneDisplayRule(rule: DisplayRule): DisplayRule {
  return {
    isolate: rule.isolate ? cloneTarget(rule.isolate) : null,
    hidden: rule.hidden.map(cloneTarget),
    ghost: rule.ghost
  };
}

function cloneSection(section: SectionState): SectionState {
  return {
    mode: section.mode,
    axis: section.axis,
    position: section.position,
    flip: section.flip,
    boxMin: section.boxMin ? { ...section.boxMin } : null,
    boxMax: section.boxMax ? { ...section.boxMax } : null,
    face: section.face
      ? {
          origin: [section.face.origin[0], section.face.origin[1], section.face.origin[2]],
          normal: [section.face.normal[0], section.face.normal[1], section.face.normal[2]],
          offset: section.face.offset
        }
      : null
  };
}

function cloneCamera(camera: CameraPose): SavedView['camera'] {
  return camera.projection
    ? {
        target: [camera.target[0], camera.target[1], camera.target[2]],
        distance: camera.distance,
        azimuth: camera.azimuth,
        elevation: camera.elevation,
        projection: camera.projection
      }
    : {
        target: [camera.target[0], camera.target[1], camera.target[2]],
        distance: camera.distance,
        azimuth: camera.azimuth,
        elevation: camera.elevation
      };
}

export function captureSavedView(input: CaptureSavedViewInput): SavedView {
  const trimmed = input.name.trim();
  return {
    id: input.id,
    name: trimmed.length > 0 ? trimmed : `Vista ${input.index}`,
    camera: cloneCamera(input.camera),
    hiddenModelIds: input.models.filter((m) => !m.visible).map((m) => m.id),
    displayRule: cloneDisplayRule(input.displayRule),
    section: cloneSection(input.section),
    selectedRef: input.selectedRef ? cloneRef(input.selectedRef) : null
  };
}

export function applySavedView(
  view: SavedView,
  models: ReadonlyArray<Pick<ModelRecord, 'id' | 'visible'>>
): AppliedSavedView {
  const hiddenSet = new Set(view.hiddenModelIds);
  const modelVisibilities = new Map<ModelId, boolean>();
  for (const model of models) {
    modelVisibilities.set(model.id, !hiddenSet.has(model.id));
  }
  const hasSelectedModel =
    view.selectedRef !== null && models.some((model) => model.id === view.selectedRef!.modelId);
  return {
    camera: cloneCamera(view.camera),
    modelVisibilities,
    displayRule: cloneDisplayRule(view.displayRule),
    section: cloneSection(view.section),
    selectedRef: hasSelectedModel && view.selectedRef ? cloneRef(view.selectedRef) : null
  };
}

export function savedViewWithoutModel(view: SavedView, modelId: ModelId): SavedView {
  return {
    ...view,
    camera: cloneCamera(view.camera),
    hiddenModelIds: view.hiddenModelIds.filter((id) => id !== modelId),
    displayRule: withoutModel(view.displayRule, modelId),
    section: cloneSection(view.section),
    selectedRef:
      view.selectedRef && view.selectedRef.modelId !== modelId ? cloneRef(view.selectedRef) : null
  };
}
