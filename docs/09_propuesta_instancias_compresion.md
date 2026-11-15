# 09 — Propuesta: instancias en GPU (A13) y compresión de vértices (A11)

**Estado:** propuesta, revisión 1 (2026-11-15), de Claude. Cambia el contrato (`docs/05` secciones 3 y 6, `GeometryBatch.ts`, `CONTRACT_VERSION`), así que necesita el ack de Gemini y la aprobación de Nick antes de construir nada (R4). Cuando se apruebe, el texto normativo pasa a `docs/05` y este archivo queda como registro de la decisión.

## 1. Qué se midió

Contadores temporales en la caché de representaciones mapeadas de `ModelEvaluator` (`instance_of`), con los lotes del flujo leídos en nativo. Rama `scratch/measure-a13-a11` (`d2b46de`), que no se fusiona. Modelos reales de buildingSMART (`scripts/models.json`) y tres modelos propios.

| Modelo | Triángulos | GPU hoy | Triángulos repetidos | Formas únicas / usos | Paso de 16 bits en el peor lote |
|---|---|---|---|---|---|
| Clínica, fontanería | 3,42 M | 227,4 MB | **83,1 %** | 732 / 6.580 | 0,99 mm |
| Esplanades | 185 k | 9,1 MB | 57,7 % | 689 / 7.184 | 0,92 mm |
| Clínica, arquitectura | 186 k | 10,9 MB | 49,3 % | 465 / 1.455 | 1,01 mm |
| Duplex | 29 k | 1,5 MB | 38,4 % | 75 / 164 | 0,41 mm |
| Schependomlaan | 259 k | 13,7 MB | 0 % | 0 / 0 | 0,37 mm |
| Carretera de 20 km (propia) | 40 k | 1,9 MB | 0 % | — | **62,8 mm** |
| Puente (propio) | 676 | — | 0 % | — | **5,8 mm** |
| 20.000 muros sintéticos | 1,6 M | 61,0 MB | 0 % | — | 1,22 mm |

- «Repetidos» son los triángulos servidos desde la caché: copias de una forma ya evaluada. Es una **cota superior**: una copia a la que luego se le resta un hueco ya no es la misma forma.
- La memoria de GPU cuenta posiciones, normales e índices en 32 bits y la tabla de registros.
- **A12** (T-144, Gemini) midió que, por encima de 16 ms por fotograma, lo que limita es leer vértices, no rellenar píxeles. A11 reduce justo eso a menos de la mitad.

Estimación, con las mismas cifras:

| Modelo | Hoy | Solo A13 | Solo A11 | A13 + A11 |
|---|---|---|---|---|
| Clínica, fontanería | 227 MB | ≈ 39 MB | 118 MB | ≈ 20 MB |
| Esplanades | 9,1 MB | ≈ 3,9 MB | 5,2 MB | ≈ 2,2 MB |
| Clínica, arquitectura | 10,9 MB | ≈ 5,5 MB | 5,8 MB | ≈ 2,9 MB |
| Schependomlaan | 13,7 MB | 13,7 MB | 7,5 MB | 7,5 MB |

## 2. A13: formas compartidas e instancias

### Qué se instancia

Una pieza de un elemento se emite como instancia solo si se cumplen todas:

1. Sale de un `IfcMappedItem` cuya forma está en la caché de `instance_of`, sin diagnóstico.
2. Después de colocarla no se le aplica nada que cambie su forma: ni huecos (`IfcRelVoidsElement`), ni booleanos, ni sellado, ni reparto por `MAX_BATCH_RADIUS`.
3. La transformación final (destino del mapeo × colocación del objeto) es afín, finita y con **determinante positivo**. Una copia reflejada invertiría el sentido de los triángulos: se expande como hoy.
4. La forma se usa al menos `MIN_INSTANCE_USES` veces en el modelo (propuesta: 2), contadas en el índice STEP al abrir, antes del flujo.

Todo lo demás se expande como hoy. Un elemento puede mezclar registros normales e instancias: el renderizador ya reúne los registros por `expressId`.

### Formato

`GeometryBatch` gana tres campos. Los existentes no cambian de significado.

