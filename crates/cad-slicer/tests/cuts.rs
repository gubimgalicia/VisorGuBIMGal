//! Cuts checked against sizes worked out by hand.

mod common;

use cad_slicer::{
    Axis, Cut, DrawingMesh, DrawingOptions, Look, draw,
};
use common::{assert_sound, bounds, cuboid, cylinder, layer, pyramid, v};
use ifc_geometry::{Mesh, subtract};

fn one(mesh: Mesh, cut: Cut) -> cad_slicer::Drawing {
    let item = DrawingMesh::new(1, 7, "walls", mesh);
    draw(&[item], &DrawingOptions::cut_only(cut))
}

#[test]
fn plan_of_a_box_is_a_rectangle_of_the_exact_size() {
    let drawing = one(cuboid(v(0.0, 0.0, 0.0), v(4.0, 3.0, 2.0)), Cut::Plan { z: 1.0 });
    let rings = &layer(&drawing, "walls").loops;
    assert_eq!(rings.len(), 1, "{rings:?}");
    assert_sound(&rings[0]);
    let (min_x, min_y, max_x, max_y) = bounds(&rings[0]);
    assert!((min_x - 0.0).abs() < 1e-9 && (max_x - 4.0).abs() < 1e-9);
    assert!((min_y - 0.0).abs() < 1e-9 && (max_y - 3.0).abs() < 1e-9);
    assert!((rings[0].area() - 12.0).abs() < 1e-9);
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
}

#[test]
fn plan_above_the_box_gives_nothing() {
    let drawing = one(cuboid(v(0.0, 0.0, 0.0), v(4.0, 3.0, 2.0)), Cut::Plan { z: 5.0 });
    assert!(layer(&drawing, "walls").loops.is_empty());
}

#[test]
fn plan_through_a_through_hole_gives_an_outer_and_an_inner_loop() {
    let outer = cuboid(v(0.0, 0.0, 0.0), v(4.0, 4.0, 1.0));
    let hole = cuboid(v(1.5, 1.5, -0.5), v(2.5, 2.5, 1.5));
    let mesh = subtract(&outer, &hole).expect("simple difference");
    assert!((mesh.volume() - (16.0 - 1.0)).abs() < 1e-6);

    let drawing = one(mesh, Cut::Plan { z: 0.5 });
    let rings = &layer(&drawing, "walls").loops;
    assert_eq!(rings.len(), 2, "{rings:?}");
    rings.iter().for_each(assert_sound);
    let areas: Vec<f64> = rings.iter().map(|ring| ring.area()).collect();
    let outer_area = areas.iter().copied().fold(f64::MIN, f64::max);
    let hole_area = areas.iter().copied().fold(f64::MAX, f64::min);
    assert!((outer_area - 16.0).abs() < 1e-9, "{areas:?}");
    assert!((hole_area + 1.0).abs() < 1e-9, "{areas:?}");
    // Counter-clockwise bounds material, clockwise bounds the hole.
    assert!(outer_area > 0.0 && hole_area < 0.0);
}

#[test]
fn plan_of_a_cylinder_is_a_loop_on_the_radius() {
    let radius = 1.0;
    let mesh = cylinder(radius, 2.0, 32);
    let drawing = one(mesh, Cut::Plan { z: 1.0 });
    let rings = &layer(&drawing, "walls").loops;
    assert_eq!(rings.len(), 1);
    assert_sound(&rings[0]);
    // Each side quad is two triangles, so the chord between two ring vertices is cut twice:
    // at the vertex (radius r) and on the quad's diagonal (the chord's midpoint).
    assert_eq!(rings[0].points.len(), 64);
    let on_circle = rings[0]
        .points
        .iter()
        .filter(|point| (point.length() - radius).abs() < 1e-12)
        .count();
    assert_eq!(on_circle, 32);
    let nearest = radius * (std::f64::consts::TAU / 64.0).cos();
    for point in &rings[0].points {
        assert!(point.length() <= radius + 1e-12 && point.length() >= nearest - 1e-12);
    }
    // A regular 32-gon of radius 1: half n sin(2 pi / n). The extra points lie on its chords.
    let exact = 0.5 * 32.0 * (std::f64::consts::TAU / 32.0).sin();
    assert!((rings[0].area() - exact).abs() < 1e-12);
}

