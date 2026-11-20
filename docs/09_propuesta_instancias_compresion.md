# 09 — Propuesta: instancias en GPU (A13) y compresión de vértices (A11)

**Estado:** aprobada por Nick el 2026-11-19, revisión 4, de Claude. **A11 está construida** (T-153) y el texto normativo de las dos mejoras está ya en `docs/05` revisión 10 (contrato v2), que manda sobre este archivo; A13 queda por construir. Lo que sigue es el registro de la propuesta. Las revisiones 1, 2 y 3 recogieron de Gemini sendos ACK WITH CHANGES: ocho hallazgos en T-147, cuatro en T-150, y un hallazgo más cuatro notas menores en T-151. Esta revisión incorpora todo; la sección 8 dice dónde queda cada punto. Nick ya decidió las preguntas de §7. Cambia el contrato (`docs/05` secciones 3 y 6, `GeometryBatch.ts`, `CONTRACT_VERSION`), así que necesitaba el ack final de Gemini a esta revisión, que dio en T-152 (2026-11-19), y necesita aún la aprobación de Nick antes de construir nada (R4). Cuando se apruebe, el texto normativo pasa a `docs/05` y este archivo queda como registro de la decisión.

## 1. Qué se midió

Contadores temporales en la caché de representaciones mapeadas de `ModelEvaluator` (`instance_of`), con los lotes del flujo leídos en nativo. Rama `scratch/measure-a13-a11` (`d2b46de`), que no se fusiona. Modelos reales de buildingSMART (`scripts/models.json`) y tres modelos propios.

| Modelo | Triángulos | GPU hoy | Triángulos repetidos | Formas únicas / usos | Paso de 16 bits en el peor lote |
|---|---|---|---|---|---|
| Clínica, fontanería | 3,42 M | 258,5 MB | **83,1 %** | 732 / 6.580 | 0,99 mm |
| Esplanades | 185 k | 10,2 MB | 57,7 % | 689 / 7.184 | 0,92 mm |
| Clínica, arquitectura | 186 k | 12,3 MB | 49,3 % | 465 / 1.455 | 1,01 mm |
| Duplex | 29 k | 1,7 MB | 38,4 % | 75 / 164 | 0,41 mm |
| Schependomlaan, *As Planned* | 259 k | 15,5 MB | 0 % | 0 / 0 | 0,37 mm |
| Carretera de 20 km (propia) | 40 k | 2,1 MB | 0 % | — | **62,8 mm** |
| Puente (propio) | 676 | — | 0 % | — | **5,8 mm** |
| 20.000 muros sintéticos | 1,6 M | 68,0 MB | 0 % | — | 1,22 mm |

- «Repetidos» son los triángulos servidos desde la caché: copias de una forma ya evaluada. Es una **cota superior**: una copia a la que luego se le resta un hueco ya no es la misma forma.
- La memoria de GPU cuenta posiciones, normales e índices en 32 bits, el índice de registro por vértice que el renderizador crea al subir el lote (`recordIndexBuffer`, 4 bytes) y la tabla de registros. La revisión 1 no contaba el índice de registro; por eso estas cifras son un 11–14 % más altas.
- **Schependomlaan:** el modelo del banco es `IFC Schependomlaan incl planningsdata.ifc` (la carpeta *As Planned*), que no tiene ni un `IfcMappedItem`. El 2,84× del censo (899 `IfcMappedItem` sobre 317 mapas) es el del modelo de diseño, `Design model IFC/IFC Schependomlaan.ifc`, que es otro archivo.
- **A12** (T-144, Gemini) midió que, por encima de 16 ms por fotograma, lo que limita es leer vértices, no rellenar píxeles. A11 reduce justo eso a algo más de la mitad.

**El censo de T-145** (`docs/08` §6, 258 archivos `.ifc`) da el panorama completo:

- 57 archivos usan `IfcMappedItem`. En **26** hay reutilización real: 30.803 `IfcMappedItem` sobre 3.646 mapas (8,45× de media). Destacan `chesapeake_bay_bridge_tunnel_4x3.ifc` (5.233 / 39, **134,18×**), `Clinic_Electrical.ifc` (2.995 / 64, 46,80×), `Molio_with_URIs.ifc` (2.293 / 112, 20,47×) y `Clinic_Plumbing.ifc` (3.703 / 384, 9,64×).
- Los otros **31** usan cada mapa una sola vez (1,00×). El caso extremo es `bSDD_references_example.ifc`: 16.373 mapas, cada uno usado una vez, 1,51 M triángulos. Sin un mínimo de usos, crearía 16.373 formas y unos 32.700 búferes de GPU, y pasaría de 23 llamadas de dibujo por lote a 16.373 llamadas de una instancia. Por eso existe `MIN_INSTANCE_USES` (§2, regla 5).

Estimación, con el formato de esta revisión (§3: posiciones de 8 bytes que llevan dentro el índice de registro, normales de 4 bytes, índices aún en 32 bits):

| Modelo | Hoy | Solo A13 | Solo A11 | A13 + A11 |
|---|---|---|---|---|
| Clínica, fontanería | 258,5 MB | ≈ 44 MB | 134 MB | ≈ 23 MB |
| Esplanades | 10,2 MB | ≈ 4,4 MB | 5,7 MB | ≈ 2,4 MB |
| Clínica, arquitectura | 12,3 MB | ≈ 6,2 MB | 6,6 MB | ≈ 3,3 MB |
| Schependomlaan, *As Planned* | 15,5 MB | 15,5 MB | 8,4 MB | 8,4 MB |

Los índices de 16 bits, en los lotes y formas que caben en ellos, bajan algo más estas cifras; no se cuentan. En sentido contrario, la estimación supone todos los lotes en `q16`: en la arquitectura de la clínica el peor lote (1,01 mm) vuelve a `f32`, así que sus 6,6 y 3,3 MB son algo optimistas.

