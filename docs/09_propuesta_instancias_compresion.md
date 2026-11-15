# 09 — Propuesta: instancias en GPU (A13) y compresión de vértices (A11)

**Estado:** propuesta, revisión 2 (2026-11-15), de Claude. La revisión 1 recogió de Gemini un ACK WITH CHANGES (T-147), con ocho hallazgos. Esta revisión incorpora los ocho; la sección 8 dice dónde queda cada uno. Cambia el contrato (`docs/05` secciones 3 y 6, `GeometryBatch.ts`, `CONTRACT_VERSION`), así que necesita el ack de Gemini a esta revisión y la aprobación de Nick antes de construir nada (R4). Cuando se apruebe, el texto normativo pasa a `docs/05` y este archivo queda como registro de la decisión.

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

Los índices de 16 bits, en los lotes y formas que caben en ellos, bajan algo más estas cifras; no se cuentan.

## 2. A13: formas compartidas e instancias

### Qué se instancia

Una pieza de un elemento se emite como instancia solo si se cumplen todas:

1. Sale de un `IfcMappedItem` cuya forma está en la caché de `instance_of`, sin diagnóstico.
2. Después de colocarla no se le aplica nada que cambie su forma: ni huecos (`IfcRelVoidsElement`), ni booleanos, ni sellado, ni reparto por `MAX_BATCH_RADIUS`.
3. La transformación final (destino del mapeo × colocación del objeto) es afín y finita, y su determinante cumple `det.is_normal() && det > 0.0`, la misma prueba que ya hace `model.rs`. Una copia reflejada invertiría el sentido de los triángulos, y una casi singular haría desbordar en `f32` la inversa traspuesta de las normales: las dos se expanden como hoy.
4. La caja de la forma transformada cabe dentro de `MAX_BATCH_RADIUS` alrededor de `batch.origin` (RSK-01). En un lote sin registros normales, el primer elemento instanciado fija `batch.origin`.
5. La forma se usa al menos `MIN_INSTANCE_USES` = 2 veces, contadas al abrir (abajo).

Todo lo demás se expande como hoy. Un elemento puede mezclar registros normales e instancias: el renderizador ya reúne los registros por `expressId`.

**Cómo se cuentan los usos.** La clave es la misma que usa `instance_of` para su caché: el `EntityId` del ítem geométrico hoja, no el `IfcMappedItem` ni el `IfcRepresentationMap`. Al abrir, después del índice STEP y antes del flujo, se recorre cada representación `Body` de cada producto. Cada `IfcMappedItem` se sigue hasta su mapa y sus `Items`, también a través de `IfcMappedItem` anidados (cada nivel multiplica los usos), y se suma un uso a cada ítem hoja. Se saltan los productos con `IfcRelVoidsElement`, porque la regla 2 los expandirá de todos modos. Las reglas 3 y 4 dependen de la colocación y solo se conocen en el flujo. Si una forma acaba con un único uso instanciado, sale como una instancia sola: correcto, aunque sin ahorro.

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
| `quantBox` | `{ min, max }` | Rejilla de `positions` en `q16`: la caja exacta de los vértices del lote, sin instancias (§3) |

`ShapeDef`: `{ shapeId, vertexFormat, positions, normals, indices, box, closed }`. Sus coordenadas son las de la forma (el sistema del `IfcRepresentationMap`), normalmente de tamaño de objeto, y `box` es su caja exacta y su rejilla si viaja en `q16`.

