# 03 — Especificación del Kernel BIM/CAD Soberano (Rust/WASM)

**Propósito:** Especificación para el desarrollo de un kernel nativo propio en Rust compilado a WebAssembly, como alternativa soberana 100% permisiva (MIT / Apache-2.0) sin dependencia de `@ifc-lite`.

---

## 1. Reglas de Diseño e Independencia

1. **Licencias 100% permisivas:** Solo MIT o Dual MIT/Apache-2.0. Prohibición expresa de código bajo GPL, LGPL (incluyendo OpenCASCADE) o AGPL.
2. **Zero-Copy y Punteros Lineales:** Intercambio de buffers de geometría entre la memoria lineal de WASM y JavaScript/WebGPU mediante `Float32Array` y `Uint32Array` sin serialización JSON intermedia.
3. **Rust SIMD y Memoria:** Uso de `memchr` y `glam` para vectorización SIMD nativa en operaciones geométricas de alto rendimiento.

---

## 2. Primitivas Tecnológicas (Rust)

| Componente | Crate Rust | Licencia | Rol técnico |
|---|---|---|---|
| **Matemática 3D** | `glam` | MIT / Apache-2.0 | `Vec3A`, `Mat4`, `DVec3` (64 bits para georreferenciación). |
| **Lexer STEP** | `winnow` / `memchr` | MIT / Apache-2.0 | Parseo streaming ultra-rápido de archivos ISO 10303-21. |
| **Triangulación 2D** | `earcut` | MIT / ISC | Triangulación de perfiles y polígonos complejos con huecos. |
| **Aceleración Espacial** | `bvh` | MIT / Apache-2.0 | Bounding Volume Hierarchy para raycasting y planos de corte. |
| **Operaciones CSG** | `csgrs` / Half-Edge | MIT | Evaluación de huecos (`IfcOpeningElement`) en muros y losas. |
| **Exportación CAD** | Crate propio en Rust | MIT | Generación de entidades DXF (R12/R2000) y SVG. |
| **WASM Bridge** | `wasm-bindgen` | MIT / Apache-2.0 | Exposición de buffers binarios a WebGPU en el navegador. |

---

## 3. Workspace de Cargo (`crates/`)

```text
kernel-bim/
├── Cargo.toml
└── crates/
    ├── step-parser/       # Lexer y parser streaming de archivos STEP ISO 10303-21
    ├── ifc-schema/        # Tipos e índices por Express ID (IFC2X3, IFC4, IFC4X3)
    ├── ifc-geometry/      # Evaluación geométrica (extrusiones, sweeps, mallas y CSG)
    ├── spatial-tree/      # Jerarquía espacial y resolución de Property Sets (Psets)
    ├── cad-slicer/        # Generador de planos 2D: corte BVH, unión de bucles, DXF/SVG
    └── wasm-api/          # Fachada pública WASM con punteros a memoria compartida
```

---

## 4. Contrato de Intercambio de Memoria con WebGPU

```rust
// Fachada expuesta a TypeScript para transferencia zero-copy
#[wasm_bindgen]
pub struct RenderBufferView {
    pub vertex_ptr: *const f32,
    pub vertex_len: usize,
    pub index_ptr: *const u32,
    pub index_len: usize,
}
```
En TypeScript, el visor WebGPU consume directamente:
```typescript
const vertices = new Float32Array(wasmMemory.buffer, view.vertex_ptr, view.vertex_len);
const indices = new Uint32Array(wasmMemory.buffer, view.index_ptr, view.index_len);
device.queue.writeBuffer(gpuVertexBuffer, 0, vertices);
```