| Campo | Tipo | Contenido |
|---|---|---|
| `shapes` | `ShapeDef[]` | Formas que este lote usa **por primera vez** en el flujo |
| `instanceTable` | `Uint32Array` | 4 palabras por instancia: `expressId, shapeId, rgba, flags` |
| `instanceTransforms` | `Float32Array` | 12 por instancia: matriz 3×4 por columnas, de coordenadas de forma a coordenadas locales de lote |

`ShapeDef`: `{ shapeId, positions, normals, indices, box, closed }`. Sus coordenadas son las de la forma (el sistema del `IfcRepresentationMap`), normalmente de tamaño de objeto.

- `shapeId` es único en el flujo y empieza en 1. Una forma se envía una sola vez, en el primer lote que la usa. El renderizador la guarda por modelo hasta `removeModel`.
- La traslación de cada matriz es relativa a `batch.origin`, como las posiciones, así que no hay coordenadas absolutas en `f32` (RSK-01).
- `box` del lote incluye las cajas de las formas transformadas, así que el descarte por vista (A6) sigue valiendo.
- Las banderas de una instancia son las de §3. `Closed` sale de la forma, porque una transformación de determinante positivo no cambia esa propiedad.
- `meshCount` en `complete` cuenta registros e instancias.
- `findBatchError` valida además: `shapeId` conocido o definido en el lote, matrices finitas con determinante positivo, longitudes de tabla.

### Lo que cambia en el renderizador

- Un búfer de vértices e índices por forma, por modelo, y un búfer de instancias por lote.
- Dibujo: una llamada instanciada por cada (lote, forma, pasada), separando opacos, transparentes y cerrados (A8), igual que hoy los registros.
- Las normales usan la inversa traspuesta de cada matriz, calculada en la CPU al subir el lote, 9 números más por instancia.
- Selección, colores por propiedad, BCF, ocultar, aislar, fantasma y planos de corte trabajan por registro: la tabla de registros del lote reserva un índice por instancia después de los registros normales, y el pase de selección escribe ese índice.
- El pase de selección y la profundidad de T-139 no cambian: escriben el índice del registro y la profundidad del fragmento.

### Lo que no cambia

El corte y los planos (`cad-slicer`), `elementMesh`, la medición, el ajuste a vértices y aristas, la exportación a glTF (T-138, que usa `elementMesh`) y los detalles trabajan con la geometría evaluada del kernel en `f64`, no con los lotes.

## 3. A11: posiciones de 16 bits, normales octaédricas, índices de 16 bits

| Dato | Hoy | Propuesta |
|---|---|---|
| Posición | 3 × `f32`, 12 bytes | 3 × `u16` normalizados a la caja del lote (o de la forma), 6 bytes |
| Normal | 3 × `f32`, 12 bytes | 2 × `i16` normalizados, codificación octaédrica, 4 bytes |
| Índice | `u32` | `u16` si el lote, o la forma, tiene como mucho 65.536 vértices |

- **Decodificación:** `posición = box.min + q × (box.max − box.min) / 65535` en el sombreador de vértices. La caja ya viaja con el lote y es exacta.
- **Respaldo a `f32`:** si el paso `(box.max − box.min) / 65535` de algún eje supera `MAX_QUANT_STEP`, el lote viaja en `f32` como hoy. Propuesta: **1 mm**. Con esa cifra se comprimen Schependomlaan (0,37 mm), Duplex (0,41 mm), Esplanades (0,92 mm) y la fontanería de la clínica (0,99 mm). En cambio, el peor lote de la arquitectura de la clínica (1,01 mm) y el de los 20.000 muros (1,22 mm) volverían a `f32`, igual que la carretera y el puente. Por eso la cifra final se fija con el sondeo de T-145. Alternativa a decidir: partir esos lotes más pequeños en vez de volver a `f32`.
- **Campo nuevo** `vertexFormat: 'f32' | 'q16'` por lote y por forma. `indices` es `Uint16Array` o `Uint32Array`, y el renderizador lo distingue por su tipo.
- **Error:** el error de posición es como mucho la mitad del paso, 0,5 mm en el peor caso permitido. Solo afecta a lo que se ve: la medición, el ajuste, los planos y la selección por profundidad usan el kernel o la profundidad del fragmento, con un error de 0,5 mm o menos. Puede haber grietas de hasta 1 mm entre lotes vecinos, que se ven solo con mucho zoom; dentro de un lote no hay, porque todos sus vértices usan la misma rejilla.
- Normales octaédricas de 2 × 16 bits: error angular por debajo de 0,01°.

