# Índice de Documentación Técnica — VisorGuBIMGal

**Sistema:** Visor BIM/GIS Web de código abierto y cliente puro (WebAssembly + WebGPU + Leaflet).  
**Propósito del índice:** Punto de entrada para descubrimiento progresivo de documentación (AI-ready).

---

## 1. Mapa de Descubrimiento Progresivo

| Documento | Alcance | Cuándo consultar |
|---|---|---|
| [`01_architecture_viewer.md`](./01_architecture_viewer.md) | Especificación del visor web, arquitectura hexagonal, contratos de dominio, MVP y casos de prueba. | Al implementar o modificar lógica de la app web, integración BIM/GIS, o planos 2D. |
| [`02_technical_risks.md`](./02_technical_risks.md) | Matriz de riesgos técnicos, limitaciones críticas de precisión (RTE/RTC), memoria y aislamiento WASM. | Antes de diseñar cambios que afecten a rendimiento, coordenadas grandes o hilos de ejecución. |
| [`03_sovereign_kernel_spec.md`](./03_sovereign_kernel_spec.md) | Especificación del kernel soberano en Rust/WASM. | Al trabajar en los crates del motor nativo en Rust (STEP parser, CSG, BVH). |
| [`04_team_distribution.md`](./04_team_distribution.md) | Asignación por squads para +10 desarrolladores en paralelo, límites de módulo y gobernanza. | Al distribuir tareas de desarrollo paralelo o acordar interfaces entre equipos. |
| [`05_kernel_contract.md`](./05_kernel_contract.md) | Contrato entre kernel, renderizador y aplicación: coordenadas, lotes binarios, identidad, planos 2D y límite WASM. | Antes de tocar cualquier código a ambos lados de ese límite. |
| [`06_mejoras.md`](./06_mejoras.md) | Lista de optimizaciones y nuevas funciones, con evidencia en el código y orden de trabajo. | Al terminar el visor básico, o al elegir la siguiente mejora. |
| [`08_model_survey.md`](./08_model_survey.md) | Estudio de calidad, diagnósticos, rendimiento, memoria y repetición de `IfcMappedItem` del kernel sobre los 285 modelos públicos de buildingSMART. | Al priorizar mejoras del kernel, analizar compatibilidad IFC o evaluar el impacto de instanciado GPU (A13). |
| [`09_propuesta_instancias_compresion.md`](./09_propuesta_instancias_compresion.md) | Propuesta de cambio de contrato para A13 (instancias en GPU) y A11 (vértices comprimidos), con las mediciones que la justifican. Revisión 4: pendiente del ack final de Gemini y de la aprobación de Nick. | Antes de tocar `GeometryBatch` o los renderizadores por A11 o A13. |

---

## 2. Resumen Técnico Rápido

- **Hosting:** Vercel (estático / SPA) con cabeceras `COOP: same-origin` y `COEP: credentialless`.
- **Motor BIM:** Kernel soberano propio en Rust/WASM (`crates/`) + renderizador WebGPU propio (`WebGpuRenderer`).
- **GIS 2D:** Leaflet + Proj4js (ETRS89 / UTM 29N `EPSG:25829` a WGS84 `EPSG:4326`) + WMS PNOA IGN.
- **Exportación 2D:** Generación nativa con `cad-slicer` en Rust/WASM (secciones y plantas arquitectónicas a SVG y DXF R12).
- **Estructura de código:** Arquitectura hexagonal en `src/` (`domain/`, `infrastructure/`, `ui/`).
