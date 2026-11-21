//! Projection and hidden lines, with the boxes placed so the answer is known by hand.

mod common;

use cad_slicer::{Cut, DrawingMesh, DrawingOptions, Layer, Segment, draw};
use common::{cuboid, layer, v};

/// A slab whose top face is the cut plane, over a small box that it hides completely.
fn slab_over_box() -> Vec<DrawingMesh> {
    vec![
        DrawingMesh::new(1, 1, "slab", cuboid(v(0.0, 0.0, 1.5), v(4.0, 4.0, 2.0))),
        DrawingMesh::new(1, 2, "slab", cuboid(v(1.0, 1.0, 0.0), v(2.0, 2.0, 1.0))),
    ]
}

fn options(depth: Option<f64>) -> DrawingOptions {
    DrawingOptions {
        cut: Cut::Plan { z: 2.0 },
        depth,
        include_projection: true,
        include_hatching: false,
    }
}

fn bbox(segments: &[Segment]) -> (f64, f64, f64, f64) {
    let mut min = (f64::MAX, f64::MAX);
    let mut max = (f64::MIN, f64::MIN);
    for segment in segments {
        for point in [segment.a, segment.b] {
            min = (min.0.min(point.x), min.1.min(point.y));
            max = (max.0.max(point.x), max.1.max(point.y));
        }
    }
    (min.0, min.1, max.0, max.1)
}

fn drawn(depth: Option<f64>) -> Layer {
    let drawing = draw(&slab_over_box(), &options(depth));
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
    layer(&drawing, "slab").clone()
}

#[test]
fn a_box_under_a_slab_is_hidden_where_it_lies() {
    let layer = drawn(None);
    // The slab's outline: four sides, the top and bottom rims merged into one.
    assert_eq!(layer.visible.len(), 4, "{:?}", layer.visible);
    let (min_x, min_y, max_x, max_y) = bbox(&layer.visible);
    assert!((min_x).abs() < 1e-9 && (max_x - 4.0).abs() < 1e-9);
    assert!((min_y).abs() < 1e-9 && (max_y - 4.0).abs() < 1e-9);

    // The hidden box: its own square, exactly where it stands.
    assert_eq!(layer.hidden.len(), 4, "{:?}", layer.hidden);
    let (min_x, min_y, max_x, max_y) = bbox(&layer.hidden);
    assert!((min_x - 1.0).abs() < 1e-9, "{:?}", layer.hidden);
    assert!((min_y - 1.0).abs() < 1e-9);
    assert!((max_x - 2.0).abs() < 1e-9);
    assert!((max_y - 2.0).abs() < 1e-9);
    let length: f64 = layer.hidden.iter().map(Segment::length).sum();
    assert!((length - 4.0).abs() < 1e-9, "hidden perimeter {length}");
}

#[test]
fn a_visible_edge_is_not_dashed() {
    let layer = drawn(None);
    // Every visible run lies on the slab's outline, never inside it.
    for segment in &layer.visible {
        for point in [segment.a, segment.b] {
            let on_outline = point.x.abs() < 1e-9
                || (point.x - 4.0).abs() < 1e-9
                || point.y.abs() < 1e-9
                || (point.y - 4.0).abs() < 1e-9;
            assert!(on_outline, "{point:?} is not on the outline");
        }
    }
}

#[test]
fn depth_stops_the_projection_before_the_hidden_box() {
    // The box's top is 1 m behind the plane; a reach of 0.5 m must not see it.
    let layer = drawn(Some(0.5));
    assert!(layer.hidden.is_empty(), "{:?}", layer.hidden);
    assert_eq!(layer.visible.len(), 4);
}

#[test]
fn no_projection_means_no_hidden_lines() {
    let mut quiet = options(None);
    quiet.include_projection = false;
    let drawing = draw(&slab_over_box(), &quiet);
    let layer = layer(&drawing, "slab");
    assert!(layer.visible.is_empty());
    assert!(layer.hidden.is_empty());
    // The cut itself is still there.
    assert_eq!(layer.loops.len(), 1);
}

