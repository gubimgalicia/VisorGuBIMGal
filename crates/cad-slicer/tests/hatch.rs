//! Hatching: filled where there is material, empty where the loop has a hole.

mod common;

use cad_slicer::{Cut, DrawingMesh, DrawingOptions, HatchStyle, Loop, Segment, draw};
use common::{cuboid, layer, v};
use glam::DVec2;
use ifc_geometry::subtract;

fn hatching(mesh: ifc_geometry::Mesh, style: Option<HatchStyle>) -> cad_slicer::Drawing {
    rows(mesh, style.into_iter().collect())
}

fn rows(mesh: ifc_geometry::Mesh, styles: Vec<HatchStyle>) -> cad_slicer::Drawing {
    let mut item = DrawingMesh::new(1, 1, "concrete", mesh);
    item.hatch = styles;
    let options = DrawingOptions {
        cut: Cut::Plan { z: 0.5 },
        depth: None,
        include_projection: false,
        include_hatching: true,
    };
    draw(&[item], &options)
}

/// Even-odd containment of a point in a set of loops, the way the hatch itself decides.
fn inside(rings: &[Loop], point: DVec2) -> bool {
    let mut crossings = 0;
    for ring in rings.iter().filter(|ring| ring.closed) {
        for (from, to) in ring.segments() {
            // A point on the boundary is in the material.
            let run = to - from;
            let length = run.length();
            if length > 0.0 {
                let across = run.perp_dot(point - from) / length;
                let along = run.dot(point - from) / length;
                if across.abs() <= 1e-9 && along >= -1e-9 && along <= length + 1e-9 {
                    return true;
                }
            }
            if (from.y > point.y) != (to.y > point.y) {
                let x = from.x + (point.y - from.y) / (to.y - from.y) * (to.x - from.x);
                if x > point.x {
                    crossings += 1;
                }
            }
        }
    }
    crossings % 2 == 1
}

#[test]
fn a_square_is_filled_by_parallel_lines() {
    let drawing = hatching(
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
        Some(HatchStyle::new(0.0, 0.5)),
    );
    let layer = layer(&drawing, "concrete");
    // Anchored at the origin: y = 0.5, 1.0 and 1.5. The bounds themselves are left out.
    assert_eq!(layer.hatch.len(), 3, "{:?}", layer.hatch);
    for segment in &layer.hatch {
        assert!((segment.a.y - segment.b.y).abs() < 1e-9, "not horizontal");
        assert!((segment.a.x).abs() < 1e-9 && (segment.b.x - 2.0).abs() < 1e-9);
    }
    let length: f64 = layer.hatch.iter().map(Segment::length).sum();
    assert!((length - 6.0).abs() < 1e-9);
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
}

#[test]
fn the_rule_picks_a_pattern_from_the_layer_name() {
    let drawing = hatching(
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
        None,
    );
    // "concrete" is in the keyword table: 45 degrees, 0.2 m. The exact line set follows from
    // that, and it must be the same on every run.
    let first = layer(&drawing, "concrete").hatch.clone();
    assert!(!first.is_empty());
    let again = hatching(cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)), None);
    assert_eq!(first, layer(&again, "concrete").hatch);
    // 45 degrees: every line runs up and to the right.
    for segment in &first {
        assert!((segment.a.x - segment.b.x).abs() > 1e-9);
        assert!((segment.a.y - segment.b.y).abs() > 1e-9);
    }
}

