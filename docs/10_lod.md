# 10 — Diseño: niveles de detalle para mallas lejanas y densas (A14)

**Estado:** borrador para revisión (T-167, revisión 1, 2026-11-20, Gemini). Sin código de implementación todavía; pendiente de revisión de Claude (`REQUEST` en `COORDINATION.md`).  
**Referencia:** fila A14 de [`docs/06_mejoras.md`](./06_mejoras.md), contrato v2 en [`docs/05_kernel_contract.md`](./05_kernel_contract.md) y diseño de instancias en [`docs/09_propuesta_instancias_compresion.md`](./09_propuesta_instancias_compresion.md).

---

## 1. Qué se midió

Mediciones sobre el kernel actual (`9c5f53e`, contrato v2 con A11 + A13) en los cinco modelos del banco (`test/models/bench`), con la cámara en su encuadre por defecto (`Camera.fitToBounds` + vista `iso`, lienzo `704 × 695` px, el mismo que `scripts/bench/frame-time.mjs` y las pruebas E2E en ventana `1400 × 900`). Registros crudos en `handoff/T-167/` (`measure-lod.log`, `shape-histograms.log`, `baseline-frame-time.log`).

### 1.1 Densidad en pantalla (triángulos por píxel) y distribución en los cinco modelos

Para cada registro plano y cada instancia visible se proyectaron en `f64` las 8 esquinas de su caja 3D en mundo (`Camera.project`), obteniendo su área proyectada en píxeles (`máx(1, w × h)`), su diagonal en píxeles y su densidad `tri/px = triángulos / áreaPx`.

| Modelo | Tamaño | Triángulos (inst. %) | Formas / inst. | Rangos dibujo inst. | % tri `> 1 tri/px` | % tri `> 5 tri/px` | % tri `< 10 px` diag. | `p50` / `p90` / `p99` `tri/px` | `p50` diag. (px) | GPU RAM (`gpu-bytes`) |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| `Clinic_Plumbing.ifc` | 55,8 MB | **3.423.664** (85,8 %) | 346 / 6.924 | 1.066 | **99,3 %** (85,8 % inst. + 13,5 % plan.) | **97,9 %** | **98,2 %** | 124 / 364 / 742 | **0,7 px** | 20,15 MB |
| `IFC Schependomlaan` | 65,1 MB | 258.817 (0,0 %) | 0 / 0 | 0 | 44,0 % (todo plano) | 32,7 % | 25,0 % | 0,11 / 8,63 / 140 | 24,8 px | 8,63 MB |
| `Clinic_Architectural.ifc` | 13,0 MB | 176.567 (34,1 %) | 202 / 1.583 | 208 | 61,5 % (19,1 % inst. + 42,3 % plan.) | 48,4 % | 49,1 % | 0,32 / 2,08 / 85,3 | 14,0 px | 8,08 MB |
| `1807_EP_AR_v18.ifc` (Esplanades) | 12,1 MB | 180.113 (64,7 %) | 689 / 7.873 | **1.790** | 36,0 % (34,6 % inst. + 1,4 % plan.) | 0,8 % | 29,7 % | 0,38 / 2,32 / 4,49 | 11,5 px | 2,71 MB |
| `Duplex_A_20110907.ifc` | 2,4 MB | 27.966 (57,4 %) | 63 / 226 | 63 | 20,9 % (todo inst.) | 0,0 % | 0,3 % | 0,10 / 0,55 / 3,24 | 31,5 px | 0,53 MB |

Al alejar la cámara 2× (`zoomBy(2)`), el porcentaje de triángulos con `> 1 tri/px` sube a 99,8 % en `Clinic_Plumbing`, 80,7 % en `Clinic_Architectural`, 67,3 % en `Schependomlaan` y 57,2 % en `Esplanades`.

### 1.2 Tiempos de fotograma de referencia (`scripts/bench/frame-time.mjs`, 40 fotogramas)

