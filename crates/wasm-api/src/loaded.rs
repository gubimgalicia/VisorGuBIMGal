//! An open model: its bytes, its index, and everything that borrows them.

use crate::batches::{Batch, GeometryStream};
use crate::drawing::{DrawingRequest, DrawingStream};
use crate::encode::{complete_json, diagnostics_json, snapshots_json};
use crate::json::to_json;
use crate::shape::element_shape;
pub use crate::shape::ElementShape;
use ifc_geometry::ModelEvaluator;
use spatial_tree::{ElementQuery, ModelData, SearchField};
use step_parser::{ParseError, StepIndex, index};

/// Owns the allocations that `LoadedModel`'s other fields borrow.
struct Allocation {
    bytes: *mut [u8],
    file: *mut StepIndex<'static>,
}

impl Allocation {
    fn new(bytes: Vec<u8>) -> Result<(Self, &'static StepIndex<'static>), ParseError> {
        let bytes: *mut [u8] = Box::into_raw(bytes.into_boxed_slice());
        // SAFETY: the slice stays allocated and unmoved until `drop` below. `LoadedModel`
        // declares `allocation` last, so every borrower has gone by then, and no `'static`
        // reference leaves this module.
        let view: &'static [u8] = unsafe { &*bytes };
        let parsed = index(view);
        match parsed {
            Ok(parsed) => {
                let file = Box::into_raw(Box::new(parsed));
                // SAFETY: as above.
                Ok((Self { bytes, file }, unsafe { &*file }))
            }
            Err(error) => {
                // SAFETY: `bytes` came from `Box::into_raw`, and the failed parse kept no borrow.
                drop(unsafe { Box::from_raw(bytes) });
                Err(error)
            }
        }
    }
}

impl Drop for Allocation {
    fn drop(&mut self) {
        // SAFETY: both came from `Box::into_raw` in `new`. The index borrows the bytes, so
        // it goes first.
        unsafe {
            drop(Box::from_raw(self.file));
            drop(Box::from_raw(self.bytes));
        }
    }
}

#[derive(Debug)]
pub enum OpenError {
    Parse(ParseError),
    UnsupportedSchema(Vec<String>),
}

struct ActiveStream {
    evaluator: ModelEvaluator<'static>,
    stream: GeometryStream,
}

struct Query {
    evaluator: ModelEvaluator<'static>,
    /// What the stream draws, ascending.
    drawn: Vec<u32>,
}

/// Storeys get the height of their placement, as their geometry is placed.
fn fill_levels(node: &mut spatial_tree::SpatialNode, evaluator: &mut ModelEvaluator<'static>) {
    if node.type_name.eq_ignore_ascii_case("IfcBuildingStorey") {
        node.level = evaluator.placement_origin(node.express_id).map(|origin| origin.z);
    }
    for child in &mut node.children {
        fill_levels(child, evaluator);
    }
}

pub struct LoadedModel {
    stream: Option<ActiveStream>,
    drawing: Option<DrawingStream>,
    query: Option<Query>,
    data: ModelData<'static>,
    file: &'static StepIndex<'static>,
    _allocation: Allocation,
}

impl LoadedModel {
    pub fn open(bytes: Vec<u8>) -> Result<Self, OpenError> {
        let (allocation, file) = Allocation::new(bytes).map_err(OpenError::Parse)?;
        let Some(data) = ModelData::open(file) else {
            let identifiers = file.schema_identifiers().iter().map(ToString::to_string).collect();
            return Err(OpenError::UnsupportedSchema(identifiers));
        };
        Ok(Self { stream: None, drawing: None, query: None, data, file, _allocation: allocation })
    }

    pub fn summary_json(&self) -> String {
        to_json(&self.data.summary())
    }

    pub fn spatial_tree_json(&mut self) -> Option<String> {
        let mut tree = self.data.spatial_tree()?;
        if let Some(query) = self.query_evaluator() {
            fill_levels(&mut tree.root, &mut query.evaluator);
        }
        Some(to_json(&tree))
    }

