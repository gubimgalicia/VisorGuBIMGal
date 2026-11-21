//! Grid placements, checked against intersections worked out by hand.

use glam::DVec3;
use ifc_geometry::{Diagnostic, ModelEvaluator};
use std::f64::consts::FRAC_1_SQRT_2;
use step_parser::index;

/// A body whose vertices are the placement's origin and the ends of its axes, 1, 2 and 3 long.
const BODY: &str = "#3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
    #4=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#5));\n\
    #5=IFCTRIANGULATEDFACESET(#6,$,$,((1,2,3),(1,3,4)),$);\n";

/// Grid `#40`, placed at `#10`: U axes `#23` along y = 0 and `#31` along y = 20, V axes `#27`
/// along x = 10 and `#35` along x = 30, each drawn from `from` to `to` in its own direction.
/// Lengths are multiplied by `k`, for files in other units.
fn grid(k: f64, location: &str, direction: &str, first_sense: &str) -> String {
    let at = |value: f64| format!("{:?}", value * k);
    format!(
        "#10=IFCLOCALPLACEMENT($,#11);\n#11=IFCAXIS2PLACEMENT3D(#12,$,{direction});\n\
         #12=IFCCARTESIANPOINT(({location}));\n#13=IFCDIRECTION((0.,1.,0.));\n\
         #20=IFCCARTESIANPOINT(({},{}));\n#21=IFCCARTESIANPOINT(({},{}));\n#22=IFCPOLYLINE((#20,#21));\n\
         #23=IFCGRIDAXIS('1',#22,{first_sense});\n\
         #24=IFCCARTESIANPOINT(({},{}));\n#25=IFCCARTESIANPOINT(({},{}));\n#26=IFCPOLYLINE((#24,#25));\n\
         #27=IFCGRIDAXIS('A',#26,.T.);\n\
         #28=IFCCARTESIANPOINT(({},{}));\n#29=IFCCARTESIANPOINT(({},{}));\n#30=IFCPOLYLINE((#28,#29));\n\
         #31=IFCGRIDAXIS('2',#30,.T.);\n\
         #32=IFCCARTESIANPOINT(({},{}));\n#33=IFCCARTESIANPOINT(({},{}));\n#34=IFCPOLYLINE((#32,#33));\n\
         #35=IFCGRIDAXIS('B',#34,.T.);\n\
         #40=IFCGRID('g',$,$,$,$,#10,$,(#23,#31),(#27,#35),$,$);\n\
         #6=IFCCARTESIANPOINTLIST3D((({},0.,0.),(0.,{},0.),(0.,0.,{}),(0.,0.,0.)));\n",
        at(0.0), at(0.0), at(50.0), at(0.0),
        at(10.0), at(-5.0), at(10.0), at(40.0),
        at(0.0), at(20.0), at(50.0), at(20.0),
        at(30.0), at(-5.0), at(30.0), at(40.0),
        at(1.0), at(2.0), at(3.0),
    )
}

const ROTATED: (&str, &str) = ("100.,200.,0.", "#13");
const UNROTATED: (&str, &str) = ("0.,0.,0.", "$");

/// The body's vertices and the diagnostics, for an element placed at `placement` in a file of
/// `schema` with `entities` beside the grid.
fn place(schema: &str, units: &str, grid: &str, entities: &str, placement: &str) -> (Vec<DVec3>, Vec<Diagnostic>) {
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n\
         #1=IFCPROJECT('p',$,$,$,$,$,$,$,{units});\n\
         #2=IFCCOLUMN('c',$,$,$,$,{placement},#3,$,$);\n{BODY}{grid}{entities}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(2).expect("the element evaluates");
    let diagnostics = evaluator.diagnostics().to_vec();
    let mesh = element.meshes.into_iter().next().expect("the body is drawn").mesh;
    (mesh.positions, diagnostics)
}

fn on_grid(grid: &str, entities: &str) -> (Vec<DVec3>, Vec<Diagnostic>) {
    place("IFC4X3", "$", grid, entities, "#50")
}

/// That some vertex lies within `tolerance` of `expected`.
fn near(vertices: &[DVec3], expected: DVec3, tolerance: f64) {
    let closest = vertices.iter().map(|vertex| vertex.distance(expected)).fold(f64::INFINITY, f64::min);
    assert!(closest <= tolerance, "nearest vertex {closest} from {expected}, in {vertices:?}");
}

/// The body's vertices are the origin and the ends of the x, y and z axes, 1, 2 and 3 long.
fn frame(vertices: Vec<DVec3>, origin: DVec3, x: DVec3, y: DVec3, tolerance: f64) {
    assert_eq!(vertices.len(), 4, "{vertices:?}");
    near(&vertices, origin, tolerance);
    near(&vertices, origin + x, tolerance);
    near(&vertices, origin + y * 2.0, tolerance);
    near(&vertices, origin + DVec3::Z * 3.0, tolerance);
}

fn clean(diagnostics: &[Diagnostic]) {
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
}

