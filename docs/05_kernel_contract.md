# 05 — Contrato del Kernel y del Renderizador

**Estado:** v2, revisión 10: `CONTRACT_VERSION` 2, con vértices comprimidos (A11) y formas compartidas por instancias (A13) en los lotes (secciones 3 y 6), según `docs/09` revisión 4, aceptada por Gemini en T-152 y aprobada por Nick el 2026-11-19. A11 está construida (T-153) y A13 también (T-158); la sección 7 dice qué prueba de A13 falta. La revisión 9 era la revisión 8 con la cota `level` de cada planta en el árbol espacial (sección 4, T-148; aceptada por Gemini en T-149). La revisión 8 era la revisión 7 con la bandera `Closed` de las mallas cerradas (sección 3, T-118). La revisión 7 era la revisión 6 con la caja de cada lote (`box`, sección 3, T-116). La revisión 6 era la revisión 5, que recogía la revisión de DeepSeek a la revisión 4, con dos aclaraciones de redacción de la sección 6 tras la revisión de Gemini. La versión 1 nunca se publicó; la 2 cambia el formato de los lotes, así que también la caché OPFS (`CACHE_FORMAT` 2). La sección 7 lista lo que el código aún no cumple.  
**Propósito:** Fuente única de los límites entre kernel, renderizador y aplicación.  
**Código normativo:** [`src/domain/kernel/`](../src/domain/kernel/), [`DrawingTypes.ts`](../src/domain/drawings/DrawingTypes.ts) y [`ModelRecord.ts`](../src/domain/models/ModelRecord.ts). Si este documento y los tipos discrepan, es un error que debe corregirse.

Cualquier cambio requiere aceptación previa de los otros dos agentes (regla R4 de `COORDINATION.md`) e incrementar `CONTRACT_VERSION` si rompe la compatibilidad.

---

## 1. Arquitectura

```text
Hilo principal                         Web Workers, sin memoria compartida
┌──────────────────────────┐           ┌──────────────────────────┐
│ UI React                 │           │ Worker de modelo A       │
│   │                      │  postMsg  │   wasm-api: Model        │
│ KernelPort (adaptador) ──┼──────────▶├──────────────────────────┤
│   │          ▲           │◀──────────┤ Worker de modelo B       │
│   ▼          │           │           │   wasm-api: Model        │
│ RendererPort (WebGPU)    │           ├──────────────────────────┤
└──────────────────────────┘           │ Worker de plano          │
                                       │   wasm-api: Sheet        │
                                       └──────────────────────────┘
```

1. La UI solo conoce `KernelPort` y `RendererPort`. Ningún tipo de implementación los atraviesa.
2. El kernel no conoce el renderizador. El renderizador no conoce IFC: recibe lotes e identidades.
3. La app conecta ambos: `for await` sobre `streamGeometry` y `addBatch` por cada lote.
4. Primera versión sin hilos WASM: cada instancia tiene un solo hilo y ningún Worker comparte memoria con otro. La concurrencia viene de usar un Worker por modelo y uno por plano (sección 6), no de `SharedArrayBuffer`. Los hilos WASM serán una optimización posterior, tras medir.

### Invariantes del kernel

- **Un elemento nunca hace fallar el modelo** (R8): se omite o se degrada, y se informa.
- **La pila WASM es de 1 MB**, mucho menor que la nativa. Ningún recorrido del kernel puede recurrir con la longitud del archivo: usa un límite de profundidad o una pila explícita, y en grafos un conjunto de visitados o un presupuesto de trabajo.
- **Al alcanzar un límite no se aborta.** En geometría y planos, el elemento se omite o se degrada con un diagnóstico. El árbol y los detalles no tienen canal de diagnósticos: la rama o la propiedad se omite sin más.
- **Una trampa WASM es un error del kernel**, nunca un comportamiento esperado. La operación rechaza con `internal` u `out-of-memory`, esa instancia queda inutilizable y la app debe cerrar su modelo. El resto de Workers no se ve afectado.

---

## 2. Coordenadas y unidades

| Sistema | Unidad | Precisión | Definición |
|---|---|---|---|
| **Modelo** | metros | `f64` | Coordenadas IFC tras aplicar unidades y ubicaciones. **Z arriba.** |
| **Local de lote** | metros | `f32` | `modelo − batch.origin`. Lo único que llega a los vértices. |
| **Mapa** | metros | `f64` | `localToMap × modelo`. |

### Origen por lote (RSK-01)

Cada lote lleva su propio `origin` en `f64`. No existe un origen por modelo: la geometría puede estar lejos de su ubicación (terrenos, alineaciones, coordenadas absolutas incrustadas), así que no se puede fijar antes de evaluarla.

- El origen de un lote es el centro de la caja del primer elemento, o pieza, que contiene, redondeado al metro, con la mitad alejándose de cero.
- Ningún vértice puede quedar a más de `MAX_BATCH_RADIUS` (4096 m) del origen. El kernel abre un lote nuevo cuando un elemento no cabe.
- Si un solo elemento supera ese radio alrededor del centro de su caja, el kernel lo reparte en piezas. Primero divide cada triángulo con un lado de más de 512 m en cuatro, por los puntos medios de sus lados, hasta que ninguno pase de 512 m. Luego agrupa los triángulos por la celda de 4096 m que contiene su centroide. Cada pieza conserva el `expressId`, las banderas y los colores del elemento, y viaja como un elemento más, así que un elemento repartido tiene registros en varios lotes. Ningún vértice de una pieza queda a más de unos 3844 m de su centro.
- Si repartirlo diera más de 2^20 triángulos, el elemento se emite entero en su propio lote, con la bandera `Degraded` y el diagnóstico `batch-radius-exceeded`.
- El renderizador calcula en la CPU, con `f64` y en cada fotograma, `batch.origin − cámara` para cada lote, y solo entonces pasa a `f32`. Ninguna coordenada absoluta llega a la GPU.
- El kernel conserva Z arriba, porque corte y GIS trabajan en ese espacio. La conversión a la convención de la cámara es interna del renderizador.

### Unidades

