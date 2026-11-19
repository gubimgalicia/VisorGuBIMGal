//! Turns evaluated elements into wire-format geometry batches. See `docs/05` section 3.

use std::collections::{BTreeMap, HashMap, VecDeque};

use glam::{DMat3, DMat4, DVec3, Vec3};
use ifc_geometry::hash::KeyedMap;
use ifc_geometry::{Diagnostic, ElementGeometry, Mesh, ModelEvaluator};

use crate::wire::MAX_QUANT_STEP;

/// Fewest uses of a shape, counted before the stream, for it to be sent once and drawn by
/// instances (`docs/09` §2, rule 5; Nick's decision in §7).
pub const MIN_INSTANCE_USES: u32 = 2;

/// Furthest a vertex may lie from its batch origin, in metres. Mirrors `MAX_BATCH_RADIUS`.
pub const MAX_BATCH_RADIUS: f64 = 4096.0;
/// Coordinates beyond this are corrupt: they would not survive the trip to `f32`. Metres.
const MAX_COORDINATE: f64 = 1e9;
/// An element wider than the radius is split: its triangles are halved until no side is longer
/// than `SPLIT_SIDE`, then grouped by the cell of `SPLIT_CELL` holding each centroid. A corner
/// lies within 2/3 of a side of its centroid, so a piece spans at most 4096 + 4/3 x 512 m on
/// each axis, and no corner is more than 3843 m, plus 0.9 m of rounding, from its centre.
const SPLIT_SIDE: f64 = 512.0;
const SPLIT_CELL: f64 = 4096.0;
/// Most triangles splitting may make of one element; past that it stays whole, flagged.
const MAX_SPLIT_TRIANGLES: u64 = 1 << 20;

const FLAG_TRANSPARENT: u32 = 1 << 0;
const FLAG_DEGRADED: u32 = 1 << 1;
const FLAG_HIDDEN_BY_DEFAULT: u32 = 1 << 2;
const FLAG_CLOSED: u32 = 1 << 3;

/// One block of triangles, laid out as `GeometryBatch` in `GeometryBatch.ts`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Batch {
    pub origin: [f64; 3],
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub mesh_table: Vec<u32>,
    /// Least and greatest of `positions` on each axis, relative to `origin` like them. Zeros
    /// while there are none. This is `quantBox` on the wire.
    pub min: [f32; 3],
    pub max: [f32; 3],
    /// Shapes this batch uses first in the stream (A13).
    pub shapes: Vec<ShapeData>,
    /// Four words per instance: express id, shape id, rgba, flags.
    pub instance_table: Vec<u32>,
    /// Twelve per instance: a 3x4 matrix by columns, shape to batch-local coordinates.
    pub instance_transforms: Vec<f32>,
    /// Everything the batch draws, relative to `origin`: its positions and its transformed shapes.
    /// This is `box` on the wire. Zeros while it draws nothing.
    pub draw_min: [f32; 3],
    pub draw_max: [f32; 3],
    /// Triangles drawn by instances, so batches hold as many triangles as before A13.
    pub(crate) instanced_triangles: usize,
    pub(crate) draws: bool,
}

/// A shape in its own coordinates, built as a part is, sent once per stream (A13).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShapeData {
    pub shape_id: u32,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    /// Exact box of `positions`.
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub closed: bool,
    /// Travels as `q16`: decided by its first instance's stretch.
    pub q16: bool,
}

impl Batch {
    fn triangle_count(&self) -> usize {
        self.indices.len() / 3 + self.instanced_triangles
    }

    /// Widens the drawn box by a box relative to `origin`.
    fn draw(&mut self, min: [f32; 3], max: [f32; 3]) {
        if self.draws {
            for axis in 0..3 {
                self.draw_min[axis] = self.draw_min[axis].min(min[axis]);
                self.draw_max[axis] = self.draw_max[axis].max(max[axis]);
            }
        } else {
            (self.draw_min, self.draw_max, self.draws) = (min, max, true);
        }
    }

