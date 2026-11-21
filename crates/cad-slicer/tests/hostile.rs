//! Hostile meshes and names must degrade to a diagnostic, never a panic (TC-005).
//!
//! Every case here is something a file can carry: a coordinate that is not a number, an index
//! past the vertex list, a degenerate triangle, a layer name full of controls. The drawing must
//! keep whatever is sound and say what it skipped.

mod common;

use cad_slicer::{
    Cut, DrawingMesh, DrawingOptions, DxfOptions, HatchStyle, SvgOptions, draw, to_dxf_with,
    to_svg_with,
};
use common::{cuboid, cylinder, layer, v};
use ifc_geometry::Mesh;
use std::time::{Duration, Instant};

fn options(cut: Cut, projection: bool, hatching: bool) -> DrawingOptions {
    DrawingOptions {
        cut,
        depth: None,
        include_projection: projection,
        include_hatching: hatching,
    }
}

fn codes(drawing: &cad_slicer::Drawing) -> Vec<&'static str> {
    drawing.diagnostics.iter().map(|item| item.code).collect()
}

#[test]
fn non_finite_coordinates_lose_their_element_only() {
    let bad = Mesh {
        positions: vec![
            v(f64::NAN, 0.0, 0.0),
            v(0.0, f64::INFINITY, 0.0),
            v(0.0, 0.0, f64::NEG_INFINITY),
        ],
        triangles: vec![[0, 1, 2]],
    };

    let meshes = vec![
        DrawingMesh::new(7, 70, "Muro", cuboid(v(0.0, 0.0, 0.0), v(4.0, 3.0, 1.0))),
        DrawingMesh::new(7, 71, "Muro", bad),
    ];
    let drawing = draw(&meshes, &options(Cut::Plan { z: 0.5 }, true, true));

    // The sound element still draws its plan.
    let muro = layer(&drawing, "Muro");
    let area: f64 = muro.loops.iter().map(cad_slicer::Loop::area).sum();
    assert!((area - 12.0).abs() < 1e-9, "area was {area}");
    for ring in &muro.loops {
        common::assert_sound(ring);
    }

    let reported: Vec<u32> = drawing
        .diagnostics
        .iter()
        .filter(|item| item.code == "non-finite-coordinate")
        .map(|item| item.element_id)
        .collect();
    assert!(reported.contains(&71), "diagnostics: {:?}", codes(&drawing));
    assert!(!reported.contains(&70), "the good element was blamed");
}

#[test]
fn an_empty_mesh_keeps_its_layer_and_writes_nothing() {
    let meshes = vec![DrawingMesh::new(1, 1, "Empty", Mesh::default())];
    let drawing = draw(&meshes, &options(Cut::Plan { z: 0.0 }, true, true));

    assert_eq!(drawing.layers.len(), 1);
    assert!(drawing.layers[0].loops.is_empty());
    assert!(drawing.diagnostics.is_empty(), "{:?}", codes(&drawing));

    let dxf = to_dxf_with(&drawing, &DxfOptions::default());
    assert!(dxf.starts_with(b"0\r\nSECTION"));
    assert!(dxf.ends_with(b"EOF\r\n"));
    assert!(!dxf.windows(4).any(|window| window == b"LINE"));

    let svg = to_svg_with(&drawing, &SvgOptions::default());
    assert!(svg.starts_with("<?xml"));
    assert!(svg.contains("<svg "));
    assert!(!svg.contains("<path"));
}

#[test]
fn degenerate_triangles_draw_nothing() {
    let mesh = Mesh {
        positions: vec![
            v(0.0, 0.0, 0.0),
            v(1.0, 0.0, 0.0),
            v(0.0, 1.0, 0.0),
            v(0.0, 0.0, 0.0),
            v(1.0, 0.0, 0.0),
            v(2.0, 0.0, 0.0),
        ],
        triangles: vec![
            [0, 0, 1], // repeated corner
            [3, 4, 5], // collinear: zero area
        ],
    };
    let meshes = vec![DrawingMesh::new(1, 2, "Flat", mesh)];
    let drawing = draw(&meshes, &options(Cut::Plan { z: 0.0 }, true, true));

    assert!(drawing.layers[0].loops.is_empty());
    assert!(drawing.layers[0].visible.is_empty());
    assert!(drawing.layers[0].hidden.is_empty());
    assert!(drawing.diagnostics.is_empty(), "{:?}", codes(&drawing));
}

