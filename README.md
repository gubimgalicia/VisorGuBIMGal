# VisorGuBIMGal — Visor BIM/GIS Web y de Escritorio

Visor BIM y GIS de código abierto ejecutado íntegramente en local (client-side), diseñado para abrir, federar, inspeccionar y coordinar archivos IFC (`IFC2X3`, `IFC4` e `IFC4X3`), contextualizarlos en mapas GIS y generar planos vectoriales 2D exportables sin subir nunca los modelos a ningún servidor.

**Demo en vivo (GitHub Pages):** <https://nicknunes26.github.io/VisorGuBIMGal/>

## Características principales

- **100 % en local (Client-side):** Procesamiento íntegro de archivos IFC mediante nuestro kernel soberano en Rust/WebAssembly, con un Web Worker y una instancia WASM aislada por modelo y caché persistente de geometría en **OPFS** (hasta 2 GiB LRU). Ningún archivo ni geometría sale del equipo.
- **Federación multimodelo:** Apertura e inspección simultánea de múltiples modelos IFC con identidad compuesta `(modelId, expressId)`, árbol espacial, panel de propiedades/cantidades, búsqueda avanzada y diagnósticos de carga.
- **Renderizador propio WebGPU + WebGL2:** Pipeline gráfico nativo con respaldo automático a WebGL2, compresión de vértices (`q16`) y normales octaédricas, instanciación en GPU de formas repetidas, niveles de detalle adaptativos (LoD), descarte por frustum/caras traseras y aristas por profundidad.
- **Navegación, visualización y medición:** Órbita sobre el punto de superficie señalado, cubo de vistas, proyección perspectiva/ortográfica, recorrido por planta en primera persona con minimapa, corte 3D (plano, caja y por cara en cualquier ángulo), aislar/ocultar/fantasma, color por propiedad/clase/planta/material, vistas guardadas, monitor de rendimiento y mediciones en `f64` (distancia, desnivel, área, ángulo) con ajuste a vértices/aristas y exportación a CSV.
- **Planos 2D vectoriales (DXF, SVG y PDF):** Cortes en planta, sección y plano arbitrario por cara sobre modelos federados mediante el motor propio `cad-slicer`, con líneas ocultas, tramas por material, rótulos de espacios (`IfcSpace`) con área, cotas generales y exportación a DXF R12, SVG y PDF vectorial a escala (`1:50`, `1:100`, `1:200` en A4/A3) con aviso de desbordamiento.
- **Coordinación openBIM:**
  - **BCF 3.0 / 2.1:** importar y exportar temas, comentarios y puntos de vista 3D con miniatura PNG.
  - **IDS 1.0:** validación de especificaciones `.ids` de buildingSMART con aislamiento de incumplimientos.
  - **Comparación de modelos:** diferencias por `GlobalId` (añadidos, eliminados, cambiados por tipo/nombre/propiedades/geometría) y vista coloreada.
  - **Detección de interferencias (Clash Detection):** choques duros y blandos (con holgura en mm) dentro de un modelo o entre modelos federados, reglas por clase IFC/planta, profundidad y volumen CSG, aislamiento de pares y guardado directo como incidencia BCF de tipo `Clash`.
  - **Exportación glTF/GLB:** exportación de la escena visible a `.glb` 2.0.
- **Contexto GIS 2D:** Mapa Leaflet con capas IGN PNOA (WMS) y OpenStreetMap, transformación geodésica con Proj4js (`IfcMapConversion` / UTM 29N `EPSG:25829` y otros CRS) y estado explícito sin conexión.
- **Interfaz en castellano con capa i18n:** Todos los textos salen del catálogo `src/ui/i18n/es.ts`, listo para añadir gallego e inglés.
- **Aplicación de escritorio Windows (experimental):** Carcasa Tauri v2 con apertura por doble clic en `.ifc`, instancia única, `FilePort` desacoplado en `composition.ts`, protocolo local para archivos grandes e instalador NSIS sin firmar (sustitución planificada en el siguiente sprint por una carcasa propia sin dependencias MPL-2.0, ver **E9**).

## Pila tecnológica

- **Frontend:** TypeScript, React 18, Vite 7.
- **Kernel soberano (Rust → WASM, `crates/`):**
  - `step-parser`: lector léxico e índice STEP ISO 10303-21.
  - `ifc-schema`: tablas de esquemas `IFC2X3`, `IFC4` e `IFC4X3`.
  - `spatial-tree`: árbol espacial, propiedades, cantidades, materiales y georreferenciación.
  - `ifc-geometry`: evaluación geométrica en `f64`, B-splines/NURBS, alineaciones IFC 4.3 y CSG propia.
  - `cad-slicer`: corte vectorial 2D, proyección con líneas ocultas (BVH), tramas, espacios, cotas y salida DXF R12 / SVG.
  - `clash-detector`: BVH 3D, fase estrecha triángulo-triángulo / distancia mínima en `f64` y volumen CSG.
  - `wasm-api`: fachada WebAssembly (`wasm-bindgen`).