- `lengthUnitScale` se resuelve desde `IfcProject.UnitsInContext`. El prefijo de `IfcSIUnit` se aplica primero. En `IfcConversionBasedUnit`, `ConversionFactor` es un `IfcMeasureWithUnit`: el factor es `ValueComponent` por la escala de `UnitComponent`. Si falta la unidad, se asume metro, `lengthUnitSource` es `'default'` y se emite un aviso.
- `PLANEANGLEUNIT` se resuelve igual dentro de los crates del kernel.
- `AREAUNIT` y `VOLUMEUNIT` no se convierten: el kernel no usa ningún factor suyo, solo su etiqueta en `unit`. La etiqueta sigue la regla del SI, donde el prefijo afecta a la unidad antes de la potencia: `MILLI` con `SQUARE_METRE` es `mm²`, es decir 1e-6 m². Si algún día hace falta el factor, es el prefijo al cuadrado o al cubo, nunca el prefijo tal cual.
- Las longitudes de geometría, elevaciones y espesores de capa se entregan en metros.
- **Propiedades y cantidades conservan su valor bruto** y su unidad efectiva en `unit`. Nunca se convierten usando `lengthUnitScale`. La unidad sale de `IfcPropertySingleValue.Unit` o de `IfcPhysicalSimpleQuantity.Unit`; si falta, del tipo de medida a través de `UnitsInContext`. Si nada la resuelve, `unit` se omite sin diagnóstico: es normal en valores adimensionales, y los detalles no tienen canal de diagnósticos.
- `schema` es canónico (`IFC2X3`, `IFC4`, `IFC4X3`) y `schemaIdentifier` guarda el texto original. Cualquier otro esquema produce `unsupported-schema`.

### `localToMap`

Matriz 4×4 por columnas, de metros de modelo a metros de mapa, desde `IfcMapConversion`. La fórmula normativa de IFC trabaja en unidades del archivo y de mapa, así que el kernel la encierra entre dos conversiones:

```text
a = metros por unidad de longitud del archivo (lengthUnitScale)
b = metros por unidad de MapUnit; si falta, la unidad de longitud del proyecto
θ = atan2(XAxisOrdinate, XAxisAbscissa), con 0 si faltan ambos
λ = Scale; si falta, a/b
(x, y, z) = coordenadas de modelo en metros, divididas entre a

E = b·(λ·(x·cosθ − y·sinθ) + Eastings)
N = b·(λ·(x·sinθ + y·cosθ) + Northings)
H = b·(λ·z + OrthogonalHeight)
```

- `Scale` solo convierte unidades, de las del archivo a las del mapa. Los factores de cuadrícula están en `IfcMapConversionScaled.FactorX/Y/Z`. `Eastings`, `Northings` y `OrthogonalHeight` van en unidades de mapa.
- **Falta `Scale`.** IFC indica 1, pero exige el atributo cuando las unidades difieren. Si `a = b`, `λ = 1` con el diagnóstico `map-scale-default` (`info`). Si `a ≠ b`, `λ = a/b` con `map-scale-from-units` (`warning`), porque el valor 1 multiplicaría por mil un archivo en milímetros con mapa en metros.
- **Rotación incompleta.** Si solo está uno de los dos valores, o ambos son 0, `θ = 0` con `map-rotation-invalid` (`warning`). Si faltan los dos, `θ = 0` sin diagnóstico.
- **Conversión no válida.** Si `λ` o un factor no es finito o no es positivo, `localToMap` queda indefinido con `map-conversion-invalid` (`warning`). Un factor negativo reflejaría el modelo e invertiría el sentido de los lazos de corte.
- `IfcMapConversionScaled` sigue el orden `R·F·S`: los factores multiplican los ejes sin rotar (`λ·FactorX·x`, `λ·FactorY·y`, `λ·FactorZ·z`). Cualquier otro `IfcCoordinateOperation` emite un diagnóstico; nunca se usa la identidad en silencio.
- Prueba numérica de referencia en `crates/spatial-tree/tests/model_data.rs`. Fuente: `buildingSMART/IFC4.x-development`, `IfcMapConversion.md`, `IfcMapConversionScaled.md` e `IfcProjectedCRS.md`.
- `trueNorth` es informativo: nunca entra en `localToMap` ni se suma a él. IFC lo define así cuando hay conversión, y en caso de conflicto prevalece `IfcMapConversion`. Sin conversión no hay `localToMap`, y `trueNorth` tampoco crea uno. Es el ángulo en grados, antihorario, desde +Y del proyecto hasta `IfcGeometricRepresentationContext.TrueNorth`, y queda indefinido si el archivo no lo declara.
- `latLng` son grados decimales. Si `confidence` es `'verified'` y `proj4` conoce el CRS, el adaptador los deriva en `openModel` de `localToMap` aplicado al origen del modelo, porque `IfcSite` suele ser aproximado. Si no, salen de `IfcSite.RefLatitude/RefLongitude`. El kernel no incluye proyecciones geodésicas ni supone Galicia o UTM 29N: entrega `localToMap` y el CRS.
- `crsId` es un resultado de búsqueda, no un atributo IFC. `confidence: 'verified'` exige coincidencia exacta del CRS.

---

## 3. Lotes de geometría

Definidos en `GeometryBatch.ts`. Desde la versión 2 del contrato un lote puede viajar comprimido (A11) y dibujar formas compartidas por instancias (A13). La decisión y sus mediciones están en `docs/09` (revisión 4, aceptada por Gemini en T-152 y aprobada por Nick el 2026-11-19).

| Campo | Tipo | Contenido |
|---|---|---|
| `modelId` | `ModelId` | Modelo del lote. Un registro identifica `ElementRef(batch.modelId, expressId)`; su `expressId` solo no identifica nada |
| `sequence` | `u32` | Empieza en 1 en cada flujo y sube de uno en uno |
| `origin` | `[f64; 3]` | Coordenadas absolutas de modelo. Vértice absoluto = `origin + position` |
| `box` | `{ min, max }`, cada uno `[f32; 3]` | Todo lo que dibuja el lote, relativo a `origin`: sus vértices y la caja de cada forma transformada. Sin instancias es exactamente `quantBox`; ceros si el lote no dibuja nada. El renderizador no dibuja un lote cuya caja queda entera fuera de la vista |
| `vertexFormat` | `'f32' \| 'q16'` | Formato de `positions` y `normals` |
| `quantBox` | `{ min, max } \| null` | La rejilla de `positions`: el menor y el mayor valor exactos de las posiciones del lote en cada eje, antes de cuantizar, relativos a `origin`. `null` si el lote no tiene vértices propios |
| `positions` | `Float32Array` (`f32`) o `Uint16Array` (`q16`) | `f32`: xyz por vértice. `q16`: cuatro valores por vértice, x, y, z en la rejilla y el índice del registro del vértice en `meshTable` |
| `normals` | `Float32Array` (`f32`) o `Int16Array` (`q16`) | `f32`: xyz por vértice, de longitud 1 ± 1e-3. `q16`: dos valores por vértice, codificación octaédrica. Las aristas vivas duplican vértices |
| `indices` | `Uint32Array` o `Uint16Array` | Triángulos, base cero dentro del lote. De 16 bits solo si el lote tiene como mucho 65.536 vértices; el renderizador los distingue por su tipo |
| `meshTable` | `Uint32Array` | 7 palabras por registro: `expressId, firstVertex, vertexCount, firstIndex, indexCount, rgba, flags` |
| `shapes` | `ShapeDef[]` | Formas que el lote usa **por primera vez** en el flujo |
| `instanceTable` | `Uint32Array` | 4 palabras por instancia: `expressId, shapeId, rgba, flags` |
| `instanceTransforms` | `Float32Array` | 12 por instancia: matriz 3×4 por columnas, de coordenadas de forma a coordenadas locales de lote |