- `shapeId` es único en el flujo y empieza en 1. Una forma se envía una sola vez, en el primer lote que la usa. El renderizador la guarda por modelo hasta `removeModel`.
- La traslación de cada matriz es relativa a `batch.origin`, como las posiciones, así que no hay coordenadas absolutas en `f32` (RSK-01).
- **Dos cajas con dos funciones.** `box` sigue siendo la caja de todo lo que dibuja el lote: sus vértices y las cajas de sus formas transformadas. La usan el descarte por vista (A6) y el encuadre. `quantBox` es solo la rejilla de `positions`, así que unas pocas instancias dispersas por la planta no agrandan el paso de cuantización. En un lote sin instancias las dos cajas coinciden.
- Un lote puede no tener registros normales (`positions` y `meshTable` vacíos) y solo instancias. Los dos renderizadores lo suben salvo que `recordCount === 0 && instanceCount === 0`. Hoy lo descartan si `vertexCount === 0`, y perderían en silencio los lotes de solo instancias de la fontanería de la clínica o de bSDD.
- `meshCount` en `complete` cuenta registros e instancias.
- `findBatchError` valida además:
  - `shapeId` conocido o definido en el lote;
  - matrices finitas con determinante normal y positivo;
  - longitudes de tabla;
  - `positions` vacío solo si hay instancias;
  - `quantBox` igual al mínimo y máximo de los vértices decodificados;
  - `box` que contiene `quantBox` y las 8 esquinas de cada `shape.box` transformada.

  Hoy exige que `box` sea exactamente la caja de `positions`. Esa regla pasa a `quantBox`, y `box` conserva la igualdad solo si el lote no tiene instancias.

### Lo que cambia en el renderizador

- Un búfer de vértices e índices por forma, por modelo, y un búfer de instancias por lote.
- **Agrupación.** Al subir el lote, sus instancias se ordenan por `(shapeId, transparente)`, opacas primero. Para cada forma quedan como mucho dos rangos contiguos:
  - el pase opaco dibuja el primero, con el pipeline de cerrados si `shape.closed` y no hay planos de corte (A8);
  - el pase transparente dibuja el segundo;
  - el pase fantasma y el de selección dibujan los dos de una vez.
- **WebGPU.** Hoy `vs_main`, `vs_ghost` y `vs_pick` leen el índice de lote en `@builtin(instance_index)`, con `firstInstance = batchIdx` e `instanceCount = 1`. En un dibujo instanciado ese índice cambia con cada instancia.
  - Los datos por instancia (matriz, matriz normal, índice de registro y de lote) van en un búfer de almacenamiento por lote, indexado por `instance_index` desde `firstInstance` = inicio del rango.
  - Los sombreadores instanciados son variantes propias (`vs_main_inst`, `vs_ghost_inst`, `vs_pick_inst`) y reciben el lote en ese búfer. Los de los lotes normales no cambian.
- **WebGL2.** No hay `drawElementsInstancedBaseInstance` en WebGL 2.0 estándar, y el renderizador usa hoy un VAO global con los atributos 0 a 2 siempre activos.
  - El dibujo instanciado usa su propio VAO.
  - Los atributos por instancia llevan `vertexAttribDivisor(loc, 1)` y un desplazamiento en bytes en `vertexAttribPointer` por cada rango (lote, forma, pasada): son la matriz en 3 `vec4`, la matriz normal en 3 `vec3` y el índice de registro, 7 posiciones de atributo.
  - Como el VAO es aparte, al volver a los lotes normales no queda ningún divisor puesto.
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
- **Normales octaédricas sin `sign()`.** En WGSL y en GLSL ES 3.00, `sign(0.0)` devuelve 0. El pliegue del hemisferio `z < 0` anularía entonces una componente en las normales que caen sobre los planos `x = 0` o `y = 0`. La decodificación usa `select(-1.0, 1.0, v >= 0.0)` en WGSL y `(v >= 0.0 ? 1.0 : -1.0)` en GLSL, como ya hace `expand-batch.mjs`. Error angular por debajo de 0,01°.
- **Respaldo a `f32`, en lotes:** si el paso `(quantBox.max − quantBox.min) / 65535` de algún eje supera `MAX_QUANT_STEP` = **1 mm**, el lote viaja en `f32` como hoy. Con esa cifra se comprimen Schependomlaan *As Planned* (0,37 mm), Duplex (0,41 mm), Esplanades (0,92 mm) y la fontanería de la clínica (0,99 mm). En cambio, el peor lote de la arquitectura de la clínica (1,01 mm) y el de los 20.000 muros (1,22 mm) vuelven a `f32`, igual que la carretera y el puente.
- **Respaldo a `f32`, en formas:** el paso de una forma se multiplica en el mundo por el estiramiento de cada instancia, el mayor módulo de las columnas de su matriz, como ya calcula `expand-batch.mjs`. Una forma definida en [0, 1] e instanciada a escala 100 cumple el paso en local y no en el mundo.
  - La forma se decide en su primer uso: viaja en `q16` si `(shape.box.max − shape.box.min) × estiramiento / 65535 ≤ MAX_QUANT_STEP` en cada eje, con el estiramiento de esa primera instancia.
  - Una instancia posterior que, con su propio estiramiento, supere el paso no se instancia: se expande como geometría normal.
