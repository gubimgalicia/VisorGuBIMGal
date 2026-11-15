# 08. Estudio de Calidad del Kernel sobre Modelos Públicos de buildingSMART (T-145)

Este documento recoge los resultados de ejecutar `scripts/survey-models.mjs` con el kernel soberano Rust/WASM (`crates/`) sobre el corpus completo de modelos públicos de buildingSMART descargados en `test/models` (`manifest.json`, 285 entradas, 1,33 GB).

---

## 1. Metodología y Alcance

Cada archivo `.ifc` del manifiesto se evalúa en un **proceso hijo aislado** de Node.js (`node --experimental-strip-types scripts/survey-models.mjs`) con un límite de tiempo de **60 s** por archivo:

1. **Apertura y parseo STEP (`new Model(bytes)` + `model.summaryJson()`):** registra esquema detectado, número de entidades STEP, número de elementos (`IfcProduct`), diagnósticos iniciales y tiempo de apertura (`open`).
2. **Árbol espacial (`model.spatialTreeJson()`):** mide el tiempo de construcción y serialización de la jerarquía espacial (`spatialTree`).
3. **Stream de geometría 3D (`startStream` / `nextBatch(65536)` / `finishStream`):** drena todos los lotes binarios de triángulos, contabilizando mallas, triángulos, lotes, bounding box (`bounds`), diagnósticos de teselación/CSG y tiempo de stream (`stream`).
4. **Plano 2D en planta a media altura (`startDrawing` / `nextDrawingChunk(65536)` / `Sheet.generate` / `Sheet.export`):** calcula la cota media `z = (bounds.min.z + bounds.max.z) / 2` (o `1.0 m` si no hay `bounds`), genera la sección 2D con proyección, líneas ocultas y sombreado (`includeProjection`, `includeHiddenLines`, `includeHatching`), y exporta tanto **SVG** como **DXF**, registrando el número de lazos cerrados (` Z` en SVG) y los diagnósticos de corte.
5. **Memoria:** muestrea `wasmExports.memory.buffer.byteLength` (pico de memoria lineal WASM) y `process.memoryUsage().rss` en cada etapa.
6. **Conteo independiente en texto STEP:** cuenta las instancias de `IFCMAPPEDITEM` e `IFCREPRESENTATIONMAP` directamente sobre el fichero STEP, independientemente del kernel, para cuantificar la repetición geométrica (backlog `A13`, instanciado GPU).

---

## 2. Totales del Corpus

| Métrica | Total manifiesto | Sin duplicados `bench/` | Notas |
|---|---:|---:|---|
| **Archivos en `manifest.json`** | **285** | 280 | 1,33 GB en total (`bench/` contiene copias de 5 modelos de `Community-Sample-Test-Files/`) |
| **Archivos omitidos (`.ifczip` / `.ifcxml`)** | **27** | 27 | 27 `.ifczip` (0 `.ifcxml`, 0 punteros LFS sin descargar). El parser STEP (`crates/step-parser`) solo acepta texto ISO 10303-21 sin comprimir (`.ifc`) |
| **Archivos `.ifc` evaluados** | **258** | 253 | Ejecutados en procesos hijos independientes con timeout de 60 s |
| **Abiertos correctamente (`ok`)** | **237** | 232 | `91,86 %` de los `.ifc` evaluados |
| **Fallos al abrir (`failed to open`)** | **21** | 21 | `100 %` por esquema `IFC4X3_RC1` (11), `IFC4X3_RC2` (9) o `IFC4X1` (1) en `IFC 4.3.RC Archive` |
| **Crashes o timeouts (> 60 s / OOM)** | **0** | 0 | Ningún pánico WASM, fallo de reserva (`allocationFailed`) ni timeout |
| **Planos 2D fallidos (`drawings failed`)** | **0** | 0 | Los 237 modelos abiertos generaron y exportaron SVG + DXF sin error |
| **Modelos abiertos con 0 mallas (`meshCount = 0`)** | **7** | 7 | 4 objetos de biblioteca (`IfcTypeProduct`), 2 modelos de topología estructural (`Edge`) y 1 de alineación (`Axis`/`FootPrint`) |
| **Tiempo total de ejecución** | **208,95 s** | — | Barrido completo secuencial (incluyendo geometría 3D + planos SVG/DXF) |

---

## 3. Fallos de Apertura, Crashes y Modelos sin Geometría 3D

### 3.1. Fallos al abrir y crashes (21 archivos — 0 crashes)

No se produjo ningún crash ni timeout en todo el corpus. Los **21 fallos de apertura** corresponden íntegramente a archivos de la carpeta `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/` cuyos encabezados `FILE_SCHEMA` declaran versiones candidatas previas a `IFC4X3_ADD2` (`IFC4X3_RC2`, `IFC4X3_RC1` o `IFC4X1`). Se ordenan de mayor a menor relevancia por versión candidata y tamaño de modelo:

| # | Archivo | Esquema (`FILE_SCHEMA`) | Tamaño (MB) | Estado | Error o diagnóstico devuelto por el kernel |
|---:|---|---|---:|---|---|
| 1 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/Viadotto Acerno/Viadotto Acerno_IFC4x3_RC2.ifc` | `IFC4X3_RC2` | 36,93 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 2 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/P321_24159 - Bridge initial/P321_24159.ifc` | `IFC4X3_RC2` | 20,76 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 3 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/Surface features Track_Sample_1/Track_Sample_1.ifc` | `IFC4X3_RC2` | 1,68 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 4 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/Uncoupled track model/Sample_3.ifc` | `IFC4X3_RC2` | 1,03 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 5 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/Alignment consistency within original tolerance/SNCF_Try.ifc` | `IFC4X3_RC2` | 0,88 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 6 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/Composition of switch structures/Composition of switch structures - V3.ifc` | `IFC4X3_RC2` | 0,34 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 7 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/Spatial structure breakdown/Spatial Structure Breakdown.ifc` | `IFC4X3_RC2` | 0,14 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 8 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/Railway geometry prototype/Track_Geo_Prototype (20201125).ifc` | `IFC4X3_RC2` | 0,03 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 9 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC2/70139_Bridge over highway for test_Allplan/Bridge over highway for test_Allplan IFC 4.3 RC2.ifc` | `IFC4X3_RC2` | 0,02 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC2' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 10 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/4_Tunnel segments.ifc` | `IFC4X3_RC1` | 12,17 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 11 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/1_Road body shape-Exported.ifc` | `IFC4X3_RC1` | 4,05 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 12 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/7_Track model with cant.ifc` | `IFC4X3_RC1` | 2,70 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 13 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/5_Pier geometry.ifc` | `IFC4X3_RC1` | 2,42 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 14 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/8_ Bridge Slab Geometry with Alignment with cant.ifc` | `IFC4X3_RC1` | 1,66 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 15 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/FTIA_road breaklines/FTIA_breaklines.ifc` | `IFC4X3_RC1` | 1,19 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 16 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/6_ Turnout track geometry.ifc` | `IFC4X3_RC1` | 0,88 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 17 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/9_ Railway bridge composition and alignment.ifc` | `IFC4X3_RC1` | 0,50 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 18 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/2_ Guardrail alignment and shapes.ifc` | `IFC4X3_RC1` | 0,04 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 19 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/3_ Earthworks cut and fill external shape.ifc` | `IFC4X3_RC1` | 0,02 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 20 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/10_ Alignment curve and surface geometry.ifc` | `IFC4X3_RC1` | 0,01 | `failed-to-open` | `unsupported-schema: schema 'IFC4X3_RC1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |
| 21 | `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/IFC4.3 RC1/3_ Earthworks cut and fill.ifc` | `IFC4X1` | 0,02 | `failed-to-open` | `unsupported-schema: schema 'IFC4X1' is not supported (expected IFC2X3, IFC4, or IFC4X3)` |

### 3.2. Modelos abiertos (`ok`) con 0 mallas (`meshCount = 0`)

Siete archivos abren sin error pero producen 0 mallas 3D porque no contienen instancias de `IfcProduct` con representación `Body`/`Facetation`/`Mesh`:

| Archivo | Esquema | Entidades | Elementos | Motivo en el modelo |
|---|---|---:|---:|---|
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/structural-curve-member.ifc` | `IFC4` | 150 | 7 | Contiene 7 `IfcStructuralCurveMember` cuya representación es `IfcTopologyRepresentation` (`RepresentationType = 'Edge'`), no `IfcShapeRepresentation` volumétrica. |
| `IFC4.3.x-sample-models/models/structural-analysis/structural-curve-member/structural-curve-member.ifc` | `IFC4X3` | 146 | 7 | Igual que el anterior en `IFC4X3`: topología de barras estructurales (`Edge`). |
| `IFC4.3.x-sample-models/models/alignment-geometries-and-linear-positioning/segmented-reference-curve/segmented-reference-curve.ifc` | `IFC4X3` | 144 | 4 | Contiene `IfcAlignment` e `IfcAlignmentCant` únicamente con representaciones `Axis` (`Segment`, `Curve3D`) y `FootPrint` (`Curve2D`), sin barrido sólido. |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/air-terminal-library-object.ifc` | `IFC4` | 190 | 0 | Biblioteca de tipos (`IfcProjectLibrary` + `IfcAirTerminalType` con `IfcRepresentationMap`), sin ninguna ocurrencia `IfcProduct` colocada en escena. |
| `IFC4.3.x-sample-models/models/tessellated-shape-with-style/tessellation-with-blob-texture/tessellation-with-blob-texture.ifc` | `IFC4X3` | 66 | 0 | Objeto de tipo (`IfcBoilerType`) con `IfcRepresentationMap`, pero sin instancia `IfcBoiler` (`IfcProduct`). |
| `IFC4.3.x-sample-models/models/tessellated-shape-with-style/tessellation-with-image-texture/tessellation-with-image-texture.ifc` | `IFC4X3` | 63 | 0 | Objeto de tipo (`IfcBoilerType`) con `IfcRepresentationMap`, pero sin instancia `IfcBoiler` (`IfcProduct`). |
| `IFC4.3.x-sample-models/models/tessellated-shape-with-style/tessellation-with-pixel-texture/tessellation-with-pixel-texture.ifc` | `IFC4X3` | 64 | 0 | Objeto de tipo (`IfcBoilerType`) con `IfcRepresentationMap`, pero sin instancia `IfcBoiler` (`IfcProduct`). |

---

## 4. Códigos de Diagnóstico en Todo el Corpus

### 4.1. Tabla consolidada de diagnósticos

| Origen | Código de diagnóstico | Apariciones totales | Archivos afectados (de 258) | Archivos únicos (sin `bench/`) |
|---|---|---:|---:|---:|
| Apertura (`new Model`) | `unsupported-schema` | **21** | **21** | 21 |
| Stream 3D (`finishStream`) | `invalid-triangles` | **1.113** | **58** | 55 |
| Stream 3D (`finishStream`) | `sweep-trim-ignored` | **42** | **1** | 1 |
| Stream 3D (`finishStream`) | `void-on-open-mesh` | **18** | **4** | 2 |
| Stream 3D (`finishStream`) | `unsupported-geometry` | **8** | **8** | 8 |
| Stream 3D (`finishStream`) | `boolean-on-open-mesh` | **2** | **2** | 1 |
| Resumen (`summaryJson`) | `map-scale-from-units` | **2** | **2** | 2 |
| Resumen (`summaryJson`) | `map-scale-default` | **1** | **1** | 1 |
| Resumen (`summaryJson`) | `unsupported-coordinate-operation` | **1** | **1** | 1 |
| Plano 2D (`sheet.generate`) | `open-cut-loop` | **198** | **20** | 18 |

### 4.2. Significado de cada código según el código fuente del kernel

- **`invalid-triangles`** (`crates/wasm-api/src/batches.rs:352-355`, `prepare` / `push_triangle`): Emitido cuando `push_triangle` descarta triángulos degenerados de área nula (`cross.length_squared() <= 0.0`, p. ej. dos o tres vértices coincidentes o colineales tras la teselación/CSG) o con coordenadas no finitas o superiores a `MAX_COORDINATE` (`1e9 m`).
- **`open-cut-loop`** (`crates/cad-slicer/src/lib.rs:260`, `process_element`): Emitido en la generación de planos 2D cuando los segmentos de intersección entre el plano de corte y la malla de un elemento no llegan a cerrarse dentro de la tolerancia (`1e-2 m`, porque la malla original es una superficie abierta o tiene bordes no cosidos), por lo que el corte se dibuja como polilínea sin relleno de sombreado (hatch).
- **`sweep-trim-ignored`** (`crates/ifc-geometry/src/model.rs:1388, 1491`, `swept_disk_solid` y `fixed_reference_swept_area_solid`): Emitido cuando un `IfcSweptDiskSolid` o `IfcFixedReferenceSweptAreaSolid`/`IfcSurfaceCurveSweptAreaSolid` define parámetros de recorte `StartParam`/`EndParam` sobre una directriz que no es una polilínea (o cuyos parámetros `0..1` en una polilínea de varios tramos son ambiguos entre longitud de arco y parámetro de segmento), haciendo que el kernel barra la directriz completa.
- **`unsupported-schema`** (`crates/ifc-geometry/src/lib.rs:94` y `crates/ifc-schema/src/lib.rs:15-21`, `Schema::from_header`): Emitido como error de apertura cuando el identificador en `FILE_SCHEMA` no comienza por `IFC2X3`, no es `IFC4` (`IFC4` o `IFC4_ADD*`) y no es `IFC4X3` (`IFC4X3` o `IFC4X3_ADD*`), rechazando esquemas candidatos como `IFC4X3_RC1`, `IFC4X3_RC2` e `IFC4X1`.
- **`void-on-open-mesh`** (`crates/ifc-geometry/src/model.rs:888`, `apply_voids`): Emitido cuando un elemento tiene aberturas asociadas (`IfcRelVoidsElement`) pero su malla base o la malla del hueco `IfcOpeningElement` no es una variedad cerrada tras intentar coserla con `closed_shape` / `seal` (o supera `MAX_SEALED_TRIANGLES = 10_000`), por lo que se omite la resta booleana CSG para no corromper la geometría.
- **`unsupported-geometry`** (`crates/ifc-geometry/src/model.rs:1094`, `solid`): Emitido cuando un ítem de representación dentro de `Body`, `Facetation` o `Mesh` pertenece a una entidad geométrica no soportada como sólido 3D (en los 8 archivos del corpus se trata siempre de `IfcGeometricCurveSet`, que agrupa curvas/puntos 2D o 3D sin superficie).
- **`boolean-on-open-mesh`** (`crates/ifc-geometry/src/model.rs:1141`, `boolean_result`): Emitido al evaluar un `IfcBooleanResult` o `IfcBooleanClippingResult` cuyo primer o segundo operando no es una malla cerrada ni puede sellarse con `closed_shape`, devolviendo el primer operando sin recortar.
- **`map-scale-from-units`** (`crates/spatial-tree/src/lib.rs:736`, `map_conversion`): Emitido cuando `IfcMapConversion` omite el atributo opcional `Scale` y la unidad de longitud del proyecto difiere de `TargetCRS.MapUnit`, por lo que el kernel calcula el factor de escala a partir del cociente `file_scale / map_scale`.
- **`map-scale-default`** (`crates/spatial-tree/src/lib.rs:729`, `map_conversion`): Diagnóstico informativo emitido cuando `IfcMapConversion` omite `Scale` y las unidades del proyecto y del mapa coinciden, asumiendo `Scale = 1.0`.
- **`unsupported-coordinate-operation`** (`crates/spatial-tree/src/lib.rs:676`, `extract_geo_reference`): Emitido cuando `IfcProjectedCRS` se vincula mediante una operación de coordenadas distinta de `IfcMapConversion` o `IfcMapConversionScaled` (en el corpus, `IFCRIGIDOPERATION` en IFC 4.3).

---

## 5. Rendimiento y Memoria

### 5.1. Los 15 modelos no triviales (`>= 100 KB`) más lentos por MB

En modelos muy pequeños (`2–6 KB`), el tiempo fijo de arranque del runtime y compilación/instanciación inicial del módulo WASM (~15–25 ms por proceso hijo) domina el cociente `ms/MB`. Por ello se presenta primero la tabla de los **15 modelos de al menos 100 KB más lentos por MB** (coste del kernel `open + spatialTree + stream` por MB), seguida de la tabla bruta sin filtro de tamaño:

| # | Archivo (`>= 100 KB`) | Tamaño (MB) | Open (ms) | Tree (ms) | Stream (ms) | Plano 2D (ms) | Kernel (ms/MB) | Total c/2D (ms/MB) | Triángulos |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/NURBS/Bentley Building Designer/Faces/bspline surface.ifc` | 0,376 | 16,67 | 1,41 | 142,97 | 123,06 | **428,5** | 756,0 | 40.687 |
| 2 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/NURBS/Bentley Building Designer/Faces/6.RectWithHole.ifc` | 0,248 | 15,73 | 1,01 | 79,67 | 217,36 | **388,8** | 1.265,3 | 24.813 |
| 3 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/ProjectData/GEELEN-Dakvloer.ifc` | 0,117 | 13,97 | 1,87 | 20,40 | 51,30 | **309,3** | 747,0 | 5.420 |
| 4 | `Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3 TC1)/Simple-Scene/Infra-Rail.ifc` | 0,105 | 12,66 | 2,86 | 16,85 | 24,06 | **307,1** | 535,3 | 2.120 |
| 5 | `Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3 TC1)/Simple-Scene/Building-Structural.ifc` | 0,106 | 13,34 | 1,61 | 14,78 | 22,50 | **279,7** | 491,3 | 1.494 |
| 6 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/MULTICOM-trappen+bordessen.ifc` | 0,319 | 16,08 | 3,15 | 69,67 | 74,84 | **278,5** | 513,0 | 16.836 |
| 7 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/ProjectData/GEELEN-Breedplaat V3.ifc` | 0,141 | 14,01 | 2,61 | 22,13 | 54,22 | **275,3** | 660,4 | 6.386 |
| 8 | `Sample-Test-Files/IFC 4.0.2.1 (IFC 4 ADD2 TC1)/Simple-Scene/Building-Architecture.ifc` | 0,136 | 11,12 | 2,05 | 23,54 | 30,48 | **269,7** | 493,7 | 1.167 |
| 9 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/NURBS/Bentley Building Designer/SolidsAndSheets/WithArcBoundary.facet.ifc` | 0,110 | 13,00 | 1,28 | 13,79 | 20,84 | **256,0** | 446,1 | 1.686 |
| 10 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/NURBS/Bentley Building Designer/Faces/3.Torus.facet.ifc` | 0,108 | 12,54 | 1,77 | 13,08 | 20,60 | **254,1** | 445,3 | 1.686 |
| 11 | `Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3 TC1)/Simple-Scene/Infra-Plumbing.ifc` | 0,183 | 16,26 | 1,77 | 26,77 | 52,55 | **244,9** | 532,2 | 6.792 |
| 12 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/MULTICOM-banden.ifc` | 0,384 | 16,66 | 4,33 | 66,03 | 48,65 | **226,4** | 353,0 | 10.340 |
| 13 | `Sample-Test-Files/IFC 4.0.2.1 (IFC 4 ADD2 TC1)/Simple-Scene/Building-Hvac.ifc` | 0,106 | 9,99 | 1,37 | 12,44 | 19,06 | **223,7** | 402,9 | 1.064 |
| 14 | `Sample-Test-Files/IFC 4.3.2.0 (IFC 4.3 ADD2)/Simple-Scene/Building-Hvac.ifc` | 0,106 | 10,05 | 1,46 | 11,79 | 17,43 | **219,2** | 383,2 | 1.064 |
| 15 | `Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3 TC1)/Simple-Scene/Infra-Road.ifc` | 0,171 | 13,82 | 2,43 | 20,03 | 42,30 | **212,5** | 460,3 | 2.584 |

> Entre los modelos mayores de **1 MB**, los 5 más lentos por MB son `MULTICOM-Prefab.ifc` (`1,11 MB`, `130,0 ms/MB` kernel / `286,5 ms/MB` con dibujo), `Infra-Landscaping.ifc` (`1,15 MB`, `68,9 ms/MB`), `example project location.ifc` (`2,82 MB`, `60,7 ms/MB`), `1807_EP_AR_v18.ifc` (`11,55 MB`, `57,1 ms/MB` kernel / `156,9 ms/MB` con dibujo) y `FEK - Traphekken.IFC` (`11,48 MB`, `53,6 ms/MB`).

### 5.2. Los 15 archivos con mayor ratio bruto `ms/MB` (todos los tamaños, micro-archivos de 2–6 KB)

| # | Archivo (todos los tamaños) | Tamaño (KB) | Open (ms) | Tree (ms) | Stream (ms) | Plano 2D (ms) | Kernel (ms/MB) | Total c/2D (ms/MB) | Triángulos |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/tessellation-with-individual-colors.ifc` | 2,6 | 24,79 | 2,54 | 10,33 | 10,74 | **14.642,0** | 18.817,6 | 12 |
| 2 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/bath-csg-solid.ifc` | 3,4 | 9,64 | 0,86 | 12,98 | 15,77 | **6.992,5** | 11.688,9 | 260 |
| 3 | `IFC4.3.x-sample-models/models/building-elements/beam-extruded-solid/beam-extruded-solid.ifc` | 2,7 | 9,62 | 0,95 | 7,82 | 10,00 | **6.984,2** | 10.782,0 | 172 |
| 4 | `IFC4.3.x-sample-models/models/advanced-geometric-shape/bath-csg-solid/bath-csg-solid.ifc` | 3,2 | 9,28 | 0,88 | 11,59 | 14,88 | **6.884,0** | 11.593,5 | 260 |
| 5 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/beam-varying-cardinal-points.ifc` | 6,1 | 24,78 | 2,59 | 11,01 | 14,98 | **6.408,3** | 8.909,6 | 688 |
| 6 | `IFC4.3.x-sample-models/models/tessellated-shape-with-style/tessellation-with-individual-colors/tessellation-with-individual-colors.ifc` | 2,6 | 8,91 | 0,87 | 5,77 | 8,68 | **6.136,8** | 9.562,3 | 12 |
| 7 | `Sample-Test-Files/IFC 4.0.2.1 (IFC 4 ADD2 TC1)/ISO Spec - ReferenceView_V1.2/tessellation-with-individual-colors.ifc` | 2,6 | 8,94 | 0,88 | 5,35 | 8,74 | **6.014,0** | 9.478,8 | 12 |
| 8 | `IFC4.3.x-sample-models/models/building-elements/slab-extrusion/slab-extruded-solid.ifc` | 3,2 | 9,11 | 0,90 | 8,02 | 10,37 | **5.813,6** | 9.157,3 | 84 |
| 9 | `IFC4.3.x-sample-models/models/building-elements/column-extruded-solid/column-extruded-solid.ifc` | 3,1 | 9,05 | 1,04 | 7,25 | 10,39 | **5.712,3** | 9.135,1 | 172 |
| 10 | `IFC4.3.x-sample-models/models/building-elements/slab-openings/slab-openings.ifc` | 4,3 | 9,32 | 0,92 | 13,21 | 16,19 | **5.605,0** | 9.474,7 | 434 |
| 11 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/column-extruded-solid.ifc` | 3,2 | 9,30 | 0,86 | 6,34 | 10,34 | **5.335,0** | 8.678,3 | 172 |
| 12 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/slab-openings.ifc` | 4,6 | 9,92 | 0,86 | 13,00 | 16,87 | **5.298,6** | 9.057,5 | 434 |
| 13 | `IFC4.3.x-sample-models/models/building-elements/wall-extrusion/wall-extruded-solid.ifc` | 3,3 | 9,37 | 0,88 | 6,79 | 8,79 | **5.284,7** | 8.010,9 | 12 |
| 14 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/slab-standard-case.ifc` | 3,4 | 9,20 | 0,87 | 6,62 | 10,45 | **4.998,8** | 8.128,6 | 84 |
| 15 | `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/wall-standard-case.ifc` | 3,5 | 9,07 | 0,90 | 6,18 | 9,03 | **4.790,5** | 7.469,1 | 12 |

### 5.3. Los 10 mayores archivos por pico de memoria WASM

Se listan los 10 mayores modelos por pico de memoria lineal WASM (`peakWasmMB`), indicando entre paréntesis cuando existe una copia idéntica en `bench/`:

| # | Archivo | Esquema | Tamaño (MB) | Pico WASM (MB) | Pico RSS (MB) | Entidades | Elementos | Mallas | Triángulos | Lotes |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Plumbing.ifc` *(y `bench/Clinic_Plumbing.ifc`)* | `IFC2X3` | 53,25 | **860,31** | 1.089,37 | 831.132 | 10.223 | 10.205 | 3.423.664 | 53 |
| 2 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/SDK - S1/bSDD_references_example.ifc` | `IFC2X3` | 376,40 | **774,31** | 1.564,61 | 5.193.363 | 16.373 | 16.373 | 1.505.212 | 23 |
| 3 | `Community-Sample-Test-Files/IFC 4.3.2.0 (IFC 4.3)/Chesapeake Bay Bridge-Tunnel IFC Model/chesapeake_bay_bridge_tunnel_4x3.ifc` | `IFC4X3` | 91,06 | **203,81** | 406,15 | 1.351.832 | 10.562 | 17.933 | 585.480 | 9 |
| 4 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Molio/Molio_with_URIs.ifc` | `IFC2X3` | 64,25 | **160,44** | 328,15 | 1.077.590 | 5.207 | 8.159 | 728.433 | 12 |
| 5 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_Plumbing_20121113.ifc` | `IFC2X3` | 15,74 | **101,56** | 212,25 | 253.729 | 629 | 884 | 355.493 | 6 |
| 6 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Design model IFC/IFC Schependomlaan.ifc` *(y `IFC_Schependomlaan_geo.ifc`)* | `IFC2X3` | 47,69 | **94,38** | 253,88 | 665.802 | 3.389 | 5.978 | 261.185 | 4 |
| 7 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_HVAC.ifc` | `IFC2X3` | 108,35 | **93,13** | 329,57 | 1.711.612 | 4.888 | 5.515 | 534.128 | 9 |
| 8 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_MEP_20110907.ifc` | `IFC2X3` | 15,20 | **76,81** | 184,34 | 246.153 | 1.037 | 1.037 | 337.361 | 6 |
| 9 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/HB_Nutsvoorzieningen.ifc` *(y copia en `ProjectData/`)* | `IFC2X3` | 32,88 | **70,75** | 177,05 | 485.271 | 42 | 52 | 158.574 | 3 |
| 10 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_M_20111024_ROOMS_AND_SPACES.ifc` | `IFC2X3` | 32,20 | **65,88** | 169,89 | 491.500 | 527 | 525 | 184.846 | 3 |