    fn push(&mut self, element: &Prepared, shapes: &mut ShapeRegistry) {
        let origin = DVec3::from_array(self.origin);
        for part in &element.parts {
            if let Some(instance) = &part.instance
                && let Some(accepted) = shapes.accept(instance, self)
            {
                let mut flags = element.flags;
                if part.rgba & 0xFF != 0xFF {
                    flags |= FLAG_TRANSPARENT;
                }
                if accepted.closed {
                    flags |= FLAG_CLOSED;
                }
                // The shape travels re-centred on its own box: move the matrix to match.
                let columns = instance_columns(&(instance.transform * DMat4::from_translation(accepted.centre)), origin);
                self.instance_table.extend_from_slice(&[element.express_id, accepted.shape_id, part.rgba, flags]);
                self.instance_transforms.extend_from_slice(&columns);
                self.instanced_triangles += part.indices.len() / 3;
                let (min, max) = transformed_box(accepted.min, accepted.max, &columns);
                self.draw(min, max);
                continue;
            }
            let first_vertex = (self.positions.len() / 3) as u32;
            let first_index = self.indices.len() as u32;
            for position in &part.positions {
                let local = (*position - origin).as_vec3();
                let (min, max) = if self.positions.is_empty() {
                    (local, local)
                } else {
                    (Vec3::from_array(self.min).min(local), Vec3::from_array(self.max).max(local))
                };
                (self.min, self.max) = (min.to_array(), max.to_array());
                self.positions.extend_from_slice(&local.to_array());
            }
            for normal in &part.normals {
                self.normals.extend_from_slice(&normal.to_array());
            }
            self.indices.extend(part.indices.iter().map(|index| first_vertex + index));

            let mut flags = element.flags;
            if part.rgba & 0xFF != 0xFF {
                flags |= FLAG_TRANSPARENT;
            }
            if part.closed {
                flags |= FLAG_CLOSED;
            }
            self.mesh_table.extend_from_slice(&[
                element.express_id,
                first_vertex,
                part.positions.len() as u32,
                first_index,
                part.indices.len() as u32,
                part.rgba,
                flags,
            ]);
            let (min, max) = (self.min, self.max);
            self.draw(min, max);
        }
    }
}

/// An instance's matrix as it travels: the linear part by columns, then the translation relative
/// to the batch origin, all `f32`.
fn instance_columns(transform: &DMat4, origin: DVec3) -> [f32; 12] {
    let t = transform.w_axis.truncate() - origin;
    let (x, y, z) = (transform.x_axis, transform.y_axis, transform.z_axis);
    [x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z, t.x, t.y, t.z].map(|value| value as f32)
}

/// The box of a shape's box under an `f32` matrix, as `findBatchError` computes it, rounded
/// outward to `f32` so it holds every corner.
fn transformed_box(min: [f32; 3], max: [f32; 3], m: &[f32; 12]) -> ([f32; 3], [f32; 3]) {
    let m = m.map(f64::from);
    let (mut low, mut high) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for corner in 0..8 {
        let p: [f64; 3] = std::array::from_fn(|axis| f64::from(if corner >> axis & 1 == 1 { max[axis] } else { min[axis] }));
        for row in 0..3 {
            let value = m[row] * p[0] + m[3 + row] * p[1] + m[6 + row] * p[2] + m[9 + row];
            low[row] = low[row].min(value);
            high[row] = high[row].max(value);
        }
    }
    let down = |value: f64| {
        let rounded = value as f32;
        if f64::from(rounded) > value { rounded.next_down() } else { rounded }
    };
    let up = |value: f64| {
        let rounded = value as f32;
        if f64::from(rounded) < value { rounded.next_up() } else { rounded }
    };
    (low.map(down), high.map(up))
}

/// A part that may be drawn as an instance of a shared shape, if its batch accepts it.
#[derive(Debug, Clone)]
struct PartInstance {
    /// The leaf representation item: the shape's key.
    key: u32,
    transform: DMat4,
}