| Modelo | WebGPU sin aristas (mediana) | WebGPU `--edges` (mediana) | WebGL2 sin aristas (mediana) | WebGL2 `--edges` (mediana) |
|---|---:|---:|---:|---:|
| `Clinic_Plumbing.ifc` | **55,7 ms** | **102,6 ms** | **83,9 ms** | **47,8 ms** |
| `1807_EP_AR_v18.ifc` (Esplanades) | **47,6 ms** | **73,2 ms** | **93,3 ms** | **83,7 ms** |
| `Clinic_Architectural.ifc` | 31,8 ms | 17,9 ms | 11,1 ms | 10,0 ms |
| `IFC Schependomlaan` | 18,8 ms | 17,3 ms | 5,15 ms | 5,84 ms |
| `Duplex_A_20110907.ifc` | 16,1 ms | 16,2 ms | 1,91 ms | 2,49 ms |

*(Nota: en `Clinic_Plumbing` y `Clinic_Architectural` se observa dispersión térmica/de cola entre ejecuciones consecutivas en la GPU integrada; en la validación final se ejecutarán 3 repeticiones por configuración con la máquina en reposo como exige la aceptación.)*

### 1.3 Dónde están realmente los triángulos densos y de qué entidad IFC vienen

**Hallazgo 1 — `Clinic_Plumbing.ifc` concentra el 85,5 % de sus 3,42 M triángulos en 304 formas instanciadas (`≥ 64` triángulos), y el 47,0 % en solo 5 formas (`≥ 1.000` triángulos):**

| Umbral mínimo de triángulos por forma (`ShapeDef`) | Formas (`Clinic_Plumbing`) | Triángulos cubiertos (instanciados) | % del modelo entero | Memoria GPU actual de esas formas |
|---|---:|---:|---:|---:|
| `≥ 64` triángulos | 304 / 346 | 2.926.498 | **85,5 %** | 4,51 MB |
| `≥ 128` triángulos | 173 / 346 | 2.752.290 | **80,4 %** | 4,04 MB |
| `≥ 256` triángulos | 68 / 346 | 2.315.694 | **67,6 %** | 3,30 MB |
| `≥ 512` triángulos | 15 / 346 | 1.674.718 | **48,9 %** | 2,56 MB |
| `≥ 1.000` triángulos | **5** / 346 | 1.608.664 | **47,0 %** | 2,33 MB |

Las formas más densas de `Clinic_Plumbing.ifc` en la vista por defecto:

| `shapeId` | Clase / elemento de muestra | Tri./forma | Copias | Tri. totales (% modelo) | Diag. `p50` (px) | `p50` `tri/px` | Representación IFC en el archivo STEP |
|---:|---|---:|---:|---:|---:|---:|---|
| 334 | `IfcFlowController` — *Lavatory Faucet* | 17.377 | 42 | 729.834 (**21,3 %**) | 2,2 px | **7.054** | `IfcFaceBasedSurfaceModel` |
| 332 | `IfcFlowController` — *Kitchen Sink Faucet* | 18.055 | 34 | 613.870 (**17,9 %**) | 4,0 px | **2.324** | `IfcFaceBasedSurfaceModel` |
| 49 | `IfcFlowController` — *M_Ball Valve 50 mm* | 1.046 | 167 | 174.682 (**5,1 %**) | 1,9 px | **601** | `IfcFacetedBrep` |
| 97 | `IfcFlowFitting` — *M_Elbow - Generic* | 360 | 286 | 102.960 (3,0 %) | 0,6 px | **360** | `IfcFacetedBrep` |
| 184 / 185 | `IfcFlowFitting` — *M_Elbow - Generic* | 154 | 542 × 2 | 166.936 (4,9 %) | 0,3 px | **154** | `IfcFacetedBrep` |
| 312 | `IfcFlowTerminal` — *M_Water Closet* | 2.257 | 24 | 54.168 (1,6 %) | 8,4 px | **64,7** | `IfcFaceBasedSurfaceModel` |

