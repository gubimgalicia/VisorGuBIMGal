import { angleAt, distanceBetween, polygonArea, type Vec3 } from '../../domain/measure/geometry';
import { formatFixed, formatLength, t } from '../i18n';

export type MeasureKind = 'distance' | 'height' | 'area' | 'angle';

export function getMeasureKinds(): readonly { kind: MeasureKind; label: string; hint: string }[] {
  return [
    { kind: 'distance', label: t('measure.kinds.distanceLabel'), hint: t('measure.kinds.distanceHint') },
    { kind: 'height', label: t('measure.kinds.heightLabel'), hint: t('measure.kinds.heightHint') },
    { kind: 'area', label: t('measure.kinds.areaLabel'), hint: t('measure.kinds.areaHint') },
    { kind: 'angle', label: t('measure.kinds.angleLabel'), hint: t('measure.kinds.angleHint') }
  ];
}

/** Points in absolute model coordinates, in the order they were marked. */
export interface Measurement {
  id: number;
  kind: MeasureKind;
  points: Vec3[];
}

/** Points that complete a measurement; an area takes as many as the user marks. */
const POINTS: Record<MeasureKind, number | null> = { distance: 2, height: 2, area: null, angle: 3 };

export function startMeasurement(kind: MeasureKind, id: number): Measurement {
  return { id, kind, points: [] };
}

/** Adds a point: the measurement is `done` once it has its points, else still the `draft`. */
export function addPoint(
  draft: Measurement,
  point: Vec3
): { draft: Measurement | null; done: Measurement | null } {
  const next = { ...draft, points: [...draft.points, point] };
  return next.points.length === POINTS[draft.kind] ? { draft: null, done: next } : { draft: next, done: null };
}

export function canClose(draft: Measurement): boolean {
  return draft.kind === 'area' && draft.points.length >= 3;
}

export function closeArea(draft: Measurement): Measurement | null {
  return canClose(draft) ? { ...draft, points: [...draft.points] } : null;
}

const metres = (value: number) => formatLength(value, 3);
const signed = (value: number) => formatLength(value, 3, { signed: true });

/** What the measurement reads, and the figures behind it. Empty while points are missing. */
export function measurementText(measurement: Measurement): { value: string; detail: string } {
  const [a, b, c] = measurement.points;
  switch (measurement.kind) {
    case 'distance': {
      if (!b) return { value: '', detail: '' };
      const d = distanceBetween(a, b);
      return {
        value: metres(d.length),
        detail: t('measure.detailDistance', {
          dx: signed(d.dx),
          dy: signed(d.dy),
          dz: signed(d.dz),
          horizontal: metres(d.horizontal)
        })
      };
    }
    case 'height': {
      if (!b) return { value: '', detail: '' };
      const d = distanceBetween(a, b);
      return {
        value: signed(d.dz),
        detail: t('measure.detailHeight', {
          horizontal: metres(d.horizontal),
          length: metres(d.length)
        })
      };
    }
    case 'area': {
      const area = polygonArea(measurement.points);
      if (!area) return { value: '', detail: '' };
      return {
        value: t('measure.squareMetresValue', { value: formatFixed(area.area, 3) }),
        detail: t('measure.detailArea', { perimeter: metres(area.perimeter) })
      };
    }
    case 'angle': {
      const angle = c ? angleAt(a, b, c) : null;
      if (angle === null) return { value: '', detail: '' };
      return {
        value: t('measure.degreesValue', { value: formatFixed(angle, 1) }),
        detail: t('measure.detailAngle', { supplementary: formatFixed(180 - angle, 1) })
      };
    }
  }
}