- `rgba` es `0xRRGGBBAA`, sRGB sin premultiplicar.
- Un elemento puede tener varios registros e instancias, en el mismo lote salvo que supere `MAX_BATCH_RADIUS` y se reparta en piezas (sección 2). El renderizador reúne los registros de un elemento por `expressId`, estén en el lote que estén. Cada índice de un registro apunta dentro de su rango de vértices.
- **Orientación:** los triángulos son antihorarios vistos desde el lado de su normal, y la normal se calcula de ese orden. En un sólido cerrado, ese lado es el exterior. Una malla abierta no garantiza nada, así que el renderizador dibuja las dos caras. Solo de las mallas marcadas `Closed` puede omitir las caras traseras, y no mientras haya un plano de corte, que abre los sólidos.
- **Banderas**, los bits sin definir valen 0:

| Bit | Nombre | Significado |
|---|---|---|
| 0 | `Transparent` | `rgba` tiene alfa menor que 255, exactamente |
| 1 | `Degraded` | Se evaluó solo en parte. Hay un diagnóstico con su `expressId` en `complete.diagnostics` |
| 2 | `HiddenByDefault` | Seleccionable, pero empieza oculto. Hoy solo `IfcSpace`; añadir tipos no rompe el contrato, y esos tipos también quedan fuera de los planos (sección 5) |
| 3 | `Closed` | La malla de la que sale el registro es cerrada y mira hacia fuera: cada lado, contando como uno los vértices en la misma posición, lo comparten exactamente dos de sus triángulos que lo recorren en sentidos opuestos, y cada parte, con sus triángulos unidos por esos lados, encierra un volumen positivo. Vista desde fuera no muestra caras traseras. Las piezas de una malla repartida la conservan. No la lleva una malla con una cavidad, con caras que solo se tocan en uniones en T, con una parte sin volumen (un triángulo con un vértice repetido, dos caras espalda con espalda) o con un triángulo corrupto descartado |

### Vértices `q16` (A11)

- **Posición:** `min + q / 65535 × (max − min)` en cada eje, con la rejilla del lote (`quantBox`) o de la forma (`box`). El kernel redondea al entero más cercano, así que el menor valor de cada eje es `q = 0` y el mayor `q = 65535`; un eje sin extensión vale 0 en todos los vértices.
- **Cuarta componente:** en un lote, el índice del registro del vértice dentro de `meshTable`; en una forma, 0, porque el registro sale de la instancia. Sustituye al búfer de índices de registro que el renderizador crea para los lotes `f32`. Por eso un lote con más de `MAX_Q16_RECORDS` = 65.535 registros viaja en `f32`.
- **Normal:** octaédrica en `snorm16x2` (valor / 32767, no menos de −1): `n = (x, y, 1 − |x| − |y|)`; si `n.z < 0`, `n.xy = (1 − |n.yx|) × s` con `s` = +1 o −1 según el signo de cada componente, contando el 0 como positivo; después se normaliza. Nunca `sign()`, que devuelve 0 en 0: un codificador con `sign()` lleva (0, 1/√2, −1/√2) a (0, 1, 0). Error angular por debajo de 0,01°.
- **Cuándo `q16`:** si el paso `(max − min) / 65535` de todos los ejes es como mucho `MAX_QUANT_STEP` = 1 mm (decisión de Nick, `docs/09` §7). Si no, el lote viaja en `f32` y no se parte.
- **Error:** cada coordenada se mueve como mucho medio paso de su eje, 0,5 mm en el peor caso; un vértice, como mucho la longitud del vector de medios pasos, √3/2 mm. Solo afecta a lo que se ve: medición, ajuste, planos, detalles y `elementMesh` usan la geometría del kernel en `f64`. Puede haber grietas de hasta 1 mm entre lotes vecinos, nunca dentro de un lote.
- **Alineación:** un `Uint16Array` de índices de longitud impar ocupa 2 bytes de más sobre un múltiplo de 4. El renderizador WebGPU redondea su búfer a 4 bytes y la caché OPFS rellena cada bloque hasta 4 bytes. Posiciones de 8 bytes y normales de 4 ya están alineadas.

### Formas e instancias (A13)

`ShapeDef`: `{ shapeId, vertexFormat, positions, normals, indices, box, closed }`, en coordenadas de la forma (las del `IfcRepresentationMap`). `box` es su caja exacta y su rejilla en `q16`.

- `shapeId` es único en el flujo y empieza en 1. Una forma se envía una sola vez, en el primer lote que la usa, y el renderizador la guarda por modelo hasta `removeModel`.
- La traslación de cada matriz es relativa a `batch.origin`, como las posiciones: no hay coordenadas absolutas en `f32` (RSK-01).
- El determinante de cada matriz es normal y positivo también en `f32` (`det = 1e-40` se rechaza): una copia reflejada o casi singular se expande como geometría normal.
- Una forma `q16` cumple el paso en el mundo: `(box.max − box.min) × estiramiento / 65535 ≤ MAX_QUANT_STEP` en cada eje, con el estiramiento de la instancia (el mayor módulo de las columnas de su matriz). Una instancia que no lo cumple se expande.
- Una instancia hereda `Degraded` y `HiddenByDefault` de su elemento. `Closed` sale de la forma.
- Un lote puede no tener vértices propios: `positions` y `meshTable` vacíos, `quantBox` `null` y solo instancias. Los renderizadores lo suben salvo que no tenga ni registros ni instancias.
- `complete.meshCount` cuenta registros e instancias.
- Qué se instancia, cómo se cuentan los usos (`MIN_INSTANCE_USES` = 2) y qué hace el renderizador con las instancias está en `docs/09` §2, que es normativo para A13 hasta que se construya.

### Validación y transporte

- `findBatchError(batch, knownShapes?)` valida este formato en pruebas, con datos simulados y en `scripts/check-kernel.mjs`, nunca por lote en la ruta caliente; los renderizadores solo la exponen en `__gubim_dev__`. `knownShapes` son las formas ya recibidas de ese modelo. Comprueba:
  - tipos y longitudes de cada arreglo según `vertexFormat`, y los índices de 16 bits solo hasta 65.536 vértices;
  - `box`, `quantBox` y el `box` de cada forma: finitos y con `min ≤ max`;
  - `quantBox` presente si y solo si hay vértices; en `f32`, igual al menor y mayor valor de `positions`; en `q16`, exacta sin comparar coma flotante (algún `q = 0` y algún `q = 65535` en cada eje con extensión, todos 0 sin ella) y con paso de 1 mm como mucho;
  - en `q16`, la cuarta componente de cada vértice igual a su registro, y como mucho 65.535 registros;
  - sin instancias, `box` igual a `quantBox`; con ellas, `box` contiene `quantBox` y las 8 esquinas de cada forma transformada, con medio paso de holgura en las `q16`;
  - formas con `shapeId` desde 1 y no repetido, rejilla exacta y cuarta componente 0; instancias con forma conocida, matriz finita y determinante normal y positivo en `f32`;
  - registros: `expressId` distinto de 0 y cada índice dentro del rango de vértices de su registro.

  El radio máximo lo garantiza el kernel y no se comprueba ahí, porque un elemento `Degraded` demasiado grande para repartirlo puede superarlo.