**Hallazgo 2 — Las mallas densas son mallas explícitas pre-teseladas en el archivo IFC, no sólidos paramétricos:**
- Todas las formas principales de `Clinic_Plumbing` (grifos, válvulas, codos, sanitarios) vienen como `IfcFaceBasedSurfaceModel` o `IfcFacetedBrep` exportados ya triangulados/poligonizados desde Revit. Solo las tuberías rectas (`IfcFlowSegment`, 360 k triángulos = 10,5 % del modelo) usan `IfcExtrudedAreaSolid(IfcCircleProfileDef)`.
- El 100 % de `IFC Schependomlaan` (5.973 de 5.973 representaciones) son `IfcFacetedBrep`.

**Hallazgo 3 — `1807_EP_AR_v18.ifc` (Esplanades) está limitado por llamadas de dibujo, no por densidad de triángulos:**
- Esplanades tiene **0 formas con `≥ 64` triángulos** (todas sus 689 formas son prismas de 12–44 triángulos), pero genera **1.790 rangos de dibujo instanciados** (397 de ellos de una sola instancia). Por eso tarda 47,6–93,3 ms con solo 180 k triángulos, mientras `Schependomlaan` con 259 k triángulos en 4 lotes planos tarda 5,15 ms en WebGL2.
- Ningún algoritmo de LoD puede simplificar una caja de 12 triángulos: acelerar Esplanades corresponde a ajustar `MIN_INSTANCE_TRIANGLES` / `MIN_BATCH_INSTANCES` (ya dejado anotado en `crates/wasm-api/src/batches.rs:15-21`), fuera del alcance de A14 para no mezclar variables.

**Hallazgo 4 — Los modelos de referencia E2E no tienen formas densas:**
- `SimpleWall.ifc`, `bspline-surface.ifc` e `ifc4x3-infra-road.ifc`: 0 formas instanciadas.
- `ManySimpleWalls.ifc`: 6 formas, máximo **28 triángulos** (`[28, 28, 12, 28, 28, 12]`).

---

## 2. De dónde sale la malla gruesa

### 2.1 Por qué NO basta variar la tolerancia de teselación del kernel

Reducir `CIRCLE_SEGMENTS` (32), `PIPE_SEGMENTS` (12) o `ARC_TOLERANCE` (5 mm) en `crates/ifc-geometry/src/solids.rs` solo afecta a primitivos paramétricos (`IfcExtrudedAreaSolid` con arco/círculo, `IfcRevolvedAreaSolid`, `IfcSweptDiskSolid`, NURBS). Como demuestra §1.3, más del 85 % de los triángulos de `Clinic_Plumbing` y el 100 % de `Schependomlaan` llegan como `IfcFaceBasedSurfaceModel` o `IfcFacetedBrep` ya faceteados en el STEP: variar la tolerancia de teselación no reduciría ni un solo triángulo de los 1,34 M de grifos ni de los 1,33 M de codos y válvulas.

Por tanto, **la malla gruesa debe obtenerse mediante simplificación (decimación) de malla**.

### 2.2 Opción recomendada: simplificación de `ShapeDef` en el renderizador reutilizando los búferes de vértices

Se propone un módulo puro sin dependencias externas (`src/infrastructure/renderer/lodSimplify.ts`) invocado una sola vez cuando `addBatch()` registra por primera vez cada `ShapeDef` con `triCount >= LOD_MIN_SHAPE_TRIS` (`128` triángulos):