- **Alineación a 4 bytes.** Un `Uint16Array` de índices con un número impar de triángulos ocupa 2 bytes más que un múltiplo de 4:
  - En WebGPU, `createBuffer` y `writeBuffer` exigen múltiplos de 4, así que el renderizador redondea el tamaño hacia arriba al subirlo.
  - En la caché OPFS (`geometryCache.ts`), cada bloque binario empieza en un múltiplo de 4. Si no, el `Float32Array` o `Uint32Array` siguiente caería en un desplazamiento inválido (`RangeError`).
  - Las posiciones de 8 bytes y las normales de 4 ya están alineadas.
- **Error:** el error de posición es como mucho la mitad del paso, 0,5 mm en el peor caso permitido. Solo afecta a lo que se ve: la medición, el ajuste, los planos y la selección por profundidad usan el kernel o la profundidad del fragmento, con un error de 0,5 mm o menos. Puede haber grietas de hasta 1 mm entre lotes vecinos, que se ven solo con mucho zoom; dentro de un lote no hay, porque todos sus vértices usan la misma rejilla. Los planos de corte 3D descartan fragmentos sin dibujar tapa, así que la cuantización no abre huecos nuevos en ellos.
- `indices` es `Uint16Array` o `Uint32Array`, y el renderizador lo distingue por su tipo.

## 4. Lo que hay que cambiar

1. **Kernel** (`ifc-geometry`, `wasm-api/batches.rs`):
   - recuento de usos al abrir, por ítem hoja y a través de los mapeos anidados (§2);
   - `Closed` de cada forma en sus coordenadas;
   - separar las piezas que cumplen §2 y llevar la tabla de formas del flujo;
   - `quantBox`, la cuantización con el índice de registro en la cuarta componente y la elección de formato por lote y por forma.
2. **Límite WASM** (`BatchView`): `vertexFormat()`, `quantBox()`, `takeShapes`, `takeInstanceTable`, `takeInstanceTransforms`, y `takePositions` y `takeNormals` en el formato elegido. Sigue habiendo una sola copia (§6). Son los nombres que ya lee `scripts/bench/check-equivalent.mjs`, que gana `quantBox`.
3. **`GeometryBatch.ts`**: campos nuevos, `findBatchError` con las reglas de §2, `CONTRACT_VERSION` 1 → 2.
4. **Renderizadores** WebGPU y WebGL2:
   - formas por modelo y lotes de solo instancias;
   - instancias agrupadas por forma y transparencia;
   - sombreadores instanciados propios, con un búfer de almacenamiento en WebGPU y un VAO aparte con divisores en WebGL2;
   - decodificación en el sombreador, sin `sign()`, y normales normalizadas;
   - sin `recordIndexBuffer` en los lotes `q16`;
   - búferes de 16 bits redondeados a 4 bytes;
   - descarte por vista con `box`.
5. **Exportación a glTF y `App.tsx`**: `extractBatchElementMeta` y `batchMetaMap` leen también `instanceTable`.
6. **Caché OPFS** (`geometryCache.ts`): `CACHE_FORMAT` 1 → 2, con bloques alineados a 4 bytes. Las entradas antiguas se descartan solas, porque cambia la huella del kernel.
7. **Monitor de rendimiento**: cuenta formas e instancias.

## 5. Cómo se prueba