- **`complete.bounds`** son coordenadas absolutas de modelo de todo lo que no lleva `HiddenByDefault`. Queda indefinido si no queda nada.
- **Los lotes se transfieren, nunca se clonan** (RSK-06): todos sus búferes, formas incluidas. Tras `addBatch`, el renderizador sube los datos a la GPU y no conserva copia en JS (RSK-03).
- Los lotes son solo para el renderizador. `cad-slicer` trabaja dentro del kernel con la geometría evaluada de `ifc-geometry`, combinando origen y posición en `f64`.

---

## 4. Identidad, datos y errores

- **Identidad:** siempre `ElementRef` = `(modelId, expressId)`. Selección, visibilidad y resaltado no pueden usar un `expressId` suelto (TC-002).
- **`elementCount`:** `IfcProduct` con `Representation`, sin `IfcFeatureElementSubtraction`. Incluye `IfcSpace`. Cuenta los elementos que el kernel intenta evaluar, no los que acaban con geometría.
- **Árbol espacial:** hijos y elementos en `expressId` ascendente, porque las relaciones IFC no tienen orden. Un elemento aparece con `via: 'contains'` en su contenedor y con `via: 'references'` en cada estructura que lo referencia, así que puede salir más de una vez. `unassigned` lista los productos sin relación `contains`. `IfcSpace` aparece como nodo. `IfcFeatureElementSubtraction` no aparece. En cada `IfcBuildingStorey`, `elevation` es el atributo `Elevation` en metros, relativo al edificio y a menudo ausente, y `level` es la altura del origen de su `ObjectPlacement` en coordenadas de modelo, resuelta como la de la geometría: la cota a la que se dibuja su suelo. En los modelos públicos de buildingSMART, `Elevation` falta en 51 de 225 plantas y difiere de `level` en 17 (14,3 m en Esplanades). Los planos proyectan por defecto hasta el `level` de la planta en la que está el corte (T-148).
- **Materiales y tipo:** se resuelven `IfcRelDefinesByType` e `IfcRelAssociatesMaterial` en el elemento y en su tipo. La asignación del elemento prevalece.
- **Atributos:** claves con el nombre EXPRESS y valores `AttributeValue`, sin `any`.

### Propiedades

Garantías de cada campo de `PropertyItem` que entrega el kernel:

| Campo | Garantía |
|---|---|
| `name` | Siempre |
| `value` | Siempre. En `single`, el valor bruto. En los demás casos, un escalar solo para mostrar: el dato real está en `structured` |
| `structured` | Solo si el valor no es `single` |
| `kind` | Siempre, `property` o `quantity` |
| `type` | Si el archivo da un tipo de medida |
| `unit` | Si se resuelve, ver sección 2 |
| `methodOfMeasurement` | Solo en cantidades, si el archivo lo declara |

### Búsqueda

`findElements(modelId, query)` devuelve, en `expressId` ascendente, los elementos de `elementCount` que cumplen `ElementQuery`:

- **Texto:** se recorta y se busca como subcadena. Mayúsculas y minúsculas dan igual (minúsculas Unicode), salvo en el `GlobalId`, que las distingue porque su codificación también lo hace.
- **`field`:** `name` mira el atributo `Name`; `class`, el nombre de la clase IFC (`IfcWallStandardCase` sale con `wall`); `globalId`, el `GlobalId`; `property`, los valores de propiedades y cantidades; `any`, todo lo anterior.
- **Valores de propiedad:** los conjuntos son los mismos que da `getElementDetails`: los del elemento y los de su tipo, y un conjunto del elemento anula al del tipo con el mismo nombre. Se mira cada escalar tal como lo muestra el panel: números como los escribe JavaScript (`String`), lógicos como `true` y `false`, enumerados por su nombre. En valores enumerados, de lista, acotados y de tabla cuenta cada escalar; en una propiedad compleja, cada miembro. Los nombres de conjuntos y propiedades no son valores.
- **`propertyName`:** solo con `property`. Limita la búsqueda a las propiedades con ese nombre, sin distinguir mayúsculas; si es el de una propiedad compleja, a todos sus miembros. Con él, un `text` vacío encuentra todo elemento que tenga esa propiedad.
- **Sin nada que buscar** (texto vacío y sin `propertyName` útil) devuelve una lista vacía.
- Un modelo cerrado da una lista vacía, no un error.

### Malla de un elemento

`elementMesh(modelId, expressId)` devuelve los triángulos de un elemento para medir sobre él (`ElementMesh`):

- **La superficie que dibuja el flujo:** los mismos triángulos, huecos ya restados y sin los degenerados, con todas las mallas del elemento juntas. Sin color ni normales.
- **Coordenadas absolutas de modelo en `f64`**, metros y Z arriba, sin origen de lote: la medida no pierde la precisión que `f32` perdería lejos del origen.
- **Vértices compartidos:** las esquinas a menos de una micra son un solo vértice, que conserva la posición de la primera. Un triángulo que al fundirse queda sin área se descarta.
- **`edges`:** las aristas que ve un usuario, en pares de índices con el menor primero. Son los bordes (un lado con un solo triángulo, o con más de dos) y los pliegues, donde las normales de los dos triángulos se separan más de 20°. Nunca la diagonal de una cara plana ni las facetas de una superficie curva: los círculos tienen 32 lados, a 11,25°.
- `null` si el flujo no dibuja nada para ese `expressId` (aberturas, productos sin representación, ids desconocidos) o si el modelo está cerrado.
- El Worker usa un evaluador propio, que conserva sus cachés para las consultas siguientes, así que puede intercalarse con un flujo o un plano. Un elemento de un millón de triángulos tarda unos 3,5 s en el Worker; en el hilo principal solo se copian los índices de las esquinas.

### Medición en el renderizador

Para medir, `RendererPort` da lo mínimo y no sabe nada de medidas:

- `setPointerMode('measure')` hace que un clic llame a `onPoint(x, y)` en vez de seleccionar, y que el ratón sin botones pulsados llame a `onPointerMove`, con `null` al salir del lienzo. Órbita, desplazamiento y zoom no cambian. Por defecto es `'select'`.
- `pick(x, y)` es la misma selección del clic: no ve fantasmas ni lo que el corte quita. Las peticiones se atienden de una en una y en orden.
- `rayAt(x, y)` y `project(point)` pasan de posición en el lienzo a rayo y de punto a posición, en `f64` y coordenadas absolutas de modelo. Concuerdan con las matrices con que se dibuja.
- `onFrame` se llama tras cada fotograma dibujado, para que una capa encima del lienzo siga a la cámara.
- Las posiciones del lienzo son píxeles CSS desde su esquina superior izquierda.

