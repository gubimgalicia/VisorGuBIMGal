// Metres in the drawing frame, IFC Z-up. Plans look towards -Z, and 'positive' looks along +axis.
// For 'plane', `origin` is a point on the cut plane and `normal` is the look direction into the model.
// `depth` is measured from the plane along the look direction and limits projection only; omit for no limit.
export type DrawingCut =
  | { kind: 'plan'; elevation: number; depth?: number }
  | {
      kind: 'section';
      axis: 'x' | 'y';
      position: number;
      look: 'positive' | 'negative';
      depth?: number;
    }
  | {
      kind: 'plane';
      origin: readonly [number, number, number];
      normal: readonly [number, number, number];
      depth?: number;
    };

// 'project': absolute model coordinates, taken as shared by every model, as the 3D view does.
// 'map': each model through its localToMap. Models without one are skipped with a diagnostic.
export type DrawingFrame = { kind: 'project' } | { kind: 'map' };

export interface DrawingOptions {
  cut: DrawingCut;
  frame: DrawingFrame;
  includeProjection: boolean;     // Visible and hidden lines, which come from one pass
  includeHiddenLines: boolean;    // Requires includeProjection
  includeHatching: boolean;
}

export interface DrawingExportConfig {
  format: 'dxf' | 'svg';
  fileName: string;
  crsComment?: string;
  units: 'm' | 'mm';              // Scales the exported coordinates
  showHiddenLines: boolean;       // Export can omit what was generated, never add to it
  showHatching: boolean;
}