- **Renderizado:** `WebGpuRenderer` y `WebGl2Renderer` propios (sin motores 3D externos).
- **GIS 2D:** Leaflet + Proj4js.
- **CI/CD y publicación:** GitHub Actions (`ci.yml`, `deploy-pages.yml` en GitHub Pages y `release-desktop.yml` bajo etiqueta `v*`).

## Desarrollo local y pruebas

Requisitos: Node.js 22+, Rust estable con el target `wasm32-unknown-unknown` y `wasm-bindgen-cli` (`0.2.130`).

```bash
npm install
npm run kernel        # Compila el kernel Rust a WASM y genera bindings en src/infrastructure/kernel/pkg/
npm run dev           # Servidor de desarrollo Vite
npm run build         # Compila kernel + verificación TypeScript + paquete web (dist/)
npm run typecheck     # Verificación de tipos TypeScript
```

### Batería de pruebas

```bash
npm run test:unit                                    # 16 suites unitarias en Node
npm run test:drawings                                # 32 pruebas de regresión visual y geométrica 2D (SVG/DXF/PDF)
npm run test:e2e                                     # 24 suites E2E en navegador (WebGPU, WebGL2 y sin adaptador)
npm run bench                                        # Banco de rendimiento del kernel (D2)
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                               # >500 pruebas unitarias y de integración en Rust
```

### Escritorio (Windows)

```bash
npm run build:desktop   # Paquete web con base relativa (./)
npm run desktop:build   # Compila el ejecutable e instalador NSIS sin firmar en src-tauri/target/release/bundle/nsis/
```

## Documentación técnica

La documentación técnica completa se organiza en [`docs/`](./docs/00_index.md):

- [Índice de documentación](./docs/00_index.md)
- [01 — Arquitectura y especificación del visor](./docs/01_architecture_viewer.md)
- [02 — Análisis de riesgos técnicos y mitigaciones](./docs/02_technical_risks.md)
- [03 — Especificación del kernel BIM/CAD soberano (Rust/WASM)](./docs/03_sovereign_kernel_spec.md)
- [04 — Plan de trabajo paralelo](./docs/04_team_distribution.md)
- [05 — Contrato del kernel y del renderizador](./docs/05_kernel_contract.md) (v2, revisión 12)
- [06 — Hoja de mejoras y estado del sprint](./docs/06_mejoras.md)
- [08 — Estudio de modelos reales](./docs/08_model_survey.md)
- [09 — Compresión de vértices e instanciación](./docs/09_propuesta_instancias_compresion.md)
- [10 — Niveles de detalle (A14)](./docs/10_lod.md)
- [11 — Detección de interferencias (C22)](./docs/11_clash.md)

## Hoja de ruta

- [x] **Fase 0 (Spike técnico):** Validación de WebGPU/WASM, federación básica y planos 2D.
- [x] **Fase 1 (MVP BIM):** Kernel soberano en Rust/WASM, renderizador WebGPU/WebGL2, federación, árbol espacial y panel de propiedades.
- [x] **Fase 2 (Planos y coordinación):** Cortes 2D (DXF R12, SVG, PDF vectorial), mediciones/CSV, BCF 3.0, IDS 1.0, comparación de modelos, exportación GLB y detección de interferencias.
- [x] **Fase 3 (GIS y rendimiento):** Integración Leaflet + Proj4js con estado sin conexión, caché OPFS, compresión `q16`, instanciación en GPU y LoD adaptativo.
- [x] **Fase 4a (CI/CD y caché local):** CI completo en GitHub Actions (`rust`, `licences`, `web`, `bench`, `browser`), despliegue continuo en GitHub Pages y caché de geometría en OPFS.
- [ ] **Siguiente sprint:**
  - **E9:** Sustituir Tauri por una carcasa de escritorio Windows propia en Rust puro (Win32 + WebView2, cero dependencias MPL-2.0).
  - Persistencia de sesión de trabajo en IndexedDB (vistas guardadas, incidencias BCF, reglas de choques y preferencias).
  - Auditoría de accesibilidad (navegación por teclado, `:focus-visible`, `aria-live` y contraste WCAG).
  - Idiomas adicionales (gallego e inglés, C18) sobre la capa i18n existente.

## Licencia y avisos

Los crates de Rust bajo `crates/` se distribuyen bajo `MIT OR Apache-2.0`. Consulta [NOTICE.md](./NOTICE.md) para los avisos legales completos y la atribución de los esquemas IFC de buildingSMART (excluidos de la licencia del proyecto).