## 2. A13: formas compartidas e instancias

### Qué se instancia

Una pieza de un elemento se emite como instancia solo si se cumplen todas:

1. Sale de un `IfcMappedItem` cuya forma está en la caché de `instance_of`, sin diagnóstico.
2. Después de colocarla no se le aplica nada que cambie su forma: ni huecos (`IfcRelVoidsElement`), ni booleanos, ni sellado, ni reparto por `MAX_BATCH_RADIUS`.
3. La transformación final (destino del mapeo × colocación del objeto) es afín y finita, y su determinante cumple `det.is_normal() && det > 0.0`, la misma prueba que ya hace `model.rs`. Una copia reflejada invertiría el sentido de los triángulos, y una casi singular haría desbordar en `f32` la inversa traspuesta de las normales: las dos se expanden como hoy.
4. La caja de la forma transformada cabe dentro de `MAX_BATCH_RADIUS` alrededor de `batch.origin` (RSK-01). En un lote sin registros normales, el primer elemento instanciado fija `batch.origin`.
5. La forma se usa al menos `MIN_INSTANCE_USES` = 2 veces, contadas al abrir (abajo).

Todo lo demás se expande como hoy. Un elemento puede mezclar registros normales e instancias: el renderizador ya reúne los registros por `expressId`.

**Cómo se cuentan los usos.** La clave es la misma que usa `instance_of` para su caché: el `EntityId` del ítem geométrico hoja, no el `IfcMappedItem` ni el `IfcRepresentationMap`. Al abrir, después del índice STEP y antes del flujo, el recuento recorre lo mismo que recorrerá el flujo, con las mismas funciones de `model.rs`:

- los productos de `element_ids()`, que ya excluye `IfcFeatureElementSubtraction` (un hueco con `IfcMappedItem` solo resta y nunca se dibuja), y de esos se saltan los que tienen huecos (`self.openings`), porque la regla 2 los expandirá de todos modos;
- de cada producto, la representación que elige `product_meshes`: la primera de `Body`, `Facetation` y `Mesh`;
- cada `IfcMappedItem` hasta su mapa y sus `Items`, también a través de `IfcMappedItem` anidados (cada nivel multiplica los usos), sumando un uso a cada ítem hoja;
- con las cotas del evaluador, por la pila de 1 MB de WASM (`docs/05` §1): `MAX_DEPTH` = 64 niveles, un conjunto de visitados por camino contra ciclos, y `MAX_ITEMS_PER_ELEMENT`. El recuento de cada mapa se memoriza, así que un grafo que comparte mapas se recorre una vez por mapa.

Las reglas 3 y 4 dependen de la colocación y solo se conocen en el flujo. Si una forma acaba con un único uso instanciado, sale como una instancia sola: correcto, aunque sin ahorro.

**Banderas.** `Degraded` y `HiddenByDefault` se aplican hoy al elemento entero. Una instancia hereda las de su elemento en la palabra `flags` de `instanceTable`, igual que un registro normal. `Closed` sale de la forma: `is_closed_outward()` se evalúa una sola vez, sobre la malla en coordenadas de la forma, al teselarla por primera vez. Una transformación con determinante positivo no cambia esa propiedad.

Hoy `Closed` se evalúa en cada copia ya colocada. Si el redondeo en `f64` de una copia suelda dos vértices casi coincidentes, el v1 y el v2 pueden discrepar en ese bit. `check-equivalent.mjs` cuenta esas discrepancias de `Closed` aparte, como una categoría conocida, y no las trata como fallos; cualquier otra diferencia de banderas sí es un fallo.

### Formato

`GeometryBatch` gana cinco campos. Los existentes no cambian de significado.

| Campo | Tipo | Contenido |
|---|---|---|
| `shapes` | `ShapeDef[]` | Formas que este lote usa **por primera vez** en el flujo |
| `instanceTable` | `Uint32Array` | 4 palabras por instancia: `expressId, shapeId, rgba, flags` |
| `instanceTransforms` | `Float32Array` | 12 por instancia: matriz 3×4 por columnas, de coordenadas de forma a coordenadas locales de lote |
| `vertexFormat` | `'f32' \| 'q16'` | Formato de `positions` y `normals` (§3) |
| `quantBox` | `{ min, max } \| null` | Rejilla de `positions` en `q16`: la caja exacta de los vértices del lote, sin instancias (§3). `null` si el lote no tiene vértices propios |

`ShapeDef`: `{ shapeId, vertexFormat, positions, normals, indices, box, closed }`. Sus coordenadas son las de la forma (el sistema del `IfcRepresentationMap`), normalmente de tamaño de objeto, y `box` es su caja exacta y su rejilla si viaja en `q16`.