/// What `ShapeRegistry::accept` gives the batch.
struct Accepted {
    shape_id: u32,
    /// Where the shape's own coordinates were before it was re-centred.
    centre: DVec3,
    closed: bool,
    min: [f32; 3],
    max: [f32; 3],
}

struct ShapeEntry {
    shape_id: u32,
    centre: DVec3,
    /// Until the first batch that uses it takes it.
    pending: Option<ShapeData>,
    q16: bool,
    steps: [f64; 3],
    closed: bool,
    min: [f32; 3],
    max: [f32; 3],
}

/// The stream's shapes, by the leaf item they come from (A13, `docs/09` §2).
#[derive(Default)]
pub(crate) struct ShapeRegistry {
    /// Uses of each leaf item, counted before the stream. Empty: nothing is instanced.
    uses: HashMap<u32, u32>,
    entries: HashMap<u32, Option<ShapeEntry>>,
    next_id: u32,
}

impl ShapeRegistry {
    /// Whether a mesh may be drawn as an instance of `key`'s shape, building the shape the first
    /// time it is seen. `None` after that if it cannot be: too few uses, or no usable triangle.
    fn register(&mut self, key: u32, shape: &Mesh, closed: bool) -> bool {
        if self.uses.get(&key).copied().unwrap_or(0) < MIN_INSTANCE_USES {
            return false;
        }
        if let Some(entry) = self.entries.get(&key) {
            return entry.is_some();
        }
        let entry = shape_data(shape).map(|(mut data, centre)| {
            self.next_id += 1;
            data.shape_id = self.next_id;
            data.closed = closed;
            let steps = crate::wire::quant_steps(data.min, data.max);
            ShapeEntry { shape_id: data.shape_id, centre, q16: false, steps, closed, min: data.min, max: data.max, pending: Some(data) }
        });
        let usable = entry.is_some();
        self.entries.insert(key, entry);
        usable
    }

    /// Whether this batch draws the part as an instance. The first batch to accept a shape takes
    /// it, and the shape travels `q16` if its grid step, stretched by that instance, stays within
    /// `MAX_QUANT_STEP`. A later instance that would stretch a `q16` shape's step past it is
    /// drawn as a plain part instead.
    fn accept(&mut self, instance: &PartInstance, batch: &mut Batch) -> Option<Accepted> {
        let entry = self.entries.get_mut(&instance.key)?.as_mut()?;
        let (x, y, z) = (instance.transform.x_axis, instance.transform.y_axis, instance.transform.z_axis);
        let stretch = x.truncate().length().max(y.truncate().length()).max(z.truncate().length());
        let fits_grid = entry.steps.iter().all(|step| step * stretch <= MAX_QUANT_STEP);
        if let Some(mut data) = entry.pending.take() {
            entry.q16 = fits_grid;
            data.q16 = fits_grid;
            batch.shapes.push(data);
        } else if entry.q16 && !fits_grid {
            return None;
        }
        Some(Accepted { shape_id: entry.shape_id, centre: entry.centre, closed: entry.closed, min: entry.min, max: entry.max })
    }
}