#[test]
fn a_section_projects_towards_its_look_direction() {
    // Looking along +X at x = 0, a wall at x = 1 is behind the plane and visible; the same
    // wall at x = -1 is in front of it and must not appear at all.
    let wall = |x: f64| DrawingMesh::new(1, 3, "wall", cuboid(v(x, 0.0, 0.0), v(x + 0.2, 1.0, 2.0)));
    let mut options = DrawingOptions::cut_only(Cut::Section {
        axis: cad_slicer::Axis::X,
        position: 0.0,
        look: cad_slicer::Look::Positive,
    });
    options.include_projection = true;
    let drawing = draw(&[wall(1.0), wall(-1.0)], &options);
    let layer = layer(&drawing, "wall");
    assert!(!layer.visible.is_empty());
    // Along +X the sheet's X is -Y and its Y is Z, so the far wall spans y in 0..1 and
    // z in 0..2. The near wall would sit at the same place: the cut plane hides it.
    for segment in &layer.visible {
        for point in [segment.a, segment.b] {
            assert!(point.x >= -1.0 - 1e-9 && point.x <= 0.0 + 1e-9, "{point:?}");
            assert!(point.y >= -1e-9 && point.y <= 2.0 + 1e-9, "{point:?}");
        }
    }
}

trait AtPlan {
    fn with_plan(self, z: f64) -> Self;
}

impl AtPlan for DrawingOptions {
    fn with_plan(mut self, z: f64) -> Self {
        self.cut = Cut::Plan { z };
        self
    }
}

/// A row of `count` long walls, each hidden under one slab, so a lost budget shows as solid lines.
fn stacked_walls(count: usize) -> Vec<DrawingMesh> {
    let mut meshes = vec![DrawingMesh::new(
        1,
        1,
        "roof",
        cuboid(v(-1.0, -1.0, 90.0), v(201.0, 1001.0, 91.0)),
    )];
    for index in 0..count {
        let y = index as f64;
        let wall = cuboid(v(0.0, y, 0.0), v(200.0, y + 0.2, 3.0));
        meshes.push(DrawingMesh::new(1, 2 + index as u32, "walls", wall));
    }
    meshes
}

#[test]
fn every_edge_under_a_roof_stays_hidden_however_many_there_are() {
    let drawing = draw(&stacked_walls(800), &options(None).with_plan(100.0));
    let walls = layer(&drawing, "walls");
    assert!(walls.visible.is_empty(), "{} visible runs", walls.visible.len());
    // Each wall's outline: two 200 m sides and two 0.2 m ends.
    let length: f64 = walls.hidden.iter().map(Segment::length).sum();
    assert!((length - 800.0 * 400.4).abs() < 1e-6, "{length}");
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
}

#[test]
fn a_gap_narrower_than_any_sampling_step_is_seen() {
    // Two slabs 1 mm apart over one long edge: only that millimetre of it is visible.
    let meshes = vec![
        DrawingMesh::new(1, 1, "roof", cuboid(v(0.0, -1.0, 5.0), v(4.9995, 1.0, 6.0))),
        DrawingMesh::new(1, 2, "roof", cuboid(v(5.0005, -1.0, 5.0), v(10.0, 1.0, 6.0))),
        DrawingMesh::new(1, 3, "bar", cuboid(v(0.0, 0.0, 0.0), v(10.0, 0.1, 1.0))),
    ];
    let drawing = draw(&meshes, &options(None).with_plan(7.0));
    let bar = layer(&drawing, "bar");
    // Two long sides show through, and the rest of the outline is hidden.
    let seen: f64 = bar.visible.iter().map(Segment::length).sum();
    // Within the nanometres of slack that keeps a border from flickering.
    assert!((seen - 0.002).abs() < 1e-8, "{seen}");
    let unseen: f64 = bar.hidden.iter().map(Segment::length).sum();
    assert!((unseen - (20.2 - 0.002)).abs() < 1e-8, "{unseen}");
}

