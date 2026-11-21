//! Packs a finished batch for the wire, contract v2 (`docs/05` section 3, backlog A11): 16-bit
//! positions on the grid of the batch's own box with the record index in a fourth component,
//! octahedral 16-bit normals, and 16-bit indices where they fit. A batch that does not fit keeps
//! today's `f32` layout.

use crate::batches::{Batch, ShapeData};

/// Largest step of the 16-bit grid on any axis, in metres. A coarser batch stays `f32`.
/// Nick's decision on `docs/09` section 7: 1 mm, so a position is off by 0.5 mm at most.
pub const MAX_QUANT_STEP: f64 = 0.001;
/// Most records a `q16` batch may hold: the record index rides in a 16-bit component.
pub const MAX_Q16_RECORDS: usize = 65535;
/// Most vertices a batch may hold and still use 16-bit indices.
pub const MAX_U16_VERTICES: usize = 65536;

const GRID: f64 = 65535.0;
const RECORD_WORDS: usize = 7;

#[derive(Debug, Clone, PartialEq)]
pub enum Vertices {
    /// xyz per vertex, and xyz of a unit normal per vertex.
    F32 { positions: Vec<f32>, normals: Vec<f32> },
    /// xyzr per vertex, where r is the vertex's record in `mesh_table`; two octahedral
    /// components per normal.
    Q16 { positions: Vec<u16>, normals: Vec<i16> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Indices {
    U32(Vec<u32>),
    U16(Vec<u16>),
}

/// A batch as it crosses to JS.
#[derive(Debug, Clone, PartialEq)]
pub struct WireBatch {
    pub origin: [f64; 3],
    /// `box`: everything the batch draws, its vertices and its transformed shapes.
    pub min: [f32; 3],
    pub max: [f32; 3],
    /// `quantBox`: the exact box of the batch's own vertices, and the grid of `q16` ones.
    /// `None` when it has none, only instances. Without instances it equals `box`.
    pub quant: Option<([f32; 3], [f32; 3])>,
    pub vertices: Vertices,
    pub indices: Indices,
    pub mesh_table: Vec<u32>,
    pub shapes: Vec<WireShape>,
    pub instance_table: Vec<u32>,
    pub instance_transforms: Vec<f32>,
}

/// A shape as it crosses to JS (A13): `q16` on the grid of its own box, fourth component 0.
#[derive(Debug, Clone, PartialEq)]
pub struct WireShape {
    pub shape_id: u32,
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub closed: bool,
    pub vertices: Vertices,
    pub indices: Indices,
}

/// The grid step on each axis for a box, in metres.
pub fn quant_steps(min: [f32; 3], max: [f32; 3]) -> [f64; 3] {
    std::array::from_fn(|axis| (f64::from(max[axis]) - f64::from(min[axis])) / GRID)
}

/// Whether a batch can travel as `q16`.
pub fn fits_q16(batch: &Batch) -> bool {
    !batch.positions.is_empty()
        && batch.mesh_table.len() / RECORD_WORDS <= MAX_Q16_RECORDS
        && quant_steps(batch.min, batch.max).iter().all(|step| *step <= MAX_QUANT_STEP)
}

/// The grid of one axis: its least value, and steps per metre (0 on an axis without extent).
#[derive(Clone, Copy)]
struct Axis {
    min: f64,
    scale: f64,
}

impl Axis {
    fn new(min: f32, max: f32) -> Self {
        let extent = f64::from(max) - f64::from(min);
        Self { min: f64::from(min), scale: if extent > 0.0 { GRID / extent } else { 0.0 } }
    }

    /// One coordinate on the grid: `min` maps to 0 and `max` to 65535, to the nearest step.
    /// Adding a half and truncating rounds a non-negative value with one conversion, where
    /// `round` can be a library call.
    fn quantise(self, value: f32) -> u16 {
        (((f64::from(value) - self.min) * self.scale).clamp(0.0, GRID) + 0.5) as u16
    }
}

/// +1 or -1, never 0: `sign(0) = 0` would fold a normal with a zero component onto the wrong
/// side (`docs/09` section 3).
fn sign_not_zero(value: f64) -> f64 {
    if value >= 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// Octahedral encoding of a unit vector into two signed 16-bit values (`snorm16x2`).
pub fn oct_encode(normal: [f32; 3]) -> [i16; 2] {
    let [x, y, z] = normal.map(f64::from);
    let sum = x.abs() + y.abs() + z.abs();
    if !(sum > 0.0 && sum.is_finite()) {
        return [0, 0];
    }
    let inverse = 1.0 / sum;
    let (mut u, mut v) = (x * inverse, y * inverse);
    if z < 0.0 {
        let (folded_u, folded_v) = ((1.0 - v.abs()) * sign_not_zero(u), (1.0 - u.abs()) * sign_not_zero(v));
        (u, v) = (folded_u, folded_v);
    }
    // To the nearest of -32767..=32767: shifted up to stay non-negative, so truncating rounds.
    [u, v].map(|component| ((component.clamp(-1.0, 1.0) * 32767.0 + 32768.5) as i32 - 32768) as i16)
}

/// The record each vertex belongs to, from the mesh table's vertex ranges.
fn record_of_vertices(mesh_table: &[u32], vertex_count: usize) -> Vec<u16> {
    let mut records = vec![0u16; vertex_count];
    for (record, row) in mesh_table.as_chunks::<RECORD_WORDS>().0.iter().enumerate() {
        let (first, count) = (row[1] as usize, row[2] as usize);
        let end = (first + count).min(vertex_count);
        if first < end {
            records[first..end].fill(record as u16);
        }
    }
    records
}

/// x, y, z on the grid of a box and a fourth value per vertex (a record, or 0 in a shape), and
/// octahedral normals.
fn quantised(positions: &[f32], normals: &[f32], min: [f32; 3], max: [f32; 3], fourth: &[u16]) -> Vertices {
    let vertex_count = positions.len() / 3;
    let axes: [Axis; 3] = std::array::from_fn(|axis| Axis::new(min[axis], max[axis]));
    let mut packed = vec![0u16; vertex_count * 4];
    let corners = positions.as_chunks::<3>().0;
    for (at, (out, corner)) in packed.as_chunks_mut::<4>().0.iter_mut().zip(corners).enumerate() {
        let extra = fourth.get(at).copied().unwrap_or(0);
        *out = [axes[0].quantise(corner[0]), axes[1].quantise(corner[1]), axes[2].quantise(corner[2]), extra];
    }
    let mut octahedral = vec![0i16; vertex_count * 2];
    for (out, normal) in octahedral.as_chunks_mut::<2>().0.iter_mut().zip(normals.as_chunks::<3>().0) {
        *out = oct_encode(*normal);
    }
    Vertices::Q16 { positions: packed, normals: octahedral }
}

/// 16-bit indices up to 65,536 vertices.
fn indices_for(indices: Vec<u32>, vertex_count: usize) -> Indices {
    if vertex_count <= MAX_U16_VERTICES {
        Indices::U16(indices.iter().map(|index| *index as u16).collect())
    } else {
        Indices::U32(indices)
    }
}

fn pack_shape(shape: ShapeData) -> WireShape {
    let vertex_count = shape.positions.len() / 3;
    let vertices = if shape.q16 {
        quantised(&shape.positions, &shape.normals, shape.min, shape.max, &[])
    } else {
        Vertices::F32 { positions: shape.positions, normals: shape.normals }
    };
    WireShape { shape_id: shape.shape_id, min: shape.min, max: shape.max, closed: shape.closed, vertices, indices: indices_for(shape.indices, vertex_count) }
}

/// Packs a batch: `q16` when it fits (`fits_q16`), `f32` otherwise; 16-bit indices whenever the
/// batch has at most 65,536 vertices, in either format. Shapes are packed as their first
/// instance decided.
pub fn pack(batch: Batch) -> WireBatch {
    let vertex_count = batch.positions.len() / 3;
    let quant = (vertex_count > 0).then_some((batch.min, batch.max));
    let vertices = if fits_q16(&batch) {
        let records = record_of_vertices(&batch.mesh_table, vertex_count);
        quantised(&batch.positions, &batch.normals, batch.min, batch.max, &records)
    } else {
        Vertices::F32 { positions: batch.positions, normals: batch.normals }
    };
    WireBatch {
        origin: batch.origin,
        min: batch.draw_min,
        max: batch.draw_max,
        quant,
        vertices,
        indices: indices_for(batch.indices, vertex_count),
        mesh_table: batch.mesh_table,
        shapes: batch.shapes.into_iter().map(pack_shape).collect(),
        instance_table: batch.instance_table,
        instance_transforms: batch.instance_transforms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The decoder of `docs/09` section 3, as the shaders and `expand-batch.mjs` run it.
    fn oct_decode([sx, sy]: [i16; 2]) -> [f64; 3] {
        let (mut x, mut y) = ((f64::from(sx) / 32767.0).max(-1.0), (f64::from(sy) / 32767.0).max(-1.0));
        let z = 1.0 - x.abs() - y.abs();
        if z < 0.0 {
            let ox = x;
            x = (1.0 - y.abs()) * sign_not_zero(ox);
            y = (1.0 - ox.abs()) * sign_not_zero(y);
        }
        let length = (x * x + y * y + z * z).sqrt();
        [x / length, y / length, z / length]
    }

    fn degrees_between(a: [f32; 3], b: [f64; 3]) -> f64 {
        let length = a.iter().map(|c| f64::from(*c).powi(2)).sum::<f64>().sqrt();
        let dot: f64 = (0..3).map(|axis| f64::from(a[axis]) / length * b[axis]).sum();
        dot.clamp(-1.0, 1.0).acos().to_degrees()
    }

    #[test]
    fn octahedral_round_trip_stays_within_a_hundredth_of_a_degree() {
        let h = std::f32::consts::FRAC_1_SQRT_2;
        // The two folds that `sign(0) = 0` breaks in the encoder (docs/09 section 5), the axes,
        // and a spread of directions over the whole sphere.
        let mut normals = vec![[0.0, h, -h], [h, 0.0, -h], [0.0, -h, -h], [-h, 0.0, -h]];
        normals.extend([[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]]);
        for i in 0..2000 {
            let z = 1.0 - 2.0 * (i as f64 + 0.5) / 2000.0;
            let angle = i as f64 * 2.399_963_229_728_653;
            let r = (1.0 - z * z).sqrt();
            normals.push([(r * angle.cos()) as f32, (r * angle.sin()) as f32, z as f32]);
        }
        let mut worst = 0.0f64;
        for normal in normals {
            let error = degrees_between(normal, oct_decode(oct_encode(normal)));
            assert!(error < 0.01, "{normal:?} decodes {error} degrees off");
            worst = worst.max(error);
        }
        assert!(worst > 0.0);
    }

    #[test]
    fn a_zero_component_folds_to_its_own_side() {
        // u = 0 folds with the sign of u. With sign(0) = 0 it would encode as [0, 32767], which
        // decodes to (0, 1, 0): 45 degrees off, on the wrong side.
        let h = std::f32::consts::FRAC_1_SQRT_2;
        assert_eq!(oct_encode([0.0, h, -h]), [16384, 32767]);
        let decoded = oct_decode(oct_encode([0.0, h, -h]));
        assert!(decoded[2] < -0.7, "{decoded:?}");
    }

    fn batch(positions: Vec<f32>, records: &[(u32, u32)]) -> Batch {
        let vertex_count = positions.len() / 3;
        let (mut min, mut max) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for corner in positions.as_chunks::<3>().0 {
            for axis in 0..3 {
                min[axis] = min[axis].min(corner[axis]);
                max[axis] = max[axis].max(corner[axis]);
            }
        }
        let mut mesh_table = Vec::new();
        for (record, (first, count)) in records.iter().enumerate() {
            mesh_table.extend_from_slice(&[record as u32 + 1, *first, *count, 0, 0, 0xFFFF_FFFF, 0]);
        }
        Batch {
            origin: [500_000.0, 4_700_000.0, 20.0],
            normals: [0.0, 0.0, 1.0].repeat(vertex_count),
            indices: (0..vertex_count as u32).collect(),
            positions,
            mesh_table,
            min,
            max,
            draw_min: min,
            draw_max: max,
            draws: true,
            ..Batch::default()
        }
    }

    #[test]
    fn ends_of_the_box_land_on_0_and_65535_and_records_ride_along() {
        let positions = vec![-10.0, 0.5, 3.0, 20.0, 1.5, 3.0, 5.0, 1.0, 3.0];
        let packed = pack(batch(positions, &[(0, 1), (1, 2)]));
        let Vertices::Q16 { positions, normals } = packed.vertices else { panic!("expected q16") };
        // Axis z has no extent: every vertex sits at 0.
        assert_eq!(positions, vec![0, 0, 0, 0, 65535, 65535, 0, 1, 32768, 32768, 0, 1]);
        assert_eq!(normals, vec![0, 0, 0, 0, 0, 0]);
        assert_eq!(packed.indices, Indices::U16(vec![0, 1, 2]));
    }

    #[test]
    fn decoded_positions_stay_within_half_a_step() {
        let positions: Vec<f32> = (0..3000).map(|i| ((i * 7919) % 65000) as f32 / 1000.0 - 30.0).collect();
        let source = batch(positions.clone(), &[(0, 1000)]);
        let (min, max) = (source.min, source.max);
        let steps = quant_steps(min, max);
        let Vertices::Q16 { positions: q, .. } = pack(source).vertices else { panic!("expected q16") };
        for (corner, packed) in positions.as_chunks::<3>().0.iter().zip(q.as_chunks::<4>().0) {
            for axis in 0..3 {
                let decoded = f64::from(min[axis]) + f64::from(packed[axis]) / GRID * (f64::from(max[axis]) - f64::from(min[axis]));
                let error = (decoded - f64::from(corner[axis])).abs();
                assert!(error <= steps[axis] / 2.0 + 1e-9, "axis {axis}: {error}");
            }
        }
    }

    #[test]
    fn a_step_over_a_millimetre_keeps_f32() {
        // 65.535 m would be exactly 1 mm steps, but is not exact in f32: test either side of it.
        let fits = batch(vec![0.0, 0.0, 0.0, 65.5, 0.0, 0.0], &[(0, 2)]);
        assert!(fits_q16(&fits));
        let wide = batch(vec![0.0, 0.0, 0.0, 65.6, 0.0, 0.0], &[(0, 2)]);
        assert!(!fits_q16(&wide));
        assert!(matches!(pack(wide).vertices, Vertices::F32 { .. }));
    }

    #[test]
    fn too_many_records_keep_f32() {
        let records: Vec<(u32, u32)> = (0..=MAX_Q16_RECORDS as u32).map(|r| (r, 1)).collect();
        let positions: Vec<f32> = (0..records.len()).flat_map(|i| [(i % 10) as f32, 0.0, 0.0]).collect();
        assert!(!fits_q16(&batch(positions.clone(), &records)));
        assert!(fits_q16(&batch(positions[3..].to_vec(), &records[..MAX_Q16_RECORDS])));
    }

    #[test]
    fn indices_widen_past_65536_vertices() {
        let at = |count: usize| batch((0..count).flat_map(|i| [(i % 100) as f32 / 100.0, 0.0, 0.0]).collect(), &[(0, count as u32)]);
        assert!(matches!(pack(at(MAX_U16_VERTICES)).indices, Indices::U16(_)));
        assert!(matches!(pack(at(MAX_U16_VERTICES + 1)).indices, Indices::U32(_)));
    }
}