    /// The evaluator for one-off questions, made on first use.
    fn query_evaluator(&mut self) -> Option<&mut Query> {
        if self.query.is_none() {
            self.query = ModelEvaluator::new(self.file).ok().map(|evaluator| {
                let drawn = evaluator.element_ids();
                Query { evaluator, drawn }
            });
        }
        self.query.as_mut()
    }

    pub fn element_details_json(&self, express_id: u32) -> Option<String> {
        self.data.element_details(express_id).map(|details| to_json(&details))
    }

    /// One snapshot per product the geometry stream draws, ascending: the input of `diffModels`.
    pub fn element_snapshots_json(&self) -> String {
        let Ok(evaluator) = ModelEvaluator::new(self.file) else {
            return "[]".to_string();
        };
        let details: Vec<_> = evaluator
            .element_ids()
            .into_iter()
            .filter_map(|id| self.data.element_details(id))
            .collect();
        snapshots_json(&details)
    }

    /// `field` is an `ElementQuery['field']` of the contract; `None` for any other.
    pub fn find_elements(
        &self,
        field: &str,
        text: &str,
        property_name: Option<&str>,
    ) -> Option<Vec<u32>> {
        let field = match field {
            "any" => SearchField::Any,
            "name" => SearchField::Name,
            "class" => SearchField::Class,
            "globalId" => SearchField::GlobalId,
            "property" => SearchField::Property,
            _ => return None,
        };
        Some(self.data.find_elements(&ElementQuery {
            field,
            text: text.to_string(),
            property_name: property_name.map(str::to_string),
        }))
    }

    /// `None` for an id the stream does not draw. Its own evaluator, kept for the next query.
    pub fn element_mesh(&mut self, express_id: u32) -> Option<ElementShape> {
        let query = self.query_evaluator()?;
        query.drawn.binary_search(&express_id).ok()?;
        element_shape(&query.evaluator.evaluate(express_id)?)
    }

    /// Starts from the first element. Evaluator caches last only as long as the stream.
    pub fn start_stream(&mut self) {
        self.stream = ModelEvaluator::new(self.file).ok().map(|evaluator| {
            let stream = GeometryStream::new(evaluator.element_ids()).with_instances(evaluator.instance_uses());
            ActiveStream { evaluator, stream }
        });
    }

    pub fn next_batch(&mut self, max_triangles: usize) -> Option<Batch> {
        let active = self.stream.as_mut()?;
        active.stream.next_batch(&mut active.evaluator, max_triangles)
    }

    pub fn processed_elements(&self) -> usize {
        self.stream.as_ref().map_or(0, |active| active.stream.processed())
    }

    pub fn total_elements(&self) -> usize {
        self.stream.as_ref().map_or(0, |active| active.stream.total())
    }

    /// Its own evaluator, so a drawing can interleave with a geometry stream.
    pub fn start_drawing(&mut self, request: DrawingRequest) {
        self.drawing = ModelEvaluator::new(self.file)
            .ok()
            .map(|evaluator| DrawingStream::new(evaluator, request));
    }

    pub fn next_drawing_chunk(&mut self, max_triangles: usize) -> Option<Vec<u8>> {
        self.drawing.as_mut()?.next_chunk(&self.data, max_triangles)
    }

    /// Ends the drawing, frees its caches, and returns its diagnostics as JSON.
    pub fn finish_drawing(&mut self) -> String {
        let drawing = self.drawing.take();
        let diagnostics: Vec<_> = drawing
            .iter()
            .flat_map(|drawing| drawing.evaluator().diagnostics())
            .collect();
        diagnostics_json(&diagnostics)
    }

    /// Ends the stream, frees its caches, and returns the closing event.
    pub fn finish_stream(&mut self) -> String {
        let Some(active) = self.stream.take() else {
            return complete_json(0, None, &[]);
        };
        let diagnostics: Vec<_> = active
            .evaluator
            .diagnostics()
            .iter()
            .chain(active.stream.diagnostics())
            .collect();
        complete_json(active.stream.mesh_count(), active.stream.bounds(), &diagnostics)
    }
}
