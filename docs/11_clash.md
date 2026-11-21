# 11 — Diseño de detección de interferencias (C22, T-168)

**Estado:** nota de diseño propuesta (T-168, rama `feat/clash-T-168`). Pendiente de revisión de Claude (R4: extensión aditiva de `KernelPort`).
**Alcance:** fila C22 de `docs/06_mejoras.md` y criterios de `GEMINI_HANDOFF.md` (T-168).

---

## 1. Medición base: `Clinic_Architectural.ifc` + `Clinic_Plumbing.ifc`

Medido sobre el kernel actual (`9e9c120`) excluyendo `IfcSpace` (`HiddenByDefault`):

| Modelo | Tamaño archivo | Elementos con malla | Vértices (`f64`) | Triángulos | Mallas completas en `f64` | Solo AABBs (52 B/elem) | Triángulos p50 / p95 / máx | Elemento más grande |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `Clinic_Architectural.ifc` | 13,00 MB | 2 586 | 96 692 | 176 567 | 4,44 MB | 131,3 KB | 12 / 152 / 5 945 | `IfcRailing` (0,146 MB) |
| `Clinic_Plumbing.ifc` | 55,83 MB | 6 587 | 1 531 471 | 3 423 664 | 77,84 MB | 334,5 KB | 176 / 1 046 / 18 055 | `IfcFlowController` (0,491 MB) |
| **Suma** | **68,83 MB** | **9 173** | **1 628 163** | **3 600 231** | **82,28 MB** | **465,8 KB** | — | — |

Pares candidatos tras fase ancha (solape de AABB) entre ambos modelos:

| Regla | Pares brutos ($N_A \times N_B$) | Holgura | Pares candidatos | Poda | Únicos A | Únicos B | Mallas de únicos (A+B) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Todos vs. todos | 17 033 982 | 0 mm | 2 565 | 99,985 % | 368 | 2 169 | 44,22 MB |
| Todos vs. todos | 17 033 982 | 50 mm | 3 579 | 99,979 % | 423 | 2 615 | 53,10 MB |
| Estructura (1 092) vs. tuberías (6 211) | 6 782 412 | 0 mm | 1 929 | 99,972 % | 234 | 1 746 | 8,72 MB |
| Estructura (1 092) vs. tuberías (6 211) | 6 782 412 | 50 mm | 2 542 | 99,963 % | 266 | 2 184 | 10,74 MB |

**Conclusión de la medición:**
- Cargar todas las mallas `f64` de ambos modelos a la vez consumiría >82 MB solo en buffers crudos (más BVH y sobrecarga WASM), y escalaría linealmente con modelos de 184+ MB (RSK-03).
- En cambio, **todas las AABB de ambos modelos caben en 465,8 KB**, y la fase ancha elimina >99,97 % de los pares.
- Además, en el caso asimétrico típico (`368` elementos arquitectónicos pequeños frente a `2 169` piezas de fontanería más densas), iterar el bucle externo sobre el conjunto con más elementos únicos y cachear el menor permite evaluar cada malla **una sola vez** con menos de **5 MB** de caché en el caso de la clínica.

---

## 2. Arquitectura entre Workers y presupuesto de memoria (D-014, RSK-03)

Se sigue el mismo patrón probado de `generateDrawing` (`Sheet` en su propio Worker efímero, `docs/05` §1 y §6), sin retener ninguna malla en el hilo principal y sin juntar dos modelos completos en una misma instancia WASM:

1. **Fase 1 — AABBs compactas en cada `ModelWorker`:**
   - El hilo principal resuelve los `expressId` de `setA` y `setB` a partir del `SpatialTree` ya cargado (filtrando por modelo, clases IFC y plantas, excluyendo `IfcSpace`).
   - A cada `ModelWorker` implicado se le piden solo las cajas `f64` de sus IDs seleccionados (`clash-bounds`): `4 B (expressId) + 48 B (min/max f64) = 52 B/elemento`.
   - Para `Clinic_Architectural` + `Clinic_Plumbing` son **465,8 KB** en total.