/// A shape's vertices, normals and triangles, and the point its coordinates were moved from.
///
/// - Re-centred on its own box, in `f64`: some exporters write a mapped shape at site
///   coordinates, where `f32` keeps only centimetres. Each instance's matrix takes the move.
/// - Vertices are shared only between triangles of exactly the same normal: a shape may be
///   stretched unevenly, which would part normals that a rounded facing had merged.
///
/// `None` when no triangle is usable.
fn shape_data(mesh: &Mesh) -> Option<(ShapeData, DVec3)> {
    let usable: Vec<([u32; 3], [DVec3; 3], Vec3)> = mesh
        .triangles
        .iter()
        .filter_map(|triangle| {
            let corners = triangle.map(|id| mesh.positions[id as usize]);
            usable_normal(corners).map(|normal| (*triangle, corners, normal))
        })
        .collect();
    if usable.is_empty() {
        return None;
    }
    let (mut low, mut high) = (DVec3::INFINITY, DVec3::NEG_INFINITY);
    for (_, corners, _) in &usable {
        for corner in corners {
            (low, high) = (low.min(*corner), high.max(*corner));
        }
    }
    let centre = (low + high) / 2.0;
    let mut data = ShapeData::default();
    let mut shared: KeyedMap<(u32, [u32; 3]), u32> = KeyedMap::with_capacity_and_hasher(mesh.positions.len(), Default::default());
    let (mut min, mut max) = (Vec3::INFINITY, Vec3::NEG_INFINITY);
    for (triangle, corners, normal) in usable {
        let bits = normal.to_array().map(f32::to_bits);
        for (id, corner) in triangle.iter().zip(corners) {
            let next = (data.positions.len() / 3) as u32;
            let index = *shared.entry((*id, bits)).or_insert(next);
            if index == next {
                let local = (corner - centre).as_vec3();
                data.positions.extend_from_slice(&local.to_array());
                data.normals.extend_from_slice(&normal.to_array());
                (min, max) = (min.min(local), max.max(local));
            }
            data.indices.push(index);
        }
    }
    (data.min, data.max) = (min.to_array(), max.to_array());
    Some((data, centre))
}

/// The determinant of the matrix's linear part, as `f32` values multiplied out in `f64`, the
/// way `findBatchError` and the shaders see it.
fn f32_determinant(transform: &DMat4) -> f64 {
    let as_f32 = |value: f64| f64::from(value as f32);
    let m = DMat3::from_mat4(*transform);
    DMat3::from_cols(m.x_axis.map(as_f32), m.y_axis.map(as_f32), m.z_axis.map(as_f32)).determinant()
}

/// One mesh of an element, with its sharp edges split so each vertex has one normal.
struct Part {
    positions: Vec<DVec3>,
    normals: Vec<Vec3>,
    indices: Vec<u32>,
    rgba: u32,
    /// The mesh it came from is closed and winds outward, so its back faces never show from
    /// outside. Pieces of a split mesh keep it: they still lie on that surface.
    closed: bool,
    /// Set when the part is a placed copy of a shape the batch may draw as an instance. The part
    /// itself is still built, so batching, the radius and splitting treat it like any other, and
    /// it is drawn as it is when the batch declines the instance. Pieces of a split mesh drop it.
    instance: Option<PartInstance>,
}

struct Prepared {
    express_id: u32,
    parts: Vec<Part>,
    flags: u32,
    min: DVec3,
    max: DVec3,
}

impl Prepared {
    fn triangle_count(&self) -> usize {
        self.parts.iter().map(|part| part.indices.len() / 3).sum()
    }

    /// The centre of the box, rounded to the metre, half away from zero.
    fn origin(&self) -> [f64; 3] {
        ((self.min + self.max) / 2.0).round().to_array()
    }

    fn fits(&self, origin: [f64; 3]) -> bool {
        let origin = DVec3::from_array(origin);
        let limit = MAX_BATCH_RADIUS * MAX_BATCH_RADIUS;
        self.parts
            .iter()
            .flat_map(|part| &part.positions)
            .all(|position| position.distance_squared(origin) <= limit)
    }

    /// Whether it fits a batch of its own. The box answers for nearly every element; rounding
    /// moves the origin by at most half a metre on each axis.
    fn fits_alone(&self) -> bool {
        let reach = (self.max - self.min).length() / 2.0 + 0.5 * 3f64.sqrt();
        reach <= MAX_BATCH_RADIUS || self.fits(self.origin())
    }