1. **Algoritmo: agrupación espacial adaptativa en rejilla (*vertex clustering*) sobre `shape.box`, con remapeo de índices sobre los vértices existentes:**
   - Se genera una rejilla uniforme $N \times N \times N$ sobre la caja `shape.box` (en coordenadas locales de la forma, decodificando `q16` directamente desde los enteros `u16` sin copiar la malla entera).
   - Para cada celda ocupada se elige un **único índice de vértice existente** (el más cercano al centroide de los vértices de esa celda) y se crea una tabla `remap[v] -> rep`.
   - Cada triángulo `(i0, i1, i2)` pasa a `(remap[i0], remap[i1], remap[i2])`: se descartan los degenerados (dos índices iguales) y los duplicados exactos `(min, mid, max)`.
   - **Cota de error geométrico exacta:** ningún vértice se desplaza más de una diagonal de celda respecto a su representante, por lo que el error geométrico en espacio de la forma está acotado analíticamente por:
     $$\varepsilon_{\text{local}} = \frac{\sqrt{3}}{2} \cdot \frac{\max(\Delta x, \Delta y, \Delta z)}{N}$$
   - Se construyen hasta **dos niveles gruesos** por forma densa, descartando cualquier nivel que no reduzca al menos el 40 % respecto al nivel superior:
     - **LOD1 (medio):** $N_1$ elegido para apuntar a ~20–25 % de triángulos (p. ej. $N_1 = 16$ para formas `< 2.000` tri., $N_1 = 24$ para `≥ 2.000` tri.).
     - **LOD2 (lejano):** $N_2$ más grueso (p. ej. $N_2 = 6$, mínimo 12 triángulos si existen) apuntando a ~3–8 % de triángulos (en los grifos de 17–18 k tri., reduce a ~300–600 tri., más de **30×**).
2. **Reutilización de búferes GPU:**
   - Como el remapeo solo selecciona vértices que ya existen en `shape.positions` y `shape.normals`, **no se crean nuevos búferes de vértices ni de normales, ni nuevos `GPUBindGroup`, ni nuevos VAOs, ni se recuantiza `q16`**.
   - Cada nivel LoD añade únicamente un `GPUBuffer` / `WebGLBuffer` de índices (`lodIndices`) y su `indexCount` + `errorLocal` en la estructura `GpuShape` del renderizador.
   - El tipo de índice (`uint16` vs `uint32`) coincide automáticamente con el de LOD0.
3. **Orientación y descarte de caras traseras (A8):**
   - La decimación de mallas `IfcFaceBasedSurfaceModel` (a menudo abiertas o no-manifold) puede producir caras sueltas o pequeñas inversiones locales. Por seguridad visual, los niveles LOD1 y LOD2 se dibujan siempre con el pipeline sin descarte de caras traseras (`cullMode: 'none'`, que ambos renderizadores ya tienen para mallas no cerradas), mientras LOD0 conserva intacto A8 (`cullMode: 'back'` cuando `shape.closed`).

### 2.3 Alternativas evaluadas

| Alternativa | Ventajas | Inconvenientes | Decisión |
|---|---|---|---|
| **A. *Vertex clustering* en `ShapeDef` (renderizador, TS puro)** *(recomendada)* | $O(V + T)$ (~5–15 ms totales al cargar `Clinic_Plumbing`); cota de error analítica exacta; tolerante a mallas no-manifold de Revit; **0 cambios de contrato (R4)**; `< 0,25 MB` GPU extra; `check-identical.mjs` intacto | Silueta menos fiel que QEM a tamaños intermedios (mitigado activando solo con `errorPx ≤ 1,5 px`) | **Recomendada para Fase 1** |
| **B. Colapso de aristas QEM (Garland–Heckbert) en `ShapeDef` (renderizador)** | Mejor preservación de siluetas a distancias medias (20–60 px); puede mantener orientación cerrada con filtro *fold-over* | $O(E \log E)$ con listas de adyacencia y cola de prioridad (~450 líneas); hay que soldar vértices duplicados de aristas vivas antes de colapsar; ~50–150 ms en JS | Alternativa viable si Claude prefiere mayor fidelidad en tamaños medios |
| **C. Simplificación en el kernel Rust/WASM (`ShapeDef.lods` en el contrato)** | Más rápida en CPU nativo/WASM; podría guardarse en la caché OPFS (`geometryCache.ts`) | Exige `CONTRACT_VERSION = 3`, `CACHE_FORMAT = 3`, actualizar `docs/05`, `findBatchError`, `expand-batch.mjs`, `check-equivalent.mjs` y `check-identical.mjs`; aumenta el tamaño transferido por `postMessage` | **Descartada para Fase 1** (coste de contrato injustificado para ahorrar ~10 ms de CPU) |
| **D. LoD también en lotes planos no instanciados** | Cubriría `Schependomlaan` (259 k tri.) y el 14,2 % plano de `Clinic_Plumbing` | `Schependomlaan` ya va a **5,15 ms** en WebGL2; simplificar un lote plano exige o romper la agrupación (de 4 a 5.973 llamadas) o duplicar todo el búfer de vértices preservando `recordIndex` por triángulo | **Fuera de Fase 1**; solo tendría sentido si aparece un modelo real no instanciado > 2 M tri. |