2. **Fase 2 — Fase ancha (BVH 3D) en un `ClashWorker` efímero:**
   - `WasmKernelAdapter` crea un único `ModelWorker` dedicado para la ejecución (`ClashEngine` en WASM) y lo termina en `finally` al concluir, devolviendo el 100 % de su memoria WASM al sistema.
   - `ClashEngine` construye una **BVH 3D de AABBs** (división por mediana en el eje más largo de centroides, hoja de hasta 8 cajas, iterativa con pila explícita para respetar la pila WASM de 1 MB) sobre el conjunto B y consulta cada caja del conjunto A expandida en `clearance_m` (en los 6 lados).
   - Se excluyen autopares `(modelId, id) == (modelId, id)` y, si un par aparece en ambos sentidos cuando `setA` y `setB` se solapan, se canonicaliza y deduplica por `(min(refA, refB), max(refA, refB))`.

3. **Fase 3 — Fase estrecha en streaming con caché LRU acotada (≤ 16 MB):**
   - Entre los pares candidatos, se elige como lado **externo** el que tiene más elementos únicos (en la clínica: fontanería, 2 169 elementos) y como lado **cacheado** el que tiene menos (arquitectura, 368 elementos).
   - Los pares se agrupan por elemento externo. Para cada elemento externo:
     1. Se solicita su malla cruda `f64` (`positions` + `indices`, sin aristas de medición) a su `ModelWorker`, se transfiere (`Transferable`, sin copia) al `ClashWorker` como malla activa temporal.
     2. Para cada candidato del lado cacheado que no esté aún en la caché LRU del `ClashWorker`, se solicita a su `ModelWorker` y se transfiere al `ClashWorker`. La caché LRU mantiene un tope estricto de **`MAX_CACHE_BYTES = 16 MiB`** (vértices + índices + BVH de triángulos); si se supera, expulsa las entradas menos usadas recientemente.
     3. Se ejecuta la prueba estrecha en Rust/WASM (`clash-detector`) sobre ambos triángulos/BVH en `f64`.
     4. Al terminar el grupo, se libera la malla activa externa.

### Presupuesto de memoria (Clinic Architectural + Clinic Plumbing)

| Componente | Memoria pico | Vida útil |
|---|---:|---|
| Hilo principal (`WasmKernelAdapter`) | ~0,7 MB (AABBs 466 KB + lista de pares + resultado) | Solo durante la ejecución; 0 bytes de mallas retenidas |
| `ClashWorker` — BVH fase ancha | ~0,6 MB | Liberada en `finally` (`worker.terminate()`) |
| `ClashWorker` — caché LRU + 1 malla activa | **≤ 16,5 MB** (~5 MB reales en clínica) | Liberada en `finally` (`worker.terminate()`) |
| `ModelWorker` existentes | Sin copia extra (reutilizan `query_evaluator`) | La vida de cada modelo abierto |

---

## 3. Algoritmos de fase estrecha (`crates/clash-detector`)

Se crea el crate puro de Rust `crates/clash-detector` (sin dependencias nuevas: solo `ifc-geometry` y `glam`, MIT/Apache-2.0):

1. **BVH de triángulos por malla:** construida bajo demanda al entrar en la fase estrecha, iterativa, con AABB `f64` por nodo.
2. **Choque duro (intersección estricta de interiores):**
   - Dos sólidos **no chocan si solo se tocan por caras coplanares, aristas o vértices** (tolerancia geométrica `EPS = 1e-6 m = 0,001 mm`).
   - Prueba triángulo-triángulo en `f64`:
     - Descarta triángulos degenerados o coplanares (un contacto coplanar puro de caras que se apoyan tiene penetración nula).
     - Calcula el segmento de intersección entre planos y comprueba si existe **cruce estricto interior** (un segmento interior de un triángulo perfora el interior del otro, o dos triángulos se cruzan con penetración `> EPS`).
   - **Contención total:** si las AABBs se solapan estrictamente (`overlap > EPS` en los 3 ejes) y ningún par de triángulos se cruza, se prueba un vértice de A dentro de B (y viceversa) mediante paridad de rayo sobre la BVH de triángulos, descartando puntos sobre la frontera (`dist <= EPS`).
3. **Profundidad y volumen mediante CSG propia (D-009):**
   - Solo se invoca `ifc_geometry::csg::intersect(&mesh_a, &mesh_b)` **cuando la fase de triángulos/contención ya confirmó un choque duro** y ambas mallas están cerradas y dentro del presupuesto BSP (`tris_a + tris_b <= 2 000` triángulos, para evitar bloqueos en válvulas muy teseladas).
   - Si la intersección CSG devuelve volumen `<= 1e-12 m³` (contacto rasante de volumen nulo entre sólidos cerrados), el par se descarta como falso positivo.
   - Con volumen positivo: `volume_m3 = inter.volume()`, `penetration_m = min(dx, dy, dz)` de la AABB de la intersección (exacto en cajas paralelas: 1 mm de solape → `0,001 m`), y `point` es el centroide de la intersección.
   - Si alguna malla es abierta o supera 2 000 triángulos (o CSG devuelve `TooComplex`), se mantiene el choque confirmado por triángulos y se estima `penetration_m` y `point` a partir de los segmentos de cruce (con `volume_m3 = None`).