#[test]
fn indices_past_the_vertex_list_are_skipped() {
    let mesh = Mesh {
        positions: vec![v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 1.0, 0.0)],
        triangles: vec![[0, 1, 99], [0, 1, 2]],
    };
    let meshes = vec![DrawingMesh::new(1, 3, "Broken", mesh)];
    // Must not index out of bounds; the sound triangle is at z = 0 and the cut misses it.
    let drawing = draw(&meshes, &options(Cut::Plan { z: 5.0 }, true, false));
    assert!(drawing.layers[0].loops.is_empty());
}

#[test]
fn a_cut_or_depth_that_is_not_a_length_is_reported() {
    let meshes = vec![DrawingMesh::new(1, 4, "Muro", cuboid(v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0)))];

    let bad_cut = draw(&meshes, &options(Cut::Plan { z: f64::NAN }, false, false));
    assert!(bad_cut.layers.is_empty());
    assert_eq!(codes(&bad_cut), ["bad-cut"]);
    assert!(bad_cut.frame.origin.is_finite());

    let mut with_depth = options(Cut::Plan { z: 0.5 }, true, false);
    with_depth.depth = Some(f64::INFINITY);
    let bad_depth = draw(&meshes, &with_depth);
    assert_eq!(codes(&bad_depth), ["bad-depth"]);
    assert_eq!(bad_depth.depth, None);
    // The drawing still carries on with the full depth.
    assert!(!bad_depth.layers[0].loops.is_empty());
}

#[test]
fn a_hatch_with_no_usable_style_is_reported() {
    let mut item = DrawingMesh::new(
        1,
        5,
        "Muro",
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
    );
    item.hatch = vec![HatchStyle::new(f64::NAN, 0.2)];
    let drawing = draw(&[item], &options(Cut::Plan { z: 0.5 }, false, true));
    assert!(codes(&drawing).contains(&"bad-hatch-style"), "{:?}", codes(&drawing));
}

#[test]
fn a_dense_hatch_stops_at_its_line_limit() {
    let mut item = DrawingMesh::new(
        1,
        6,
        "Terreno",
        cuboid(v(0.0, 0.0, 0.0), v(100.0, 100.0, 1.0)),
    );
    // A hundred metres at five millimetres would be tens of thousands of lines.
    item.hatch = vec![HatchStyle::new(45.0, 0.005)];
    let drawing = draw(&[item], &options(Cut::Plan { z: 0.5 }, false, true));

    let hatch = &layer(&drawing, "Terreno").hatch;
    assert!(!hatch.is_empty());
    assert!(hatch.len() <= 4096, "{} lines", hatch.len());
    assert!(codes(&drawing).contains(&"hatch-truncated"), "{:?}", codes(&drawing));
}

#[test]
fn a_huge_mesh_is_cut_within_its_limits() {
    // 50 000 segments: about 200 000 triangles, over both the projection and loop limits.
    let mesh = cylinder(1.0, 2.0, 50_000);
    let meshes = vec![DrawingMesh::new(1, 7, "Steel", mesh)];

    let started = Instant::now();
    let drawing = draw(&meshes, &options(Cut::Plan { z: 1.0 }, true, false));
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(120),
        "the drawing took {elapsed:?}"
    );
    let found = codes(&drawing);
    assert!(found.contains(&"projection-skipped"), "{found:?}");
    assert!(found.contains(&"cut-truncated"), "{found:?}");
    assert!(!layer(&drawing, "Steel").loops.is_empty());
    assert!(drawing.diagnostics.len() <= 512);
}

#[test]
fn a_hostile_layer_name_cannot_break_the_exporters() {
    let name = format!(
        "Wall\n0\nLINE\n<script>&\u{1}\u{7F}{}",
        "Muro ".repeat(400)
    );
    let meshes = vec![DrawingMesh::new(
        1,
        8,
        name,
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
    )];
    let drawing = draw(&meshes, &options(Cut::Plan { z: 0.5 }, false, false));
    assert!(drawing.diagnostics.is_empty(), "{:?}", codes(&drawing));

    let dxf = to_dxf_with(&drawing, &DxfOptions::default());
    // Every control character except the CRLF pairs is gone, so no group can end early.
    assert!(
        dxf.iter()
            .all(|byte| *byte >= 0x20 || *byte == b'\r' || *byte == b'\n'),
        "a control byte reached the DXF"
    );
    assert!(dxf.windows(2).any(|window| window == b"\r\n"));
    assert!(dxf.ends_with(b"EOF\r\n"));

    let svg = to_svg_with(&drawing, &SvgOptions { layer_labels: true, ..SvgOptions::default() });
    assert!(!svg.contains("<script"));
    assert!(svg.contains("&lt;script&gt;"));
    assert!(svg.contains("&amp;"));
    assert!(
        svg.chars()
            .all(|character| !character.is_control() || character == '\n'),
        "a control character reached the SVG"
    );
}