- **Kernel:** el flujo expandido de un lote instanciado (cada instancia multiplicada por su matriz) debe coincidir con el flujo de hoy, en cada registro, en los 258 modelos del censo. La herramienta ya existe (T-146).
  - Uso: `scripts/bench/check-equivalent.mjs <kernel de hoy> <kernel nuevo> <archivos>` expande los dos flujos con `expand-batch.mjs` y compara cada elemento con 0,05 mm más medio paso de 16 bits por lado, y las normales con 0,5°.
  - Probada: dos versiones iguales del kernel dan 0 mm y 0° en los modelos reales; un desplazamiento de 0,2 mm y un cambio de color se detectan, y uno de 0,01 mm no.
  - `test/t146-expand-test.mjs` prueba el formato v2 con lotes sintéticos (16 bits, octaédricas, forma más instancia con escala no uniforme) y mata 7 de 7 mutantes.
  - Para esta revisión: lee `quantBox` y la cuarta componente, y cuenta aparte las discrepancias de `Closed` por soldadura de vértices (§2).
- **Planos (D3):** los 28 casos, idénticos byte a byte, porque los planos no usan lotes.
- **Navegador (D1):** las 9 ejecuciones de `npm run test:e2e`. Las capturas cambian como mucho en el borde de los píxeles por la cuantización; si superan el 0,5 %, se mira la imagen y se decide. Comprobaciones nuevas:
  - el GLB exportado contiene un elemento que solo tiene instancias, con su color;
  - un lote de solo instancias se dibuja;
  - en WebGL2, un lote normal dibujado justo después de uno instanciado sale igual que sin él.
- **Caché:** ida y vuelta por OPFS de un lote con índices `Uint16Array` de longitud impar.
- **Rendimiento (D2):** banco con los modelos reales: memoria máxima y tiempo de carga. En el navegador, con el método de T-144: tiempo de GPU por fotograma en la fontanería de la clínica y en el modelo de 60.000 muros, antes y después, en los dos motores.
- **Mutantes**, cada uno con una prueba que lo mate:
  - determinante negativo aceptado, o casi singular aceptado;
  - matriz traspuesta;
  - normal sin inversa traspuesta, o sin normalizar;
  - `sign()` en la decodificación octaédrica;
  - paso de cuantización mal redondeado, o sin el estiramiento de la instancia;
  - índice de registro de una instancia desplazado en uno;
  - lote de solo instancias descartado;
  - glTF sin `instanceTable`;
  - divisor de WebGL2 sin restaurar;
  - índices de 16 bits sin rellenar a 4 bytes.

## 6. Orden propuesto

1. **A11 primero**, sola. Toca menos código, ataca el ancho de banda de vértices que midió A12, y reduce a algo más de la mitad todos los modelos del censo, también los 232 sin reutilización.
2. **A13 después**, con su propia ronda de pruebas.

`CONTRACT_VERSION` 2 define los dos desde el primer corte. Con A11 sola, el kernel emite `shapes: []`, `instanceTable` y `instanceTransforms` vacíos y `quantBox` igual a `box`. Así el contrato y `CACHE_FORMAT` cambian una sola vez, con una sola ronda de acks. Gemini está de acuerdo con este orden (T-147).

## 7. Preguntas abiertas, para Nick

1. **`MAX_QUANT_STEP` de 1 mm.** Gemini lo acepta (error máximo 0,5 mm, imperceptible a escala de edificio), a condición de los cambios de §3 sobre el estiramiento y `quantBox`, que ya están dentro. Queda confirmarlo.
2. **Infraestructura lineal y los lotes de 1,01 a 1,22 mm:** ¿volver a `f32`, como propone esta revisión, o partir los lotes hasta que quepan en 16 bits? Partirlos ahorra memoria en la carretera, el puente, la arquitectura de la clínica y los 20.000 muros, a cambio de más lotes y de tocar el reparto por `MAX_BATCH_RADIUS`.
3. **`MIN_INSTANCE_USES` = 2.** Gemini lo respalda con el censo: los 31 modelos de 1,00× quedan fuera del todo. Queda confirmarlo.

## 8. Cambios respecto a la revisión 1 (T-147)

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