#[test]
fn hatch_stays_inside_the_loop_and_out_of_the_hole() {
    let outer = cuboid(v(0.0, 0.0, 0.0), v(4.0, 4.0, 1.0));
    let hole = cuboid(v(1.5, 1.5, -0.5), v(2.5, 2.5, 1.5));
    let mesh = subtract(&outer, &hole).expect("simple difference");
    let drawing = hatching(mesh, Some(HatchStyle::new(0.0, 0.4)));
    let layer = layer(&drawing, "concrete");
    assert_eq!(layer.loops.len(), 2);
    assert!(!layer.hatch.is_empty());

    for segment in &layer.hatch {
        for point in [segment.a, segment.b, segment.a.lerp(segment.b, 0.5)] {
            assert!(inside(&layer.loops, point), "{point:?} is not in the material");
        }
        // No part of a line crosses the hole.
        let mid = segment.a.lerp(segment.b, 0.5);
        let in_hole = mid.x > 1.5 && mid.x < 2.5 && mid.y > 1.5 && mid.y < 2.5;
        assert!(!in_hole, "hatch crosses the hole at {mid:?}");
    }
    // y = 0.4 .. 3.6 step 0.4: nine lines of 4 m, three of them cut by a 1 m hole.
    let length: f64 = layer.hatch.iter().map(Segment::length).sum();
    assert!((length - (9.0 * 4.0 - 3.0 * 1.0)).abs() < 1e-9, "{length}");
}

#[test]
fn an_explicit_style_turns_the_lines() {
    let drawing = hatching(
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
        Some(HatchStyle::new(90.0, 0.5)),
    );
    let hatch = &layer(&drawing, "concrete").hatch;
    assert_eq!(hatch.len(), 3);
    for segment in hatch {
        assert!((segment.a.x - segment.b.x).abs() < 1e-9, "not vertical");
        assert!((segment.a.y).abs() < 1e-9 && (segment.b.y - 2.0).abs() < 1e-9);
    }
}

#[test]
fn an_unusable_style_falls_back_to_the_name_and_says_so() {
    let drawing = hatching(
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
        Some(HatchStyle::new(f64::NAN, 0.5)),
    );
    assert!(!layer(&drawing, "concrete").hatch.is_empty());
    assert!(
        drawing
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "bad-hatch-style")
    );
}

#[test]
fn a_spacing_below_the_floor_is_raised_and_a_wide_element_is_cut_off() {
    // 1e-9 m is raised to the floor of 5 mm; 40 m at 5 mm is 8000 lines, past the limit.
    let drawing = hatching(
        cuboid(v(0.0, 0.0, 0.0), v(40.0, 40.0, 1.0)),
        Some(HatchStyle::new(0.0, 1e-9)),
    );
    let hatch = &layer(&drawing, "concrete").hatch;
    assert!(hatch.len() <= 4096);
    assert!(
        drawing
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "hatch-truncated")
    );
}

#[test]
fn two_rows_of_lines_cross() {
    let drawing = rows(
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
        vec![HatchStyle::new(0.0, 0.5), HatchStyle::new(90.0, 0.5)],
    );
    let hatch = &layer(&drawing, "concrete").hatch;
    // Three lines each way, at 0.5, 1.0 and 1.5, each 2 m long.
    let flat = hatch.iter().filter(|line| (line.a.y - line.b.y).abs() < 1e-9).count();
    let upright = hatch.iter().filter(|line| (line.a.x - line.b.x).abs() < 1e-9).count();
    assert_eq!((flat, upright, hatch.len()), (3, 3, 6), "{hatch:?}");
    let length: f64 = hatch.iter().map(Segment::length).sum();
    assert!((length - 12.0).abs() < 1e-9, "{length}");
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
}

#[test]
fn an_unusable_row_is_left_out_and_the_others_are_kept() {
    let drawing = rows(
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
        vec![HatchStyle::new(f64::NAN, 0.5), HatchStyle::new(0.0, 0.5)],
    );
    let hatch = &layer(&drawing, "concrete").hatch;
    // Only the level row: the name's rule would draw 45 degree lines.
    assert_eq!(hatch.len(), 3, "{hatch:?}");
    assert!(hatch.iter().all(|line| (line.a.y - line.b.y).abs() < 1e-9));
    assert!(drawing.diagnostics.iter().any(|item| item.code == "bad-hatch-style"));
}

