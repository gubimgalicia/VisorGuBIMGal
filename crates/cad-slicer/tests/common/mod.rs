//! Meshes and assertions shared by the tests. Every mesh is built here from first
//! principles, so no expected value comes from the slicer itself.

#![allow(dead_code)]

use cad_slicer::{Drawing, Layer, Loop};
use glam::DVec3;
use ifc_geometry::Mesh;

pub fn v(x: f64, y: f64, z: f64) -> DVec3 {
    DVec3::new(x, y, z)
}

pub fn cuboid(min: DVec3, max: DVec3) -> Mesh {
    Mesh::cuboid(min, max)
}

/// A closed cylinder standing on the XY plane, its axis along +Z.
pub fn cylinder(radius: f64, height: f64, segments: usize) -> Mesh {
    let ring = |z: f64| -> Vec<DVec3> {
        (0..segments)
            .map(|i| {
                let angle = std::f64::consts::TAU * i as f64 / segments as f64;
                v(radius * angle.cos(), radius * angle.sin(), z)
            })
            .collect()
    };
    let bottom = ring(0.0);
    let top = ring(height);
    let mut positions = bottom.clone();
    positions.extend(top.iter().copied());

    let count = segments as u32;
    let mut triangles = Vec::new();
    for i in 0..count {
        let next = (i + 1) % count;
        triangles.push([i, next, next + count]);
        triangles.push([i, next + count, i + count]);
        // Caps fan out from each ring's first vertex, so the fan skips it as a corner.
        if i > 0 {
            triangles.push([0, next, i]);
            triangles.push([count, i + count, next + count]);
        }
    }
    Mesh {
        positions,
        triangles,
    }
}

/// A square funnel: base on z = 0, apex on the axis at `height`.
pub fn pyramid(base: f64, height: f64) -> Mesh {
    let half = base / 2.0;
    let positions = vec![
        v(-half, -half, 0.0),
        v(half, -half, 0.0),
        v(half, half, 0.0),
        v(-half, half, 0.0),
        v(0.0, 0.0, height),
    ];
    let triangles = vec![
        [0, 2, 1],
        [0, 3, 2],
        [0, 1, 4],
        [1, 2, 4],
        [2, 3, 4],
        [3, 0, 4],
    ];
    Mesh {
        positions,
        triangles,
    }
}

pub fn layer<'a>(drawing: &'a Drawing, name: &str) -> &'a Layer {
    drawing
        .layers
        .iter()
        .find(|layer| layer.name == name)
        .unwrap_or_else(|| panic!("no layer {name}"))
}

/// Area of a loop, positive when counter-clockwise.
pub fn signed_area(ring: &Loop) -> f64 {
    ring.area()
}

pub fn bounds(ring: &Loop) -> (f64, f64, f64, f64) {
    let mut min = (f64::MAX, f64::MAX);
    let mut max = (f64::MIN, f64::MIN);
    for point in &ring.points {
        min = (min.0.min(point.x), min.1.min(point.y));
        max = (max.0.max(point.x), max.1.max(point.y));
    }
    (min.0, min.1, max.0, max.1)
}

/// A loop is sound when it closes, has no repeated neighbours and encloses something.
#[track_caller]
pub fn assert_sound(ring: &Loop) {
    assert!(ring.closed, "loop is open: {:?}", ring.points);
    assert!(ring.points.len() >= 3, "loop has {} points", ring.points.len());
    for i in 0..ring.points.len() {
        let next = (i + 1) % ring.points.len();
        assert!(
            ring.points[i].distance(ring.points[next]) > 1e-9,
            "repeated point in loop"
        );
    }
    assert!(ring.area().abs() > 1e-9, "loop encloses nothing");
}