### Errores y diagnósticos

**`KernelError`** es el fallo de toda una operación, que rechaza su promesa:

| Operación | Rechaza con |
|---|---|
| `openModel` | `parse`, `unsupported-schema`, `out-of-memory`, `internal` |
| `streamGeometry` | `model-not-open` si no estaba abierto; `out-of-memory`, `internal` |
| `getElementDetails`, `getSpatialTree` | `out-of-memory`, `internal`. Un modelo cerrado o un elemento desconocido da `null`, no un error |
| `findElements` | `out-of-memory`, `internal`. Un modelo cerrado da `[]` |
| `elementMesh` | `out-of-memory`, `internal`. Un modelo cerrado o un elemento sin geometría da `null` |
| `generateDrawing` | `model-not-open` si no queda ningún modelo abierto; `drawing-frame-empty` si hay modelos abiertos y el marco los excluye a todos, con el motivo en el mensaje; `out-of-memory`, `internal` |
| `exportDrawing` | `drawing-not-found`, `out-of-memory`, `internal` |
| `discardDrawing`, `closeModel` | Nunca: son idempotentes |

**`KernelDiagnostic`** es un problema que no impide seguir.

- **Alcance:** con `expressId` se refiere a ese elemento; sin él, al modelo de `modelId`; sin ninguno de los dos, a todo el plano.
- **Severidad:** `info` no cambia lo que ve el usuario, `warning` sí puede cambiarlo, y `error` indica que algo no se ha podido entregar.
- **Entrega:** por `ModelSummary.diagnostics` al abrir, `complete.diagnostics` en el flujo y `GeneratedDrawing.diagnostics` en los planos. Detalles y árbol no tienen canal.
- **`code`** es un texto estable en kebab-case de un conjunto abierto. Añadir códigos no rompe el contrato, y la UI debe mostrar los desconocidos sin fallar.

**Cerrar un modelo durante `streamGeometry`** termina la iteración sin error y **sin** evento `complete`. Un flujo que llega al final emite exactamente un `complete`, así que su presencia distingue ambos casos. Los diagnósticos de un flujo cortado se pierden.

---

## 5. Planos 2D

- `generateDrawing` se ejecuta dentro del kernel y devuelve `GeneratedDrawing`, con su marco y diagnósticos. La UI ya no maneja mallas.
- **Marco:** un plano pertenece a un marco, no a un modelo. `project` toma las coordenadas absolutas de modelo como compartidas por todos los modelos, igual que la vista 3D. `map` pasa cada modelo por su `localToMap`; los modelos sin él se omiten con `map-frame-no-georeference`. Las posiciones de corte se expresan en metros del marco.
- **CRS común de `map`:** es el del primer modelo de la lista con `localToMap`. Otro modelo lo comparte si coincide `verticalDatum` y además coincide `crsId`, o ninguno tiene `crsId` y ambos tienen el mismo `crsName`. Dos modelos sin `crsId` ni `crsName` no se consideran iguales. El que difiera se omite con `map-frame-crs-mismatch`. `GeneratedDrawing.crsId` es ese CRS si está verificado, y queda indefinido si no.
- **Generar y exportar:** `DrawingOptions` decide qué se calcula. `exportDrawing` solo serializa y puede omitir capas ya calculadas, nunca añadirlas.
  - `includeProjection` activa juntas las líneas visibles y ocultas, que salen de la misma pasada.
  - `includeHiddenLines` exige `includeProjection`. Sin él, las ocultas se descartan antes de guardar el plano.
  - Las aristas siempre forman parte de la proyección y las líneas siempre se fusionan.
  - `units` escala las coordenadas exportadas a metros o milímetros.
- **Tramas:** la trama procede del material que da nombre a la capa, con la misma precedencia: la asignación del elemento antes que la de su tipo, y en un conjunto, su primer miembro. Se sigue `IfcMaterialDefinitionRepresentation` → `IfcStyledRepresentation` → `IfcStyledItem` → `IfcFillAreaStyle` (también a través de `IfcPresentationStyleAssignment`), y cada `IfcFillAreaStyleHatching` es una fila de líneas, de modo que dos filas se cruzan. Como máximo se leen 8 filas.
  - El ángulo es `HatchLineAngle` en la unidad de ángulo del proyecto, antihorario desde el eje X de la hoja. La separación es `StartOfNextHatchLine` en la unidad de longitud del proyecto. Si es un vector (`IfcVector`, o `IfcOneDirectionRepeatFactor` en IFC2x3), cuenta su componente perpendicular a las líneas.
  - Un `IfcFillAreaStyle` con `ModelOrDraughting` falso mide en papel, a una escala que la hoja no conoce, y no se usa.
  - La línea de referencia pasa por `PatternStart`, o si no lo hay por `PointOfReferenceHatchLine`, en coordenadas de la hoja y en la unidad de longitud del proyecto. Sin ninguno pasa por el origen de la hoja, como en el anexo A.
  - La hoja solo dibuja líneas continuas, así que una fila cuyo `HatchLineAppearance` tiene una fuente de trazos se omite: solo cuentan las que no tienen fuente o usan la predefinida `continuous`. Una fila idéntica a otra ya leída también se omite.
  - Se ignoran `IfcExternallyDefinedHatchStyle`, `IfcFillAreaStyleTiles` y los estilos asignados a los ítems de geometría.
  - Una fila sin ángulo finito, sin separación positiva o sin desplazamiento finito se omite con `bad-hatch-style`. Si no queda ninguna, o el material no tiene trama, se aplica la regla del anexo A.
- **Capas:** cada elemento va a una capa, que también decide su trama. Es el nombre del material del elemento, con la asignación del elemento por delante de la de su tipo: el nombre del material, o del conjunto de capas, perfiles o constituyentes; si no tiene, el del material de su primer miembro. Sin material, es la clase IFC, como `IfcWall`. Un muro multicapa es una sola capa y un solo estilo de trama, porque el kernel no separa su geometría por capas de material. La trama se calcula por parte de la malla: un elemento de varias partes recibe la suya en cada una, y si se solapan, sus tramas también.
- **Ciclo de vida:** un dibujo guarda sus propios datos 2D y sobrevive a `closeModel`. `discardDrawing` es idempotente. Exportar un dibujo descartado produce `drawing-not-found`.

### Corte

Se conserva lo que queda detrás del plano, en el sentido de la mirada (`(p − origin) · look ≥ 0`).

