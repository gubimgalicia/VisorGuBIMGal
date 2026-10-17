export type ModelId = string;

export interface CoordinateReference {
  crsId?: string;                 // e.g. "EPSG:25829" or "EPSG:3857"
  source: 'ifc-map-conversion' | 'user-defined' | 'unknown';
  localToMap?: number[];          // 4x4 transform matrix
  verticalDatum?: string;
  confidence: 'verified' | 'user-supplied' | 'unknown';
  latLng?: [number, number];      // Approximate geographic anchor [lat, lng]
}

export interface ModelBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface ModelRecord {
  id: ModelId;
  fileName: string;
  fileSize: number;
  schema?: string;
  status: 'queued' | 'parsing' | 'rendering' | 'ready' | 'error';
  visible: boolean;
  color?: string;
  units: 'm' | 'mm' | 'unknown';
  elementCount: number;
  meshCount: number;
  coordinateReference?: CoordinateReference;
  errorMessage?: string;
  bounds?: ModelBounds;
  originalBytes?: Uint8Array;
}

export interface ElementRef {
  modelId: ModelId;
  expressId: number;
  globalId?: string;
}

export interface PropertyItem {
  name: string;
  value: string | number | boolean | null;
  type?: string;
}

export interface PropertySetItem {
  name: string;
  globalId?: string;
  properties: PropertyItem[];
}

export interface SelectedElementDetails {
  modelId: ModelId;
  modelName: string;
  expressId: number;
  globalId?: string;
  type: string;
  name?: string;
  attributes: Record<string, any>;
  propertySets: PropertySetItem[];
}