---

## 3. Dónde y cómo se elige el nivel de detalle

### 3.1 Granularidad: por rango `(lote, forma)` en cada fotograma

En ambos renderizadores, las instancias de cada lote ya están agrupadas por `(shapeId, transparent)` en `InstanceRange` (`src/infrastructure/renderer/instances.ts`), donde cada rango es una sola llamada `drawIndexed` / `drawElementsInstanced`.

- **Por qué NO global por forma:** si los 42 grifos de `Clinic_Plumbing` están repartidos por todo el hospital y el usuario acerca la cámara a un baño, una decisión global subiría los 42 grifos a LOD0 (o dejaría borroso el cercano).
- **Por qué NO por instancia individual:** obligaría a reordenar y resubir el búfer de instancias a la GPU en cada movimiento de cámara (o a partir cada rango en hasta 3 llamadas de dibujo por lote y forma).
- **Elección propuesta — por `InstanceRange` (por par lote + forma) una vez por fotograma:**
  - En `addBatch()`, al construir cada `InstanceRange`, se calculan y guardan dos valores en coordenadas de mundo (en `f64` respecto a `batch.origin`):
    1. `rangeMin`, `rangeMax`: la caja AABB que envuelve todas las instancias de ese rango.
    2. `maxStretch`: el estiramiento máximo (mayor módulo de columna de la parte lineal) de las instancias de ese rango.
  - En cada fotograma (`renderFrame()`), solo para los lotes que pasan el descarte por frustum (A6) y solo para rangos cuya forma tenga niveles LoD:
    1. Se calcula la distancia mínima `dMin` desde `camera.getEye()` a la caja AABB `[rangeMin, rangeMax]` del rango (`dMin = 0` si el ojo está dentro de la caja → siempre **LOD0**).
    2. Se convierte el error local de cada nivel LoD a píxeles en pantalla (`heightPx` = altura física del lienzo):
       - **Perspectiva:** $\text{errorPx} = \frac{\varepsilon_{\text{local}} \cdot \text{maxStretch}}{d_{\min}} \cdot \frac{\text{heightPx}}{2 \tan(\text{fovY}/2)}$
       - **Ortográfica:** $\text{errorPx} = \varepsilon_{\text{local}} \cdot \text{maxStretch} \cdot \frac{\text{heightPx}}{2 \cdot \text{halfH}}$
    3. **Selección con histéresis** (guardando `activeLod: 0 | 1 | 2` en cada rango para evitar parpadeo en el borde):
       - Para bajar a un nivel más grueso: $\text{errorPx} \le 1{,}5\text{ px}$ (LOD2 si cumple; si no, LOD1 si cumple; si no, LOD0).
       - Para volver a subir a un nivel más fino: solo cuando $\text{errorPx} > 1{,}75\text{ px}$ (banda de histéresis del ~17 %).
       - Si el rango está en un modelo o forma sin niveles gruesos, ni siquiera se ejecuta el cálculo.

Con ~300 rangos elegibles en `Clinic_Plumbing`, el cálculo por fotograma son ~300 distancias punto-AABB en JS: **< 0,03 ms de CPU por fotograma**, sin asignaciones de memoria.

### 3.2 Impacto esperado en triángulos dibujados (`Clinic_Plumbing.ifc` en vista por defecto)