- `shapeId` es único en el flujo y empieza en 1. Una forma se envía una sola vez, en el primer lote que la usa. El renderizador la guarda por modelo hasta `removeModel`.
- La traslación de cada matriz es relativa a `batch.origin`, como las posiciones, así que no hay coordenadas absolutas en `f32` (RSK-01).
- **Dos cajas con dos funciones.** `box` sigue siendo la caja de todo lo que dibuja el lote: sus vértices y las cajas de sus formas transformadas. La usan el descarte por vista (A6) y el encuadre. `quantBox` es solo la rejilla de `positions`, así que unas pocas instancias dispersas por la planta no agrandan el paso de cuantización. En un lote sin instancias las dos cajas coinciden.
- Un lote puede no tener registros normales (`positions` y `meshTable` vacíos) y solo instancias. Los dos renderizadores lo suben salvo que `recordCount === 0 && instanceCount === 0`. Hoy lo descartan si `vertexCount === 0`, y perderían en silencio los lotes de solo instancias de la fontanería de la clínica o de bSDD.
- `meshCount` en `complete` cuenta registros e instancias.
- **`findBatchError(batch, knownShapes?)`.** Una forma llega en el primer lote que la usa, y los siguientes solo la nombran, así que un lote suelto no basta para validarlas. La función gana un segundo argumento opcional, `knownShapes: ReadonlyMap<number, ShapeDef>`, con las formas ya recibidas de ese modelo. Sin él, solo se validan las formas definidas en el propio lote.
  - **Quién la llama.** `scripts/check-kernel.mjs` lleva `knownShapes` por modelo y lo pasa. Los renderizadores **no** la llaman al subir un lote: es una función para pruebas y datos simulados, fuera de la ruta caliente (`GeometryBatch.ts:67`), y solo la exponen en `__gubim_dev__`, en modo desarrollo. Siguen así. Las pruebas de navegador que la usan pasan el `knownShapes` del modelo, que el renderizador ya guarda para dibujar.

  Valida además:
  - `shapeId` definido en el lote o en `knownShapes`, y no definido dos veces;
  - matrices finitas con determinante normal y positivo, también en `f32`: `det = 1e-40` es normal en `f64` y subnormal en `f32`, y se rechaza;
  - longitudes de tabla;
  - `positions` vacío solo si hay instancias, y entonces `quantBox` es `null`;
  - `box`, `quantBox` y el `box` de cada forma: seis números finitos y `min ≤ max` en cada eje;
  - `quantBox` exacta sin comparar coma flotante: en `q16`, en cada eje con extensión, algún vértice tiene `q = 0` y alguno `q = 65535`; con extensión cero, todos tienen `q = 0`. En `f32`, `quantBox` es el mínimo y máximo de `positions`, como hoy la caja;
  - `shape.box` de cada forma definida en el lote, con la misma regla sobre los `positions` de la forma: entera en `q16`, mínimo y máximo en `f32`;
  - `box` que contiene `quantBox` (si no es `null`) y las 8 esquinas de cada `shape.box` transformada, con medio paso de holgura en las de `q16`.

  Hoy exige que `box` sea exactamente la caja de `positions`. Esa regla pasa a `quantBox`, y `box` conserva la igualdad solo si el lote no tiene instancias. En un lote de solo instancias, `box` es la caja de sus formas transformadas y no tiene por qué contener `batch.origin`.

### Lo que cambia en el renderizador

- Un búfer de vértices e índices por forma, por modelo, y un búfer de instancias por lote.
- **Agrupación.** Al subir el lote, sus instancias se ordenan por `(shapeId, transparente)`, opacas primero. Para cada forma quedan como mucho dos rangos contiguos:
  - el pase opaco dibuja el primero, con el pipeline de cerrados si `shape.closed` y no hay planos de corte (A8);
  - el pase transparente dibuja el segundo;
  - el pase fantasma y el de selección dibujan los dos de una vez.
- **Cuatro variantes de sombreador de vértices.** A11 cambia también los lotes normales: en `q16` la posición es `uint16x4` con el registro dentro, la normal `snorm16x2` y no hay `recordIndexBuffer`. Cada uno de `vs_main`, `vs_ghost` y `vs_pick` existe así en cuatro variantes: normal `f32` (la de hoy), normal `q16`, instanciada `f32` e instanciada `q16`. Las `q16` reciben la rejilla: `quantBox` en un lote normal, `shape.box` en una forma.
- **WebGPU.** Hoy `vs_main`, `vs_ghost` y `vs_pick` leen el índice de lote en `@builtin(instance_index)`, con `firstInstance = batchIdx` e `instanceCount = 1`. En un dibujo instanciado ese índice cambia con cada instancia.
  - Los lotes normales `q16` siguen leyendo el lote así. `BatchGpuData` crece de 16 a 48 bytes para llevar `quantBox.min` y `quantBox.max`.
  - Los datos por instancia (matriz, matriz normal e índice de registro) van en un búfer de almacenamiento por lote, en un `@group(1)` propio de los pipelines instanciados, con su `GPUPipelineLayout`. Ese layout comparte el `GPUBindGroupLayout` de `@group(0)`, así que `@group(0)` no cambia entre lotes normales e instanciados. Se indexa con `instance_index` desde `firstInstance` = inicio del rango. Los pipelines normales no cambian de layout.
  - **El índice de lote no va en la instancia.** `batchIdx` es la posición plana del lote en `batches[]` recorriendo todos los modelos, y se recalcula en cada fotograma (`WebGpuRenderer.ts:1279-1352`). Cambia cuando se quita un modelo y cuando los lotes de dos modelos llegan intercalados al cargar. Si se grabara en cada instancia al subir el lote, las instancias de otro modelo leerían el desplazamiento de cámara y el `recordBase` de otro lote, o se saldrían del búfer.
    - Por eso el búfer de instancias del lote empieza con una cabecera de 16 bytes cuyo primer `u32` es el `batchIdx`, seguida de las instancias. El sombreador lee `batches[cabecera.batchIdx]`.
    - El renderizador guarda en cada lote el último valor escrito, y escribe esos 4 bytes con `writeBuffer` solo si el valor cambió. Lo hace en un único sitio, `updateGpuSceneTables()`, que ya recorre todos los lotes de todos los modelos, sin descarte por vista, antes de dibujar (`renderFrame`) y antes de seleccionar (`pickOnce`). Así no se repite la comprobación en los bucles opaco, transparente, fantasma y de selección (T-152).
    - En WGSL, la cabecera es `batchIdx: u32` con relleno de tres `u32` (explícito o implícito), **nunca** `vec3<u32>`. Como `vec3<u32>` se alinea a 16, movería `instances` al byte 32. Con la instancia de §2 (3 `vec4<f32>` de filas, 3 `vec3<f32>` de matriz normal y un `u32` de registro), la instancia ocupa 96 bytes y `instances[0]` empieza en el byte 16 (T-152).
    - `writeBuffer` se ejecuta antes que cualquier `submit` posterior, así que todas las pasadas de un fotograma leen el índice de ese fotograma. Normalmente no se escribe nada: el índice solo cambia al quitar o añadir lotes.
    - Los lotes normales no cambian: siguen recibiendo el lote en `firstInstance`, con una sola instancia.
  - La rejilla de la forma (`shape.box`) va en el mismo `@group(1)`, en un uniforme por forma. Hay un `GPUBindGroup` por par (lote, forma) que el lote usa, y las formas `f32` reciben un uniforme de relleno con el mismo layout.
  - En un lote de solo instancias, `quantMin` y `quantMax` de su `BatchGpuData` quedan sin uso.