#[test]
fn cut_through_a_single_vertex_yields_no_broken_loop() {
    // The apex sits exactly on the plane, so every incident triangle touches it.
    let drawing = one(pyramid(2.0, 2.0), Cut::Plan { z: 2.0 });
    for ring in &layer(&drawing, "walls").loops {
        assert_sound(ring);
    }
    assert!(layer(&drawing, "walls").loops.is_empty());
}

#[test]
fn cut_a_millimetre_below_the_apex_is_a_small_square() {
    let drawing = one(pyramid(2.0, 2.0), Cut::Plan { z: 1.9 });
    let rings = &layer(&drawing, "walls").loops;
    assert_eq!(rings.len(), 1);
    assert_sound(&rings[0]);
    // A funnel narrows linearly: half a side of 1 m at the base per metre of height,
    // so 0.1 m up from the apex the square is 0.1 m across.
    let (min_x, min_y, max_x, max_y) = bounds(&rings[0]);
    assert!((max_x - min_x - 0.1).abs() < 1e-9, "{:?}", rings[0].points);
    assert!((max_y - min_y - 0.1).abs() < 1e-9);
}

#[test]
fn plane_coplanar_with_the_far_face_yields_that_face() {
    let drawing = one(cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 2.0)), Cut::Plan { z: 2.0 });
    let rings = &layer(&drawing, "walls").loops;
    assert_eq!(rings.len(), 1);
    assert_sound(&rings[0]);
    assert!((rings[0].area() - 4.0).abs() < 1e-9);
    let (min_x, min_y, max_x, max_y) = bounds(&rings[0]);
    assert!((min_x).abs() < 1e-9 && (max_x - 2.0).abs() < 1e-9);
    assert!((min_y).abs() < 1e-9 && (max_y - 2.0).abs() < 1e-9);
}

#[test]
fn plane_coplanar_with_the_near_face_yields_nothing() {
    // The kept side is behind the plane, so a plane on the bottom face keeps no material.
    let drawing = one(cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 2.0)), Cut::Plan { z: 0.0 });
    assert!(layer(&drawing, "walls").loops.is_empty());
}

#[test]
fn plane_along_a_shared_edge_keeps_one_loop() {
    // Two boxes touching at z = 1: the plane lies in the shared face, an edge of both.
    let lower = cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0));
    let upper = cuboid(v(0.0, 0.0, 1.0), v(2.0, 2.0, 2.0));
    let item = DrawingMesh::new(
        1,
        7,
        "walls",
        Mesh {
            positions: [lower.positions, upper.positions].concat(),
            triangles: [
                lower.triangles,
                upper
                    .triangles
                    .iter()
                    .map(|[a, b, c]| [a + 8, b + 8, c + 8])
                    .collect(),
            ]
            .concat(),
        },
    );
    let drawing = draw(&[item], &DrawingOptions::cut_only(Cut::Plan { z: 1.0 }));
    let rings = &layer(&drawing, "walls").loops;
    assert!(rings.len() <= 1, "{rings:?}");
    rings.iter().for_each(assert_sound);
    if let Some(ring) = rings.first() {
        assert!((ring.area() - 4.0).abs() < 1e-9);
    }
}