#[test]
fn the_rows_share_one_line_limit() {
    // 40 m at 1 cm is 3999 lines each way: the first row takes them, the second the 97 left.
    let drawing = rows(
        cuboid(v(0.0, 0.0, 0.0), v(40.0, 40.0, 1.0)),
        vec![HatchStyle::new(0.0, 0.01), HatchStyle::new(90.0, 0.01)],
    );
    let hatch = &layer(&drawing, "concrete").hatch;
    let upright = hatch.iter().filter(|line| (line.a.x - line.b.x).abs() < 1e-9).count();
    assert_eq!((hatch.len(), upright), (4096, 97));
    assert!(drawing.diagnostics.iter().any(|item| item.code == "hatch-truncated"));
}

#[test]
fn an_offset_moves_the_lines_across() {
    let heights = |offset: f64| {
        let drawing = rows(
            cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
            vec![HatchStyle::new(0.0, 0.5).shifted(offset)],
        );
        let hatch = &layer(&drawing, "concrete").hatch;
        let mut found: Vec<f64> = hatch.iter().map(|line| line.a.y).collect();
        found.sort_by(f64::total_cmp);
        found
    };
    // A quarter of the way between the unshifted lines at 0.5, 1.0 and 1.5.
    let expected = [0.25, 0.75, 1.25, 1.75];
    for offset in [0.25, -0.25, 1e6 + 0.25] {
        let found = heights(offset);
        assert_eq!(found.len(), 4, "{offset}: {found:?}");
        assert!(found.iter().zip(expected).all(|(a, b)| (a - b).abs() < 1e-9), "{offset}: {found:?}");
    }
    // Far past any line number, and a whole number of spacings: the unshifted lines.
    assert_eq!(heights(1e300), [0.5, 1.0, 1.5]);
    let drawing = rows(
        cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)),
        vec![HatchStyle::new(0.0, 0.5).shifted(f64::NAN)],
    );
    assert!(drawing.diagnostics.iter().any(|item| item.code == "bad-hatch-style"));
}

#[test]
fn a_shifted_row_that_just_fits_the_limit_is_whole() {
    // At 1 cm through 5 mm, 40.962 m holds lines 0.005 to 40.955 m: 4096, the limit exactly.
    let drawing = rows(
        cuboid(v(0.0, 0.0, 0.0), v(1.0, 40.962, 1.0)),
        vec![HatchStyle::new(0.0, 0.01).shifted(0.005)],
    );
    assert_eq!(layer(&drawing, "concrete").hatch.len(), 4096);
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
}

#[test]
fn a_row_one_line_over_the_limit_loses_that_line() {
    // 40.98 m at 1 cm: lines 1 to 4097.
    let drawing = rows(
        cuboid(v(0.0, 0.0, 0.0), v(40.98, 1.0, 1.0)),
        vec![HatchStyle::new(90.0, 0.01)],
    );
    assert_eq!(layer(&drawing, "concrete").hatch.len(), 4096);
    assert!(drawing.diagnostics.iter().any(|item| item.code == "hatch-truncated"));
}

#[test]
fn spanish_and_galician_names_reach_their_patterns() {
    // Each name, its spacing from Annex A. Lines run across a 2 m square, so the count alone
    // tells the spacing apart, and an English name with the same pattern must give the same lines.
    for (name, twin) in [
        ("Fábrica cara vista", "brick"),
        ("Formigón armado", "concrete"),
        ("Aceiro laminado", "steel"),
        ("Madeira de castiñeiro", "wood"),
        ("Illamento térmico", "insulation"),
        ("Vidro temperado", "glass"),
    ] {
        let lines = |layer_name: &str| {
            let item = DrawingMesh::new(1, 1, layer_name, cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)));
            let options = DrawingOptions {
                cut: Cut::Plan { z: 0.5 },
                depth: None,
                include_projection: false,
                include_hatching: true,
            };
            layer(&draw(&[item], &options), layer_name).hatch.clone()
        };
        assert!(!lines(name).is_empty(), "{name}");
        assert_eq!(lines(name), lines(twin), "{name}");
    }
}