    /// Pieces of an element too wide for one batch, in a fixed order, each with the element's
    /// id and flags, or `None` when they would hold more than `MAX_SPLIT_TRIANGLES`.
    fn split(&self) -> Option<Vec<Prepared>> {
        // Halving every side `levels` times leaves 4^levels triangles: count before making any.
        let levels_of = |corners: &[DVec3; 3]| {
            let mut side = (0..3).map(|at| corners[at].distance(corners[(at + 1) % 3])).fold(0.0, f64::max);
            let mut levels = 0u32;
            while side > SPLIT_SIDE && levels <= 31 {
                side /= 2.0;
                levels += 1;
            }
            levels
        };
        let mut total = 0u64;
        for part in &self.parts {
            for triangle in part.indices.as_chunks::<3>().0 {
                let levels = levels_of(&triangle.map(|index| part.positions[index as usize]));
                if levels > 31 {
                    return None;
                }
                total = total.saturating_add(1 << (2 * levels));
            }
        }
        if total > MAX_SPLIT_TRIANGLES {
            return None;
        }

        // Per cell, one part for each part of the element, sharing corners of equal position and
        // normal. A BTreeMap keeps the pieces in the same order on every run.
        type Shared = KeyedMap<([u64; 3], [u32; 3]), u32>;
        let mut cells: BTreeMap<[i64; 3], Vec<(Part, Shared)>> = BTreeMap::new();
        for (index, part) in self.parts.iter().enumerate() {
            for triangle in part.indices.as_chunks::<3>().0 {
                let corners = triangle.map(|index| part.positions[index as usize]);
                // Every corner of a triangle carries its facing: see `prepare`.
                let normal = part.normals[triangle[0] as usize];
                // Depth first, so at most 3 triangles per level wait here, never all of them.
                let mut stack = vec![(corners, levels_of(&corners))];
                while let Some((piece, levels)) = stack.pop() {
                    if levels > 0 {
                        stack.extend(quarters(piece).map(|quarter| (quarter, levels - 1)));
                        continue;
                    }
                    let centroid = (piece[0] + piece[1] + piece[2]) / 3.0;
                    let cell = (centroid / SPLIT_CELL).floor().as_i64vec3().to_array();
                    let parts = cells.entry(cell).or_insert_with(|| {
                        let empty = |part: &Part| Part {
                            positions: Vec::new(),
                            normals: Vec::new(),
                            indices: Vec::new(),
                            rgba: part.rgba,
                            closed: part.closed,
                            instance: None,
                        };
                        self.parts.iter().map(|part| (empty(part), Shared::default())).collect()
                    });
                    let (out, shared) = &mut parts[index];
                    for corner in piece {
                        let key = (corner.to_array().map(f64::to_bits), normal.to_array().map(f32::to_bits));
                        let next = out.positions.len() as u32;
                        let at = *shared.entry(key).or_insert(next);
                        if at == next {
                            out.positions.push(corner);
                            out.normals.push(normal);
                        }
                        out.indices.push(at);
                    }
                }
            }
        }

        let pieces = cells.into_values().map(|parts| {
            let parts: Vec<Part> = parts.into_iter().map(|(part, _)| part).filter(|part| !part.indices.is_empty()).collect();
            let corners = parts.iter().flat_map(|part| &part.positions);
            let min = corners.clone().fold(DVec3::INFINITY, |min, corner| min.min(*corner));
            let max = corners.fold(DVec3::NEG_INFINITY, |max, corner| max.max(*corner));
            Prepared { express_id: self.express_id, parts, flags: self.flags, min, max }
        });
        Some(pieces.collect())
    }
}

/// The four triangles between a triangle's corners and the middles of its sides, each facing
/// the same way as the whole.
fn quarters([a, b, c]: [DVec3; 3]) -> [[DVec3; 3]; 4] {
    let (ab, bc, ca) = ((a + b) / 2.0, (b + c) / 2.0, (c + a) / 2.0);
    [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]
}

/// `None` when a corner is corrupt or the triangle has no area, so it has no normal.
pub(crate) fn usable_normal(corners: [DVec3; 3]) -> Option<Vec3> {
    if !corners.iter().all(|corner| corner.abs().max_element() <= MAX_COORDINATE) {
        return None;
    }
    let cross = (corners[1] - corners[0]).cross(corners[2] - corners[0]);
    let length = cross.length();
    (length > 0.0 && length.is_finite()).then(|| (cross / length).as_vec3())
}