| Corte | Mira hacia | X de la hoja | Y de la hoja |
|---|---|---|---|
| `plan` | −Z | +X | +Y |
| `section`, `x`, `positive` | +X | −Y | +Z |
| `section`, `x`, `negative` | −X | +Y | +Z |
| `section`, `y`, `positive` | +Y | +X | +Z |
| `section`, `y`, `negative` | −Y | −X | +Z |
| `plane`, `origin`, `normal` | $\hat{l} = \text{normal}/\|\text{normal}\|$ | $\hat{u} \times (-\hat{l})$ | Si $\|\hat{l}_z\| > 0{,}5$, proyección de $+Y$ sobre el plano (se lee como una planta); si no, de $+Z$ (se lee como un alzado) |

- `positive` significa mirar hacia el sentido positivo del eje, desde el ojo hacia el modelo. Así la hoja queda a derechas vista desde el ojo.
- En `plane`, `origin` es un punto del plano de corte y `normal` el sentido de la mirada hacia el interior del corte (normalizado por el kernel). Si `origin` o `normal` no son finitos, o `normal` es nulo, se emite el diagnóstico `bad-cut`. Ambos van en las coordenadas del marco del plano (`project` o `map`). El eje de la hoja se elige por la dirección dominante de la mirada para que una cara de suelo elegida con el ratón, cuya normal se aparta un poco de $-Z$ por ruido de f32 o por una pendiente, no gire la hoja hacia donde apunte ese error.
- `depth` son metros desde el plano en el sentido de la mirada, y solo limita la proyección. Si se omite, llega hasta el final de la geometría. Un valor negativo o `NaN` se ignora con `bad-depth`, igual que un infinito, y el plano se genera como si no tuviera `depth`.
- **Plano coplanario con una cara:** se genera el lazo solo si el material queda detrás del plano. En una planta, un plano en la cara superior de una losa da su contorno, y uno en la cara inferior no da nada.

### Planos de varios modelos

- **Lista de modelos:** vacía significa todos los abiertos, en orden de apertura. Su orden numera los modelos dentro del plano, y esa posición no cambia aunque otro modelo de la lista se omita.
- **Concurrencia:** el adaptador atiende `generateDrawing` de una en una, en orden de llegada. Una llamada espera a que termine la anterior.
- **Ocultación cruzada:** las líneas ocultas se calculan entre todos los modelos del plano. Un elemento de un modelo oculta a los de otro, como en la realidad.
- **Exclusiones:** lo marcado `HiddenByDefault`, hoy solo `IfcSpace`, no entra en los planos, porque sus lazos taparían cada estancia con una trama. La visibilidad por elemento de la vista 3D no se aplica.
- **Determinismo:** los mismos modelos, en el mismo orden y con las mismas opciones dan bytes idénticos en DXF y SVG (TC-005), sea cual sea el orden de llegada de los datos y aunque cambie `ModelId`, que es aleatorio. El kernel ordena las mallas por `(posición en la lista, expressId, parte)` antes de cortar, donde `parte` es el orden de la malla dentro de su elemento. Esa clave es única, así que los límites de trabajo también cortan siempre en el mismo sitio.
- **Fallos:** un modelo que no está abierto, que se cierra antes de `Sheet::generate` o cuyo Worker falla se omite entero con `drawing-model-lost`: lo que ya hubiera enviado se descarta, para no dibujar medio modelo. Un modelo que se cierra durante `Sheet::generate`, que es síncrono, queda en ese plano. Un modelo cerrado da `drawing-model-lost` también en un marco `map`, no `map-frame-no-georeference`. Un trozo mal formado también pierde su modelo entero, con `bad-drawing-chunk`, y si eso ocurre en todos, el plano se entrega vacío con esos diagnósticos. Si no queda ninguno, `generateDrawing` rechaza con `model-not-open`, o con `drawing-frame-empty` si los modelos siguen abiertos y el marco los excluye. Si falla el Worker de plano, rechaza con `out-of-memory` o `internal`, y los modelos no se ven afectados.
- **Límites:** los límites de oclusores y de pruebas de oclusión de `cad-slicer` son por plano, no por modelo. Los de triángulos y aristas son por parte de malla. Al alcanzar cualquiera, el plano se entrega incompleto con un diagnóstico.

### Seguridad del SVG

`SectionDxfPanel.tsx` lo inserta con `dangerouslySetInnerHTML` y los nombres vienen del archivo IFC, que no es de confianza. El exportador usa una **lista blanca**:

| Elemento | Atributos propios |
|---|---|
| `svg` | `xmlns`, `width`, `height`, `viewBox` |
| `g` | Ninguno |
| `path` | `d` |
| `line` | `x1`, `y1`, `x2`, `y2` |
| `polyline`, `polygon` | `points` |
| `circle` | `cx`, `cy`, `r` |
| `text`, `tspan` | `x`, `y` |

- Todos admiten además `fill`, `stroke`, `stroke-width`, `stroke-linejoin`, `stroke-dasharray` y `font-size`.
- Los valores los genera el propio exportador: números, números con el sufijo `mm` en `width` y `height` de `svg`, colores `#rrggbb`, `none` o `round`. Los textos IFC solo aparecen como texto escapado (`& < > " '`), nunca como nombre o valor de un atributo.
- La lista es un máximo: el exportador puede usar solo una parte. Se admite la declaración XML inicial.
- Se eliminan los caracteres de control no válidos en XML 1.0.
- Sin `<style>`, `<use>`, `<image>`, `<a>`, `<animate>`, `<set>`, `<foreignObject>`, ni los atributos `style`, `class`, `id`, `href`, `xlink:href` u `on*`, ni entidades externas.

### DXF R12

- `content` es `Uint8Array`, ya codificado. La descarga usa `new Blob([content])` sin conversión de texto.
- `$ACADVER = AC1009`, `$DWGCODEPAGE = ANSI_1252`, finales de línea CRLF.
- Todo valor que entre en un código de grupo se sanea: textos, nombres de capa, bloque y estilo, comentarios 999 y nombre de archivo. Se eliminan CR, LF, NUL y controles, y nunca se emiten los bytes indefinidos `0x81`, `0x8D`, `0x8F`, `0x90` y `0x9D`.
- En valores de texto, los caracteres fuera de CP1252 se sustituyen por `?`. Nunca se emite UTF-8 bajo `ANSI_1252`.
- Los nombres de capa siguen otra regla, porque R12 limita sus caracteres: solo `A-Z a-z 0-9 $ _ - .`, y cualquier otro se sustituye por `_`. Tienen hasta 31 caracteres, con truncado sin colisiones que ignora mayúsculas.

---

## 6. Límite WASM

Interno entre `wasm-api` y sus Workers. Puede cambiar sin tocar `KernelPort`. Propietario: Claude (T-033), incluidos los Workers en `src/infrastructure/kernel/`. Los nombres son los de Rust; en JS van en camelCase.

