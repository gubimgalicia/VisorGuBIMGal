export type DrawingCutType = 'floorplan' | 'section-x' | 'section-z';

export interface SectionCutOptions {
  cutType: DrawingCutType;
  position: number;       // Elevation for floor plan, X or Z position for section
  includeHiddenLines: boolean;
  includeProjection: boolean;
  includeEdges: boolean;
  mergeLines: boolean;
}

export interface DrawingExportConfig {
  format: 'dxf' | 'svg';
  fileName: string;
  crsComment?: string;
  units: 'm' | 'mm';
  showHiddenLines: boolean;
  showHatching: boolean;
}