#[test]
fn a_sloped_edge_goes_hidden_where_it_passes_under_a_plate() {
    // A ramp climbing from z = 0 to z = 10 over x = 0..10, under a plate whose top is at z = 5.
    // Seen from above, both long edges are hidden up to x = 5 and visible after it.
    let ramp = ifc_geometry::Mesh {
        positions: vec![v(0.0, 0.0, 0.0), v(10.0, 0.0, 10.0), v(10.0, 1.0, 10.0)],
        triangles: vec![[0, 1, 2]],
    };
    let meshes = vec![
        DrawingMesh::new(1, 1, "plate", cuboid(v(-1.0, -1.0, 4.9), v(11.0, 2.0, 5.0))),
        DrawingMesh::new(1, 2, "ramp", ramp),
    ];
    let drawing = draw(&meshes, &options(None).with_plan(20.0));
    let drawn = layer(&drawing, "ramp");
    let diagonal = 101.0_f64.sqrt();
    let hidden: f64 = drawn.hidden.iter().map(Segment::length).sum();
    let visible: f64 = drawn.visible.iter().map(Segment::length).sum();
    assert!((hidden - (5.0 + diagonal / 2.0)).abs() < 1e-5, "{hidden}");
    assert!((visible - (5.0 + diagonal / 2.0 + 1.0)).abs() < 1e-5, "{visible}");
}

#[test]
fn an_occluder_listed_after_what_it_hides_still_hides() {
    // The order of the file must not matter: the box comes first here, the slab after it.
    let mut meshes = slab_over_box();
    meshes.reverse();
    let drawing = draw(&meshes, &options(None));
    let drawn = layer(&drawing, "slab");
    assert_eq!(drawn.hidden.len(), 4, "{:?}", drawn.hidden);
    assert!((drawn.hidden.iter().map(Segment::length).sum::<f64>() - 4.0).abs() < 1e-9);
}

#[test]
fn an_occluder_in_the_same_grid_cells_is_found_whatever_the_order() {
    // A far marker makes the grid coarse, so the small slab sits in cells beside the box it
    // hides, rather than in the list of wide triangles. The box is listed first.
    let meshes = vec![
        DrawingMesh::new(1, 1, "box", cuboid(v(1.0, 1.0, 0.0), v(2.0, 2.0, 1.0))),
        DrawingMesh::new(1, 2, "slab", cuboid(v(0.5, 0.5, 1.5), v(2.5, 2.5, 2.0))),
        DrawingMesh::new(1, 3, "far", cuboid(v(500.0, 500.0, 0.0), v(501.0, 501.0, 1.0))),
    ];
    let drawing = draw(&meshes, &options(None));
    let drawn = layer(&drawing, "box");
    assert!(drawn.visible.is_empty(), "{:?}", drawn.visible);
    assert!((drawn.hidden.iter().map(Segment::length).sum::<f64>() - 4.0).abs() < 1e-9);
}


/// A plate over x = 0..4, at `low` over x = 0 and `high` over x = 4: one sloped surface.
fn sloped_plate(low: f64, high: f64) -> ifc_geometry::Mesh {
    ifc_geometry::Mesh {
        positions: vec![v(0.0, 0.0, low), v(4.0, 0.0, high), v(4.0, 4.0, high), v(0.0, 4.0, low)],
        triangles: vec![[0, 1, 2], [0, 2, 3]],
    }
}

#[test]
fn the_part_of_a_slope_above_the_cut_hides_nothing() {
    // The plate crosses the plane at x = 2. Over x < 2 it is above the cut and gone, so the first
    // box is in plain sight, while the second lies under what remains of the plate.
    let meshes = vec![
        DrawingMesh::new(1, 1, "plate", sloped_plate(3.0, 1.0)),
        DrawingMesh::new(1, 2, "seen", cuboid(v(0.5, 1.0, 0.0), v(1.5, 2.0, 0.5))),
        DrawingMesh::new(1, 3, "under", cuboid(v(2.5, 1.0, 0.0), v(3.5, 2.0, 0.5))),
    ];
    let drawing = draw(&meshes, &options(None));
    let seen = layer(&drawing, "seen");
    assert!(seen.hidden.is_empty(), "{:?}", seen.hidden);
    assert!((seen.visible.iter().map(Segment::length).sum::<f64>() - 4.0).abs() < 1e-9);
    let under = layer(&drawing, "under");
    assert!(under.visible.is_empty(), "{:?}", under.visible);
    assert!((under.hidden.iter().map(Segment::length).sum::<f64>() - 4.0).abs() < 1e-9);
}

