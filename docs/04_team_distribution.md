# 04 — Plan de Trabajo Paralelo para Equipos (+10 Desarrolladores)

**Propósito:** Organización de tareas, propiedad de código y gobernanza técnica para desarrollo simultáneo sin bloqueos.

---

## 1. Principio Fundamental: Desarrollo Basado en Contratos (API-First)

1. **Límites de módulo inmutables:** Cada paquete (`crate` en Rust o directorio en `src/`) expone un contrato público tipado (`trait` o `interface`). Los desarrolladores programan contra interfaces y mocks, no contra implementaciones ajenas.
2. **Propiedad de código:** Cada squad tiene propiedad exclusiva de su módulo. Modificar un contrato público requiere consenso previo.
3. **Desarrollo desacoplado:** El frontend trabaja con mallas simuladas mientras el kernel de Rust procesa la geometría real.

---

## 2. Mapa de Squads y Roles

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        COORDINACIÓN GENERAL                            │
├───────────────────┬───────────────────┬────────────────────────────────┤
│  SQUAD 1: KERNEL  │  SQUAD 2: CAD 2D  │   SQUAD 3: GRÁFICOS Y BRIDGE   │
│  (Rust / WASM)    │  (Slicer & DXF)   │   (WebGPU / Memoria WASM)      │
│  Dev 01, 02, 03, 04│  Dev 05, 06       │   Dev 07, 08                   │
├───────────────────┴───────────────────┴────────────────────────────────┤
│  SQUAD 4: FRONTEND, GIS Y FEDERACIÓN  │  SQUAD 5: QA, CI/CD Y FIXTURES │
│  Dev 09, 10, 11                       │  Dev 12                        │
└───────────────────────────────────────┴────────────────────────────────┘
```

| Squad | Módulos exclusivos | Responsabilidades |
|---|---|---|
| **Squad 1: Kernel Rust** | `crates/step-parser/`<br>`crates/ifc-schema/`<br>`crates/ifc-geometry/`<br>`crates/spatial-tree/` | Lexer STEP ISO 10303-21, índice por Express ID, evaluación de perfiles/extrusiones y CSG de huecos. |
| **Squad 2: CAD 2D** | `crates/cad-slicer/`<br>`src/infrastructure/ifclite/IfcDrawingService.ts` | Algoritmo de corte planar, extracción de contornos cerrados, sombreados de material y exportador DXF R12. |
| **Squad 3: Gráficos** | `crates/wasm-api/`<br>`src/infrastructure/ifclite/BimEngine.ts` | Shaders WebGPU, gestión de buffers vertex/index, cámara CAD, culling y bridge de memoria zero-copy. |
| **Squad 4: Frontend & GIS** | `src/ui/`<br>`src/domain/`<br>`src/infrastructure/gis/` | UI React, federación multi-modelo, panel de propiedades, árbol espacial y mapas Leaflet con PNOA IGN. |
| **Squad 5: QA & CI/CD** | `test/`<br>`.github/workflows/`<br>`vercel.json` | Pruebas unitarias, fixtures IFC representativos, pipeline CI/CD en Vercel y validación visual. |

---

## 3. Flujo de Integración y Gobernanza

1. **Ramas por módulo:** Prefijos `feat/kernel-*`, `feat/cad-*`, `feat/graphics-*`, `feat/ui-*`.
2. **Requisitos de PR:** Debe compilar sin advertencias (`tsc --noEmit` y `cargo check`), pasar los tests unitarios del módulo y no romper contratos públicos.
3. **Sin dependencias circulares:** Cumplir estrictamente la arquitectura hexagonal de capas definida en [`01_architecture_viewer.md`](./01_architecture_viewer.md).
