//! Drawings across per-model Workers: `docs/05` section 6.
//!
//! Each model turns its elements into frame-space chunks. One `Sheet`, in a Worker of its own,
//! gathers them and runs `cad_slicer::draw` once, so hidden lines work across models.

use crate::encode::severity;
use crate::json::{Object, ToJson, to_json};
use cad_slicer::{
    Axis, Cut, Drawing, DrawingMesh, DrawingOptions, DxfOptions, Frame, HatchStyle, Look,
    SpaceInput, SvgOptions, draw_with_spaces, to_dxf_with, to_svg_with,
};
use glam::{DMat4, DVec3};
use ifc_geometry::{ElementGeometry, Mesh, ModelEvaluator};
use spatial_tree::{Hatching, MAX_HATCH_ROWS, ModelData};

/// Words of an axial request before the optional transform.
const AXIAL_REQUEST_WORDS: usize = 7;
/// Words of an arbitrary plane request before the optional transform.
const PLANE_REQUEST_WORDS: usize = 11;

/// Sentinel `part` tag distinguishing an `IfcSpace` label record from a normal element mesh record.
const SPACE_RECORD_PART: u32 = u32::MAX;

/// What a drawing asks for, as the flat numbers the Worker sends. See `drawingRequest.ts`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawingRequest {
    pub options: DrawingOptions,
    pub include_hidden: bool,
    pub include_space_labels: bool,
    /// Frame coordinates from model metres, for a `map` frame.
    pub transform: Option<DMat4>,
}