- Las 173 formas con `≥ 128` triángulos suman **2.752.290 triángulos** (80,4 % del modelo), casi todas con diagonal `< 5 px` en la vista por defecto.
- Con LOD2 (~5–8 % de triángulos en las formas muy lejanas y ~20 % en las de tamaño medio), los triángulos instanciados bajan de **2,94 M** a **~0,35–0,55 M**, y el total dibujado del modelo de **3,42 M** a **~0,85–1,05 M** (reducción de **3,3× a 4×** en vértices e índices procesados por la GPU, manteniendo intactas las 1.066 llamadas de dibujo sin añadir ni una sola llamada extra).

---

## 4. Coste en memoria y en tiempo de carga

| Modelo | Formas elegibles (`≥ 128` tri.) | Índices LOD0 de esas formas | Memoria GPU extra estimada (LOD1 ~22 % + LOD2 ~6 % de índices) | % sobre GPU RAM actual | Coste CPU único en carga (estimado) |
|---|---:|---:|---:|---:|---:|
| `Clinic_Plumbing.ifc` | 173 | ~0,75 MB | **~0,21 MB** | **+1,0 %** (sobre 20,15 MB) | ~5–15 ms repartidos entre lotes |
| `Clinic_Architectural.ifc` | 18 | ~0,07 MB | **~0,02 MB** | +0,25 % (sobre 8,08 MB) | < 2 ms |
| `Duplex_A_20110907.ifc` | 8 | ~0,03 MB | **~0,01 MB** | +1,9 % (sobre 0,53 MB) | < 1 ms |
| `IFC Schependomlaan` | 0 | 0 MB | **0 MB** | 0,0 % | 0 ms |
| `1807_EP_AR_v18.ifc` (Esplanades) | 0 | 0 MB | **0 MB** | 0,0 % | 0 ms |

- Al llamar a `removeModel()`, los búferes de índices `lod1`/`lod2` de cada `GpuShape` se destruyen junto al `indexBuffer` de LOD0 y se descuentan de `allocatedGpuBytes` / `liveGpuBuffers` (TC-003b / TC-003c).
- En la vista `PerfMonitor` (`getDebugStats()`), no hace falta cambiar el contrato de `RendererPort`.

---

## 5. Impacto en el contrato (R4), selección y aristas (C17)

### 5.1 Contrato (R4)
- **No cambia el contrato.** `docs/05_kernel_contract.md`, `src/domain/kernel/GeometryBatch.ts` (`CONTRACT_VERSION = 2`), `KernelPort.ts`, `RendererPort.ts`, `crates/wasm-api` y la caché OPFS (`CACHE_FORMAT = 2`) permanecen intactos.
- `scripts/bench/check-identical.mjs` sigue siendo idéntico byte a byte por construcción, porque el kernel no se modifica.

### 5.2 Selección (`pickOnce` / `pickFirst`), pivote de órbita (T-139) y medición (C5)
- **El pase de selección (`renderPick` / `pickOnce`) enlaza SIEMPRE LOD0** (`shape.indexBuffer`, detalle completo):
  1. La selección ya está podada al frustum de 1×1 píxel (A7, T-117), solo se ejecuta al pulsar o al mover el ratón en modo medición, y en WebGL2 ya es asíncrona mediante PBO + `fenceSync` (A15, T-163).
  2. Garantiza identidad exacta (`expressId`), profundidad reverse-Z exacta para el pivote de órbita (`resolveOrbitPivot`, T-139) y cero clics perdidos sobre válvulas o accesorios lejanos.
- La medición con ajuste a vértices y aristas (C5, `KernelPort.elementMesh`), la exportación GLB (C14) y los planos 2D (`cad-slicer`) usan la geometría del kernel en `f64` y no se ven afectados en absoluto.

### 5.3 Aristas (C17, `edges.ts`)
- Las aristas de C17 se calculan en espacio de pantalla a partir de la segunda diferencia de la textura de profundidad opaca (`EDGE_FRAGMENT_GLSL` / `EDGE_WGSL`), sin geometría adicional.
- Como el cambio a LOD1/LOD2 exige $\text{errorPx} \le 1{,}5\text{ px}$, el contorno exterior (`outline`, donde un vecino es fondo) se mantiene estable y las pendientes de profundidad no cambian de forma visible. De hecho, en accesorios de 17.000 triángulos proyectados en 2–4 px, eliminar triángulos subpíxel reduce el centelleo de aristas al orbitar.
- No se añade ninguna pasada ni variante de sombreador: `edges.ts` lee directamente el búfer de profundidad ya escrito por el pase opaco.