---

## 6. Repetición de Geometría (`IFCMAPPEDITEM` / `IFCREPRESENTATIONMAP`) e Instanciado GPU (A13)

### 6.1. Estado actual en el kernel y totales de repetición

En `crates/ifc-geometry/src/model.rs:1010` (`instance_of`), el kernel ya cachea la malla local teselada en `self.instances` cuando `depth > 0` (evitando recalcular el sólido base hasta `MAX_INSTANCE_TRIANGLES`), pero en `model.rs:999` clona y transforma todos los vértices al espacio de proyecto (`transformed(mesh, transform)`) para cada `IfcMappedItem`, emitiendo vértices e índices duplicados en cada `PreparedBatch` y en el corte 2D.

- **Modelos con `IFCREPRESENTATIONMAP > 0`:** **61** de 258 archivos `.ifc` (**57** tienen `IFCMAPPEDITEM > 0`; 4 son bibliotecas de tipos con `IFCREPRESENTATIONMAP = 1` y `IFCMAPPEDITEM = 0`).
- **Totales globales en el corpus:** **48.897** `IFCMAPPEDITEM` frente a **22.431** `IFCREPRESENTATIONMAP` (ratio global **2,18×**).
- **Totales en modelos con reutilización real (`ratio > 1`, 26 archivos):** **30.803** `IFCMAPPEDITEM` frente a solo **3.646** `IFCREPRESENTATIONMAP` (ratio medio **8,45×**, es decir, **27.157** instancias repetidas).