```rust
#[wasm_bindgen]
impl Model {
    #[wasm_bindgen(constructor)]
    pub fn open(bytes: Vec<u8>) -> Result<Model, JsError>;
    pub fn summary_json(&self) -> String;
    pub fn element_details_json(&self, express_id: u32) -> Option<String>;
    pub fn spatial_tree_json(&self) -> Option<String>;
    pub fn find_elements(&self, field: &str, text: &str, property_name: Option<String>)
        -> Result<Vec<u32>, JsError>;
    /// Con `take_positions`, `take_indices` y `take_edges`, como `BatchView`.
    pub fn element_mesh(&mut self, express_id: u32) -> Option<ShapeView>;

    pub fn start_stream(&mut self);
    /// Modelo de extracción: el Worker pide el siguiente lote cuando puede enviarlo.
    pub fn next_batch(&mut self, max_triangles: u32) -> Option<BatchView>;
    pub fn processed_elements(&self) -> u32;
    pub fn total_elements(&self) -> u32;
    pub fn finish_stream(&mut self) -> String;

    /// `[tipo, posición, mirada, depth, proyección, trama, ocultas, ...localToMap]`.
    pub fn start_drawing(&mut self, request: Vec<f64>) -> Result<(), JsError>;
    pub fn next_drawing_chunk(&mut self, max_triangles: u32) -> Option<Vec<u8>>;
    pub fn finish_drawing(&mut self) -> String;
}

#[wasm_bindgen]
impl Sheet {
    #[wasm_bindgen(constructor)]
    pub fn new(request: Vec<f64>) -> Result<Sheet, JsError>;
    pub fn add_chunk(&mut self, model_index: u32, chunk: Vec<u8>);
    pub fn drop_model(&mut self, model_index: u32);
    pub fn generate(&mut self) -> String;
    pub fn export(
        &self,
        svg: bool,
        scale: f64,
        show_hidden: bool,
        show_hatching: bool,
        comment: Option<String>,
    ) -> Option<Vec<u8>>;
}
```

**Un Worker por modelo.** La memoria WASM solo crece, y un fallo fatal inutiliza toda la instancia. Con una instancia por modelo, cerrar un modelo termina su Worker y devuelve toda su memoria, detiene al momento un cálculo en curso, y un fallo solo afecta a ese modelo.

### Flujo de geometría

- `start_stream` empieza por el primer elemento. Llamarlo otra vez descarta un flujo sin terminar.
- `next_batch` devuelve `None` cuando no quedan elementos. `max_triangles` es un tope flexible: un lote se cierra antes de superarlo, pero un elemento, o pieza, mayor viaja solo en su lote y nunca se parte por ese tope. Solo el radio reparte un elemento (sección 2).
- `BatchView` da `origin()`, `bounds()`, que es `box` como `[minX, minY, minZ, maxX, maxY, maxZ]`, `quantBox()` en el mismo orden, `vertexFormat()` (`"f32"` o `"q16"`), `indicesAreU16()` y los `take_*`. Cada arreglo tiene un `take` por anchura, y el de la otra anchura devuelve un arreglo vacío: `takePositions` (`f32`) o `takePositionsQ16`, `takeNormals` o `takeNormalsOct`, `takeIndices` o `takeIndicesU16`, y `takeMeshTable`. Así cada uno devuelve su arreglo tipado sin depender de `js-sys`. `src/infrastructure/kernel/batchView.ts` los lee como un `GeometryBatch`. Las formas y las instancias llegan con A13.
- `finish_stream` se llama una vez tras `None`, libera las cachés y devuelve el JSON del evento `complete`, sin `type`. Sin flujo activo devuelve `meshCount` 0 y sin diagnósticos.

**Corrección a `docs/03` sección 4:** una vista `Float32Array` sobre `wasmMemory.buffer` queda inválida en cuanto la memoria WASM crece, y la memoria de WASM no se puede transferir entre hilos. Por tanto, **ninguna vista sobre la memoria WASM sobrevive a una llamada**, y el recorrido real es:

1. `next_batch` deja el lote en un `BatchView`, que es memoria de Rust y sigue siendo válido aunque la memoria crezca.
2. Cada `take_*` copia un arreglo a un `ArrayBuffer` propio del Worker, en cualquier orden.
3. El Worker los transfiere al hilo principal, sin más copias.

Hay exactamente una copia y ninguna serialización. Los datos no geométricos, poco frecuentes (detalles, árbol, resumen, opciones), pueden viajar como JSON.

### Caché de geometría en OPFS

`kernel.worker.ts` y `geometryCache.ts` guardan el flujo evaluado en el sistema de archivos privado del origen (`navigator.storage.getDirectory()`, carpeta `gubim-geometry-cache`) mediante `FileSystemSyncAccessHandle`, sin cambiar `KernelPort`:

- **Identidad:** cada entrada une la clave rápida de apertura (`cacheKey`: longitud del archivo en 8 bytes + primer MiB + último MiB, SHA-256) y la huella del binario WASM (`SHA-256(wasmBytes)`). La cabecera de 96 bytes (`GUBIMGC1`, `CACHE_FORMAT = 2`) guarda además el SHA-256 completo del archivo IFC (`identity.file`, 32 bytes) y el del kernel (`identity.kernel`, 32 bytes), la marca de último uso (`LAST_USED_AT`) y la longitud final (`LENGTH_AT`).
- **Lotes (formato 2):** cada registro `Batch` empieza con una cabecera de 120 bytes: `origin`, `box`, `quantBox` (ceros si es `null`), una palabra de banderas (`q16`, `quantBox` presente, índices de 16 bits), `sequence`, elementos procesados y totales, y las longitudes de `positions`, `normals`, `indices`, `meshTable`, `instanceTable` e `instanceTransforms` y el número de formas. Siguen esos arreglos, cada uno rellenado hasta 4 bytes, y cada forma con su cabecera de 48 bytes (`shapeId`, banderas, `box`, longitudes) y sus tres arreglos. Abrir comprueba que las longitudes casan con el tamaño del registro; leer, que los índices y el registro de cada vértice `q16` quedan dentro del lote.
- **Escritura en la segunda apertura:** la primera apertura de un archivo solo deja una marca `.seen` y no calcula el SHA-256 completo ni escribe `.gbc`, evitando penalizar los modelos que solo se abren una vez. En la segunda apertura se comprueba la marca, se calcula el SHA-256 completo del archivo y se escribe el `.gbc` (`Summary`, lotes `Batch`, `Complete`, `Tree` y `End`). La longitud total en la cabecera se escribe y vuelca (`flush`) al final: un archivo truncado o interrumpido nunca se da por válido, se descarta y se vuelve a generar desde WASM.
- **Reproducción y apertura diferida de `Model`:** cuando `CacheReader.open` valida un `.gbc` (magia, versión, longitud exacta, SHA-256 completo del archivo y del kernel), `open` devuelve el `ModelSummary` guardado sin instanciar `Model` en WASM y conserva los bytes IFC en el Worker; `streamGeometry` y `getSpatialTree` se sirven desde el `.gbc`, y `Model.open(sourceBytes)` solo se ejecuta bajo demanda cuando se pide una operación que necesita el modelo vivo (`getElementDetails`, `findElements`, `elementMesh`, `start_drawing`).
- **Limpieza:** al escribir o abrir la caché se eliminan entradas de otros kernels y marcas huérfanas, y se aplica un tope LRU de 2 GiB por fecha de último uso (`lastUsed`). El diálogo «Acerca de» (`GeometryCacheControl.tsx`) consulta y vacía la carpeta OPFS.