impl DrawingRequest {
    /// Axial cuts: `[kind, position, look, depth, projection, flags, hidden, ...transform]`,
    /// where `kind` is 0 for a plan and 1 or 2 for sections on X and Y, and `flags` packs
    /// hatching (bit 0 = 1) and space labels (bit 1 = 2).
    /// Plane cuts: `[3, ox, oy, oz, nx, ny, nz, depth, projection, flags, hidden, ...transform]`.
    /// A NaN depth means no limit.
    pub fn decode(words: &[f64]) -> Option<Self> {
        let kind = *words.first()?;
        let (cut, rest) = match kind {
            0.0 => {
                if words.len() != AXIAL_REQUEST_WORDS && words.len() != AXIAL_REQUEST_WORDS + 16 {
                    return None;
                }
                (Cut::Plan { z: words[1] }, &words[3..])
            }
            1.0 | 2.0 => {
                if words.len() != AXIAL_REQUEST_WORDS && words.len() != AXIAL_REQUEST_WORDS + 16 {
                    return None;
                }
                let axis = if kind == 1.0 { Axis::X } else { Axis::Y };
                let look = if words[2] > 0.0 { Look::Positive } else { Look::Negative };
                (Cut::Section { axis, position: words[1], look }, &words[3..])
            }
            3.0 => {
                if words.len() != PLANE_REQUEST_WORDS && words.len() != PLANE_REQUEST_WORDS + 16 {
                    return None;
                }
                let origin = DVec3::new(words[1], words[2], words[3]);
                let normal = DVec3::new(words[4], words[5], words[6]);
                (Cut::Plane { origin, normal }, &words[7..])
            }
            _ => return None,
        };
        let flags = if rest[2].is_finite() && rest[2] >= 0.0 { rest[2] as u32 } else { 0 };
        let options = DrawingOptions {
            cut,
            depth: (!rest[0].is_nan()).then_some(rest[0]),
            include_projection: rest[1] != 0.0,
            include_hatching: (flags & 1) != 0,
        };
        let transform = (rest.len() > 4)
            .then(|| <[f64; 16]>::try_from(&rest[4..]).ok())
            .flatten()
            .map(|matrix| DMat4::from_cols_array(&matrix));
        Some(Self {
            options,
            include_hidden: rest[3] != 0.0,
            include_space_labels: (flags & 2) != 0,
            transform,
        })
    }
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// `[id, part, layer length, layer, hatch rows, (angle, spacing, offset) f64 per row, vertex
/// count, triangle count, positions, triangles]`, little-endian.
fn write_element(
    out: &mut Vec<u8>,
    express_id: u32,
    part: u32,
    layer: &str,
    hatching: &[Hatching],
    mesh: &Mesh,
) {
    put_u32(out, express_id);
    put_u32(out, part);
    put_u32(out, layer.len() as u32);
    out.extend_from_slice(layer.as_bytes());
    put_u32(out, hatching.len() as u32);
    for row in hatching {
        out.extend_from_slice(&row.angle_degrees.to_le_bytes());
        out.extend_from_slice(&row.spacing.to_le_bytes());
        out.extend_from_slice(&row.offset.to_le_bytes());
    }
    put_u32(out, mesh.positions.len() as u32);
    put_u32(out, mesh.triangles.len() as u32);
    for position in &mesh.positions {
        for value in position.to_array() {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    for triangle in &mesh.triangles {
        for index in triangle {
            put_u32(out, *index);
        }
    }
}

/// `[id, SPACE_RECORD_PART, name_len, name, quantity_area_m2 (NaN if absent), vertices, triangles, ...]`.
fn write_space(
    out: &mut Vec<u8>,
    express_id: u32,
    name: &str,
    quantity_area_m2: Option<f64>,
    mesh: &Mesh,
) {
    put_u32(out, express_id);
    put_u32(out, SPACE_RECORD_PART);
    put_u32(out, name.len() as u32);
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&quantity_area_m2.unwrap_or(f64::NAN).to_le_bytes());
    put_u32(out, mesh.positions.len() as u32);
    put_u32(out, mesh.triangles.len() as u32);
    for position in &mesh.positions {
        for value in position.to_array() {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    for triangle in &mesh.triangles {
        for index in triangle {
            put_u32(out, *index);
        }
    }
}

enum ChunkRecord {
    Element(Item),
    Space(SpaceInput),
}

struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        if count > self.bytes.len() {
            return None;
        }
        let (head, rest) = self.bytes.split_at(count);
        self.bytes = rest;
        Some(head)
    }

    fn u32(&mut self) -> Option<u32> {
        self.take(4)?.try_into().ok().map(u32::from_le_bytes)
    }

    fn f64(&mut self) -> Option<f64> {
        self.take(8)?.try_into().ok().map(f64::from_le_bytes)
    }

    fn mesh(&mut self) -> Option<Mesh> {
        let vertices = self.u32()? as usize;
        let triangles = self.u32()? as usize;
        if vertices.checked_mul(24)?.checked_add(triangles.checked_mul(12)?)? > self.bytes.len() {
            return None;
        }
        let mut mesh = Mesh {
            positions: Vec::with_capacity(vertices),
            triangles: Vec::with_capacity(triangles),
        };
        for _ in 0..vertices {
            let (x, y, z) = (self.f64()?, self.f64()?, self.f64()?);
            mesh.positions.push(DVec3::new(x, y, z));
        }
        for _ in 0..triangles {
            let triangle = [self.u32()?, self.u32()?, self.u32()?];
            if triangle.iter().any(|index| *index as usize >= vertices) {
                return None;
            }
            mesh.triangles.push(triangle);
        }
        Some(mesh)
    }

    /// Checks the size first: a bad count must not reserve gigabytes.
    fn record(&mut self, model_index: u32) -> Option<ChunkRecord> {
        let express_id = self.u32()?;
        let part = self.u32()?;
        if part == SPACE_RECORD_PART {
            let name_len = self.u32()? as usize;
            let name = String::from_utf8_lossy(self.take(name_len)?).into_owned();
            let raw_area = self.f64()?;
            let quantity_area_m2 = (!raw_area.is_nan()).then_some(raw_area);
            let mesh = self.mesh()?;
            return Some(ChunkRecord::Space(SpaceInput {
                model_id: model_index,
                element_id: express_id,
                name,
                quantity_area_m2,
                mesh,
            }));
        }
        let layer_length = self.u32()? as usize;
        let layer = String::from_utf8_lossy(self.take(layer_length)?).into_owned();
        let rows = self.u32()? as usize;
        if rows > MAX_HATCH_ROWS {
            return None;
        }
        let mut hatch = Vec::with_capacity(rows);
        for _ in 0..rows {
            let (angle, spacing, offset) = (self.f64()?, self.f64()?, self.f64()?);
            hatch.push(HatchStyle::new(angle, spacing).shifted(offset));
        }
        let mesh = self.mesh()?;
        let mut mesh = DrawingMesh::new(model_index, express_id, layer, mesh);
        mesh.hatch = hatch;
        Some(ChunkRecord::Element(Item { part, mesh }))
    }
}

/// Whether anything of an element can reach the sheet: behind the plane, within `depth`, and on
/// the plane itself when nothing is projected. Each corner is in frame coordinates.
fn reaches_sheet(mesh: &Mesh, frame: &Frame, options: &DrawingOptions) -> bool {
    let (mut near, mut far) = (f64::INFINITY, f64::NEG_INFINITY);
    for position in &mesh.positions {
        let depth = frame.depth(*position);
        near = near.min(depth);
        far = far.max(depth);
    }
    if far < 0.0 {
        return false;
    }
    // A depth that is not a length is ignored, and `draw` reports it.
    let limit = options.depth.filter(|limit| *limit >= 0.0);
    if limit.is_some_and(|limit| near > limit) {
        return false;
    }
    options.include_projection || near <= 0.0
}

/// One model's way through a drawing, on an evaluator of its own.
pub struct DrawingStream {
    evaluator: ModelEvaluator<'static>,
    ids: Vec<u32>,
    cursor: usize,
    frame: Option<Frame>,
    request: DrawingRequest,
}

impl DrawingStream {
    pub fn new(evaluator: ModelEvaluator<'static>, request: DrawingRequest) -> Self {
        let ids = evaluator.element_ids();
        let frame = Frame::of(request.options.cut);
        Self { evaluator, ids, cursor: 0, frame, request }
    }

    fn write(&self, geometry: ElementGeometry, data: &ModelData<'_>, out: &mut Vec<u8>) -> usize {
        let Some(frame) = &self.frame else { return 0 };
        let layer = data.layer_name(geometry.express_id, &geometry.type_name);
        let hatching = data.layer_hatching(geometry.express_id);
        let mut written = 0;
        for (part, element_mesh) in geometry.meshes.into_iter().enumerate() {
            let mut mesh = element_mesh.mesh;
            if let Some(transform) = &self.request.transform {
                for position in &mut mesh.positions {
                    *position = transform.transform_point3(*position);
                }
            }
            if reaches_sheet(&mesh, frame, &self.request.options) {
                written += mesh.triangles.len();
                write_element(out, geometry.express_id, part as u32, &layer, &hatching, &mesh);
            }
        }
        written
    }

    fn write_space(&self, geometry: ElementGeometry, data: &ModelData<'_>, out: &mut Vec<u8>) -> usize {
        let Some(frame) = &self.frame else { return 0 };
        let mut combined = Mesh::default();
        for element_mesh in geometry.meshes {
            let mut mesh = element_mesh.mesh;
            if let Some(transform) = &self.request.transform {
                for position in &mut mesh.positions {
                    *position = transform.transform_point3(*position);
                }
            }
            let base = combined.positions.len() as u32;
            combined.positions.extend(mesh.positions);
            combined.triangles.extend(
                mesh.triangles
                    .into_iter()
                    .map(|[a, b, c]| [a + base, b + base, c + base]),
            );
        }
        if combined.triangles.is_empty() {
            return 0;
        }
        // Only send spaces whose Z span crosses the plan cut plane.
        let cut_only = DrawingOptions::cut_only(self.request.options.cut);
        if !reaches_sheet(&combined, frame, &cut_only) {
            return 0;
        }
        let info = data.space_info(geometry.express_id);
        let written = combined.triangles.len();
        write_space(out, geometry.express_id, &info.name, info.quantity_area_m2, &combined);
        written
    }

    /// `None` when every element has been through. `max_triangles` is soft, as for batches: an
    /// element is never split.
    pub fn next_chunk(&mut self, data: &ModelData<'_>, max_triangles: usize) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        let mut triangles = 0;
        let want_spaces = self.request.include_space_labels
            && matches!(self.request.options.cut, Cut::Plan { .. });
        while self.cursor < self.ids.len() && (triangles < max_triangles || out.is_empty()) {
            let id = self.ids[self.cursor];
            self.cursor += 1;
            let Some(geometry) = self.evaluator.evaluate(id) else { continue };
            if !geometry.hidden_by_default {
                triangles += self.write(geometry, data, &mut out);
            } else if want_spaces && geometry.type_name.eq_ignore_ascii_case("IfcSpace") {
                triangles += self.write_space(geometry, data, &mut out);
            }
        }
        (!out.is_empty()).then_some(out)
    }

    pub fn evaluator(&self) -> &ModelEvaluator<'static> {
        &self.evaluator
    }
}

struct Item {
    part: u32,
    mesh: DrawingMesh,
}

/// A problem with the sheet as a whole or one of its elements.
struct SheetDiagnostic {
    model_index: Option<u32>,
    express_id: Option<u32>,
    code: &'static str,
    message: String,
}

impl ToJson for SheetDiagnostic {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("severity", severity(self.code))
            .field("code", self.code)
            .field("message", &self.message)
            .some("modelIndex", &self.model_index)
            .some("expressId", &self.express_id)
            .end();
    }
}

