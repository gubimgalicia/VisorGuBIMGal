//! Independent review of T-050: exact answers worked out by hand, on cases the slicer's own
//! tests leave out.

use cad_slicer::{Axis, Cut, DrawingMesh, DrawingOptions, Look, Segment, draw, to_dxf, to_svg};
use glam::DVec3;
use ifc_geometry::Mesh;
use std::f64::consts::FRAC_PI_6;

fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!((actual - expected).abs() <= tolerance, "{actual} against {expected}");
}

fn turned(mesh: &Mesh, angle: f64) -> Mesh {
    let (sin, cos) = angle.sin_cos();
    mesh.map_positions(|point| DVec3::new(point.x * cos - point.y * sin, point.x * sin + point.y * cos, point.z))
}

fn item(id: u32, mesh: Mesh) -> DrawingMesh {
    DrawingMesh::new(0, id, "Layer", mesh)
}

fn length(segments: &[Segment]) -> f64 {
    segments.iter().map(Segment::length).sum()
}

fn lines(meshes: &[DrawingMesh], cut: Cut, depth: Option<f64>) -> (f64, f64) {
    let options = DrawingOptions { cut, depth, include_projection: true, include_hatching: false };
    let drawing = draw(meshes, &options);
    let visible = drawing.layers.iter().map(|layer| length(&layer.visible)).sum();
    let hidden = drawing.layers.iter().map(|layer| length(&layer.hidden)).sum();
    (visible, hidden)
}

/// A tall box with a long low one running under its middle.
fn tall_over_low(angle: f64) -> Vec<DrawingMesh> {
    let tall = Mesh::cuboid(DVec3::ZERO, DVec3::new(2.0, 2.0, 3.0));
    let low = Mesh::cuboid(DVec3::new(-1.0, 0.5, 0.0), DVec3::new(3.0, 1.5, 1.0));
    vec![item(1, turned(&tall, angle)), item(2, turned(&low, angle))]
}

#[test]
fn a_plan_hides_what_lies_under_a_taller_box() {
    // Seen from above: the tall box's outline of 8 m, the low box's two 1 m ends, and 1 m of
    // each long side either side of the tall box. The 2 m of each side beneath it is hidden.
    let (visible, hidden) = lines(&tall_over_low(0.0), Cut::Plan { z: 10.0 }, None);
    close(visible, 8.0 + 2.0 + 4.0, 0.1);
    close(hidden, 4.0, 0.1);
}

#[test]
fn hidden_lines_do_not_depend_on_being_lined_up_with_the_axes() {
    let (visible, hidden) = lines(&tall_over_low(FRAC_PI_6), Cut::Plan { z: 10.0 }, None);
    close(visible, 14.0, 0.15);
    close(hidden, 4.0, 0.15);
}

#[test]
fn a_section_hides_what_lies_behind_a_nearer_box() {
    // Looking along +Y from y = -5. The near box covers x 0..2, z 0..2; the far one spans
    // x -1..3, z 0..1, so 2 m of its top edge is hidden. Its base lies under the near box's
    // own visible base on the sheet, so that stretch stays a visible line.
    let near = Mesh::cuboid(DVec3::ZERO, DVec3::new(2.0, 1.0, 2.0));
    let far = Mesh::cuboid(DVec3::new(-1.0, 3.0, 0.0), DVec3::new(3.0, 4.0, 1.0));
    let cut = Cut::Section { axis: Axis::Y, position: -5.0, look: Look::Positive };
    let (_, hidden) = lines(&[item(1, near), item(2, far)], cut, None);
    close(hidden, 2.0, 0.1);
}

