import type { KernelDiagnostic } from '../kernel/KernelPort';

export type ModelId = string;

export interface CoordinateReference {
  crsId?: string;                 // e.g. "EPSG:25829" or "EPSG:3857"
  source: 'ifc-map-conversion' | 'ifc-site' | 'user-defined' | 'unknown';
  localToMap?: number[];          // 4x4 column-major, model metres to map metres. See docs/05 section 2
  verticalDatum?: string;
  confidence: 'verified' | 'user-supplied' | 'unknown';   // 'verified' needs an exact CRS match
  latLng?: [number, number];      // Decimal degrees [lat, lng]
  crsName?: string;               // IfcProjectedCRS fields, as written in the file
  mapProjection?: string;
  mapZone?: string;
  mapUnit?: string;
  geodeticDatum?: string;
  trueNorth?: number;             // Degrees counter-clockwise from project +Y. Display only, never part of localToMap
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
  /** From opening the model and from its geometry stream, in that order. */
  diagnostics?: KernelDiagnostic[];
}

export interface ElementRef {
  modelId: ModelId;
  expressId: number;
  globalId?: string;
}

export type PropertyScalar = string | number | boolean | null;

/** JSON-safe encoding of one EXPRESS attribute value. */
export type AttributeValue =
  | PropertyScalar
  | { ref: number }
  | { enum: string }
  | { type: string; value: AttributeValue }
  | AttributeValue[];

export type PropertyValue =
  | { kind: 'single'; value: PropertyScalar }
  | { kind: 'enumerated'; values: PropertyScalar[] }
  | { kind: 'list'; values: PropertyScalar[] }
  | { kind: 'bounded'; lower?: PropertyScalar; upper?: PropertyScalar; setPoint?: PropertyScalar }
  | { kind: 'table'; defining: PropertyScalar[]; defined: PropertyScalar[] }
  | { kind: 'complex'; properties: PropertyItem[] };

export interface PropertyItem {
  name: string;
  value: PropertyScalar;          // Raw when single, never converted to SI. Otherwise for display: see `structured`
  type?: string;
  kind: 'property' | 'quantity';
  unit?: string;                  // Effective unit of `value`, when one is known
  structured?: PropertyValue;     // Present exactly when the value is not single
  methodOfMeasurement?: string;   // IfcElementQuantity.MethodOfMeasurement
}

export interface MaterialLayer {
  name?: string;
  thickness?: number;             // Metres
}

export interface MaterialProfile {
  name?: string;
  material?: string;
  profile?: string;
}

export interface MaterialConstituent {
  name?: string;
  material?: string;
  fraction?: number;
}

export interface MaterialInfo {
  kind: 'material' | 'layer-set' | 'profile-set' | 'constituent-set' | 'list';
  name?: string;
  layers?: MaterialLayer[];
  profiles?: MaterialProfile[];
  constituents?: MaterialConstituent[];
  source: 'instance' | 'type';    // An instance assignment wins over its type's
}

export interface TypeObjectRef {
  expressId: number;
  type: string;
  name?: string;
  globalId?: string;
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
  attributes: Record<string, AttributeValue>;
  propertySets: PropertySetItem[];
  typeObject?: TypeObjectRef;
  materials?: MaterialInfo[];
}
