import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { KernelPort, SpatialTree } from '../../domain/kernel/KernelPort';
import type { CameraPose, RendererPort } from '../../domain/kernel/RendererPort';
import type { ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import {
  eyeOf,
  minimapFrame,
  storeyAt,
  svgPlanSheet,
  pinCone,
  viewCone,
  type MinimapFrame
} from '../viewer/minimap';
import { storeyLevels } from '../viewer/planDepth';
import { t } from '../i18n';
import { widenForPreview } from './drawingPreview';

/** The map is a square, in CSS pixels. */
const SIZE = 200;
/** The plan is cut this far above the storey's floor, as SectionDxfPanel does. Metres. */
const CUT_ABOVE_FLOOR = 1.2;
/** How far below the cut the plan projects. Metres. */
const CUT_DEPTH = 1.25;
/** The camera moves the marker at most ten times a second. */
const FRAME_INTERVAL_MS = 100;
/**
 * The camera's vertical field of view is 45 degrees (Camera.ts) and the viewport is about 16:9,
 * so the horizontal one is close to 77 degrees. RendererPort exposes neither.
 */
const HORIZONTAL_FOV = 2 * Math.atan(Math.tan(Math.PI / 8) * (16 / 9));
/** How far the cone reaches across the longest side of the plan. */
const CONE_FRACTION = 0.18;

/**
 * After-frame notifications, so the minimap follows the camera without taking over the
 * renderer's handlers, which belong to the viewer and the measuring tool.
 */
export interface FrameSignal {
  subscribe(listener: () => void): () => void;
}

interface PlanBounds {
  min: { x: number; y: number };
  max: { x: number; y: number };
}

interface Plan {
  /** The exported SVG, widened so its strokes show at this size. Safe to inject: docs/05 section 5. */
  svg: string;
  /** Model x, y to the sheet's viewBox coordinates, north up as the sheet counts y downwards. */
  frame: MinimapFrame;
  width: number;
  height: number;
  /** The storey the plan was cut in, shown under the map. */
  storeyName: string;
}

interface MinimapProps {
  kernel: KernelPort;
  renderer: RendererPort;
  /** Every open model: the minimap regenerates when this set changes. */
  models: readonly ModelRecord[];
  spatialTrees: Record<ModelId, SpatialTree | null | undefined>;
  frames: FrameSignal;
}

/** The plan extent of the models that have geometry, or null before any arrives. */
function planBounds(models: readonly ModelRecord[]): PlanBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const model of models) {
    const bounds = model.bounds;
    if (!bounds) continue;
    minX = Math.min(minX, bounds.min.x);
    minY = Math.min(minY, bounds.min.y);
    maxX = Math.max(maxX, bounds.max.x);
    maxY = Math.max(maxY, bounds.max.y);
  }
  return Number.isFinite(minX) ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}

/**
 * A plan of the storey the camera stands in, fitted to a corner of the 3D view. North is up.
 * The plan is generated once per storey and model set, never per frame: only the eye and the
 * view cone follow the camera, on the renderer's after-frame signal, ten times a second.
 */