### 6.2. Los 10 modelos donde el instanciado GPU (A13) ahorraría más

Ordenados por el volumen de instancias redundantes (`IFCMAPPEDITEM - IFCREPRESENTATIONMAP`) y peso geométrico en triángulos/memoria:

| # | Modelo | `IFCMAPPEDITEM` | `IFCREPRESENTATIONMAP` | Ratio (`Mapped / Map`) | Instancias redundantes | Mallas | Triángulos totales | Pico WASM (MB) |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | `Community-Sample-Test-Files/IFC 4.3.2.0 (IFC 4.3)/Chesapeake Bay Bridge-Tunnel IFC Model/chesapeake_bay_bridge_tunnel_4x3.ifc` | 5.233 | 39 | **134,18×** | **5.194** | 17.933 | 585.480 | 203,81 |
| 2 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Plumbing.ifc` *(y `bench/Clinic_Plumbing.ifc`)* | 3.703 | 384 | **9,64×** | **3.319** | 10.205 | 3.423.664 | 860,31 |
| 3 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Electrical.ifc` | 2.995 | 64 | **46,80×** | **2.931** | 6.358 | 447.477 | 40,31 |
| 4 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_HVAC.ifc` | 2.823 | 397 | **7,11×** | **2.426** | 5.515 | 534.128 | 93,13 |
| 5 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Molio/Molio_with_URIs.ifc` | 2.293 | 112 | **20,47×** | **2.181** | 8.159 | 728.433 | 160,44 |
| 6 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Architectural.ifc` *(y `bench/Clinic_Architectural.ifc`)* | 1.656 | 474 | **3,49×** | **1.182** | 3.708 | 185.695 | 46,88 |
| 7 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Esplanades/1807_EP_AR_v18.ifc` *(y `bench/1807_EP_AR_v18.ifc`)* | 833 | 88 | **9,47×** | **745** | 9.635 | 185.141 | 39,25 |
| 8 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Design model IFC/IFC Schependomlaan.ifc` *(y `IFC_Schependomlaan_geo.ifc`)* | 899 | 317 | **2,84×** | **582** | 5.978 | 261.185 | 94,38 |
| 9 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_MEP_20110907.ifc` | 942 | 520 | **1,81×** | **422** | 1.037 | 337.361 | 76,81 |
| 10 | `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_Plumbing_20121113.ifc` | 271 | 71 | **3,82×** | **200** | 884 | 355.493 | 101,56 |

