//! Drawings that span several models. A roof in one model hides a wall in another, so the
//! slicer has to see them together: docs/05 section 6 sends every model's meshes to one pass.

mod common;

use cad_slicer::{Cut, DrawingMesh, DrawingOptions, Segment, draw, to_dxf};
use common::{cuboid, layer, v};

/// A slab from one model over a small box from another, which it hides completely.
fn slab() -> DrawingMesh {
    DrawingMesh::new(0, 1, "slab", cuboid(v(0.0, 0.0, 1.5), v(4.0, 4.0, 2.0)))
}

fn hidden_box() -> DrawingMesh {
    DrawingMesh::new(1, 1, "box", cuboid(v(1.0, 1.0, 0.0), v(2.0, 2.0, 1.0)))
}

fn options() -> DrawingOptions {
    DrawingOptions {
        cut: Cut::Plan { z: 2.0 },
        depth: None,
        include_projection: true,
        include_hatching: false,
    }
}

fn length(segments: &[Segment]) -> f64 {
    segments.iter().map(Segment::length).sum()
}

#[test]
fn one_pass_hides_an_element_behind_another_model() {
    let drawing = draw(&[slab(), hidden_box()], &options());
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
    let drawn = layer(&drawing, "box");
    assert!(drawn.visible.is_empty(), "{:?}", drawn.visible);
    assert!((length(&drawn.hidden) - 4.0).abs() < 1e-9, "{:?}", drawn.hidden);
}

#[test]
fn drawing_each_model_alone_would_show_the_hidden_element() {
    // Why the models are not drawn apart and merged: the box has nothing above it on its own,
    // so every one of its edges would come out solid on the sheet.
    let drawing = draw(&[hidden_box()], &options());
    let drawn = layer(&drawing, "box");
    assert!(drawn.hidden.is_empty(), "{:?}", drawn.hidden);
    assert!((length(&drawn.visible) - 4.0).abs() < 1e-9, "{:?}", drawn.visible);
}

#[test]
fn sorting_by_model_and_element_makes_the_arrival_order_irrelevant() {
    // Workers finish in any order. Same layer on purpose: within a layer, order reaches the bytes.
    let walls = |model, element, x: f64| {
        DrawingMesh::new(model, element, "wall", cuboid(v(x, 0.0, 0.0), v(x + 1.0, 1.0, 3.0)))
    };
    let arrived = |mut meshes: Vec<DrawingMesh>| {
        meshes.sort_by_key(|mesh| (mesh.model_id, mesh.element_id));
        to_dxf(&draw(&meshes, &options()))
    };
    let first = arrived(vec![walls(0, 7, 0.0), walls(0, 9, 2.0), walls(1, 7, 4.0)]);
    let second = arrived(vec![walls(1, 7, 4.0), walls(0, 9, 2.0), walls(0, 7, 0.0)]);
    assert_eq!(first, second);
}