/// How `Sheet::export` should serialise.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportOptions {
    pub svg: bool,
    pub scale: f64,
    pub show_hidden: bool,
    pub show_hatching: bool,
    pub comment: Option<String>,
}

/// One drawing: its meshes until `generate`, its 2D data afterwards.
pub struct SheetStore {
    request: DrawingRequest,
    items: Vec<Item>,
    spaces: Vec<SpaceInput>,
    bad_chunks: Vec<u32>,
    drawing: Option<Drawing>,
}

impl SheetStore {
    pub fn new(request: DrawingRequest) -> Self {
        Self {
            request,
            items: Vec::new(),
            spaces: Vec::new(),
            bad_chunks: Vec::new(),
            drawing: None,
        }
    }

    /// A malformed chunk loses that model whole, what it sent before and after, so half a model
    /// is never drawn. It is reported once, and it never panics.
    pub fn add_chunk(&mut self, model_index: u32, chunk: &[u8]) {
        if self.bad_chunks.contains(&model_index) {
            return;
        }
        let mut reader = Reader { bytes: chunk };
        while !reader.bytes.is_empty() {
            match reader.record(model_index) {
                Some(ChunkRecord::Element(item)) => self.items.push(item),
                Some(ChunkRecord::Space(space)) => self.spaces.push(space),
                None => {
                    self.items.retain(|item| item.mesh.model_id != model_index);
                    self.spaces.retain(|space| space.model_id != model_index);
                    self.bad_chunks.push(model_index);
                    return;
                }
            }
        }
    }

