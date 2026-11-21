import React, { useEffect, useReducer, useSyncExternalStore } from 'react';
import type { RendererPort } from '../../domain/kernel/RendererPort';
import type { Vec3 } from '../../domain/measure/geometry';
import { measurementText, type Measurement } from '../viewer/measure';
import type { MeasureController } from '../viewer/MeasureController';

interface MeasureOverlayProps {
  controller: MeasureController;
  renderer: RendererPort;
}

type Screen = { x: number; y: number } | null;

/** The lines a measurement draws, as pairs of points, and where its label goes. */
function figure(
  measurement: Measurement,
  closed: boolean
): { segments: [Vec3, Vec3][]; anchor: Vec3 | null; dashed: [Vec3, Vec3][] } {
  const p = measurement.points;
  const pairs = (points: Vec3[]): [Vec3, Vec3][] => points.slice(1).map((point, i) => [points[i], point]);
  switch (measurement.kind) {
    case 'height': {
      if (p.length < 2) return { segments: [], anchor: null, dashed: [] };
      const corner: Vec3 = [p[0][0], p[0][1], p[1][2]];
      const middle: Vec3 = [p[0][0], p[0][1], (p[0][2] + p[1][2]) / 2];
      return { segments: [[p[0], corner]], anchor: middle, dashed: [[corner, p[1]]] };
    }
    case 'area': {
      const segments = pairs(p);
      if (closed && p.length >= 3) segments.push([p[p.length - 1], p[0]]);
      const mean = (axis: 0 | 1 | 2) => p.reduce((sum, point) => sum + point[axis], 0) / p.length;
      return { segments, anchor: closed && p.length >= 3 ? [mean(0), mean(1), mean(2)] : null, dashed: [] };
    }
    case 'angle':
      return { segments: pairs(p), anchor: p.length === 3 ? p[1] : null, dashed: [] };
    default: {
      const anchor: Vec3 | null =
        p.length === 2 ? [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2, (p[0][2] + p[1][2]) / 2] : null;
      return { segments: pairs(p), anchor, dashed: [] };
    }
  }
}

export const MeasureOverlay: React.FC<MeasureOverlayProps> = ({ controller, renderer }) => {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  // Every drawn frame may have moved the camera.
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => controller.subscribeFrame(redraw), [controller]);

  const { draft, measurements, hover, kind } = state;
  if (!kind && measurements.length === 0) return null;

  const project = (point: Vec3): Screen => renderer.project(point);
  const lines: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];
  const dots: React.ReactNode[] = [];
  const line = (key: string, a: Vec3, b: Vec3, className: string) => {
    const pa = project(a);
    const pb = project(b);
    if (pa && pb) lines.push(<line key={key} className={className} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} />);
  };
  const dot = (key: string, point: Vec3) => {
    const at = project(point);
    if (at) dots.push(<circle key={key} className="measure-point" cx={at.x} cy={at.y} r={3} />);
  };

  for (const measurement of measurements) {
    const { segments, anchor, dashed } = figure(measurement, true);
    segments.forEach(([a, b], i) => line(`m${measurement.id}-${i}`, a, b, 'measure-line'));
    dashed.forEach(([a, b], i) => line(`m${measurement.id}-d${i}`, a, b, 'measure-line measure-dashed'));
    if (measurement.kind === 'area') {
      const corners = measurement.points.map(project);
      if (corners.every(Boolean)) {
        lines.unshift(
          <polygon
            key={`m${measurement.id}-fill`}
            className="measure-fill"
            points={corners.map((c) => `${c!.x},${c!.y}`).join(' ')}
          />
        );
      }
    }
    measurement.points.forEach((point, i) => dot(`m${measurement.id}-p${i}`, point));
    const at = anchor && project(anchor);
    if (at) {
      labels.push(
        <div
          key={`m${measurement.id}-label`}
          className="measure-label"
          data-id={measurement.id}
          style={{ left: at.x, top: at.y }}
        >
          {measurementText(measurement).value}
        </div>
      );
    }
  }

  if (draft) {
    const { segments } = figure(draft, false);
    segments.forEach(([a, b], i) => line(`d-${i}`, a, b, 'measure-line measure-draft'));
    draft.points.forEach((point, i) => dot(`d-p${i}`, point));
    const last = draft.points[draft.points.length - 1];
    if (last && hover) {
      line('d-rubber', last, hover.point, 'measure-line measure-draft measure-dashed');
      if (draft.kind === 'area' && draft.points.length >= 2) {
        line('d-rubber-close', hover.point, draft.points[0], 'measure-line measure-draft measure-dashed');
      }
    }
  }

  const marker = hover && project(hover.point);

  return (
    <div className="measure-overlay">
      <svg className="measure-svg">
        {lines}
        {dots}
        {marker && hover && (
          <g className="measure-snap" data-kind={hover.kind} transform={`translate(${marker.x} ${marker.y})`}>
            {hover.kind === 'vertex' && <rect x={-5} y={-5} width={10} height={10} />}
            {hover.kind === 'edge' && <polygon points="0,-6 6,0 0,6 -6,0" />}
            {hover.kind === 'surface' && <circle r={4} />}
          </g>
        )}
      </svg>
      {labels}
    </div>
  );
};