#[test]
fn an_edge_passing_from_under_a_slope_to_beyond_the_cut_splits_where_the_slope_is_cut() {
    // One long bar under the whole plate: hidden only where the plate survives, x = 2..4.
    let meshes = vec![
        DrawingMesh::new(1, 1, "plate", sloped_plate(3.0, 1.0)),
        DrawingMesh::new(1, 2, "bar", cuboid(v(0.0, 1.0, 0.0), v(4.0, 2.0, 0.5))),
    ];
    let drawing = draw(&meshes, &options(None));
    let bar = layer(&drawing, "bar");
    let hidden: f64 = bar.hidden.iter().map(Segment::length).sum();
    // Two sides of 2 m and the far end of 1 m.
    assert!((hidden - 5.0).abs() < 1e-6, "{hidden}");
}

#[test]
fn a_slope_reaching_past_the_depth_limit_still_hides_what_is_under_its_near_part() {
    // Depth is 2 - z: the plate runs from 0.2 to 4 behind the plane, past the 3 m limit. The box
    // is 1.5 to 2 behind it, and the plate stays above the box's top over x = 0.2..1.2.
    let meshes = vec![
        DrawingMesh::new(1, 1, "plate", sloped_plate(1.8, -2.0)),
        DrawingMesh::new(1, 2, "under", cuboid(v(0.2, 1.0, 0.0), v(1.2, 2.0, 0.5))),
    ];
    let drawing = draw(&meshes, &options(Some(3.0)));
    let under = layer(&drawing, "under");
    assert!(under.visible.is_empty(), "{:?}", under.visible);
    assert!((under.hidden.iter().map(Segment::length).sum::<f64>() - 4.0).abs() < 1e-9);
}

#[test]
fn an_element_with_too_many_edges_says_so() {
    // 40,000 separate triangles have 120,000 boundary edges, past the limit of one element.
    let mut soup = ifc_geometry::Mesh { positions: Vec::new(), triangles: Vec::new() };
    for index in 0..40_000u32 {
        let (x, y) = (f64::from(index % 200), f64::from(index / 200));
        soup.positions.extend([v(x, y, 0.0), v(x + 0.5, y, 0.0), v(x, y + 0.5, 0.0)]);
        soup.triangles.push([index * 3, index * 3 + 1, index * 3 + 2]);
    }
    let drawing = draw(&[DrawingMesh::new(1, 7, "soup", soup)], &options(None));
    assert!(
        drawing.diagnostics.iter().any(|item| item.code == "projection-truncated" && item.element_id == 7),
        "{:?}",
        drawing.diagnostics
    );
}

/// What the two runs of a drawing add up to: visible and hidden length over every layer.
fn line_lengths(drawing: &cad_slicer::Drawing) -> (f64, f64) {
    let total = |pick: fn(&Layer) -> &Vec<Segment>| {
        drawing.layers.iter().flat_map(pick).map(Segment::length).sum::<f64>()
    };
    (total(|layer| &layer.visible), total(|layer| &layer.hidden))
}

#[test]
fn visibility_does_not_depend_on_where_the_model_sits() {
    // Slabs flush with the walls under them, so lines lie along the borders of their occluders,
    // which is where rounding at survey coordinates would show. Map frames work in those.
    let scene = |x: f64, y: f64| -> Vec<DrawingMesh> {
        let mut meshes = Vec::new();
        for index in 0..40 {
            let shift = f64::from(index) * 3.1;
            let at = |px: f64, py: f64, pz: f64| v(x + shift + px, y + py, pz);
            let id = index as u32 * 2;
            meshes.push(DrawingMesh::new(1, id + 1, "a", cuboid(at(0.0, 0.0, 3.0), at(2.7, 2.9, 3.2))));
            meshes.push(DrawingMesh::new(1, id + 2, "b", cuboid(at(0.0, 0.0, 0.0), at(0.3, 2.9, 3.0))));
        }
        meshes
    };
    let near = draw(&scene(0.0, 0.0), &options(None).with_plan(10.0));
    let far = draw(&scene(500_000.0, 4_700_000.0), &options(None).with_plan(10.0));
    let (near, far) = (line_lengths(&near), line_lengths(&far));
    assert!((near.0 - far.0).abs() < 1e-3, "visible {} against {}", near.0, far.0);
    assert!((near.1 - far.1).abs() < 1e-3, "hidden {} against {}", near.1, far.1);
}