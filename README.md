# VisorGuBIMGal — Visor BIM/GIS Web

Visor BIM y GIS de código abierto ejecutado íntegramente en el navegador (client-side), diseñado para abrir, federar e inspeccionar archivos IFC, contextualizarlos con información geoespacial y generar planos vectoriales exportables a DXF.

## Características principales

- **100% en el navegador (Client-side):** Procesamiento local de archivos IFC mediante el kernel soberano en WebAssembly (WASM). Los modelos no se transfieren a ningún servidor.
- **Federación visual:** Apertura e inspección simultánea de múltiples modelos IFC con identificación compuesta `(modelId + expressId)`.
- **Renderizado WebGPU propio:** Pipeline gráfico nativo de alto rendimiento con transmisión en streaming de mallas y lotes de geometría binaria.
- **Contexto GIS:** Visualización geoespacial con Leaflet (servicios WMS/WMTS) y soporte para globo 3D opcional con CesiumJS.
- **Planos 2D y exportación DXF:** Generación de plantas y secciones 2D reproducibles exportables a formato DXF (R12) y SVG mediante el motor de corte vectorial propio (`cad-slicer`).
- **Despliegue estático:** Preparado para Vercel con cabeceras `COOP` y `COEP` para soporte óptimo de multihilo en WASM.

## Pila tecnológica

- **Lenguaje y herramientas:** TypeScript, Vite, Rust (compilado a WASM con `wasm-bindgen`).
- **Motor BIM:** Kernel soberano propio en Rust/WASM (`crates/ifc-step`, `ifc-schema`, `ifc-geometry`, `spatial-tree`, `cad-slicer`, `wasm-api`) y renderizador WebGPU propio (`WebGpuRenderer`).
- **GIS 2D:** Leaflet (WMS/WMTS) + Proj4js (EPSG:25829 / UTM 29N a WGS84).
- **GIS 3D:** CesiumJS (módulo opcional).
- **Hosting objetivo:** Vercel.

## Documentación técnica

La documentación técnica completa, arquitectura y análisis de riesgos se organiza en [`docs/`](./docs/00_index.md):
- [Índice de documentación (AI-Ready)](./docs/00_index.md)
- [01 — Arquitectura y especificación del visor web](./docs/01_architecture_viewer.md)
- [02 — Análisis de riesgos técnicos y mitigaciones](./docs/02_technical_risks.md)
- [03 — Especificación del kernel BIM/CAD soberano (Rust/WASM)](./docs/03_sovereign_kernel_spec.md)
- [04 — Plan de trabajo paralelo para equipos (+10 devs)](./docs/04_team_distribution.md)
- [05 — Contrato del kernel y del renderizador](./docs/05_kernel_contract.md)

## Hoja de ruta

- [x] **Fase 0 (Spike técnico):** Validación de WebGPU/WASM, federación básica, planos 2D y despliegue en Vercel.
- [x] **Fase 1 (MVP BIM):** Kernel soberano en WASM, renderizador WebGPU, selector de modelos, árbol espacial y panel de propiedades.
- [x] **Fase 2 (Planos/DXF):** Generación de secciones reproducibles y descarga DXF/SVG con motor de corte `cad-slicer`.
- [x] **Fase 3 (GIS):** Integración con Leaflet y sincronización de coordenadas.
- [ ] **Fase 4 (Robustez y CI/CD):** Persistencia en IndexedDB, accesibilidad y despliegue continuo.

## Pruebas

- Exportación glTF/GLB (T-138): `node test/t138-gltf-test.mjs`

## Licencia

Código abierto bajo licencia MIT (o la que determine la organización GuBIM Galicia).