### Flujo de planos

Un Worker por plano, con su propia instancia WASM, además del de cada modelo. Un plano sobrevive así a `closeModel`, y `discardDrawing` termina su Worker y devuelve toda su memoria.

1. El adaptador resuelve la lista de modelos y el CRS común (sección 5), y crea el Worker de plano con `Sheet::new`.
2. Cada Worker de modelo evalúa sus elementos uno a uno y los pasa a coordenadas del marco en `f64`, aplicando su `localToMap` si el marco es `map`.
3. `next_drawing_chunk` entrega trozos binarios con `expressId`, `parte`, capa, las filas de trama (ángulo, separación y desplazamiento en `f64`, como máximo 8), posiciones `f64` y triángulos. Cada elemento se evalúa entero, y antes de escribir el trozo se descarta cada parte de malla cuya profundidad, medida en coordenadas del marco, queda entera delante del plano sin tocarlo o más allá de `depth`, y sin proyección también las que no tocan el plano. Una parte fuera de esa zona no se ve ni oculta nada.
4. El hilo principal transfiere cada trozo a `Sheet::add_chunk` sin leerlo ni guardarlo, y **solo pide el siguiente cuando `add_chunk` ha terminado**. Así los trozos nunca se acumulan en la cola de mensajes, y los de un modelo llegan en orden. `finish_drawing` devuelve los diagnósticos del modelo.
5. Si un modelo se pierde a medias, el adaptador llama a `Sheet::drop_model` antes de seguir. Antes de generar repite la comprobación con los modelos que ya terminaron, porque pueden haberse cerrado mientras se atendía a otro.
6. `Sheet::generate` ordena las mallas por `(model_index, expressId, parte)`, llama una vez a `cad_slicer::draw` con todas, libera las mallas y devuelve los diagnósticos, cuyo `model_index` el adaptador traduce a `ModelId`.
7. `exportDrawing` llama a `Sheet::export`, que serializa en Rust. El adaptador decodifica el SVG de UTF-8 a texto y deja el DXF en bytes. Nada de geometría se procesa en el hilo principal.

`start_drawing` usa su propio evaluador, y el Worker atiende de uno en uno, así que un plano puede intercalarse con un flujo de geometría del mismo modelo. Los trozos son formato interno entre dos Workers de la misma versión, pero `add_chunk` los valida igual, incluidos los índices de triángulos, y nunca entra en pánico. Los modelos se atienden uno tras otro: un plano evalúa en serie, y la concurrencia entre Workers de modelo solo vale para `streamGeometry`.

**Por qué una pasada conjunta y no un dibujo por modelo que luego se funde:** un dibujo por modelo deja sólidas las líneas que otro modelo oculta, y corregirlo exigiría un segundo protocolo de oclusores. Además, retener todas las mallas en el Worker de un modelo fija ese máximo de memoria hasta cerrarlo, mientras que el Worker de plano se destruye. El coste es un solo hilo para el corte, cuatro copias transitorias de cada triángulo (al trozo, al salir de WASM, al entrar en la otra instancia y de vuelta a malla), y un pico de memoria con la suma de los modelos. `Sheet::generate` libera las mallas, pero la memoria WASM no encoge, así que la instancia conserva ese pico reservado hasta que `discardDrawing` termina su Worker. T-061 lo mide. Un plano demasiado grande rechaza con `out-of-memory` sin afectar a los modelos.

---

## 7. Migración desde el código actual

| Hoy | Después |
|---|---|
| `ModelRecord.originalBytes` | Se elimina: `openModel` toma posesión del búfer |
| `bimEngine.modelMeshes`, `getModelMeshes` | Se eliminan: nadie retiene mallas en JS |
| `getSpatialHierarchy` (`byStorey`) | `getSpatialTree`, árbol real con nombres |
| `Atributo #n` posicional | `attributes` con nombres EXPRESS del esquema |
| `BimEngine.isWebGpuSupported` en `Header` | `initialize` informa del fallo; la cabecera deja de depender del motor |

### Conformidad pendiente

El código aún no cumple esta revisión en los puntos siguientes.

| Contrato | Código actual |
|---|---|
| `crsComment` | Solo llega al DXF. El SVG no admite comentarios en su lista blanca |
| Formas e instancias (A13) | Construidas en T-158. Falta una prueba: una instancia escalada 0,001 debe iluminarse igual que su copia expandida (`docs/09` §5); ningún modelo de prueba tiene esa escala |

---

## Anexo A. Regla de tramas

Se aplica a los elementos cuyo material no tiene `IfcFillAreaStyleHatching`, de modo que otra implementación produzca la misma hoja. También se aplica si ninguna de sus filas tiene un ángulo finito y una separación positiva, con el diagnóstico `bad-hatch-style`.

1. El nombre de la capa se pasa a minúsculas y se busca cada clave de la tabla, en orden. Gana la primera.
2. Sin coincidencia, se elige un patrón de reserva por FNV-1a de 64 bits de los bytes UTF-8 del nombre en minúsculas, módulo 4.

| Claves | Ángulo | Separación |
|---|---|---|
| `hormig`, `formig`, `concret` | 45° | 0,20 m |
| `ladrill`, `masonry`, `brick`, `fabric`, `fábric` | 45° | 0,12 m |
| `acero`, `aceiro`, `steel`, `metal` | 45° | 0,05 m |
| `mader`, `madeir`, `wood` | 90° | 0,10 m |
| `aisl`, `illament`, `insulat` | 30° | 0,15 m |
| `vidrio`, `vidro`, `glass` | 0° | 0,25 m |
| `terreno` | 45° | 0,30 m |

| Resto del hash | Ángulo | Separación |
|---|---|---|
| 0 | 45° | 0,20 m |
| 1 | −45° | 0,20 m |
| 2 | 0° | 0,15 m |
| 3 | 90° | 0,15 m |

- Los ángulos son antihorarios desde el eje X de la hoja.
- Las líneas se anclan en el origen de la hoja, así que los elementos vecinos se traman de forma continua, también entre modelos.
- Cada línea se recorta contra todos los lazos cerrados del elemento con la regla par-impar, de modo que el material se rellena y los huecos quedan vacíos. Una línea sobre el propio contorno se omite.
- La separación se limita a 0,005–10 m, también en las filas del archivo, y cada parte de malla recibe como máximo 4096 líneas entre todas sus filas, con `hatch-truncated` si se alcanza.