4. **Choque blando (holgura `clearance_m > 0`):**
   - Solo se ejecuta cuando `clearance_m > 0` y no hubo choque duro.
   - Recorrido dual de las BVH de triángulos (`min_distance_sq`) con poda *branch-and-bound*: se podan pares de nodos cuya distancia mínima entre AABBs sea `>= min(best_sq, clearance_m²)`.
   - Distancia exacta triángulo-triángulo en `f64` (vértice-cara y arista-arista).
   - Si `min_dist < clearance_m - 1e-9`: se notifica choque blando con `gap_m = min_dist`, `penetration_m = 0`, y `point` = punto medio entre los dos puntos más cercanos.
   - Cuando `clearance_m == 0`, esta fase se omite, garantizando que caras tocándose (`gap = 0`) nunca sean choque.

---

## 4. Formato de reglas y flujo de interfaz (`ClashPanel.tsx`)

### Formato de regla (`src/domain/clash/ClashTypes.ts`)

```ts
export interface ClashFilter {
  /** ModelId concreto o '*' para todos los modelos cargados. */
  modelId: ModelId | '*';
  /** Clases IFC permitidas (vacío = todas excepto IfcSpace). */
  ifcClasses: string[];
  /** Nombres de planta permitidos (vacío = todas). */
  storeys: string[];
}

export interface ClashRule {
  name: string;
  setA: ClashFilter;
  setB: ClashFilter;
  /** 0 = solo choques duros; > 0 = choques duros + blandos hasta esta holgura en mm. */
  clearanceMm: number;
}
```

Se ofrecen plantillas rápidas en castellano (p. ej. «Todos contra todos», «Tuberías contra estructura», «Personalizada») y selección libre de modelo, clases IFC y plantas para cada conjunto, además de holgura en mm.

### Resultados y exportación a BCF («Clash»)
- Lista agrupada por par `(Elemento A ↔ Elemento B)`, ordenada por gravedad (choques duros por mayor penetración primero, luego blandos por menor holgura).
- Clic en un par: **aísla el par** (`DisplayTarget` de tipo `'search'` con los dos `ElementRef` — reutilizando el mecanismo existente de `displayRule.ts` sin tocar el renderizador), **colorea A en rojo y B en naranja** (vía `setElementColors`), y **encuadra la cámara** en la caja del par (`renderer.fitToBounds(clash.bounds, true)`).
- Botón **«Guardar como BCF»**: crea un tema BCF de tipo `'Clash'` en `BcfPanel` con título, descripción (elementos, tipo de choque, penetración/holgura y punto 3D) y un `BcfViewpoint` capturado tras aislar y encuadrar el par (con selección de ambos `GlobalId`, visibilidad aislada y miniatura PNG), listo para exportar a `.bcf` y reimportar en `BcfPanel`.

---

## 5. Cambio de contrato (R4)

- **Ningún cambio en `GeometryBatch.ts` (v2), `RendererPort.ts`, `DrawingTypes.ts` ni caché OPFS (`CACHE_FORMAT` 2).**
- **Extensión estrictamente aditiva en `KernelPort.ts`** (nuevo archivo `src/domain/clash/ClashTypes.ts` + método opcional en `KernelPort`):
  ```ts
  detectClashes?(request: ClashRequest, onProgress?: ProgressHandler): Promise<ClashReport>;
  ```
- **Límite interno WASM (`docs/05` §6, `crates/wasm-api`):**
  - `Model::element_bounds(&mut self, express_ids: Vec<u32>) -> Vec<f64>` (tuplas `[id, minX, minY, minZ, maxX, maxY, maxZ]`)
  - `Model::raw_element_mesh(&mut self, express_id: u32) -> Option<RawMeshView>` (`positions: Float64Array`, `indices: Uint32Array`, sin `edges`)
  - `ClashEngine` (`broad_phase`, `set_active_mesh`, `cache_mesh`, `test_pair`)
- **Licencias (R3):** cero dependencias nuevas.