### 5.4 Imágenes de referencia E2E
- Como se verificó en §1.3 (Hallazgo 4), ningún modelo usado en `test/e2e` (`SimpleWall`, `ManySimpleWalls`, `bspline-surface`, `ifc4x3-infra-road`) tiene formas de `≥ 128` triángulos. Ninguna imagen de referencia E2E cambiará ni un solo píxel.

---

## 6. Plan de implementación y verificación (tras la aprobación)

1. **`src/infrastructure/renderer/lodSimplify.ts`:** simplificador puro sin dependencias (`buildShapeLods(shape, minTris)` + `chooseLodLevel(range, camera, heightPx, prevLevel)`), con pruebas unitarias en `test/t167-lod-test.mjs` (reducción efectiva, índices válidos dentro del rango de vértices, cota de error geométrico, histéresis al acercar/alejar, LOD0 garantizado con cámara dentro de la caja) y mutantes muertos.
2. **Integración en `WebGpuRenderer.ts` y `WebGl2Renderer.ts`:** subir los búferes de índices gruesos en `uploadShape`, guardar `rangeMin`/`rangeMax`/`maxStretch`/`activeLod` por rango, seleccionar el búfer de índices por fotograma en el pase opaco y transparente (usando pipeline sin culling en LOD > 0), **mantener LOD0 en el pase de selección**, y liberar los búferes en `removeModel`.
3. **Aceptación:**
   - `node scripts/bench/frame-time.mjs` (WebGPU y WebGL2, con y sin `--edges`), **3 ejecuciones cada uno con la máquina en reposo**, antes vs. después en `Clinic_Plumbing.ifc` (ganancia medible) y en `Duplex_A_20110907.ifc` / `IFC Schependomlaan` / `Clinic_Architectural.ifc` (sin regresión), guardando la salida cruda en `handoff/T-167/`.
   - `scripts/bench/check-identical.mjs` pasa al 100 %.
   - Todas las pruebas (`typecheck`, `build`, `test:unit`, `test:drawings`, `test:e2e`, `cargo clippy`, `cargo test`) en verde y sin modificar ninguna imagen de referencia E2E.

---

## 7. Puntos a confirmar por Claude antes de construir

1. **Origen y algoritmo:** ¿Apruebas generar los niveles LoD en el renderizador (TS puro, sin tocar el contrato v2 ni `check-identical.mjs`) mediante *vertex clustering* adaptativo reutilizando los búferes de vértices de `ShapeDef`, o prefieres QEM (Opción B) o generación en el kernel (contrato v3)?
2. **Umbral y niveles:** ¿Te parecen adecuados `LOD_MIN_SHAPE_TRIS = 128` (cubre el 80,4 % de `Clinic_Plumbing` y 0 % de los modelos E2E), dos niveles gruesos (LOD1 ~20–25 %, LOD2 ~5–8 %) y el umbral de error proyectado `1,5 px` con histéresis en `1,75 px`?
3. **Culling en LOD > 0:** ¿Confirmas dibujar LOD1 y LOD2 con `cullMode: 'none'` para evitar huecos si una malla `Closed` pierde orientación tras la agrupación, manteniendo A8 en LOD0?
4. **Esplanades (`1807_EP_AR_v18.ifc`):** Los datos confirman que sus 47–93 ms vienen de 1.790 rangos instanciados de 12–44 triángulos (`MIN_INSTANCE_TRIANGLES = 0`, `MIN_BATCH_INSTANCES = 1` en `batches.rs:17-21`), no de triángulos por píxel. ¿Lo dejamos separado de T-167 como tarea independiente de ajuste de A13 para no mezclar el efecto de A14?
