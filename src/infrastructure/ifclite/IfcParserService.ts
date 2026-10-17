import {
  IfcParser,
  extractGeoreferencing,
  type IfcDataStore
} from '@ifc-lite/parser';
import type {
  ModelId,
  ModelRecord,
  CoordinateReference,
  SelectedElementDetails,
  PropertySetItem
} from '../../domain/models/ModelRecord';
import { detectCrsFromText, utm29NToLatLng, DEFAULT_GALICIA_CENTER } from '../../domain/coordinates/Coordinates';

export class IfcParserService {
  private parser: IfcParser;
  private stores: Map<ModelId, IfcDataStore> = new Map();

  constructor() {
    this.parser = new IfcParser();
  }

  async parseModel(
    id: ModelId,
    file: File | { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> },
    onProgress?: (phase: string, percent: number) => void
  ): Promise<{ modelRecord: Partial<ModelRecord>; store: IfcDataStore }> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    onProgress?.('Analizando IFC', 10);

    const store = await this.parser.parseColumnar(bytes.buffer, {
      onProgress: (p) => {
        onProgress?.(p.phase, Math.min(95, p.percent));
      }
    });

    this.stores.set(id, store);

    // Schema and units
    const schema = store.schemaVersion || 'IFC';
    const unitScale = store.lengthUnitScale ?? 1.0;
    const units: 'm' | 'mm' = unitScale < 0.01 ? 'mm' : 'm';

    // Georeferencing
    let coordinateRef: CoordinateReference = {
      source: 'unknown',
      confidence: 'unknown',
      latLng: DEFAULT_GALICIA_CENTER
    };

    try {
      if (store.entities) {
        const georef = extractGeoreferencing(new Map(), new Map());
        if (georef.hasGeoreference && georef.projectedCRS) {
          const detected = detectCrsFromText(georef.projectedCRS.name, georef.projectedCRS.description);
          coordinateRef = {
            crsId: detected || georef.projectedCRS.name,
            source: 'ifc-map-conversion',
            confidence: detected ? 'verified' : 'unknown',
            localToMap: georef.transformMatrix,
            verticalDatum: georef.projectedCRS.verticalDatum
          };

          if (georef.mapConversion) {
            const pos = utm29NToLatLng(georef.mapConversion.eastings, georef.mapConversion.northings);
            coordinateRef.latLng = [pos.lat, pos.lng];
          }
        }
      }
    } catch {
      // Fallback georeferencing
    }

    const elementCount = store.entityCount || 0;

    const modelRecord: Partial<ModelRecord> = {
      id,
      fileName: file.name,
      fileSize: file.size,
      schema,
      units,
      elementCount,
      coordinateReference: coordinateRef,
      originalBytes: bytes
    };

    onProgress?.('Completado', 100);

    return { modelRecord, store };
  }

  getStore(modelId: ModelId): IfcDataStore | undefined {
    return this.stores.get(modelId);
  }

  removeStore(modelId: ModelId): void {
    this.stores.delete(modelId);
  }

  async getElementDetails(
    modelId: ModelId,
    modelName: string,
    expressId: number
  ): Promise<SelectedElementDetails | null> {
    const store = this.stores.get(modelId);
    if (!store) return null;

    try {
      const entity = store.getEntity ? store.getEntity(expressId) : null;
      const type = entity?.type || 'Elemento IFC';
      const attributes: Record<string, any> = {};

      if (entity?.attributes && Array.isArray(entity.attributes)) {
        entity.attributes.forEach((attr, idx) => {
          if (attr !== null && attr !== undefined) {
            attributes[`Atributo #${idx + 1}`] = String(attr);
          }
        });
      }

      // Extract property sets
      const rawPsets = store.getProperties ? await store.getProperties(expressId) : [];
      const propertySets: PropertySetItem[] = [];

      if (Array.isArray(rawPsets)) {
        for (const pset of rawPsets) {
          const props = Array.isArray(pset.properties)
            ? pset.properties.map((p: any) => ({
                name: p.name || 'Propiedad',
                value: p.value !== undefined ? p.value : p.nominalValue ?? '',
                type: p.type
              }))
            : [];

          propertySets.push({
            name: pset.name || 'Conjunto de Propiedades',
            globalId: pset.globalId,
            properties: props
          });
        }
      }

      const globalId = typeof entity?.attributes?.[0] === 'string' ? entity.attributes[0] : undefined;
      const name = typeof entity?.attributes?.[2] === 'string' ? entity.attributes[2] : undefined;

      return {
        modelId,
        modelName,
        expressId,
        globalId,
        type,
        name,
        attributes,
        propertySets
      };
    } catch (err) {
      console.error('Error fetching element details:', err);
      return null;
    }
  }

  getSpatialHierarchy(modelId: ModelId) {
    const store = this.stores.get(modelId);
    return store?.spatialHierarchy;
  }
}

export const ifcParserService = new IfcParserService();