#[test]
fn sections_along_every_axis_and_look_direction() {
    // An asymmetric box: 2 m wide in X, 3 in Y, 4 in Z, away from the origin.
    let mesh = || cuboid(v(1.0, 2.0, 3.0), v(3.0, 5.0, 7.0));
    let cases = [
        // axis, position, look, expected drawing bounds, expected area.
        (Axis::X, 2.0, Look::Positive, (-5.0, 3.0, -2.0, 7.0), 12.0),
        (Axis::X, 2.0, Look::Negative, (2.0, 3.0, 5.0, 7.0), 12.0),
        (Axis::Y, 3.0, Look::Positive, (1.0, 3.0, 3.0, 7.0), 8.0),
        (Axis::Y, 3.0, Look::Negative, (-3.0, 3.0, -1.0, 7.0), 8.0),
        (Axis::Z, 4.0, Look::Positive, (-3.0, 2.0, -1.0, 5.0), 6.0),
        (Axis::Z, 4.0, Look::Negative, (1.0, 2.0, 3.0, 5.0), 6.0),
    ];
    for (axis, position, look, expected, area) in cases {
        let drawing = one(
            mesh(),
            Cut::Section {
                axis,
                position,
                look,
            },
        );
        let rings = &layer(&drawing, "walls").loops;
        assert_eq!(rings.len(), 1, "{axis:?} {look:?}");
        assert_sound(&rings[0]);
        let (min_x, min_y, max_x, max_y) = bounds(&rings[0]);
        let found = (min_x, min_y, max_x, max_y);
        for (got, want) in [
            (found.0, expected.0),
            (found.1, expected.1),
            (found.2, expected.2),
            (found.3, expected.3),
        ] {
            assert!((got - want).abs() < 1e-9, "{axis:?} {look:?}: {found:?}");
        }
        // Counter-clockwise whatever the look direction: the frame follows the eye.
        assert!(rings[0].area() > 0.0, "{axis:?} {look:?}");
        assert!((rings[0].area().abs() - area).abs() < 1e-9);
    }
}

#[test]
fn depth_does_not_change_a_cut() {
    // Depth limits the projection, never the section itself.
    let mut options = DrawingOptions::cut_only(Cut::Plan { z: 1.0 });
    options.depth = Some(0.0);
    let drawing = draw(
        &[DrawingMesh::new(1, 7, "walls", cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 2.0)))],
        &options,
    );
    assert_eq!(layer(&drawing, "walls").loops.len(), 1);
}

#[test]
fn oblique_plane_cut_builds_right_handed_vertical_up_sheet() {
    // Plane x + y = 2 through [0, 4] x [0, 4] x [0, 3] cuts a chord from (2, 0) to (0, 2)
    // of length 2 * sqrt(2) and height 3, so area = 6 * sqrt(2).
    let cut = Cut::Plane {
        origin: v(1.0, 1.0, 0.0),
        normal: v(3.0, 3.0, 0.0),
    };
    let drawing = one(cuboid(v(0.0, 0.0, 0.0), v(4.0, 4.0, 3.0)), cut);
    assert!(drawing.diagnostics.is_empty(), "{:?}", drawing.diagnostics);
    let frame = drawing.frame;
    let inv_sqrt2 = std::f64::consts::FRAC_1_SQRT_2;
    assert!((frame.look - v(inv_sqrt2, inv_sqrt2, 0.0)).length() < 1e-12);
    assert!((frame.up - v(0.0, 0.0, 1.0)).length() < 1e-12);
    assert!((frame.right - v(inv_sqrt2, -inv_sqrt2, 0.0)).length() < 1e-12);
    assert!((frame.right.cross(frame.up) - (-frame.look)).length() < 1e-12);

    let rings = &layer(&drawing, "walls").loops;
    assert_eq!(rings.len(), 1);
    assert_sound(&rings[0]);
    let (min_x, min_y, max_x, max_y) = bounds(&rings[0]);
    let expected_width = 2.0 * std::f64::consts::SQRT_2;
    assert!(((max_x - min_x) - expected_width).abs() < 1e-9);
    assert!((min_y - 0.0).abs() < 1e-9 && (max_y - 3.0).abs() < 1e-9);
    assert!((rings[0].area() - 3.0 * expected_width).abs() < 1e-9);
}

