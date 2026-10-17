# Índice de Documentación Técnica — VisorGuBIMGal

**Sistema:** Visor BIM/GIS Web de código abierto y cliente puro (WebAssembly + WebGPU + Leaflet).  
**Propósito del índice:** Punto de entrada para descubrimiento progresivo de documentación (AI-ready).

---

## 1. Mapa de Descubrimiento Progresivo

| Documento | Alcance | Cuándo consultar |
|---|---|---|
| [`01_architecture_viewer.md`](./01_architecture_viewer.md) | Especificación del visor web, arquitectura hexagonal, contratos de dominio, MVP y casos de prueba. | Al implementar o modificar lógica de la app web, integración BIM/GIS, o planos 2D. |
| [`02_technical_risks.md`](./02_technical_risks.md) | Matriz de riesgos técnicos, limitaciones críticas de precisión (RTE/RTC), memoria y aislamiento WASM. | Antes de diseñar cambios que afecten a rendimiento, coordenadas grandes o hilos de ejecución. |
| [`03_sovereign_kernel_spec.md`](./03_sovereign_kernel_spec.md) | Especificación del kernel soberano en Rust/WASM (alternativa/evolución independiente de `@ifc-lite`). | Al trabajar en los crates del motor nativo en Rust (STEP parser, CSG, BVH). |
| [`04_team_distribution.md`](./04_team_distribution.md) | Asignación por squads para +10 desarrolladores en paralelo, límites de módulo y gobernanza. | Al distribuir tareas de desarrollo paralelo o acordar interfaces entre equipos. |

---

## 2. Resumen Técnico Rápido

- **Hosting:** Vercel (estático / SPA) con cabeceras `COOP: same-origin` y `COEP: credentialless`.
- **Motor BIM actual:** `@ifc-lite/parser` (Rust/WASM) + `@ifc-lite/geometry` (CSG) + `@ifc-lite/renderer` (WebGPU).
- **GIS 2D:** Leaflet + Proj4js (ETRS89 / UTM 29N `EPSG:25829` a WGS84 `EPSG:4326`) + WMS PNOA IGN.
- **Exportación 2D:** `@ifc-lite/drawing-2d` (secciones y plantas arquitectónicas a SVG y DXF R12).
- **Estructura de código:** Arquitectura hexagonal en `src/` (`domain/`, `infrastructure/`, `ui/`).