## 4. Lo que hay que cambiar

1. **Kernel** (`ifc-geometry`, `wasm-api/batches.rs`): recuento de usos de cada forma al abrir; separar las piezas que cumplen §2; tabla de formas del flujo; cuantización y elección de formato por lote.
2. **Límite WASM** (`BatchView`): `vertexFormat()`, `takeShapes`, `takeInstanceTable`, `takeInstanceTransforms`, y `takePositions` y `takeNormals` en el formato elegido. Sigue habiendo una sola copia (§6). Son los nombres que ya lee `scripts/bench/check-equivalent.mjs`.
3. **`GeometryBatch.ts`**: campos nuevos, `findBatchError`, `CONTRACT_VERSION` 1 → 2.
4. **Renderizadores** WebGPU y WebGL2: formas por modelo, dibujo instanciado, decodificación en el sombreador, selección por índice de registro.
5. **Caché OPFS** (`geometryCache.ts`): `CACHE_FORMAT` 1 → 2. Las entradas antiguas se descartan solas, porque cambia la huella del kernel.
6. **Monitor de rendimiento**: cuenta formas e instancias.

## 5. Cómo se prueba

- **Antes de empezar:** el sondeo de T-145 da los usos de formas en los 285 modelos y fija `MIN_INSTANCE_USES` y `MAX_QUANT_STEP` con datos.
- **Kernel:** el flujo expandido de un lote instanciado (cada instancia multiplicada por su matriz) debe coincidir con el flujo de hoy, en cada registro, en los 285 modelos. La herramienta ya existe (T-146): `scripts/bench/check-equivalent.mjs <kernel de hoy> <kernel nuevo> <archivos>` expande los dos flujos con `expand-batch.mjs` y compara cada elemento con 0,05 mm más medio paso de 16 bits por lado, y las normales con 0,5°. Probada: dos versiones iguales del kernel dan 0 mm y 0° en los modelos reales; un desplazamiento de 0,2 mm y un cambio de color se detectan, y uno de 0,01 mm no. `test/t146-expand-test.mjs` prueba el formato v2 con lotes sintéticos (16 bits, octaédricas, forma más instancia con escala no uniforme) y mata 7 de 7 mutantes.
- **Planos (D3):** los 28 casos, idénticos byte a byte, porque los planos no usan lotes.
- **Navegador (D1):** las 9 ejecuciones de `npm run test:e2e`. Las capturas cambian como mucho en el borde de los píxeles por la cuantización; si superan el 0,5 %, se mira la imagen y se decide.
- **Rendimiento (D2):** banco con los modelos reales: memoria máxima y tiempo de carga. En el navegador, con el método de T-144: tiempo de GPU por fotograma en la fontanería de la clínica y en el modelo de 60.000 muros, antes y después, en los dos motores.
- **Mutantes:** determinante negativo aceptado, matriz traspuesta, normal sin inversa traspuesta, paso de cuantización mal redondeado, índice de registro de una instancia desplazado en uno.

## 6. Orden propuesto

1. **A11 primero**, sola: no depende del sondeo, toca menos código y es lo que más ayuda a que los fotogramas bajen de 16 ms.
2. **A13 después**, cuando el sondeo confirme los usos, con su propia ronda de pruebas.

Ambas entran en un mismo `CONTRACT_VERSION` 2, para una sola ronda de acks.

## 7. Preguntas abiertas

1. ¿`MAX_QUANT_STEP` de 1 mm, o más fino (0,5 mm) a cambio de más lotes en `f32`?
2. En infraestructura lineal: ¿volver a `f32`, o partir los lotes hasta que quepan en 16 bits?
3. `MIN_INSTANCE_USES` de 2, o más alto, para no crear llamadas de dibujo para formas que se usan pocas veces.