- **WebGL2.** No hay `drawElementsInstancedBaseInstance` en WebGL 2.0 estándar, y el renderizador usa hoy un VAO global con los atributos 0 a 2 siempre activos.
  - Un lote normal `q16` usa su propio VAO, sin el atributo 2: la posición entera (`vertexAttribIPointer`, `UNSIGNED_SHORT`, 4 componentes) ya trae el registro, y no queda ningún atributo apuntando a un búfer de registro inexistente o destruido. `quantBox` va en uniformes.
  - El dibujo instanciado usa también su propio VAO.
  - Los atributos por instancia llevan `vertexAttribDivisor(loc, 1)` y un desplazamiento en bytes por cada rango (lote, forma, pasada): son la matriz en 3 `vec4`, la matriz normal en 3 `vec3` y el índice de registro, 7 posiciones de atributo. Con la posición y la normal son 9, por debajo del mínimo de 16 de WebGL2. Los de coma flotante usan `vertexAttribPointer`; el índice de registro, que es `uint`, usa `vertexAttribIPointer`.
  - Como cada VAO es aparte, al volver a los lotes normales no queda ningún divisor puesto.
- **Matriz por filas en la GPU.** `instanceTransforms` viaja por columnas (4 columnas de 3 números) y eso no cambia: así la leen `expand-batch.mjs` y `check-equivalent.mjs`. Sin embargo, 3 atributos `vec4` necesitan las filas. El renderizador ya recorre cada instancia en la CPU al subir el lote, para calcular su matriz normal. En ese mismo recorrido traspone la matriz: la fila `i` es `(c0[i], c1[i], c2[i], c3[i])`, y la posición es `dot(fila_i, vec4(p, 1))`. Lo hace en los dos motores, para que WebGPU y WebGL2 lean la misma disposición.
- **Índices de 16 bits en el dibujo.** Hoy todo supone `u32`: `setIndexBuffer(…, 'uint32')` en WebGPU, y en WebGL2 `drawOpaque`, que dibuja con `gl.UNSIGNED_INT` y desplaza `culled * 4` bytes, e `indexGroups.ts`, que reparte los índices en grupos opacos y transparentes. Con un `Uint16Array` pasan a `'uint16'`, a `gl.UNSIGNED_SHORT` y a `culled * 2`, e `indexGroups.ts` produce grupos del mismo tipo que recibe.
- **Normales.** Usan la inversa traspuesta de cada matriz, calculada en la CPU al subir el lote. El sombreador de vértices normaliza la normal transformada, `normalize(normalMat * shapeNormal)`, **antes** de sacar `worldUpZ` y la normal de vista. Una instancia que pasa de mm a m tiene escala 0,001, y sin normalizar la normal saldría de longitud 1000: `worldUpZ` se saturaría y la interpolación entre vértices se deformaría.
- Selección, colores por propiedad, BCF, ocultar, aislar, fantasma y planos de corte trabajan por registro: la tabla de registros del lote reserva un índice por instancia después de los registros normales, y el pase de selección escribe ese índice.
- El pase de selección y la profundidad de T-139 no cambian: escriben el índice del registro y la profundidad del fragmento.

### Lo que también lee las instancias

La revisión 1 decía que la exportación a glTF no cambiaba, porque usa `elementMesh`. La geometría sí sale de `elementMesh`, pero la lista de elementos, su color base (`baseRgba`, que `elementMesh` no lleva) y `HiddenByDefault` se recogen del flujo en `App.tsx`, con `extractBatchElementMeta(event.batch.meshTable, batchMetaMap)`. Un elemento que solo tiene instancias, como un mueble, una tubería o una puerta repetidos, no está en `meshTable` y desaparecería del GLB. `extractBatchElementMeta` (`gltfExport.ts`) y `App.tsx` recorren también `batch.instanceTable`, con un paso de 4 palabras.

### Lo que no cambia

El corte y los planos (`cad-slicer`), `elementMesh`, la medición, el ajuste a vértices y aristas y los detalles trabajan con la geometría evaluada del kernel en `f64`, no con los lotes.

## 3. A11: posiciones de 16 bits, normales octaédricas, índices de 16 bits

| Dato | Hoy | Propuesta (`q16`) |
|---|---|---|
| Posición | 3 × `f32`, 12 bytes | 4 × `u16` (`uint16x4`), 8 bytes: x, y, z en la rejilla y, en lotes normales, el índice de registro en la cuarta |
| Índice de registro por vértice | `u32`, 4 bytes, creado por el renderizador | ninguno: va en la cuarta componente de la posición |
| Normal | 3 × `f32`, 12 bytes | 2 × `i16` (`snorm16x2`), codificación octaédrica, 4 bytes |
| Índice | `u32` | `u16` si el lote, o la forma, tiene como mucho 65.536 vértices |