/// Vertices are shared between triangles of the same facing. Curved surfaces stay faceted.
fn prepare(geometry: ElementGeometry, evaluator: &mut ModelEvaluator<'_>, shapes: &mut ShapeRegistry) -> (Option<Prepared>, usize) {
    let mut parts = Vec::new();
    let mut dropped = 0;
    let (mut min, mut max) = (DVec3::INFINITY, DVec3::NEG_INFINITY);

    for element_mesh in &geometry.meshes {
        let mesh = &element_mesh.mesh;
        let mut part = Part {
            positions: Vec::new(),
            normals: Vec::new(),
            indices: Vec::new(),
            rgba: element_mesh.rgba,
            closed: false,
            instance: None,
        };
        // Dropping a triangle with no area leaves no gap; dropping a corrupt one may.
        let mut gap = false;
        // A mesh normally uses each of its positions at least once, so reserving that many
        // saves the map from growing step by step.
        let mut shared: KeyedMap<(u32, u64), u32> =
            KeyedMap::with_capacity_and_hasher(mesh.positions.len(), Default::default());
        for triangle in &mesh.triangles {
            let corners = triangle.map(|id| mesh.positions[id as usize]);
            let Some(normal) = usable_normal(corners) else {
                dropped += 1;
                gap |= !corners.iter().all(|corner| corner.abs().max_element() <= MAX_COORDINATE);
                continue;
            };
            let facing = (normal * 32767.0).round().as_i16vec3().to_array();
            // One word instead of three to hash.
            let packed = facing.iter().fold(0, |packed, part| packed << 16 | u64::from(*part as u16));
            for (id, corner) in triangle.iter().zip(corners) {
                let next = part.positions.len() as u32;
                let index = *shared.entry((*id, packed)).or_insert(next);
                if index == next {
                    part.positions.push(corner);
                    part.normals.push(normal);
                    min = min.min(corner);
                    max = max.max(corner);
                }
                part.indices.push(index);
            }
        }
        if !part.indices.is_empty() {
            part.closed = !gap && element_mesh.closed.unwrap_or_else(|| mesh.is_closed_outward());
            // A13: a copy of a kept shape, placed by a finite matrix whose determinant is normal
            // and positive in f64 and in f32, with no corrupt triangle dropped.
            if let Some(instance) = &element_mesh.instance {
                let transform = instance.transform;
                let det = DMat3::from_mat4(transform).determinant();
                let usable = !gap
                    && transform.is_finite()
                    && det.is_normal()
                    && det > 0.0
                    && f32_determinant(&transform) >= f64::from(f32::MIN_POSITIVE);
                if usable {
                    let closed = evaluator.shape_closed(instance.key).unwrap_or(false);
                    if shapes.register(instance.key, &instance.shape, closed) {
                        part.instance = Some(PartInstance { key: instance.key, transform });
                    }
                }
            }
            parts.push(part);
        }
    }

    if parts.is_empty() {
        return (None, dropped);
    }
    let mut flags = 0;
    if geometry.degraded {
        flags |= FLAG_DEGRADED;
    }
    if geometry.hidden_by_default {
        flags |= FLAG_HIDDEN_BY_DEFAULT;
    }
    let prepared = Prepared { express_id: geometry.express_id, parts, flags, min, max };
    (Some(prepared), dropped)
}

/// Pulls batches out of an evaluator, element by element, so the Worker stays responsive.
pub struct GeometryStream {
    ids: Vec<u32>,
    cursor: usize,
    /// An element that did not fit the last batch, or the pieces of a split one still to go.
    pending: VecDeque<Prepared>,
    mesh_count: u32,
    bounds: Option<(DVec3, DVec3)>,
    diagnostics: Vec<Diagnostic>,
    shapes: ShapeRegistry,
}

impl GeometryStream {
    pub fn new(ids: Vec<u32>) -> Self {
        Self {
            ids,
            cursor: 0,
            pending: VecDeque::new(),
            mesh_count: 0,
            bounds: None,
            diagnostics: Vec::new(),
            shapes: ShapeRegistry::default(),
        }
    }