#[test]
fn an_element_on_a_grid_sits_where_its_axes_cross_along_the_first_axis() {
    let (location, direction) = ROTATED;
    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(0.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    // The grid's x runs along world y, so the crossing at grid (10, 0) is world (100, 210).
    frame(body, DVec3::new(100.0, 210.0, 0.0), DVec3::Y, -DVec3::X, 1e-9);

    // With the axes the other way round, x follows the V axis.
    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#27,#23),(0.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    frame(body, DVec3::new(100.0, 210.0, 0.0), -DVec3::X, -DVec3::Y, 1e-9);
}

#[test]
fn offsets_move_each_axis_to_its_left_and_the_crossing_up() {
    let (location, direction) = UNROTATED;
    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(2.,3.,4.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    // Axis 1 runs along +x, so its left is +y; axis A runs along +y, so its left is -x.
    frame(body, DVec3::new(7.0, 2.0, 4.0), DVec3::X, DVec3::Y, 1e-9);

    // An axis drawn against its sense runs the other way, and so does its left.
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".F."), placement);
    clean(&diagnostics);
    frame(body, DVec3::new(7.0, -2.0, 4.0), -DVec3::X, -DVec3::Y, 1e-9);

    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(-2.,-3.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    frame(body, DVec3::new(13.0, -2.0, 0.0), DVec3::X, DVec3::Y, 1e-9);
}

#[test]
fn offsets_are_in_the_files_length_unit() {
    let units = "#90";
    let entities = "#90=IFCUNITASSIGNMENT((#91));\n#91=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n\
                    #50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(2000.,3000.,4000.));\n";
    let (body, diagnostics) = place("IFC4X3", units, &grid(1000.0, "0.,0.,0.", "$", ".T."), entities, "#50");
    clean(&diagnostics);
    frame(body, DVec3::new(7.0, 2.0, 4.0), DVec3::X, DVec3::Y, 1e-9);
}

#[test]
fn a_reference_direction_turns_the_element() {
    let (location, direction) = UNROTATED;
    // Only the x and y of an explicit direction count.
    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,#52);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(0.,0.,0.));\n\
                     #52=IFCDIRECTION((0.,1.,5.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    frame(body, DVec3::new(10.0, 0.0, 0.0), DVec3::Y, -DVec3::X, 1e-9);

    // Toward a second crossing, here grid (30, 20).
    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,#52);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(0.,0.,0.));\n\
                     #52=IFCVIRTUALGRIDINTERSECTION((#31,#35),(0.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    let diagonal = DVec3::new(FRAC_1_SQRT_2, FRAC_1_SQRT_2, 0.0);
    frame(body, DVec3::new(10.0, 0.0, 0.0), diagonal, DVec3::new(-FRAC_1_SQRT_2, FRAC_1_SQRT_2, 0.0), 1e-9);
}

#[test]
fn without_a_parent_the_grid_placement_is_relative_to_its_grid() {
    // IFC4 has no PlacementRelTo on a grid placement: the grid that holds the axes places it.
    let (location, direction) = ROTATED;
    let placement = "#50=IFCGRIDPLACEMENT(#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(0.,0.,0.));\n";
    let (body, diagnostics) = place("IFC4", "$", &grid(1.0, location, direction, ".T."), placement, "#50");
    clean(&diagnostics);
    frame(body, DVec3::new(100.0, 210.0, 0.0), DVec3::Y, -DVec3::X, 1e-9);

    // The same in IFC 4.3 when PlacementRelTo is left out.
    let placement = "#50=IFCGRIDPLACEMENT($,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(0.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    frame(body, DVec3::new(100.0, 210.0, 0.0), DVec3::Y, -DVec3::X, 1e-9);
}

#[test]
fn a_local_placement_can_hang_from_a_grid_placement() {
    let (location, direction) = ROTATED;
    let entities = "#50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(0.,0.,0.));\n\
                    #60=IFCLOCALPLACEMENT(#50,#61);\n#61=IFCAXIS2PLACEMENT3D(#62,$,$);\n\
                    #62=IFCCARTESIANPOINT((1.,0.,0.));\n";
    let (body, diagnostics) = place("IFC4X3", "$", &grid(1.0, location, direction, ".T."), entities, "#60");
    clean(&diagnostics);
    frame(body, DVec3::new(100.0, 211.0, 0.0), DVec3::Y, -DVec3::X, 1e-9);
}

#[test]
fn axes_run_on_past_their_drawn_ends() {
    let (location, direction) = UNROTATED;
    // Axis 1 is drawn from x = 0 to 50: an offset of 60 along A puts the crossing beyond it.
    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(0.,-60.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    frame(body, DVec3::new(70.0, 0.0, 0.0), DVec3::X, DVec3::Y, 1e-9);

    // And an offset of 20 puts it before axis 1 begins.
    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#27),(0.,20.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    clean(&diagnostics);
    frame(body, DVec3::new(-10.0, 0.0, 0.0), DVec3::X, DVec3::Y, 1e-9);
}

#[test]
fn axes_may_be_lines_bent_polylines_or_circles() {
    let (location, direction) = UNROTATED;
    // An unbounded line through (0, 5) heading +x, crossing axis A at (10, 5).
    let entities = "#70=IFCCARTESIANPOINT((0.,5.));\n#71=IFCDIRECTION((3.,0.));\n#72=IFCVECTOR(#71,7.);\n\
                    #73=IFCLINE(#70,#72);\n#74=IFCGRIDAXIS('L',#73,.T.);\n\
                    #50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#74,#27),(0.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), entities);
    clean(&diagnostics);
    frame(body, DVec3::new(10.0, 5.0, 0.0), DVec3::X, DVec3::Y, 1e-9);

    // A polyline bent at (20, 20).
    let entities = "#70=IFCCARTESIANPOINT((0.,0.));\n#71=IFCCARTESIANPOINT((20.,20.));\n\
                    #72=IFCCARTESIANPOINT((40.,20.));\n#73=IFCPOLYLINE((#70,#71,#72));\n\
                    #74=IFCGRIDAXIS('P',#73,.T.);\n\
                    #50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#74,#35),(0.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), entities);
    clean(&diagnostics);
    // Axis B at x = 30 meets the second leg, at (30, 20), heading +x.
    frame(body, DVec3::new(30.0, 20.0, 0.0), DVec3::X, DVec3::Y, 1e-9);

    // Offset, the legs meet at a mitred corner: 2 to the left it is at (22 - 2√2, 22), so
    // x = 19.5 is on the second leg, though past the end of the first leg moved on its own.
    let bent = |x: f64, offset: f64| {
        format!(
            "#70=IFCCARTESIANPOINT((0.,0.));\n#71=IFCCARTESIANPOINT((20.,20.));\n\
             #72=IFCCARTESIANPOINT((40.,20.));\n#73=IFCPOLYLINE((#70,#71,#72));\n\
             #74=IFCGRIDAXIS('P',#73,.T.);\n#80=IFCCARTESIANPOINT(({x:?},-5.));\n\
             #81=IFCCARTESIANPOINT(({x:?},40.));\n#82=IFCPOLYLINE((#80,#81));\n#83=IFCGRIDAXIS('V',#82,.T.);\n\
             #50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#74,#83),({offset:?},0.,0.));\n"
        )
    };
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), &bent(19.5, 2.0));
    clean(&diagnostics);
    frame(body, DVec3::new(19.5, 22.0, 0.0), DVec3::X, DVec3::Y, 1e-9);
    // 2 to the right the corner is at (18 + 2√2, 18), so x = 21 is on the first leg moved on
    // its own, but before the corner, on the second leg.
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), &bent(21.0, -2.0));
    clean(&diagnostics);
    frame(body, DVec3::new(21.0, 18.0, 0.0), DVec3::X, DVec3::Y, 1e-9);

    // A circle of radius 10 round the origin, offset 2 to its left, which is inward.
    let entities = "#70=IFCCARTESIANPOINT((0.,0.));\n#71=IFCAXIS2PLACEMENT2D(#70,$);\n#73=IFCCIRCLE(#71,10.);\n\
                    #74=IFCGRIDAXIS('R',#73,.T.);\n#75=IFCCARTESIANPOINT((-20.,0.));\n\
                    #76=IFCCARTESIANPOINT((20.,0.));\n#77=IFCPOLYLINE((#75,#76));\n#78=IFCGRIDAXIS('S',#77,.T.);\n\
                    #50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#74,#78),(2.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), entities);
    clean(&diagnostics);
    // The first crossing along the circle, which starts at (10, 0) heading +y.
    near(&body, DVec3::new(8.0, 0.0, 0.0), 0.03);
    near(&body, DVec3::new(8.0, 1.0, 0.0), 0.1);
}

#[test]
fn axes_that_never_cross_leave_the_element_at_its_parent() {
    let (location, direction) = ROTATED;
    let placement = "#50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#31),(0.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    assert!(diagnostics.iter().any(|item| item.code == "bad-placement"), "{diagnostics:?}");
    frame(body, DVec3::new(100.0, 200.0, 0.0), DVec3::Y, -DVec3::X, 1e-9);

    // Nearly parallel is parallel: these would meet about 10^12 m away.
    let placement = "#70=IFCCARTESIANPOINT((0.,20.));\n#71=IFCCARTESIANPOINT((50.,20.000000001));\n\
                     #72=IFCPOLYLINE((#70,#71));\n#73=IFCGRIDAXIS('3',#72,.T.);\n\
                     #50=IFCGRIDPLACEMENT(#10,#51,$);\n#51=IFCVIRTUALGRIDINTERSECTION((#23,#73),(0.,0.,0.));\n";
    let (body, diagnostics) = on_grid(&grid(1.0, location, direction, ".T."), placement);
    assert!(diagnostics.iter().any(|item| item.code == "bad-placement"), "{diagnostics:?}");
    frame(body, DVec3::new(100.0, 200.0, 0.0), DVec3::Y, -DVec3::X, 1e-9);
}
