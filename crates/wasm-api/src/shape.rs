//! One element's triangles for measuring and snapping. See `KernelPort.elementMesh`.

use crate::batches::usable_normal;
use glam::DVec3;
use ifc_geometry::ElementGeometry;
use ifc_geometry::hash::KeyedMap;

/// Corners closer than this, in metres, become one vertex.
const MERGE_GRID: f64 = 1e-6;
/// Neighbouring triangles turning more than this meet at an edge; less, they are one surface.
/// Circles have 32 sides, 11.25 degrees apart, so curved faces show no edges.
const CREASE_DEGREES: f64 = 20.0;

/// Absolute model coordinates in metres, three per vertex; three indices per triangle; two per
/// edge a user can see.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ElementShape {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub edges: Vec<u32>,
}

/// The triangles the stream would draw, every mesh of the element in one, with corners on the
/// same micrometre merged so neighbouring triangles share them. `None` when none is left.
pub fn element_shape(geometry: &ElementGeometry) -> Option<ElementShape> {
    let mut shape = ElementShape::default();
    let mut ids: KeyedMap<[i64; 3], u32> = KeyedMap::default();
    for element_mesh in &geometry.meshes {
        let mesh = &element_mesh.mesh;
        for triangle in &mesh.triangles {
            let corners = triangle.map(|id| mesh.positions[id as usize]);
            if usable_normal(corners).is_none() {
                continue;
            }
            let keys = corners.map(|corner| (corner / MERGE_GRID).round().as_i64vec3().to_array());
            if keys[0] == keys[1] || keys[1] == keys[2] || keys[0] == keys[2] {
                continue;
            }
            // A corner already seen keeps its first position, so check the triangle as it will be.
            let kept = [0, 1, 2].map(|at| match ids.get(&keys[at]) {
                Some(&index) => {
                    let start = index as usize * 3;
                    DVec3::from_slice(&shape.positions[start..start + 3])
                }
                None => corners[at],
            });
            if usable_normal(kept).is_none() {
                continue;
            }
            for (key, corner) in keys.into_iter().zip(kept) {
                let next = (shape.positions.len() / 3) as u32;
                let index = *ids.entry(key).or_insert_with(|| {
                    shape.positions.extend_from_slice(&corner.to_array());
                    next
                });
                shape.indices.push(index);
            }
        }
    }
    if shape.indices.is_empty() {
        return None;
    }
    shape.edges = feature_edges(&shape.positions, &shape.indices);
    Some(shape)
}

/// Edges where the surface turns by more than CREASE_DEGREES, and borders: an edge with one
/// triangle, or more than two. Never one inside a flat or gently curved face. Low index first.
fn feature_edges(positions: &[f64], indices: &[u32]) -> Vec<u32> {
    let point = |index: u32| {
        let at = index as usize * 3;
        DVec3::from_slice(&positions[at..at + 3])
    };
    let normals: Vec<DVec3> = indices
        .chunks(3)
        .map(|t| (point(t[1]) - point(t[0])).cross(point(t[2]) - point(t[0])).normalize_or_zero())
        .collect();
    // Each side of each triangle as (low, high, triangle); sorting puts shared sides together.
    let mut sides: Vec<(u32, u32, u32)> = Vec::with_capacity(indices.len());
    for (triangle, corners) in indices.chunks(3).enumerate() {
        for (a, b) in [(corners[0], corners[1]), (corners[1], corners[2]), (corners[2], corners[0])] {
            sides.push((a.min(b), a.max(b), triangle as u32));
        }
    }
    sides.sort_unstable();
    let crease = CREASE_DEGREES.to_radians().cos();
    let mut edges = Vec::new();
    for group in sides.chunk_by(|x, y| (x.0, x.1) == (y.0, y.1)) {
        let smooth = group.len() == 2
            && normals[group[0].2 as usize].dot(normals[group[1].2 as usize]) >= crease;
        if !smooth {
            edges.extend([group[0].0, group[0].1]);
        }
    }
    edges
}