- **Por qué 4 componentes y no 3.** WebGPU no tiene formatos de vértice de 3 × 16 bits (solo `x2` y `x4`), y exige que `arrayStride` sea múltiplo de 4: un paso de 6 bytes no valida. En WebGL2 sobre ANGLE/D3D11 tampoco existe un formato de 3 × 16 bits en hardware, y ANGLE expandiría el búfer en la CPU. La cuarta componente no se desperdicia: lleva el índice de registro del vértice dentro del lote, que hoy ocupa 4 bytes más por vértice en un búfer aparte. Un lote con más de 65.535 registros viaja en `f32`. En las formas compartidas la cuarta componente es 0, porque el registro sale de la instancia.
- **Decodificación:** `posición = quantBox.min + vec3(q.xyz) × (quantBox.max − quantBox.min) / 65535` en el sombreador de vértices, con `q` leído como enteros (`uint16x4` en WebGPU, `vertexAttribIPointer` en WebGL2). En una forma, con `shape.box`.
- **Normales octaédricas sin `sign()`.** En WGSL y en GLSL ES 3.00, `sign(0.0)` devuelve 0, no ±1 como pide el pliegue.
  - Donde importa es el **codificador** (`batches.rs`): una normal del hemisferio `z < 0` con `x = 0` o `y = 0`, como (0, 1/√2, −1/√2), se pliega con el signo de esa componente, y con `sign(0) = 0` se codifica mal.
  - En el decodificador de la GPU no puede ocurrir: con `snorm16x2`, x e y están en [−1, 1], y si una es 0, z = 1 − |x| − |y| no es negativo, así que la rama del pliegue no se alcanza.
  - Las dos partes usan aun así `select(-1.0, 1.0, v >= 0.0)` en WGSL, `(v >= 0.0 ? 1.0 : -1.0)` en GLSL y una comparación explícita en Rust, como ya hace `expand-batch.mjs`. Error angular por debajo de 0,01°.
- **Respaldo a `f32`, en lotes:** si el paso `(quantBox.max − quantBox.min) / 65535` de algún eje supera `MAX_QUANT_STEP` = **1 mm**, el lote viaja en `f32` como hoy. Con esa cifra se comprimen Schependomlaan *As Planned* (0,37 mm), Duplex (0,41 mm), Esplanades (0,92 mm) y la fontanería de la clínica (0,99 mm). En cambio, el peor lote de la arquitectura de la clínica (1,01 mm) y el de los 20.000 muros (1,22 mm) vuelven a `f32`, igual que la carretera y el puente.
- **Respaldo a `f32`, en formas:** el paso de una forma se multiplica en el mundo por el estiramiento de cada instancia, el mayor módulo de las columnas de su matriz, como ya calcula `expand-batch.mjs`. Una forma definida en [0, 1] e instanciada a escala 100 cumple el paso en local y no en el mundo.
  - La forma se decide en su primer uso: viaja en `q16` si `(shape.box.max − shape.box.min) × estiramiento / 65535 ≤ MAX_QUANT_STEP` en cada eje, con el estiramiento de esa primera instancia.
  - Una instancia posterior que, con su propio estiramiento, supere el paso no se instancia: se expande como geometría normal.
- **Alineación a 4 bytes.** Un `Uint16Array` de índices con un número impar de triángulos ocupa 2 bytes más que un múltiplo de 4:
  - En WebGPU, `createBuffer` y `writeBuffer` exigen múltiplos de 4, así que el renderizador redondea el tamaño hacia arriba al subirlo.
  - En la caché OPFS (`geometryCache.ts`), cada bloque binario empieza en un múltiplo de 4. Si no, el `Float32Array` o `Uint32Array` siguiente caería en un desplazamiento inválido (`RangeError`).
  - Las posiciones de 8 bytes y las normales de 4 ya están alineadas.
- **Error** (precisado en T-153: cada coordenada se mueve como mucho medio paso de su eje; un vértice, como mucho la longitud del vector de medios pasos, √3/2 mm): el error de posición es como mucho la mitad del paso, 0,5 mm en el peor caso permitido. Solo afecta a lo que se ve: la medición, el ajuste, los planos y la selección por profundidad usan el kernel o la profundidad del fragmento, con un error de 0,5 mm o menos. Puede haber grietas de hasta 1 mm entre lotes vecinos, que se ven solo con mucho zoom; dentro de un lote no hay, porque todos sus vértices usan la misma rejilla. Los planos de corte 3D descartan fragmentos sin dibujar tapa, así que la cuantización no abre huecos nuevos en ellos.
- `indices` es `Uint16Array` o `Uint32Array`, y el renderizador lo distingue por su tipo.

## 4. Lo que hay que cambiar

1. **Kernel** (`ifc-geometry`, `wasm-api/batches.rs`):
   - recuento de usos al abrir, por ítem hoja y a través de los mapeos anidados (§2);
   - `Closed` de cada forma en sus coordenadas;
   - separar las piezas que cumplen §2 y llevar la tabla de formas del flujo;
   - `quantBox`, la cuantización con el índice de registro en la cuarta componente y la elección de formato por lote y por forma.