export const Minimap: React.FC<MinimapProps> = ({ kernel, renderer, models, spatialTrees, frames }) => {
  const [pose, setPose] = useState<CameraPose | null>(() => renderer.getCameraPose());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The eye and the cone follow every drawn frame, at most ten times a second.
  useEffect(() => {
    let last = 0;
    let timer: number | null = null;
    const update = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      last = performance.now();
      setPose(renderer.getCameraPose());
    };
    const unsubscribe = frames.subscribe(() => {
      const now = performance.now();
      const wait = FRAME_INTERVAL_MS - (now - last);
      if (wait <= 0) {
        update();
      } else if (timer === null) {
        timer = window.setTimeout(update, wait);
      }
    });
    update();
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [frames, renderer]);

  const storeys = useMemo(
    () => storeyLevels(models.map((model) => spatialTrees[model.id])),
    [models, spatialTrees]
  );
  const eye = pose ? eyeOf(pose) : null;
  const storey = eye ? storeyAt(eye[2], storeys) : null;
  const storeyLevel = storey ? storey.level : null;
  const storeyName = storey ? storey.name : null;

  const modelIds = useMemo(() => models.map((model) => model.id), [models]);
  // The set, not the order, decides whether there is a new plan to make.
  const modelKey = useMemo(() => [...modelIds].sort().join('\u0000'), [modelIds]);
  const bounds = useMemo(() => planBounds(models), [models]);
  const hasBounds = bounds !== null;

  // One plan per storey and set of open models. The eye height picks the storey, so walking up
  // a floor makes the next plan; moving within one floor leaves it alone.
  useEffect(() => {
    if (storeyLevel === null || storeyName === null || modelIds.length === 0 || !bounds) {
      setPlan(null);
      setPlanError(null);
      setIsGenerating(false);
      return;
    }
    let cancelled = false;
    let drawingId: string | null = null;
    setIsGenerating(true);
    setPlanError(null);
    const boundsX = bounds.max.x - bounds.min.x;
    const boundsY = bounds.max.y - bounds.min.y;

    const generate = async () => {
      try {
        const generated = await kernel.generateDrawing(modelIds, {
          cut: { kind: 'plan', elevation: storeyLevel + CUT_ABOVE_FLOOR, depth: CUT_DEPTH },
          frame: { kind: 'project' },
          includeProjection: false,
          includeHiddenLines: false,
          includeHatching: false
        });
        drawingId = generated.drawingId;
        if (cancelled) return;

        const exported = await kernel.exportDrawing(drawingId, {
          format: 'svg',
          fileName: 'minimap',
          units: 'm',
          showHiddenLines: false,
          showHatching: false
        });
        if (cancelled) return;

        const svg =
          typeof exported.content === 'string'
            ? exported.content
            : new TextDecoder().decode(exported.content);
        const sheet = svgPlanSheet(svg);
        if (!sheet) throw new Error(t('minimap.badViewBox'));

        // svg.rs writes the drawing plus its margin in the viewBox, y counted downwards. A plan
        // cut at one storey can hold less than the models' full plan extent, so the drawing keeps
        // its own extent, centred on the models' extent: the frame is then exactly the writer's.
        const spanX = Math.max(0, sheet.width - 2 * sheet.margin);
        const spanY = Math.max(0, sheet.height - 2 * sheet.margin);
        const lowX = bounds.min.x + (boundsX - spanX) / 2;
        const lowY = bounds.min.y + (boundsY - spanY) / 2;
        const frame = minimapFrame(
          { min: { x: lowX, y: lowY }, max: { x: lowX + spanX, y: lowY + spanY } },
          sheet.width,
          sheet.height,
          sheet.margin
        );

        if (cancelled || !mountedRef.current) return;
        setPlan({
          svg: widenForPreview(svg, { width: SIZE, height: SIZE }),
          frame,
          width: sheet.width,
          height: sheet.height,
          storeyName
        });
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          setPlan(null);
          setPlanError(err instanceof Error ? err.message : t('minimap.failed'));
        }
      } finally {
        if (drawingId) {
          const id = drawingId;
          drawingId = null;
          void kernel.discardDrawing(id);
        }
        if (!cancelled && mountedRef.current) setIsGenerating(false);
      }
    };

    void generate();
    return () => {
      cancelled = true;
      if (drawingId) {
        const id = drawingId;
        drawingId = null;
        void kernel.discardDrawing(id);
      }
    };
  }, [storeyLevel, storeyName, modelKey, hasBounds, kernel]);

  // A screen pixel in the sheet's units: the sheet is fitted to the square by its longest side.
  const eyeRadius = plan ? (3 * Math.max(plan.width, plan.height)) / SIZE : 0;
  const rawCone = pose && eye && plan
    ? viewCone(plan.frame, eye, pose.target, HORIZONTAL_FOV, Math.max(plan.width, plan.height) * CONE_FRACTION)
    : null;
  // A camera outside the building would fall off the map: show it on the edge, hollow.
  const pinned = rawCone && plan ? pinCone(rawCone, plan.width, plan.height, 2 * eyeRadius) : null;
  const cone = pinned?.cone ?? null;

  return (
    <div className="minimap-widget" aria-label={t('minimap.ariaLabel')}>
      <div className="minimap-map">
        {plan ? (
          <div className="minimap-plan" dangerouslySetInnerHTML={{ __html: plan.svg }} />
        ) : (
          <div className="minimap-empty">{isGenerating ? t('minimap.computing') : t('minimap.noPlan')}</div>
        )}
        {plan && cone && (
          <svg
            className="minimap-overlay"
            viewBox={`0 0 ${plan.width} ${plan.height}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            <polygon
              className="minimap-cone"
              points={`${cone.apex.x},${cone.apex.y} ${cone.left.x},${cone.left.y} ${cone.right.x},${cone.right.y}`}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              className={pinned?.outside ? 'minimap-eye minimap-eye-outside' : 'minimap-eye'}
              cx={cone.apex.x}
              cy={cone.apex.y}
              r={eyeRadius}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
      <div className="minimap-storey" title={planError ?? undefined}>
        {planError ? (
          <span className="minimap-error">{planError}</span>
        ) : plan ? (
          plan.storeyName
        ) : isGenerating ? (
          t('minimap.computingPlan')
        ) : storeyName ? (
          storeyName
        ) : (
          t('minimap.noStoreys')
        )}
      </div>
    </div>
  );
};