### 6.3. Ratio `IFCMAPPEDITEM / IFCREPRESENTATIONMAP` en todos los modelos del corpus con mapas de representación (61 archivos)

*(Los 197 archivos `.ifc` restantes tienen `IFCMAPPEDITEM = 0` e `IFCREPRESENTATIONMAP = 0`.)*

| Archivo | Esquema | `IFCMAPPEDITEM` | `IFCREPRESENTATIONMAP` | Ratio | Mallas | Triángulos |
|---|---|---:|---:|---:|---:|---:|
| `Community-Sample-Test-Files/IFC 4.3.2.0 (IFC 4.3)/Chesapeake Bay Bridge-Tunnel IFC Model/chesapeake_bay_bridge_tunnel_4x3.ifc` | `IFC4X3` | 5.233 | 39 | **134,18** | 17.933 | 585.480 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Electrical.ifc` | `IFC2X3` | 2.995 | 64 | **46,80** | 6.358 | 447.477 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/reinforcing-assembly.ifc` | `IFC4` | 34 | 1 | **34,00** | 35 | 45.708 |
| `IFC4.3.x-sample-models/models/building-elements/reinforcing-assembly/reinforcing-assembly.ifc` | `IFC4X3` | 34 | 1 | **34,00** | 35 | 45.708 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Molio/Molio_with_URIs.ifc` | `IFC2X3` | 2.293 | 112 | **20,47** | 8.159 | 728.433 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/wall-elemented-case.ifc` | `IFC4` | 44 | 3 | **14,67** | 44 | 528 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Plumbing.ifc` | `IFC2X3` | 3.703 | 384 | **9,64** | 10.205 | 3.423.664 |
| `bench/Clinic_Plumbing.ifc` | `IFC2X3` | 3.703 | 384 | **9,64** | 10.205 | 3.423.664 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Esplanades/1807_EP_AR_v18.ifc` | `IFC2X3` | 833 | 88 | **9,47** | 9.635 | 185.141 |
| `bench/1807_EP_AR_v18.ifc` | `IFC2X3` | 833 | 88 | **9,47** | 9.635 | 185.141 |
| `IFC4.3.x-sample-models/models/alignment-geometries-and-linear-positioning/linear-placement-of-signal/linear-placement-of-signal.ifc` | `IFC4X3` | 25 | 3 | **8,33** | 33 | 3.512 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/FEK - Balkonhekken en borstweringsleuningen.IFC` | `IFC2X3` | 8 | 1 | **8,00** | 252 | 53.908 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_HVAC.ifc` | `IFC2X3` | 2.823 | 397 | **7,11** | 5.515 | 534.128 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Structural.ifc` | `IFC2X3` | 195 | 29 | **6,72** | 1.078 | 372.075 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/ProjectData/FEK-Leuningen en hekwerken.IFC` | `IFC2X3` | 6 | 1 | **6,00** | 179 | 38.066 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_Electrical_20121207.ifc` | `IFC2X3` | 117 | 23 | **5,09** | 251 | 30.346 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_M_20111024_ROOMS_AND_SPACES.ifc` | `IFC2X3` | 243 | 53 | **4,58** | 525 | 184.846 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/mapped-shape-with-multiple-items.ifc` | `IFC4` | 4 | 1 | **4,00** | 4 | 48 |
| `IFC4.3.x-sample-models/models/mapped-geometric-shape/mapped-shape-with-multiple-items/mapped-shape-with-multiple-items.ifc` | `IFC4X3` | 4 | 1 | **4,00** | 4 | 48 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_Plumbing_20121113.ifc` | `IFC2X3` | 271 | 71 | **3,82** | 884 | 355.493 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Architectural.ifc` | `IFC2X3` | 1.656 | 474 | **3,49** | 3.708 | 185.695 |
| `bench/Clinic_Architectural.ifc` | `IFC2X3` | 1.656 | 474 | **3,49** | 3.708 | 185.695 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/V_L_Constructief.ifc` | `IFC2X3` | 300 | 90 | **3,33** | 532 | 21.475 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/ProjectData/V_L_Constructief.ifc` | `IFC2X3` | 300 | 90 | **3,33** | 532 | 21.475 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Design model IFC/IFC Schependomlaan.ifc` | `IFC2X3` | 899 | 317 | **2,84** | 5.978 | 261.185 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Design model IFC/IFC_Schependomlaan_geo.ifc` | `IFC2X3` | 899 | 317 | **2,84** | 5.978 | 261.185 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_A_20110907.ifc` | `IFC2X3` | 167 | 60 | **2,78** | 436 | 28.531 |
| `bench/Duplex_A_20110907.ifc` | `IFC2X3` | 167 | 60 | **2,78** | 436 | 28.531 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/JORDAHL-Gevelderagers.ifc` | `IFC2X3` | 42 | 17 | **2,47** | 144 | 26.617 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/ProjectData/JORDAHL-Gevelderagers.ifc` | `IFC2X3` | 45 | 20 | **2,25** | 168 | 41.354 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/Example project location/example project location.ifc` | `IFC4` | 335 | 156 | **2,15** | 664 | 165.434 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Duplex Apartment/Duplex_MEP_20110907.ifc` | `IFC2X3` | 942 | 520 | **1,81** | 1.037 | 337.361 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/SDK - S1/bSDD_references_example.ifc` | `IFC2X3` | 16.373 | 16.373 | **1,00** | 16.373 | 1.505.212 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/ProjectData/BERNTS-Staalconstructie.ifc` | `IFC2X3` | 937 | 937 | **1,00** | 2.063 | 126.232 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/BERNTS-Staalconstructie.ifc` | `IFC2X3` | 711 | 711 | **1,00** | 1.643 | 88.842 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/ProjectData/MULTICOM-Prefab.ifc` | `IFC2X3` | 42 | 42 | **1,00** | 337 | 45.217 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/HB_Nutsvoorzieningen.ifc` | `IFC2X3` | 3 | 3 | **1,00** | 52 | 158.574 |
| `Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/ProjectData/HB_Nutsvoorzieningen.ifc` | `IFC2X3` | 3 | 3 | **1,00** | 52 | 158.574 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/air-terminal-element.ifc` | `IFC4` | 1 | 1 | **1,00** | 2 | 400 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/basin-advanced-brep.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 1.212 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/basin-faceted-brep.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 315 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/basin-tessellation.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 234 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/bath-csg-solid.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 260 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/mapped-shape-with-transformation.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 12 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/mapped-shape-without-transformation.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 12 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/reinforcing-stirrup.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 1.344 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/tessellation-with-blob-texture.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 64 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/tessellation-with-image-texture.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 64 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/tessellation-with-pixel-texture.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 64 |
| `IFC4.3.x-sample-models/models/advanced-geometric-shape/basin-advanced-brep/basin-advanced-brep.ifc` | `IFC4X3` | 1 | 1 | **1,00** | 1 | 1.212 |
| `IFC4.3.x-sample-models/models/advanced-geometric-shape/basin-faceted-brep/basin-faceted-brep.ifc` | `IFC4X3` | 1 | 1 | **1,00** | 1 | 316 |
| `IFC4.3.x-sample-models/models/advanced-geometric-shape/basin-tessellation/basin-tessellation.ifc` | `IFC4X3` | 1 | 1 | **1,00** | 1 | 234 |
| `IFC4.3.x-sample-models/models/advanced-geometric-shape/bath-csg-solid/bath-csg-solid.ifc` | `IFC4X3` | 1 | 1 | **1,00** | 1 | 260 |
| `IFC4.3.x-sample-models/models/building-elements/reinforcing-stirrup/reinforcing-stirrup.ifc` | `IFC4X3` | 1 | 1 | **1,00** | 1 | 1.344 |
| `IFC4.3.x-sample-models/models/mapped-geometric-shape/mapped-shape-with-transformation/mapped-shape-with-transformation.ifc` | `IFC4X3` | 1 | 1 | **1,00** | 1 | 12 |
| `IFC4.3.x-sample-models/models/mapped-geometric-shape/mapped-shape-without-transformation/mapped-shape-without-transformation.ifc` | `IFC4X3` | 1 | 1 | **1,00** | 1 | 12 |
| `Sample-Test-Files/IFC 4.0.2.1 (IFC 4 ADD2 TC1)/ISO Spec - ReferenceView_V1.2/basin-tessellation.ifc` | `IFC4` | 1 | 1 | **1,00** | 1 | 234 |
| `Community-Sample-Test-Files/IFC 4.0.2.1 (IFC 4)/ISO Spec archive/air-terminal-library-object.ifc` | `IFC4` | 0 | 1 | **0,00** | 0 | 0 |
| `IFC4.3.x-sample-models/models/tessellated-shape-with-style/tessellation-with-blob-texture/tessellation-with-blob-texture.ifc` | `IFC4X3` | 0 | 1 | **0,00** | 0 | 0 |
| `IFC4.3.x-sample-models/models/tessellated-shape-with-style/tessellation-with-image-texture/tessellation-with-image-texture.ifc` | `IFC4X3` | 0 | 1 | **0,00** | 0 | 0 |
| `IFC4.3.x-sample-models/models/tessellated-shape-with-style/tessellation-with-pixel-texture/tessellation-with-pixel-texture.ifc` | `IFC4X3` | 0 | 1 | **0,00** | 0 | 0 |