#[test]
fn tilted_and_horizontal_plane_cuts_orient_sheet_axes_and_reject_bad_normals() {
    // Mostly horizontal look, an elevation: normal = (0, 24, 7) -> look = (0, 0.96, 0.28),
    // +Z projected gives up = (0, -0.28, 0.96), right = (1, 0, 0).
    let tilted = cad_slicer::Frame::of(Cut::Plane {
        origin: v(1.0, 2.0, 3.0),
        normal: v(0.0, 24.0, 7.0),
    })
    .expect("valid tilted plane");
    assert!((tilted.look - v(0.0, 0.96, 0.28)).length() < 1e-12);
    assert!((tilted.up - v(0.0, -0.28, 0.96)).length() < 1e-12);
    assert!((tilted.right - v(1.0, 0.0, 0.0)).length() < 1e-12);
    assert!((tilted.right.cross(tilted.up) - (-tilted.look)).length() < 1e-12);
    let point_on_plane = v(1.0, 2.0, 3.0);
    assert!((tilted.unproject(tilted.project(point_on_plane)) - point_on_plane).length() < 1e-12);

    // Mostly vertical look, a plan: normal = (0, 3, 4) -> look = (0, 0.6, 0.8), +Y projected
    // gives up = (0, 0.8, -0.6); seen from below, right = (-1, 0, 0).
    let steep = cad_slicer::Frame::of(Cut::Plane {
        origin: v(1.0, 2.0, 3.0),
        normal: v(0.0, 3.0, 4.0),
    })
    .expect("valid steep plane");
    assert!((steep.up - v(0.0, 0.8, -0.6)).length() < 1e-12);
    assert!((steep.right - v(-1.0, 0.0, 0.0)).length() < 1e-12);
    assert!((steep.right.cross(steep.up) - (-steep.look)).length() < 1e-12);

    // A picked floor face a little off -Z, from f32 noise or a fall, keeps the plan's axes
    // instead of turning the sheet towards the error.
    for normal in [v(1e-5, 1e-5, -1.0), v(0.02, 0.0, -1.0), v(0.0, -0.02, -1.0)] {
        let (y, x) = (v(0.0, 1.0, 0.0), v(1.0, 0.0, 0.0));
        let floor = cad_slicer::Frame::of(Cut::Plane { origin: v(0.0, 0.0, 1.0), normal })
            .expect("valid floor plane");
        assert!(floor.up.dot(y) > 0.999, "{normal:?} -> up {:?}", floor.up);
        assert!(floor.right.dot(x) > 0.999, "{normal:?} -> right {:?}", floor.right);
    }

    // Horizontal plane looking down (-Z) matches Cut::Plan at the same Z.
    let horiz = one(
        cuboid(v(0.0, 0.0, 0.0), v(4.0, 3.0, 2.0)),
        Cut::Plane {
            origin: v(2.5, 1.5, 1.0),
            normal: v(0.0, 0.0, -5.0),
        },
    );
    assert!((horiz.frame.up - v(0.0, 1.0, 0.0)).length() < 1e-12);
    assert!((horiz.frame.right - v(1.0, 0.0, 0.0)).length() < 1e-12);
    let rings = &layer(&horiz, "walls").loops;
    assert_eq!(rings.len(), 1);
    assert!((rings[0].area() - 12.0).abs() < 1e-9);

    // Zero or non-finite normal/origin reports bad-cut.
    for bad in [
        Cut::Plane {
            origin: v(0.0, 0.0, 0.0),
            normal: v(0.0, 0.0, 0.0),
        },
        Cut::Plane {
            origin: v(0.0, 0.0, 0.0),
            normal: v(f64::NAN, 1.0, 0.0),
        },
        Cut::Plane {
            origin: v(f64::INFINITY, 0.0, 0.0),
            normal: v(0.0, 0.0, -1.0),
        },
    ] {
        assert!(cad_slicer::Frame::of(bad).is_none());
        let bad_drawing = one(cuboid(v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0)), bad);
        assert_eq!(bad_drawing.diagnostics.len(), 1);
        assert_eq!(bad_drawing.diagnostics[0].code, "bad-cut");
    }
}