    pub fn drop_model(&mut self, model_index: u32) {
        self.items.retain(|item| item.mesh.model_id != model_index);
        self.spaces.retain(|space| space.model_id != model_index);
        self.bad_chunks.retain(|index| *index != model_index);
    }

    /// Cuts everything once and frees the meshes. Returns the diagnostics as JSON.
    pub fn generate(&mut self) -> String {
        let mut items = std::mem::take(&mut self.items);
        items.sort_by_key(|item| (item.mesh.model_id, item.mesh.element_id, item.part));
        let meshes: Vec<DrawingMesh> = items.into_iter().map(|item| item.mesh).collect();
        let mut spaces = std::mem::take(&mut self.spaces);
        spaces.sort_by_key(|space| (space.model_id, space.element_id));
        let mut drawing = draw_with_spaces(&meshes, &spaces, &self.request.options);
        drop(meshes);
        drop(spaces);
        if !self.request.include_hidden {
            for layer in &mut drawing.layers {
                layer.hidden = Vec::new();
            }
        }
        let mut diagnostics: Vec<SheetDiagnostic> = self
            .bad_chunks
            .iter()
            .map(|index| SheetDiagnostic {
                model_index: Some(*index),
                express_id: None,
                code: "bad-drawing-chunk",
                message: "part of this model's geometry could not be read".to_string(),
            })
            .collect();
        diagnostics.extend(drawing.diagnostics.iter().map(|item| SheetDiagnostic {
            model_index: (item.element_id != 0).then_some(item.model_id),
            express_id: (item.element_id != 0).then_some(item.element_id),
            code: item.code,
            message: item.message.clone(),
        }));
        self.drawing = Some(drawing);
        to_json(&diagnostics)
    }

    /// `None` before `generate`.
    pub fn export(&self, options: &ExportOptions) -> Option<Vec<u8>> {
        let drawing = self.drawing.as_ref()?;
        let scaled;
        let drawing = if options.scale == 1.0 {
            drawing
        } else {
            scaled = drawing.scaled(options.scale);
            &scaled
        };
        Some(if options.svg {
            let svg = SvgOptions {
                include_hidden: options.show_hidden,
                include_hatch: options.show_hatching,
                millimetres_per_unit: 10.0 / options.scale,
                ..SvgOptions::default()
            };
            to_svg_with(drawing, &svg).into_bytes()
        } else {
            let dxf = DxfOptions {
                include_hidden: options.show_hidden,
                include_hatch: options.show_hatching,
                comment: options.comment.clone(),
            };
            to_dxf_with(drawing, &dxf)
        })
    }
}
