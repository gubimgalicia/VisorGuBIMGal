//! WebAssembly facade of the kernel. Owner: Claude (T-033). Contract: `docs/05_kernel_contract.md`.

pub mod batches;
pub mod drawing;
mod encode;
mod json;
pub mod wire;
pub mod loaded;
pub mod shape;

use drawing::{DrawingRequest, ExportOptions, SheetStore};
use loaded::{LoadedModel, OpenError};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, Ordering};
use wasm_bindgen::prelude::*;

static ALLOCATION_FAILED: AtomicBool = AtomicBool::new(false);

/// Remembers a failed allocation. Rust then aborts, which in WASM is a bare `unreachable` trap
/// that JS cannot tell from any other bug.
struct TrackingAllocator;

impl TrackingAllocator {
    fn track(pointer: *mut u8) -> *mut u8 {
        if pointer.is_null() {
            ALLOCATION_FAILED.store(true, Ordering::Relaxed);
        }
        pointer
    }
}

// SAFETY: every call forwards to `System` with the caller's own arguments.
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract.
        Self::track(unsafe { System.alloc(layout) })
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: the caller upholds `GlobalAlloc::dealloc`'s contract.
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc_zeroed`'s contract.
        Self::track(unsafe { System.alloc_zeroed(layout) })
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract.
        Self::track(unsafe { System.realloc(pointer, layout, size) })
    }
}

#[global_allocator]
static ALLOCATOR: TrackingAllocator = TrackingAllocator;

/// Kernel version, so the app can detect a stale `.wasm` next to newer TypeScript.
#[wasm_bindgen(js_name = kernelVersion)]
pub fn kernel_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Whether memory ran out. Safe to call after a trap: it touches no `Model`.
#[wasm_bindgen(js_name = allocationFailed)]
pub fn allocation_failed() -> bool {
    ALLOCATION_FAILED.load(Ordering::Relaxed)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = crypto, js_name = getRandomValues, catch)]
    fn get_random_values(bytes: &mut [u8]) -> Result<(), JsValue>;
}

/// Gives the geometry's hash maps a fresh secret from the host's random source, so a file cannot
/// be written to make their keys collide. Without one they keep the secret they had.
fn renew_hash_secret() {
    #[cfg(target_arch = "wasm32")]
    {
        let mut bytes = [0u8; 32];
        if get_random_values(&mut bytes).is_ok() {
            let mut words = [0u64; 4];
            for (word, chunk) in words.iter_mut().zip(bytes.as_chunks::<8>().0) {
                *word = u64::from_le_bytes(*chunk);
            }
            ifc_geometry::hash::set_secret(words);
        }
    }
}

/// Encoded as `code|offset|message`, which the Worker turns into a `KernelError`.
fn open_error(error: OpenError) -> JsError {
    match error {
        OpenError::Parse(error) => JsError::new(&format!("parse|{}|{error}", error.offset())),
        OpenError::UnsupportedSchema(identifiers) => JsError::new(&format!(
            "unsupported-schema||schema not supported: {}",
            identifiers.join(", ")
        )),
    }
}

#[wasm_bindgen]
pub struct Model {
    inner: LoadedModel,
}

#[wasm_bindgen]
impl Model {
    #[wasm_bindgen(constructor)]
    pub fn open(bytes: Vec<u8>) -> Result<Model, JsError> {
        renew_hash_secret();
        LoadedModel::open(bytes).map(|inner| Model { inner }).map_err(open_error)
    }

    #[wasm_bindgen(js_name = summaryJson)]
    pub fn summary_json(&self) -> String {
        self.inner.summary_json()
    }

    #[wasm_bindgen(js_name = spatialTreeJson)]
    pub fn spatial_tree_json(&mut self) -> Option<String> {
        self.inner.spatial_tree_json()
    }

    #[wasm_bindgen(js_name = elementDetailsJson)]
    pub fn element_details_json(&self, express_id: u32) -> Option<String> {
        self.inner.element_details_json(express_id)
    }

    /// The products the stream draws, with their properties as the panel shows them.
    #[wasm_bindgen(js_name = elementSnapshotsJson)]
    pub fn element_snapshots_json(&self) -> String {
        self.inner.element_snapshots_json()
    }

    /// Ascending expressIds. See `KernelPort.findElements`.
    #[wasm_bindgen(js_name = findElements)]
    pub fn find_elements(
        &self,
        field: &str,
        text: &str,
        property_name: Option<String>,
    ) -> Result<Vec<u32>, JsError> {
        self.inner
            .find_elements(field, text, property_name.as_deref())
            .ok_or_else(|| JsError::new(&format!("internal||unknown search field: {field}")))
    }

    /// See `KernelPort.elementMesh`.
    #[wasm_bindgen(js_name = elementMesh)]
    pub fn element_mesh(&mut self, express_id: u32) -> Option<ShapeView> {
        self.inner.element_mesh(express_id).map(|shape| ShapeView { shape })
    }

    #[wasm_bindgen(js_name = startStream)]
    pub fn start_stream(&mut self) {
        self.inner.start_stream();
    }

    /// The Worker pulls the next batch only once it can send it.
    #[wasm_bindgen(js_name = nextBatch)]
    pub fn next_batch(&mut self, max_triangles: u32) -> Option<BatchView> {
        self.inner
            .next_batch(max_triangles as usize)
            .map(|batch| BatchView { batch: wire::pack(batch) })
    }

    #[wasm_bindgen(js_name = processedElements)]
    pub fn processed_elements(&self) -> u32 {
        self.inner.processed_elements() as u32
    }

    #[wasm_bindgen(js_name = totalElements)]
    pub fn total_elements(&self) -> u32 {
        self.inner.total_elements() as u32
    }

    #[wasm_bindgen(js_name = finishStream)]
    pub fn finish_stream(&mut self) -> String {
        self.inner.finish_stream()
    }

    /// The numbers of `DrawingRequest::decode`.
    #[wasm_bindgen(js_name = startDrawing)]
    pub fn start_drawing(&mut self, request: Vec<f64>) -> Result<(), JsError> {
        let request = DrawingRequest::decode(&request).ok_or_else(bad_request)?;
        self.inner.start_drawing(request);
        Ok(())
    }

    #[wasm_bindgen(js_name = nextDrawingChunk)]
    pub fn next_drawing_chunk(&mut self, max_triangles: u32) -> Option<Vec<u8>> {
        self.inner.next_drawing_chunk(max_triangles as usize)
    }

    #[wasm_bindgen(js_name = finishDrawing)]
    pub fn finish_drawing(&mut self) -> String {
        self.inner.finish_drawing()
    }
}

fn bad_request() -> JsError {
    JsError::new("internal||malformed drawing request")
}

/// One drawing, in a Worker of its own. See `docs/05` section 6.
#[wasm_bindgen]
pub struct Sheet {
    inner: SheetStore,
}

#[wasm_bindgen]
impl Sheet {
    #[wasm_bindgen(constructor)]
    pub fn new(request: Vec<f64>) -> Result<Sheet, JsError> {
        let request = DrawingRequest::decode(&request).ok_or_else(bad_request)?;
        Ok(Sheet { inner: SheetStore::new(request) })
    }

    #[wasm_bindgen(js_name = addChunk)]
    pub fn add_chunk(&mut self, model_index: u32, chunk: Vec<u8>) {
        self.inner.add_chunk(model_index, &chunk);
    }

    #[wasm_bindgen(js_name = dropModel)]
    pub fn drop_model(&mut self, model_index: u32) {
        self.inner.drop_model(model_index);
    }

    pub fn generate(&mut self) -> String {
        self.inner.generate()
    }

    /// `None` before `generate`.
    pub fn export(
        &self,
        svg: bool,
        scale: f64,
        show_hidden: bool,
        show_hatching: bool,
        comment: Option<String>,
    ) -> Option<Vec<u8>> {
        self.inner.export(&ExportOptions { svg, scale, show_hidden, show_hatching, comment })
    }
}

/// Each `take` copies one array out of WASM memory into a buffer JS owns, ready to transfer.
/// Positions, normals and indices come in one of two widths (contract v2, `docs/05` section 3):
/// the `take` of the other width returns an empty array.
#[wasm_bindgen]
pub struct BatchView {
    batch: wire::WireBatch,
}

#[wasm_bindgen]
impl BatchView {
    pub fn origin(&self) -> Vec<f64> {
        self.batch.origin.to_vec()
    }

    /// `box` as `[minX, minY, minZ, maxX, maxY, maxZ]`, relative to the origin.
    pub fn bounds(&self) -> Vec<f32> {
        [self.batch.min, self.batch.max].concat()
    }

    /// `quantBox` in the same layout: the grid of `q16` positions, and in `f32` the least and
    /// greatest position. Without instances it equals `bounds`.
    #[wasm_bindgen(js_name = quantBox)]
    pub fn quant_box(&self) -> Option<Vec<f32>> {
        Some([self.batch.min, self.batch.max].concat())
    }

    /// `"f32"` or `"q16"`.
    #[wasm_bindgen(js_name = vertexFormat)]
    pub fn vertex_format(&self) -> String {
        match self.batch.vertices {
            wire::Vertices::F32 { .. } => "f32".into(),
            wire::Vertices::Q16 { .. } => "q16".into(),
        }
    }

    /// `f32`: xyz per vertex.
    #[wasm_bindgen(js_name = takePositions)]
    pub fn take_positions(&mut self) -> Vec<f32> {
        match &mut self.batch.vertices {
            wire::Vertices::F32 { positions, .. } => std::mem::take(positions),
            wire::Vertices::Q16 { .. } => Vec::new(),
        }
    }

    /// `q16`: x, y, z on the grid and the record index, per vertex.
    #[wasm_bindgen(js_name = takePositionsQ16)]
    pub fn take_positions_q16(&mut self) -> Vec<u16> {
        match &mut self.batch.vertices {
            wire::Vertices::Q16 { positions, .. } => std::mem::take(positions),
            wire::Vertices::F32 { .. } => Vec::new(),
        }
    }

    /// `f32`: xyz per vertex.
    #[wasm_bindgen(js_name = takeNormals)]
    pub fn take_normals(&mut self) -> Vec<f32> {
        match &mut self.batch.vertices {
            wire::Vertices::F32 { normals, .. } => std::mem::take(normals),
            wire::Vertices::Q16 { .. } => Vec::new(),
        }
    }

    /// `q16`: two octahedral components per vertex.
    #[wasm_bindgen(js_name = takeNormalsOct)]
    pub fn take_normals_oct(&mut self) -> Vec<i16> {
        match &mut self.batch.vertices {
            wire::Vertices::Q16 { normals, .. } => std::mem::take(normals),
            wire::Vertices::F32 { .. } => Vec::new(),
        }
    }

    /// Whether the indices are 16-bit: `takeIndicesU16` then holds them.
    #[wasm_bindgen(js_name = indicesAreU16)]
    pub fn indices_are_u16(&self) -> bool {
        matches!(self.batch.indices, wire::Indices::U16(_))
    }

    #[wasm_bindgen(js_name = takeIndices)]
    pub fn take_indices(&mut self) -> Vec<u32> {
        match &mut self.batch.indices {
            wire::Indices::U32(indices) => std::mem::take(indices),
            wire::Indices::U16(_) => Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = takeIndicesU16)]
    pub fn take_indices_u16(&mut self) -> Vec<u16> {
        match &mut self.batch.indices {
            wire::Indices::U16(indices) => std::mem::take(indices),
            wire::Indices::U32(_) => Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = takeMeshTable)]
    pub fn take_mesh_table(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.batch.mesh_table)
    }
}

/// As `BatchView`, for one element's shape.
#[wasm_bindgen]
pub struct ShapeView {
    shape: shape::ElementShape,
}

#[wasm_bindgen]
impl ShapeView {
    #[wasm_bindgen(js_name = takePositions)]
    pub fn take_positions(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.shape.positions)
    }

    #[wasm_bindgen(js_name = takeIndices)]
    pub fn take_indices(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.shape.indices)
    }

    #[wasm_bindgen(js_name = takeEdges)]
    pub fn take_edges(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.shape.edges)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_crate_version() {
        assert_eq!(kernel_version(), env!("CARGO_PKG_VERSION"));
    }
}