    /// Draws parts by instances of shapes used at least `MIN_INSTANCE_USES` times, with the
    /// uses `ModelEvaluator::instance_uses` counted (A13). Without it nothing is instanced.
    pub fn with_instances(mut self, uses: HashMap<u32, u32>) -> Self {
        self.shapes.uses = uses;
        self
    }

    pub fn processed(&self) -> usize {
        self.cursor
    }

    pub fn total(&self) -> usize {
        self.ids.len()
    }

    pub fn mesh_count(&self) -> u32 {
        self.mesh_count
    }

    /// Absolute model coordinates of everything visible by default.
    pub fn bounds(&self) -> Option<([f64; 3], [f64; 3])> {
        self.bounds.map(|(min, max)| (min.to_array(), max.to_array()))
    }

    /// Problems found here. The evaluator keeps its own.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    fn warn(&mut self, express_id: u32, code: &'static str, message: String) {
        self.diagnostics.push(Diagnostic { express_id: Some(express_id), code, message });
    }

    fn advance(&mut self, evaluator: &mut ModelEvaluator<'_>) -> Option<Prepared> {
        while self.cursor < self.ids.len() {
            let id = self.ids[self.cursor];
            self.cursor += 1;
            // Expressid 0 means "no element" on the wire.
            if id == 0 {
                self.warn(id, "invalid-express-id", "element #0 skipped".into());
                continue;
            }
            let Some(geometry) = evaluator.evaluate(id) else { continue };
            let (prepared, dropped) = prepare(geometry, evaluator, &mut self.shapes);
            if dropped > 0 {
                let message = format!("{dropped} degenerate or corrupt triangles dropped");
                self.warn(id, "invalid-triangles", message);
            }
            if let Some(mut prepared) = prepared {
                if dropped > 0 {
                    prepared.flags |= FLAG_DEGRADED;
                }
                if prepared.fits_alone() {
                    return Some(prepared);
                }
                // Too wide: its pieces go in turn. One that cannot split stays whole, and
                // `next_batch` flags it.
                let Some(pieces) = prepared.split() else { return Some(prepared) };
                self.pending.extend(pieces);
                if let Some(first) = self.pending.pop_front() {
                    return Some(first);
                }
            }
        }
        None
    }

    fn record(&mut self, element: &Prepared) {
        self.mesh_count += element.parts.len() as u32;
        if element.flags & FLAG_HIDDEN_BY_DEFAULT == 0 {
            let (min, max) = self.bounds.unwrap_or((element.min, element.max));
            self.bounds = Some((min.min(element.min), max.max(element.max)));
        }
    }

    /// The next batch, or `None` when every element has been processed.
    pub fn next_batch(
        &mut self,
        evaluator: &mut ModelEvaluator<'_>,
        max_triangles: usize,
    ) -> Option<Batch> {
        let mut batch: Option<Batch> = None;
        loop {
            let element = match self.pending.pop_front() {
                Some(element) => element,
                None => match self.advance(evaluator) {
                    Some(element) => element,
                    None => return batch,
                },
            };
            match &mut batch {
                Some(open) => {
                    let room = open.triangle_count() + element.triangle_count() <= max_triangles;
                    if !room || !element.fits(open.origin) {
                        self.pending.push_front(element);
                        return batch;
                    }
                    open.push(&element, &mut self.shapes);
                    self.record(&element);
                }
                None => {
                    let mut element = element;
                    let origin = element.origin();
                    let oversized = !element.fits_alone();
                    if oversized {
                        // Rule 2 of docs/09 section 2: an element drawn whole past the radius is
                        // never instanced.
                        for part in &mut element.parts {
                            part.instance = None;
                        }
                        element.flags |= FLAG_DEGRADED;
                        let message = format!("element exceeds {MAX_BATCH_RADIUS} m from its origin");
                        self.warn(element.express_id, "batch-radius-exceeded", message);
                    }
                    let mut open = Batch { origin, ..Batch::default() };
                    open.push(&element, &mut self.shapes);
                    self.record(&element);
                    if oversized {
                        return Some(open);
                    }
                    batch = Some(open);
                }
            }
        }
    }
}