---

## 7. Lista Priorizada de Mejoras Más Valiosas (Con Evidencia)

Ordenadas por impacto directo sobre el corpus evaluado, para que Nick pueda decidir cuáles abordar primero:

1. **Aceptar los esquemas `IFC4X3_RC1`, `IFC4X3_RC2` e `IFC4X1` en `crates/ifc-schema/src/lib.rs` (`Schema::from_header`):**
   - **Evidencia:** Elimina **21 de los 21 fallos de apertura** (`100 %` de los `failed-to-open` del corpus, 87,4 MB de modelos en `Community-Sample-Test-Files/dev archive/IFC 4.3.RC Archive/`, incluyendo `Viadotto Acerno_IFC4x3_RC2.ifc` de 36,93 MB, `P321_24159.ifc` de 20,76 MB y `4_Tunnel segments.ifc` de 12,17 MB). Actualmente `from_header` solo acepta `IFC4X3` o prefijo `IFC4X3_ADD` y `IFC4` o `IFC4_ADD`.
2. **Instanciado GPU extremo a extremo para `IfcMappedItem` (`A13` en `docs/06_mejoras.md`):**
   - **Evidencia:** **57 archivos** usan `IfcMappedItem` y **26 archivos** reutilizan mapas con **27.157 instancias redundantes** (`30.803` `IFCMAPPEDITEM` sobre `3.646` `IFCREPRESENTATIONMAP`, ratio **8,45×**). Emitir mallas base + matrices de instancia evitaría clonar vértices en los modelos con mayor huella de memoria y tiempo de stream del corpus: `Clinic_Plumbing.ifc` (**860,31 MB WASM**, 3,42M triángulos, 3.319 instancias redundantes), `chesapeake_bay_bridge_tunnel_4x3.ifc` (**203,81 MB WASM**, 5.194 instancias redundantes, ratio **134,18×**), `Molio_with_URIs.ifc` (**160,44 MB WASM**, 2.181 instancias redundantes), `Clinic_HVAC.ifc` (2.426 redundantes) y `Clinic_Electrical.ifc` (2.931 redundantes).
