//! The same input must give the same bytes, twice (TC-005).

mod common;

use cad_slicer::{
    Cut, DrawingMesh, DrawingOptions, HatchStyle, SvgOptions, draw, to_dxf, to_svg_with,
};
use common::{cuboid, cylinder, v};
use ifc_geometry::subtract;

fn scene() -> Vec<DrawingMesh> {
    let mut concrete = DrawingMesh::new(
        1,
        10,
        "Hormigón armado",
        subtract(
            &cuboid(v(0.0, 0.0, 0.0), v(4.0, 4.0, 1.0)),
            &cuboid(v(1.5, 1.5, -0.5), v(2.5, 2.5, 1.5)),
        )
        .expect("simple difference"),
    );
    concrete.hatch = vec![HatchStyle::new(45.0, 0.25)];
    vec![
        concrete,
        DrawingMesh::new(1, 11, "Steel", cylinder(0.4, 3.0, 16)),
        DrawingMesh::new(2, 20, "Madera", cuboid(v(5.0, 0.0, 0.0), v(7.0, 1.0, 1.0))),
        DrawingMesh::new(2, 21, "Madera", cuboid(v(5.0, 0.5, 0.0), v(7.0, 0.75, 2.5))),
    ]
}

fn options() -> DrawingOptions {
    DrawingOptions {
        cut: Cut::Plan { z: 1.0 },
        depth: None,
        include_projection: true,
        include_hatching: true,
    }
}

#[test]
fn two_runs_give_the_same_drawing() {
    let first = draw(&scene(), &options());
    let second = draw(&scene(), &options());
    assert_eq!(first, second);
    assert_eq!(first.layers.len(), 3);
    assert!(first.layers.iter().all(|layer| !layer.loops.is_empty()));
}

#[test]
fn two_runs_give_the_same_dxf_bytes() {
    let first = to_dxf(&draw(&scene(), &options()));
    let second = to_dxf(&draw(&scene(), &options()));
    assert_eq!(first, second);
    assert!(!first.is_empty());
}

#[test]
fn two_runs_give_the_same_svg() {
    let svg = SvgOptions { layer_labels: true, ..SvgOptions::default() };
    let first = to_svg_with(&draw(&scene(), &options()), &svg);
    let second = to_svg_with(&draw(&scene(), &options()), &svg);
    assert_eq!(first, second);
    assert!(first.contains("Hormigón armado"));
}

#[test]
fn the_order_of_the_meshes_does_not_change_a_layer() {
    // Layers are sorted by name, and each layer's geometry depends only on its own meshes, so
    // a caller streaming elements in another order still gets the same sheet.
    let forward = scene();
    let mut backward = scene();
    backward.reverse();
    let first = draw(&forward, &options());
    let second = draw(&backward, &options());
    assert_eq!(fingerprint(&first), fingerprint(&second));
}

/// Everything about a layer that must not depend on the order of the input.
fn fingerprint(drawing: &cad_slicer::Drawing) -> Vec<(String, usize, i64, usize, usize)> {
    drawing
        .layers
        .iter()
        .map(|layer| {
            let area: f64 = layer.loops.iter().map(cad_slicer::Loop::area).sum();
            (
                layer.name.clone(),
                layer.loops.len(),
                (area * 1e6).round() as i64,
                layer.visible.len() + layer.hidden.len(),
                layer.hatch.len(),
            )
        })
        .collect()
}
