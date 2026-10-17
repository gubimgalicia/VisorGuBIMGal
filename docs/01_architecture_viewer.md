# 01 — Arquitectura y Especificación del Visor Web

**Estado:** Implementación base completada (Fase 0).  
**Objetivo:** Visor BIM/GIS de cliente puro en navegador, desplegable en Vercel sin backend propio.

---

## 1. Decisiones de Stack

| Área | Selección | Justificación |
|---|---|---|
| **BIM Core** | `@ifc-lite/*` | Parseo WASM columnar, streaming de mallas y cálculo geométrico. |
| **Render 3D** | WebGPU (vía `@ifc-lite/renderer`) | Alto rendimiento con buffers directos. Fallback WebGL para fase posterior. |
| **GIS 2D** | Leaflet + Proj4js | Ligero, soporte de capas WMS (PNOA IGN) y conversión UTM 29N (`EPSG:25829`). |
| **Planos 2D** | `@ifc-lite/drawing-2d` | Corte vectorial en plano Z/X, líneas ocultas, tramas y exportación a DXF R12 / SVG. |
| **UI** | React 18 + Vite 7 + TypeScript 5 | Componentes desacoplados, estilos CSS modulares y soporte de workers ES. |
| **Hosting** | Vercel | Dominio raíz (`/`), soporte de cabeceras `COOP/COEP` para multihilo WASM. |

---

## 2. Arquitectura Hexagonal (`src/`)

```text
src/
  domain/
    models/           # ModelId, ModelRecord, ElementRef, SelectedElementDetails
    coordinates/      # CRS, Proj4js (EPSG:25829 a 4326), georreferenciación
    drawings/         # Tipos neutros de plano 2D y opciones de exportación DXF
  infrastructure/
    ifclite/          # IfcParserService, BimEngine (WebGPU), IfcDrawingService
    gis/              # LeafletService (mapas base, marcadores y ortofoto IGN)
  ui/
    components/       # Header, Sidebar, ModelsPanel, SpatialTree, Properties, SectionDxf, GisMap
    viewer/           # BimViewer (canvas WebGPU, drag & drop)
    styles/           # index.css (tokens, dark mode, glassmorphism)
```

### Reglas de Dependencias
1. `domain/` no importa UI, ni librerías de infraestructura, ni APIs del navegador.
2. `infrastructure/` implementa los contratos de dominio y aísla las librerías externas.
3. `ui/` solo consume servicios de infraestructura y estado de dominio; no parsea IFC directamente.
4. Identidad compuesta obligatoria: los elementos se identifican por `(modelId, expressId)` para evitar colisiones entre archivos federados.

---

## 3. Contratos de Dominio Principales

```typescript
type ModelId = string;

interface ModelRecord {
  id: ModelId;
  fileName: string;
  fileSize: number;
  schema?: string;
  status: 'queued' | 'parsing' | 'rendering' | 'ready' | 'error';
  visible: boolean;
  units: 'm' | 'mm' | 'unknown';
  elementCount: number;
  meshCount: number;
  coordinateReference?: CoordinateReference;
  bounds?: ModelBounds;
}

interface CoordinateReference {
  crsId?: string;                 // ej. "EPSG:25829"
  source: 'ifc-map-conversion' | 'user-defined' | 'unknown';
  localToMap?: number[];          // matriz 4x4
  latLng?: [number, number];      // [latitud, longitud]
}

interface SelectedElementDetails {
  modelId: ModelId;
  modelName: string;
  expressId: number;
  globalId?: string;
  type: string;
  name?: string;
  attributes: Record<string, any>;
  propertySets: PropertySetItem[];
}
```

---

## 4. Criterios de Aceptación (MVP)

- **TC-001:** Carga de un archivo `.ifc` local y visualización 3D en WebGPU.
- **TC-002:** Federación de dos o más modelos sin colisiones de selección por `expressId`.
- **TC-003:** Ocultar, mostrar y retirar modelos individualmente con liberación de GPU.
- **TC-004:** Selección de elemento 3D y visualización de sus Property Sets (Psets) y atributos.
- **TC-005:** Generación de plantas y secciones 2D reproducibles a partir de la geometría.
- **TC-006:** Exportación local de planos a formato **DXF (R12)** y **SVG**.
- **TC-007:** Posicionamiento en mapa GIS Leaflet con capa ortofoto PNOA y conversión UTM 29N.
- **TC-008:** Privacidad garantizada: ningún byte de los modelos sale del navegador a servidores externos.