2. **Límite WASM** (`BatchView`): `vertexFormat()`, `quantBox()`, `takeShapes`, `takeInstanceTable`, `takeInstanceTransforms`, y `takePositions` y `takeNormals` en el formato elegido. Sigue habiendo una sola copia (§6). Son los nombres que ya lee `scripts/bench/check-equivalent.mjs`.
3. **`GeometryBatch.ts`**: campos nuevos, `findBatchError(batch, knownShapes?)` con las reglas de §2, `CONTRACT_VERSION` 1 → 2.
4. **Renderizadores** WebGPU y WebGL2:
   - formas por modelo, con su registro `knownShapes`, y lotes de solo instancias;
   - instancias agrupadas por forma y transparencia;
   - las cuatro variantes de sombreador de §2; en WebGPU, `BatchGpuData` de 48 bytes y un `@group(1)` con su layout para los instanciados, con la cabecera de `batchIdx` reescrita solo cuando cambia;
   - matriz por instancia traspuesta a filas al subir el lote, en los dos motores; en WebGL2, VAO aparte para lotes `q16` y para instancias, con `vertexAttribIPointer` en los atributos enteros;
   - decodificación en el sombreador, sin `sign()`, y normales normalizadas;
   - sin `recordIndexBuffer` en los lotes `q16`;
   - índices de 16 bits: `'uint16'` en WebGPU, `UNSIGNED_SHORT` y `culled * 2` en `drawOpaque`, grupos del mismo tipo en `indexGroups.ts`, y búferes redondeados a 4 bytes;
   - descarte por vista con `box`.
5. **Exportación a glTF y `App.tsx`**: `extractBatchElementMeta` y `batchMetaMap` leen también `instanceTable`.
6. **Caché OPFS** (`geometryCache.ts`): `CACHE_FORMAT` 1 → 2, con bloques alineados a 4 bytes, y las formas y las dos tablas de instancias como bloques propios.
   - La cabecera del lote (hoy `BATCH_HEAD` = 80 bytes, con `origin` y `box`) guarda también `quantBox`, porque decodificar `q16` necesita la rejilla y no la caja.
   - Lleva además una palabra de banderas: `vertexFormat`, si el lote tiene `quantBox` (sin esa marca, un lote de solo instancias con `quantBox === null` no se distinguiría de una caja en cero), y si sus índices son de 16 bits.
   - Las entradas antiguas se descartan solas, porque cambia la huella del kernel.
7. **Herramientas que leen lotes:**
   - `scripts/check-kernel.mjs` lleva `knownShapes` por modelo y se lo pasa a `findBatchError`;
   - `scripts/bench/expand-batch.mjs` decodifica las posiciones de un lote `q16` con `quantBox`, no con `box`. Hoy usa `box`, que en la revisión 1 era la misma caja.
8. **Monitor de rendimiento**: cuenta formas e instancias.

## 5. Cómo se prueba

- **Kernel:** el flujo expandido de un lote instanciado (cada instancia multiplicada por su matriz) debe coincidir con el flujo de hoy, en cada registro, en los 258 modelos del censo. La herramienta ya existe (T-146).
  - Uso: `scripts/bench/check-equivalent.mjs <kernel de hoy> <kernel nuevo> <archivos>` expande los dos flujos con `expand-batch.mjs` y compara cada elemento con 0,05 mm más medio paso de 16 bits por lado, y las normales con 0,5°.
  - Probada: dos versiones iguales del kernel dan 0 mm y 0° en los modelos reales; un desplazamiento de 0,2 mm y un cambio de color se detectan, y uno de 0,01 mm no.
  - `test/t146-expand-test.mjs` prueba el formato v2 con lotes sintéticos (16 bits, octaédricas, forma más instancia con escala no uniforme) y mata 7 de 7 mutantes.
  - Para esta revisión: lee `quantBox` y la cuarta componente, y cuenta aparte las discrepancias de `Closed` por soldadura de vértices (§2).
  - **Paso en el mundo:** su tolerancia ya multiplica el medio paso por el estiramiento de cada instancia, así que por sí sola aceptaría una forma `q16` cuyo paso en el mundo pase de 1 mm. Por eso informa también, por instancia, del paso en el mundo, `(shape.box.max − shape.box.min) × estiramiento / 65535`, y falla si alguno supera `MAX_QUANT_STEP`.
- **Unidades del kernel y de `findBatchError`:**
  - una matriz con `det = 1e-40` se rechaza y su pieza se expande;
  - una forma cuyo paso por el estiramiento de la primera instancia pasa de 1 mm viaja en `f32`, y una instancia posterior que lo pase se expande;
  - `shapeId` desconocido sin `knownShapes`, y aceptado con él;
  - `quantBox` con un eje sin `q = 65535`, rechazada; lo mismo con el `box` de una forma `q16`;
  - una caja con un `NaN` o con `min > max` en un eje, rechazada;
  - un lote de solo instancias con `box` que no contiene su origen, aceptado;
  - el codificador octaédrico con (0, 1/√2, −1/√2) y (1/√2, 0, −1/√2).
- **Planos (D3):** los 28 casos, idénticos byte a byte, porque los planos no usan lotes.
- **Navegador (D1):** las 9 ejecuciones de `npm run test:e2e`. Las capturas cambian como mucho en el borde de los píxeles por la cuantización; si superan el 0,5 %, se mira la imagen y se decide. Comprobaciones nuevas, en los dos motores:
  - el GLB exportado contiene un elemento que solo tiene instancias, con su color;
  - un lote de solo instancias se dibuja;
  - en un lote mixto, dos instancias de la misma forma: seleccionar, colorear por propiedad y ocultar una no afecta a la otra ni a los registros normales. Esto mata el índice de registro desplazado en uno, que `check-equivalent.mjs` no puede ver;
  - una instancia con escala 0,001 se ilumina igual que su copia expandida. Esto mata la normal sin normalizar, que solo existe en el sombreador;
  - en WebGPU, subir un lote con índices `Uint16Array` de longitud impar;
  - en WebGL2, un lote normal dibujado justo después de uno instanciado sale igual que sin él;
  - **modelos que cambian de posición en `batches[]`:**
    - se cargan A y B, ambos con instancias, y se quita A: las instancias de B se siguen dibujando en su sitio, y seleccionarlas devuelve sus elementos;
    - lo mismo con los lotes de A y B llegando intercalados.

    Esto mata el `batchIdx` grabado en la instancia, que con un solo modelo no se nota.