3. **Soporte de archivos comprimidos `.ifczip` en la carga:**
   - **Evidencia:** Desbloquea los **27 archivos `.ifczip`** del manifiesto (`Community-Sample-Test-Files/IFC 2.3.0.1 (IFC 2x3)/Schependomlaan/Coordination model and subcontractors models/BIMsight Projectdata1/*.ifczip`) que hoy se omiten porque `step-parser` requiere el flujo STEP descomprimido.
4. **Mejora del sellado de mallas abiertas para booleanas CSG (`void-on-open-mesh`, `boolean-on-open-mesh`) y cierre de contornos 2D (`open-cut-loop`):**
   - **Evidencia:**
     - En 3D, `void-on-open-mesh` deja **18 huecos sin restar** en **4 archivos** (`Duplex_A_20110907.ifc` ×8 y `1807_EP_AR_v18.ifc` ×1, más sus copias en `bench/`), y `boolean-on-open-mesh` afecta a `1807_EP_AR_v18.ifc` (×1).
     - En 2D (`cad-slicer`), `open-cut-loop` ocurre **198 veces en 20 archivos** (destacando `Clinic_Plumbing.ifc` ×92, `Duplex_MEP_20110907.ifc` ×39, `Duplex_Plumbing_20121113.ifc` ×29 y `IFC Schependomlaan.ifc` ×5), impidiendo sombrear esas secciones por brechas superiores a `10 mm` en mallas B-rep/teseladas no estancas.
5. **Implementar el recorte paramétrico `StartParam`/`EndParam` en barridos sobre polilíneas y curvas (`sweep-trim-ignored`):**
   - **Evidencia:** Afecta **42 veces** a `MULTICOM-Prefab.ifc` (`crates/ifc-geometry/src/model.rs:1388, 1491`), que hoy barre la directriz entera en lugar del sub-tramo parametrizado y es además el modelo `>= 1 MB` más lento por MB del corpus (`130,0 ms/MB` en kernel).
6. **Soportar `IfcRigidOperation` en georreferenciación (`IFC4X3`) y filtrar sin advertencia `IfcGeometricCurveSet` auxiliares en representaciones:**
   - **Evidencia:** `unsupported-coordinate-operation` impide aplicar la operación rígida en `geographic-referencing-rigid-operation.ifc` (1 archivo IFC4X3), y `unsupported-geometry` aparece en **8 archivos** (`GEELEN-Breedplaat V1/V2/V3.ifc` y `GEELEN-Dakvloer.ifc`, en `BIMsight Projectdata1/` y `ProjectData/`) por incluir `IfcGeometricCurveSet` junto a sólidos de cuerpo.