#[test]
fn what_stands_in_front_of_the_cut_is_neither_drawn_nor_hides_anything() {
    let below = Mesh::cuboid(DVec3::ZERO, DVec3::new(2.0, 2.0, 1.0));
    let above = Mesh::cuboid(DVec3::new(-5.0, -5.0, 12.0), DVec3::new(5.0, 5.0, 13.0));
    let (visible, hidden) = lines(&[item(1, below), item(2, above)], Cut::Plan { z: 10.0 }, None);
    close(visible, 8.0, 0.05);
    close(hidden, 0.0, 1e-9);
}

#[test]
fn depth_stops_the_projection() {
    let box_far = Mesh::cuboid(DVec3::ZERO, DVec3::new(2.0, 2.0, 1.0));
    let (visible, _) = lines(&[item(1, box_far.clone())], Cut::Plan { z: 10.0 }, Some(5.0));
    close(visible, 0.0, 1e-9);
    let (visible, _) = lines(&[item(1, box_far)], Cut::Plan { z: 10.0 }, Some(9.5));
    close(visible, 8.0, 0.05);
}

/// Two solids sharing a face inside one mesh, as a composite profile can make.
fn merged_boxes() -> Mesh {
    let (a, b) = (
        Mesh::cuboid(DVec3::ZERO, DVec3::new(1.0, 1.0, 1.0)),
        Mesh::cuboid(DVec3::new(1.0, 0.0, 0.0), DVec3::new(2.0, 1.0, 1.0)),
    );
    let first = a.positions.len() as u32;
    let mut all = a;
    all.positions.extend(b.positions);
    all.triangles.extend(b.triangles.iter().map(|triangle| triangle.map(|id| id + first)));
    all
}

#[test]
fn solids_touching_inside_one_mesh_keep_all_their_material() {
    let drawing = draw(&[item(1, merged_boxes())], &DrawingOptions::cut_only(Cut::Plan { z: 0.5 }));
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
    let area: f64 = drawing.layers.iter().flat_map(|layer| &layer.loops).map(|ring| ring.area()).sum();
    close(area, 2.0, 1e-9);
    assert!(drawing.layers.iter().flat_map(|layer| &layer.loops).all(|ring| ring.closed));
    // The joint between them bounds nothing, so a single outline goes round both.
    assert_eq!(drawing.layers.iter().flat_map(|layer| &layer.loops).count(), 1);
}

#[test]
fn an_svg_plan_keeps_north_at_the_top() {
    // SVG counts Y downwards, so what lies further north must get the smaller y.
    let south = DrawingMesh::new(0, 1, "A", Mesh::cuboid(DVec3::ZERO, DVec3::new(1.0, 1.0, 1.0)));
    let north_part = Mesh::cuboid(DVec3::new(0.0, 9.0, 0.0), DVec3::new(1.0, 10.0, 1.0));
    let north = DrawingMesh::new(0, 2, "B", north_part);
    let svg = to_svg(&draw(&[south, north], &DrawingOptions::cut_only(Cut::Plan { z: 0.5 })));
    // Layers are written in name order, so the first path is the southern box.
    let heights = |path: &str| -> Vec<f64> {
        let numbers: Vec<f64> = path.split(' ').filter_map(|word| word.parse().ok()).collect();
        numbers.iter().skip(1).step_by(2).copied().collect()
    };
    let mut paths = svg.split(" d=\"").skip(1).map(|part| part.split('"').next().unwrap_or(""));
    let (first, second) = (heights(paths.next().unwrap()), heights(paths.next().unwrap()));
    let (lowest_of_first, highest_of_second) = (
        first.iter().copied().fold(f64::INFINITY, f64::min),
        second.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    );
    assert!(lowest_of_first > highest_of_second, "{first:?} against {second:?}");
}