- **Caché:** ida y vuelta por OPFS de un lote con índices `Uint16Array` de longitud impar, y de un lote de solo instancias (`quantBox === null`).
- **Rendimiento (D2):** banco con los modelos reales: memoria máxima y tiempo de carga. En el navegador, con el método de T-144: tiempo de GPU por fotograma en la fontanería de la clínica y en el modelo de 60.000 muros, antes y después, en los dos motores.
- **Mutantes**, cada uno con una prueba que lo mate:
  - determinante negativo aceptado, o casi singular aceptado;
  - matriz traspuesta;
  - normal sin inversa traspuesta, o sin normalizar;
  - `sign()` en el codificador octaédrico (en el decodificador de la GPU es equivalente, como explica §3);
  - paso de cuantización mal redondeado, o sin el estiramiento de la instancia;
  - índice de registro de una instancia desplazado en uno;
  - `batchIdx` escrito una sola vez al subir el lote, sin reescribirlo cuando cambia;
  - bandera de `quantBox` nula perdida en la caché;
  - lote de solo instancias descartado;
  - glTF sin `instanceTable`;
  - divisor de WebGL2 sin restaurar;
  - índices de 16 bits sin rellenar a 4 bytes.

## 6. Orden propuesto

1. **A11 primero**, sola. Toca menos código, ataca el ancho de banda de vértices que midió A12, y reduce a algo más de la mitad todos los modelos del censo, también los 232 sin reutilización.
2. **A13 después**, con su propia ronda de pruebas.

`CONTRACT_VERSION` 2 define los dos desde el primer corte. Con A11 sola, el kernel emite `shapes: []`, `instanceTable` y `instanceTransforms` vacíos y `quantBox` igual a `box`. Así el contrato y `CACHE_FORMAT` cambian una sola vez, con una sola ronda de acks. Gemini está de acuerdo con este orden (T-147).

## 7. Decisiones de Nick (2026-11-15)

1. **`MAX_QUANT_STEP` = 1 mm**, confirmado. Error máximo de posición 0,5 mm.
2. **Lotes que no caben en 16 bits** (infraestructura lineal, y los lotes de 1,01 a 1,22 mm): **vuelven a `f32`**, como propone §3. No se parten.
3. **`MIN_INSTANCE_USES` = 2**, confirmado.

## 7b. Medido tras construir A13 (T-158, 2026-11-20): memoria frente a tiempo de fotograma

**A13 tal como está aprobado no debe fusionarse sin decidir esto.** Reduce la memoria de GPU, pero en este equipo (Intel UHD 630) alarga el fotograma. Medido con `scripts/bench/frame-time.mjs` (WebGL2: consulta de tiempo de GPU; WebGPU: de inicio a `onSubmittedWorkDone`) y `scripts/bench/gpu-bytes.mjs`, con el mismo renderizador y el kernel con y sin instancias:

| Variante | Fontanería de la clínica: GPU, fotograma WebGL2 / WebGPU | Esplanades: GPU, fotograma WebGL2 / WebGPU |
|---|---|---|
| Sin instancias (A11 sola) | 139,7 MB, 19,9 / 26,3 ms | 5,9 MB, 2,2 / 6,0 ms |
| Revisión 4: toda forma con 2 usos o más | 20,2 MB, 38,4 / 34,7 ms | 2,7 MB, 14,9 / 17,8 ms |
| Solo formas de 32 triángulos o más | 20,5 MB, 38,6 ms / — | 5,1 MB, 3,1 ms / — |
| Solo formas de 128 triángulos o más | 24,9 MB, 36,3 / 30,6 ms | 5,9 MB, 2,2 / 6,5 ms |
| 4 copias o más de la forma en el mismo lote | 84,7 MB, 26,5 ms / — | 3,2 MB, 10,3 ms / — |
| 32 triángulos y 4 copias por lote | 84,7 MB, 27,9 ms / — | 5,2 MB, 3,0 ms / — |

- **Formas pequeñas:** cada rango de instancias es una llamada de dibujo. En Esplanades, 689 formas pequeñas con unas 11 copias cada una se convierten en miles de llamadas. Un mínimo de 32 triángulos por forma lo arregla (3,1 ms) y conserva casi todo el ahorro donde importa.
- **Formas grandes (fontanería):** con cualquier umbral el fotograma sigue un 35-90 % por encima. La causa más probable es lo que lee cada vértice instanciado: además de sus 12 bytes en `q16`, los 88 bytes de su instancia en WebGL2 (filas de la matriz, filas de la normal y registro), o 96 de almacenamiento en WebGPU. A12 midió que este hardware está limitado precisamente por la lectura de vértices.
- **Propuestas a evaluar (revisión 5):**
  1. Datos por instancia más ligeros: solo filas y registro (52 bytes), con la matriz normal calculada en el sombreador.
  2. Un mínimo de triángulos por forma, en torno a 32.
  3. Medir otra vez en una GPU dedicada antes de decidir.
- **Propuesta 1 probada en WebGL2** (52 bytes por instancia, matriz normal con `inverse` en el sombreador): fontanería de la clínica 38,4 → 27,6 ms, Esplanades 14,9 → 11,6 ms, con las 5 suites del navegador en verde en WebGL2 y sin adaptador. WebGPU sigue con 96 bytes.
- **Mandos en el código** (`crates/wasm-api/src/batches.rs`): `MIN_INSTANCE_TRIANGLES` (0) y `MIN_BATCH_INSTANCES` (1). Con esos valores la salida es idéntica byte a byte a la de la revisión 4 (`check-identical`, ahora también con formas e instancias).
- Decide Nick, tras la revisión de Gemini.

## 8. Cambios respecto a las revisiones anteriores

### Revisión 4: ACK de Gemini (T-152, 2026-11-19)

Gemini dio **ACK** a la revisión 4, sin hallazgos bloqueantes, y por resueltos todos los anteriores (T-147, T-150 y T-151). Dejó dos notas de implementación, que Claude comprobó en el código y añadió a §2 sin cambiar el diseño:

- la cabecera de `batchIdx` se actualiza solo en `updateGpuSceneTables()` (`WebGpuRenderer.ts:1252` antes de dibujar, `:1473` antes de seleccionar);
- relleno de la cabecera en WGSL con `u32`, no con `vec3<u32>`.

Dejó también una alternativa sin adoptar: un hueco estable por lote, con lista libre. Evitaría reescribir la cabecera, a cambio de dejar huecos de 48 bytes en `batchGpuBuffer`. No se adopta: la cabecera solo se reescribe cuando cambian los lotes, y la tabla de lotes sigue siendo densa.

### Revisión 3 → 4 (T-151)

Gemini dio por resueltos los hallazgos 1, 3 y 4 de T-150 y el 2 solo en parte, y por resueltos el 3 y el 7 de T-147, con el 5 aún en parte. Su único hallazgo nuevo cierra los que quedaban en parte (T-150 #2 y T-147 #5). Las notas menores también se recogen. Claude comprobó el hallazgo en el código: `batchIdx` se recalcula en cada fotograma en `WebGpuRenderer.ts:1279-1352`.

| # | Hallazgo o nota de Gemini | Dónde queda |
|---|---|---|
| 1 | `batchIdx` grabado en el búfer de instancias queda obsoleto al quitar un modelo o al intercalar lotes | §2, WebGPU: cabecera por lote con `batchIdx`, reescrita solo cuando cambia; §4.4; §5: dos pruebas de navegador y un mutante |
| a | Comprobación entera también para `shape.box` en `q16`, y cajas finitas con `min ≤ max` | §2, `findBatchError`; §5, unidades |
| b | La cabecera v2 de OPFS necesita una bandera para `quantBox === null` | §4.6: palabra de banderas; §5: ida y vuelta de un lote de solo instancias y un mutante |
| c | WebGL2 necesita trasponer `instanceTransforms` para leerla como 3 `vec4` | §2, «Matriz por filas en la GPU»: se traspone al subir el lote en los dos motores; el contrato sigue por columnas |
| d | Los renderizadores no llaman a `findBatchError` en la ruta caliente; solo la exponen en `__gubim_dev__` | §2, «Quién la llama»: sigue así |

### Revisión 2 → 3 (T-150)

Gemini dio por resueltos 5 de los 8 hallazgos de T-147 y por parcialmente resueltos el 3, el 5 y el 7. Sus cuatro hallazgos nuevos completan esos tres:

| # | Hallazgo de Gemini | Dónde queda |
|---|---|---|
| 1 | `findBatchError` sobre un lote suelto no ve las formas de lotes anteriores; `quantBox` en lotes sin vértices y comparada con igualdad estricta; faltan `check-kernel.mjs` y `expand-batch.mjs` | §2: `findBatchError(batch, knownShapes?)`, `quantBox` `null` y validada en enteros (`q = 0` y `q = 65535`); §4.6 y §4.7 |
| 2 | Los lotes normales `q16` también cambian de sombreador; `@group(1)` y layout en WebGPU; VAO `q16` y `vertexAttribIPointer` en WebGL2; índices `u16` en `drawOpaque` e `indexGroups.ts` | §2: cuatro variantes, WebGPU, WebGL2, índices de 16 bits; §4.4 |
| 3 | El recuento de usos no seguía a `model.rs`: solo `Body`, sin excluir `IfcFeatureElementSubtraction`, sin cotas de pila | §2, recuento de usos |
| 4 | Cinco mutantes sin prueba que los mate; el de `sign()` en el decodificador es equivalente | §5: unidades de kernel, paso en el mundo en `check-equivalent.mjs`, cuatro pruebas nuevas en D1; §3: `sign()` en el codificador |

### Revisión 1 → 2 (T-147)

| # | Hallazgo de Gemini | Dónde queda |
|---|---|---|
| 1 | No hay vértices de 3 × 16 bits en WebGPU, el paso debe ser múltiplo de 4, y ANGLE expande en la CPU; búferes y caché sin alinear | §3: 4 × `u16` con el índice de registro en la cuarta, relleno a 4 bytes en GPU y en OPFS |
| 2 | glTF y `App.tsx` perderían los elementos de solo instancias | §2 «Lo que también lee las instancias», §4.5, prueba en D1 |
| 3 | `box` hacía a la vez de caja de descarte y de rejilla; lotes de solo instancias descartados | §2: `box` y `quantBox` separados, regla de subida, `findBatchError` |
| 4 | El paso de una forma se multiplica por el estiramiento de la instancia | §3, respaldo en formas |
| 5 | `instance_index` deja de ser el lote en WebGPU; divisores y VAO en WebGL2; rangos por transparencia | §2 «Lo que cambia en el renderizador» |
| 6 | Normal transformada sin normalizar; `sign(0) = 0` en la decodificación | §2 Normales, §3 |
| 7 | Clave y anidamiento del recuento, `det.is_normal()`, `Closed` en coordenadas de forma, banderas y `MAX_BATCH_RADIUS` | §2 reglas 3 a 5, recuento, banderas |
| 8 | Datos del censo; el 0 % de Schependomlaan | §1: el censo, y el banco usa el modelo *As Planned*, sin `IfcMappedItem` |