#[test]
fn a_solid_wound_inside_out_still_cuts_to_one_closed_loop() {
    let mut mesh = Mesh::cuboid(DVec3::ZERO, DVec3::new(2.0, 1.0, 1.0));
    mesh.triangles.iter_mut().for_each(|triangle| triangle.swap(1, 2));
    let options = DrawingOptions { include_hatching: true, ..DrawingOptions::cut_only(Cut::Plan { z: 0.5 }) };
    let drawing = draw(&[item(1, mesh)], &options);
    let rings: Vec<_> = drawing.layers.iter().flat_map(|layer| &layer.loops).collect();
    assert_eq!(rings.len(), 1);
    assert!(rings[0].closed);
    close(rings[0].area().abs(), 2.0, 1e-9);
    assert!(!drawing.layers[0].hatch.is_empty());
}

#[test]
fn area_stays_exact_at_utm_coordinates() {
    // 5 cm by 5 cm, where absolute products reach 1e13 and swamp the answer.
    let shift = DVec3::new(536_000.0, 4_747_000.0, 260.0);
    let mesh = Mesh::cuboid(shift, shift + DVec3::new(0.05, 0.05, 1.0));
    let drawing = draw(&[item(1, mesh)], &DrawingOptions::cut_only(Cut::Plan { z: 260.5 }));
    close(drawing.layers[0].loops[0].area(), 0.0025, 1e-9);
}

#[test]
fn a_triangle_with_a_sliver_of_an_edge_on_the_plane_raises_no_false_alarm() {
    // A closed box with a vertex a hair from the plane on its top face.
    let mut mesh = Mesh::cuboid(DVec3::ZERO, DVec3::new(2.0, 2.0, 2.0));
    mesh.positions.iter_mut().filter(|point| point.z > 1.0 && point.x > 1.0).for_each(|point| point.z = 1.0 + 1e-10);
    let drawing = draw(&[item(1, mesh)], &DrawingOptions::cut_only(Cut::Plan { z: 1.0 }));
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
}

/// Group codes and values of a DXF, in order.
fn groups(bytes: &[u8]) -> Vec<(i32, String)> {
    let text: String = bytes.iter().map(|byte| *byte as char).collect();
    let lines: Vec<&str> = text.split("\r\n").collect();
    lines.as_chunks::<2>().0.iter().map(|[code, value]| (code.trim().parse().unwrap(), value.to_string())).collect()
}

fn hidden_sheet() -> Vec<(i32, String)> {
    let options = DrawingOptions { cut: Cut::Plan { z: 10.0 }, depth: None, include_projection: true, include_hatching: false };
    groups(&to_dxf(&draw(&tall_over_low(0.0), &options)))
}

#[test]
fn the_layer_table_counts_every_layer_it_holds() {
    let sheet = hidden_sheet();
    let declared = sheet.windows(2).find(|pair| pair[0] == (2, "LAYER".into())).map(|pair| pair[1].1.clone());
    let held = sheet.iter().filter(|group| **group == (0, "LAYER".into())).count();
    assert_eq!(declared, Some(held.to_string()));
}

#[test]
fn every_linetype_a_layer_names_is_defined() {
    let sheet = hidden_sheet();
    let named: Vec<&String> = sheet.iter().filter(|(code, _)| *code == 6).map(|(_, value)| value).collect();
    let defined: Vec<&String> = sheet
        .windows(2)
        .filter(|pair| pair[0] == (0, "LTYPE".into()))
        .map(|pair| &pair[1].1)
        .collect();
    assert!(!named.is_empty());
    assert!(named.iter().all(|name| defined.contains(name)), "{named:?} against {defined:?}");
}

#[test]
fn hidden_layers_are_drawn_dashed() {
    let sheet = hidden_sheet();
    let mut linetype_of_hidden = None;
    for (index, group) in sheet.iter().enumerate() {
        if *group == (0, "LAYER".into()) && sheet[index + 1].1.contains("-HIDDEN") {
            linetype_of_hidden = sheet[index..].iter().find(|(code, _)| *code == 6).map(|(_, value)| value.clone());
        }
    }
    let linetype = linetype_of_hidden.expect("a hidden layer");
    assert_ne!(linetype, "CONTINUOUS");
}
