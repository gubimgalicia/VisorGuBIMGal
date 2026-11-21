//! Alignment curves, linear placement and sectioned solids, against closed forms.

use glam::{DVec2, DVec3};
use ifc_geometry::{Diagnostic, Mesh, ModelEvaluator};
use std::f64::consts::{FRAC_PI_2, PI, TAU};
use std::time::{Duration, Instant};
use step_parser::index;

/// Thin enough that the bounds of a bar along a curve are the bounds of the curve.
const WIRE: f64 = 1e-3;

const COMMON: &str = "#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
    #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
    #4=IFCSHAPEREPRESENTATION($,'Body','SolidModel',(#5));\n\
    #900=IFCCARTESIANPOINT((0.,0.,0.));\n\
    #901=IFCDIRECTION((0.,0.,1.));\n\
    #902=IFCDIRECTION((1.,0.,0.));\n\
    #903=IFCAXIS2PLACEMENT3D(#900,$,$);\n\
    #904=IFCCARTESIANPOINT((0.,0.));\n\
    #905=IFCAXIS2PLACEMENT2D(#904,$);\n\
    #906=IFCDIRECTION((1.,0.));\n\
    #907=IFCVECTOR(#906,1.);\n\
    #908=IFCLINE(#904,#907);\n";

fn run(body: &str, placement: &str) -> (Mesh, Vec<Diagnostic>) {
    run_in(COMMON, body, placement)
}

fn run_in(common: &str, body: &str, placement: &str) -> (Mesh, Vec<Diagnostic>) {
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X3'));ENDSEC;DATA;\n{common}\
         #2=IFCWALL('w',$,$,$,$,{placement},#3,$,$);\n{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(2).expect("the element evaluates");
    let diagnostics = evaluator.diagnostics().to_vec();
    (element.meshes.into_iter().next().map(|item| item.mesh).unwrap_or_default(), diagnostics)
}

fn evaluate(body: &str) -> Mesh {
    let (mesh, diagnostics) = run(body, "$");
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    mesh
}

fn bounds(mesh: &Mesh) -> (DVec3, DVec3) {
    let start = (DVec3::INFINITY, DVec3::NEG_INFINITY);
    mesh.positions.iter().fold(start, |(min, max), point| (min.min(*point), max.max(*point)))
}

fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!((actual - expected).abs() <= tolerance, "{actual} against {expected}");
}

fn near(actual: DVec3, expected: DVec3, tolerance: f64) {
    assert!(actual.distance(expected) <= tolerance, "{actual} against {expected}");
}

/// A bar along curve `#50`, for reading where the curve goes.
fn wire(curves: &str) -> Mesh {
    evaluate(&format!("{curves}#5=IFCSWEPTDISKSOLID(#50,{WIRE:?},$,$,$);\n"))
}

/// A planar segment starting at the origin along +X, the only segment of curve `#50`.
fn single_segment(parent: &str, start: f64, length: f64) -> String {
    format!(
        "{parent}#40=IFCCURVESEGMENT(.CONTINUOUS.,#905,IFCLENGTHMEASURE({start:?}),IFCLENGTHMEASURE({length:?}),#30);\n\
         #50=IFCCOMPOSITECURVE((#40),.F.);\n"
    )
}

/// Where a curve of this heading ends, integrated here from the published formula.
fn integrated(heading: impl Fn(f64) -> f64, from: f64, to: f64) -> DVec2 {
    let steps = 200_000;
    let width = (to - from) / steps as f64;
    let turn = heading(from);
    let mut sum = DVec2::ZERO;
    for step in 0..steps {
        let angle = heading(from + width * (step as f64 + 0.5)) - turn;
        sum += DVec2::new(angle.cos(), angle.sin()) * width;
    }
    sum
}

fn assert_ends_at(mesh: &Mesh, expected: DVec2) {
    let reached = mesh.positions.iter().any(|point| point.truncate().distance(expected) < 0.01);
    assert!(reached, "nothing near {expected}: {:?}", bounds(mesh));
}

#[test]
fn line_segment_runs_from_its_placement() {
    let mesh = wire(&single_segment("#30=IFCLINE(#904,#907);\n", 0.0, 25.0));
    close(bounds(&mesh).1.x, 25.0, 1e-6);
}

#[test]
fn circular_segment_turns_left_and_right_by_the_sign_of_its_length() {
    let circle = "#20=IFCCARTESIANPOINT((0.,50.));\n#21=IFCAXIS2PLACEMENT2D(#20,$);\n#30=IFCCIRCLE(#21,50.);\n";
    let quarter = 50.0 * FRAC_PI_2;
    assert_ends_at(&wire(&single_segment(circle, 0.0, quarter)), DVec2::new(50.0, 50.0));
    assert_ends_at(&wire(&single_segment(circle, 0.0, -quarter)), DVec2::new(50.0, -50.0));
}

#[test]
fn clothoid_ends_where_its_series_says() {
    let (constant, length) = (100.0_f64, 100.0_f64);
    let theta = length * length / (2.0 * constant * constant);
    let x = length * (1.0 - theta.powi(2) / 10.0 + theta.powi(4) / 216.0 - theta.powi(6) / 9360.0);
    let y = length * (theta / 3.0 - theta.powi(3) / 42.0 + theta.powi(5) / 1320.0);
    let left = single_segment("#30=IFCCLOTHOID(#905,100.);\n", 0.0, length);
    assert_ends_at(&wire(&left), DVec2::new(x, y));
    // A negative constant is the same curve bending right.
    let right = single_segment("#30=IFCCLOTHOID(#905,-100.);\n", 0.0, length);
    assert_ends_at(&wire(&right), DVec2::new(x, -y));
}

#[test]
fn segment_from_partway_along_its_parent_starts_on_the_placement_heading_along_it() {
    // Entering a clothoid at 50 m, where it is already curving, as after a circular arc.
    let heading = |s: f64| s * s / (2.0 * 100.0 * 100.0);
    let expected = integrated(heading, 50.0, 100.0);
    assert_ends_at(&wire(&single_segment("#30=IFCCLOTHOID(#905,100.);\n", 50.0, 50.0)), expected);
}

#[test]
fn polynomial_spirals_follow_their_published_terms() {
    let (a0, a1, a2, a3) = (400.0_f64, 120.0_f64, -90.0_f64, 70.0_f64);
    let second = move |t: f64| t.powi(3) / (3.0 * a2.powi(3)) + a1 * t * t / (2.0 * a1.abs().powi(3)) + t / a0;
    assert_ends_at(
        &wire(&single_segment(&format!("#30=IFCSECONDORDERPOLYNOMIALSPIRAL(#905,{a2:?},{a1:?},{a0:?});\n"), 0.0, 60.0)),
        integrated(second, 0.0, 60.0),
    );
    let third = move |t: f64| a3 * t.powi(4) / (4.0 * a3.abs().powi(5)) + second(t);
    assert_ends_at(
        &wire(&single_segment(&format!("#30=IFCTHIRDORDERPOLYNOMIALSPIRAL(#905,{a3:?},{a2:?},{a1:?},{a0:?});\n"), 0.0, 60.0)),
        integrated(third, 0.0, 60.0),
    );
    let (a4, a5, a6, a7) = (80.0_f64, 75.0_f64, -85.0_f64, 72.0_f64);
    let seventh = move |t: f64| {
        a7 * t.powi(8) / (8.0 * a7.abs().powi(9))
            + t.powi(7) / (7.0 * a6.powi(7))
            + a5 * t.powi(6) / (6.0 * a5.abs().powi(7))
            + t.powi(5) / (5.0 * a4.powi(5))
            + third(t)
    };
    let terms = format!("{a7:?},{a6:?},{a5:?},{a4:?},{a3:?},{a2:?},{a1:?},{a0:?}");
    assert_ends_at(
        &wire(&single_segment(&format!("#30=IFCSEVENTHORDERPOLYNOMIALSPIRAL(#905,{terms});\n"), 0.0, 60.0)),
        integrated(seventh, 0.0, 60.0),
    );
}

#[test]
fn polynomial_spiral_without_a_term_drops_it() {
    let heading = |t: f64| 150.0 * t * t / (2.0 * 150.0_f64.powi(3));
    let spiral = "#30=IFCSECONDORDERPOLYNOMIALSPIRAL(#905,$,150.,$);\n";
    assert_ends_at(&wire(&single_segment(spiral, 0.0, 80.0)), integrated(heading, 0.0, 80.0));
}

#[test]
fn cosine_and_sine_spirals_follow_their_heading_over_the_segment_length() {
    let length = 80.0_f64;
    let (a0, a1, a2) = (500.0_f64, 300.0_f64, 200.0_f64);
    let cosine = move |s: f64| s / a0 + length / (PI * a1) * (PI / length * s).sin();
    assert_ends_at(
        &wire(&single_segment(&format!("#30=IFCCOSINESPIRAL(#905,{a1:?},{a0:?});\n"), 0.0, length)),
        integrated(cosine, 0.0, length),
    );
    let sine = move |s: f64| {
        s / a0 + 0.5 * (s / a1) * (s / a1) - length / (TAU * a2) * ((TAU / length * s).cos() - 1.0)
    };
    assert_ends_at(
        &wire(&single_segment(&format!("#30=IFCSINESPIRAL(#905,{a2:?},{a1:?},{a0:?});\n"), 0.0, length)),
        integrated(sine, 0.0, length),
    );
}

/// A line then a circular arc of radius 100, continuing tangentially: curve `#50`.
const LINE_AND_ARC: &str = "#20=IFCCARTESIANPOINT((100.,0.));\n\
    #21=IFCAXIS2PLACEMENT2D(#20,$);\n\
    #22=IFCCARTESIANPOINT((0.,100.));\n\
    #23=IFCAXIS2PLACEMENT2D(#22,$);\n\
    #24=IFCCIRCLE(#23,100.);\n\
    #40=IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#908);\n\
    #41=IFCCURVESEGMENT(.DISCONTINUOUS.,#21,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.07963267948966),#24);\n\
    #50=IFCCOMPOSITECURVE((#40,#41),.F.);\n";

#[test]
fn composite_of_segments_places_each_where_it_says() {
    let mesh = wire(LINE_AND_ARC);
    assert_ends_at(&mesh, DVec2::new(200.0, 100.0));
    assert_ends_at(&mesh, DVec2::new(100.0, 0.0));
    close(bounds(&mesh).1.x, 200.0, 0.01);
}

/// [`LINE_AND_ARC`] with the arc's length given as a parameter value of its circle.
fn line_and_arc_by_parameter(turn: f64) -> String {
    LINE_AND_ARC.replace("IFCLENGTHMEASURE(157.07963267948966),#24", &format!("IFCPARAMETERVALUE({turn:?}),#24"))
}

#[test]
fn segment_lengths_given_as_parameter_values_follow_the_parents_own_parameter() {
    // A circle's parameter is its angle: a quarter turn of radius 100 is 157.08 m long.
    let quarter = wire(&line_and_arc_by_parameter(FRAC_PI_2));
    assert_ends_at(&quarter, DVec2::new(200.0, 100.0));
    close(bounds(&quarter).1.x, 200.0, 0.01);
    // A line's is a multiple of its direction vector: 12.5 times a vector of 2 m.
    let line = "#31=IFCVECTOR(#906,2.);\n#30=IFCLINE(#904,#31);\n\
        #40=IFCCURVESEGMENT(.CONTINUOUS.,#905,IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(12.5),#30);\n\
        #50=IFCCOMPOSITECURVE((#40),.F.);\n";
    close(bounds(&wire(line)).1.x, 25.0, 1e-6);
}

#[test]
fn a_circles_parameter_is_in_the_projects_plane_angle_unit() {
    let degrees = COMMON.replace(
        "#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);",
        "#1=IFCPROJECT('p',$,$,$,$,$,$,$,#800);\n\
         #800=IFCUNITASSIGNMENT((#801));\n\
         #801=IFCCONVERSIONBASEDUNIT(#802,.PLANEANGLEUNIT.,'DEGREE',#803);\n\
         #802=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);\n\
         #803=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.017453292519943295),#804);\n\
         #804=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);",
    );
    let body = format!("{}#5=IFCSWEPTDISKSOLID(#50,{WIRE:?},$,$,$);\n", line_and_arc_by_parameter(90.0));
    let (mesh, diagnostics) = run_in(&degrees, &body, "$");
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_ends_at(&mesh, DVec2::new(200.0, 100.0));
    close(bounds(&mesh).1.x, 200.0, 0.01);
}

#[test]
fn parameter_values_are_measured_in_the_files_length_unit_and_count_as_lengths_on_spirals() {
    let millimetres = COMMON.replace(
        "#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);",
        "#1=IFCPROJECT('p',$,$,$,$,$,$,$,#800);\n\
         #800=IFCUNITASSIGNMENT((#801));\n\
         #801=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);",
    );
    let wire_in = |curves: &str| {
        let (mesh, diagnostics) = run_in(&millimetres, &format!("{curves}#5=IFCSWEPTDISKSOLID(#50,1.,$,$,$);\n"), "$");
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        mesh
    };
    // 12 500 times a vector of 2 mm.
    let line = wire_in(
        "#31=IFCVECTOR(#906,2.);\n#30=IFCLINE(#904,#31);\n\
         #40=IFCCURVESEGMENT(.CONTINUOUS.,#905,IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(12500.),#30);\n\
         #50=IFCCOMPOSITECURVE((#40),.F.);\n",
    );
    close(bounds(&line).1.x, 25.0, 1e-6);
    // A clothoid of constant 100 m, 100 m long, given in millimetres by parameter value.
    let theta = 0.5_f64;
    let x = 100.0 * (1.0 - theta.powi(2) / 10.0 + theta.powi(4) / 216.0 - theta.powi(6) / 9360.0);
    let y = 100.0 * (theta / 3.0 - theta.powi(3) / 42.0 + theta.powi(5) / 1320.0);
    let spiral = wire_in(
        "#30=IFCCLOTHOID(#905,100000.);\n\
         #40=IFCCURVESEGMENT(.CONTINUOUS.,#905,IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(100000.),#30);\n\
         #50=IFCCOMPOSITECURVE((#40),.F.);\n",
    );
    assert_ends_at(&spiral, DVec2::new(x, y));
    let arc = wire_in(&LINE_AND_ARC.replace("100.", "100000.").replace(
        "IFCLENGTHMEASURE(157.07963267948966),#24",
        &format!("IFCPARAMETERVALUE({FRAC_PI_2:?}),#24"),
    ));
    assert_ends_at(&arc, DVec2::new(200.0, 100.0));
    // A quarter turn, not round and round its circle.
    close(bounds(&arc).1.y, 100.0, 0.01);
}

#[test]
fn linear_placement_measures_along_an_arc_given_by_its_parameter() {
    let along = 100.0 + 25.0 * PI;
    let mesh = linear_placement(&line_and_arc_by_parameter(FRAC_PI_2), along, 0.0, 0.0, 0.0);
    let expected = DVec3::new(100.0 + 100.0 * (PI / 4.0).sin(), 100.0 - 100.0 * (PI / 4.0).cos(), 0.0);
    near(mesh.positions[0], expected, 1e-6);
}

#[test]
fn a_profile_arc_given_by_its_parameter_keeps_its_length() {
    // A sag of radius 1000, level at 10 m to start, for 0.05 rad: 50 m along its arc.
    let curves = format!(
        "{STRAIGHT_BASE}#30=IFCCARTESIANPOINT((0.,10.));\n#32=IFCAXIS2PLACEMENT2D(#30,$);\n\
         #35=IFCCIRCLE(#905,1000.);\n\
         #36=IFCCURVESEGMENT(.DISCONTINUOUS.,#32,IFCPARAMETERVALUE(4.71238898038469),IFCPARAMETERVALUE(0.05),#35);\n\
         #50=IFCGRADIENTCURVE((#36),.F.,#49,$);\n"
    );
    let placed = linear_placement(&curves, 40.0, 0.0, 0.0, 0.0);
    close(placed.positions[0].z, 1010.0 - (1000.0_f64 * 1000.0 - 1600.0).sqrt(), 1e-6);
}

/// A gradient over `#49`: 2% for 50 m from 10 m, then a crest to 100 m, as curve `#50`.
const GRADIENT: &str = "#30=IFCCARTESIANPOINT((0.,10.));\n\
    #31=IFCDIRECTION((1.,0.02));\n\
    #32=IFCAXIS2PLACEMENT2D(#30,#31);\n\
    #33=IFCCARTESIANPOINT((50.,11.));\n\
    #34=IFCAXIS2PLACEMENT2D(#33,#31);\n\
    #35=IFCPOLYNOMIALCURVE(#905,(0.,1.),(0.,0.02,-0.0001),$);\n\
    #36=IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#32,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(50.0100),#908);\n\
    #37=IFCCURVESEGMENT(.DISCONTINUOUS.,#34,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(50.),#35);\n\
    #50=IFCGRADIENTCURVE((#36,#37),.F.,#49,$);\n";

const STRAIGHT_BASE: &str = "#48=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#908);\n\
    #49=IFCCOMPOSITECURVE((#48),.F.);\n";

#[test]
fn gradient_curve_lifts_its_base_along_the_profile() {
    let mesh = wire(&format!("{STRAIGHT_BASE}{GRADIENT}"));
    // The crest: 11 + 0.02 x - 0.0001 x^2 over the last 50 m.
    let height = |x: f64| 11.0 + 0.02 * x - 0.0001 * x * x;
    close(height(50.0), 11.75, 1e-12);
    let at = |x: f64| mesh.positions.iter().min_by(|a, b| (a.x - x).abs().total_cmp(&(b.x - x).abs())).unwrap();
    close(at(100.0).z, 11.75, 0.01);
    close(at(50.0).z, 11.0, 0.01);
    close(at(75.0).z, height(25.0), 0.01);
    close(bounds(&mesh).0.y, 0.0, 0.01);
    // A straight run has no vertex in its middle, so stand something there to read it.
    let placed = linear_placement(&format!("{STRAIGHT_BASE}{GRADIENT}"), 25.0, 0.0, 0.0, 0.0);
    close(placed.positions[0].z, 10.5, 0.01);
}

#[test]
fn gradient_measures_true_distance_along_a_curved_base() {
    // A base of a quarter circle of radius 100, rising 1% along its length of 157.08 m.
    let curves = "#20=IFCCARTESIANPOINT((0.,100.));\n#21=IFCAXIS2PLACEMENT2D(#20,$);\n\
        #24=IFCCIRCLE(#21,100.);\n\
        #48=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.07963267948966),#24);\n\
        #49=IFCCOMPOSITECURVE((#48),.F.);\n\
        #31=IFCDIRECTION((1.,0.01));\n#32=IFCAXIS2PLACEMENT2D(#904,#31);\n\
        #36=IFCCURVESEGMENT(.DISCONTINUOUS.,#32,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(160.),#908);\n\
        #50=IFCGRADIENTCURVE((#36),.F.,#49,$);\n";
    let mesh = wire(curves);
    // 1% of 100 pi / 2.
    close(bounds(&mesh).1.z, FRAC_PI_2, 0.002);
}

#[test]
fn segmented_reference_curve_follows_its_base_and_says_it_left_out_the_cant() {
    let curves = format!(
        "{STRAIGHT_BASE}#40=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#908);\n\
         #50=IFCSEGMENTEDREFERENCECURVE((#40),.F.,#49,$);\n\
         #5=IFCSWEPTDISKSOLID(#50,{WIRE:?},$,$,$);\n"
    );
    let (mesh, diagnostics) = run(&curves, "$");
    close(bounds(&mesh).1.x, 100.0, 1e-6);
    assert!(diagnostics.iter().any(|item| item.code == "cant-ignored"), "{diagnostics:?}");
}

fn linear_placement(curves: &str, along: f64, lateral: f64, vertical: f64, long: f64) -> Mesh {
    let body = format!(
        "{curves}#60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE({along:?}),{lateral:?},{vertical:?},{long:?},#50);\n\
         #61=IFCAXIS2PLACEMENTLINEAR(#60,$,$);\n\
         #62=IFCLINEARPLACEMENT($,#61,$);\n\
         #5=IFCBLOCK(#903,2.,1.,1.);\n"
    );
    let (mesh, diagnostics) = run(&body, "#62");
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    mesh
}

#[test]
fn linear_placement_stands_on_the_curve_at_its_distance() {
    let mesh = linear_placement(LINE_AND_ARC, 30.0, 0.0, 0.0, 0.0);
    let (min, max) = bounds(&mesh);
    near(min, DVec3::new(30.0, 0.0, 0.0), 1e-6);
    near(max, DVec3::new(32.0, 1.0, 1.0), 1e-6);
}

#[test]
fn linear_placement_follows_the_tangent_and_measures_along_the_arc() {
    // A quarter of the way round the arc, 45 degrees on: 100 m + 78.54 m along the curve.
    let along = 100.0 + 25.0 * PI;
    let mesh = linear_placement(LINE_AND_ARC, along, 0.0, 0.0, 0.0);
    let corner = mesh.positions[0];
    let expected = DVec3::new(100.0 + 100.0 * (PI / 4.0).sin(), 100.0 - 100.0 * (PI / 4.0).cos(), 0.0);
    near(corner, expected, 0.01);
    // The block's 2 m X side lies along the tangent.
    let tip = expected + DVec3::new(1.0, 1.0, 0.0).normalize() * 2.0;
    assert!(mesh.positions.iter().any(|point| point.distance(tip) < 0.01), "{tip}");
}

#[test]
fn linear_placement_offsets_left_up_and_along() {
    let mesh = linear_placement(LINE_AND_ARC, 30.0, 3.0, 2.0, 4.0);
    let (min, _) = bounds(&mesh);
    near(min, DVec3::new(34.0, 3.0, 2.0), 1e-6);
}

#[test]
fn linear_placement_takes_axes_relative_to_the_curve() {
    let body = format!(
        "{LINE_AND_ARC}#60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(30.),$,$,$,#50);\n\
         #63=IFCDIRECTION((0.,1.,0.));\n\
         #61=IFCAXIS2PLACEMENTLINEAR(#60,$,#63);\n\
         #62=IFCLINEARPLACEMENT($,#61,$);\n\
         #5=IFCBLOCK(#903,2.,1.,1.);\n"
    );
    let (mesh, diagnostics) = run(&body, "#62");
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (min, max) = bounds(&mesh);
    // X now runs across the curve to its left, and Y back along it.
    near(min, DVec3::new(29.0, 0.0, 0.0), 1e-6);
    near(max, DVec3::new(30.0, 2.0, 1.0), 1e-6);
}

#[test]
fn linear_placement_on_a_lost_curve_falls_back_to_its_cartesian_position() {
    let body = "#70=IFCCARTESIANPOINT((7.,8.,9.));\n#71=IFCAXIS2PLACEMENT3D(#70,$,$);\n\
        #60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(30.),$,$,$,#999);\n\
        #61=IFCAXIS2PLACEMENTLINEAR(#60,$,$);\n\
        #62=IFCLINEARPLACEMENT($,#61,#71);\n\
        #5=IFCBLOCK(#903,2.,1.,1.);\n";
    let (mesh, _) = run(body, "#62");
    near(bounds(&mesh).0, DVec3::new(7.0, 8.0, 9.0), 1e-6);
}

/// Sections of a rectangle at each of `stations` along curve `#50`, as `#5`.
fn sectioned(curves: &str, sections: &[(f64, f64, f64)]) -> String {
    let mut body = curves.to_string();
    let (mut profiles, mut places) = (Vec::new(), Vec::new());
    for (index, (station, x, y)) in sections.iter().enumerate() {
        let id = 100 + index as u32 * 4;
        body += &format!(
            "#{id}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,{x:?},{y:?});\n\
             #{}=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE({station:?}),$,$,$,#50);\n\
             #{}=IFCAXIS2PLACEMENTLINEAR(#{},$,$);\n",
            id + 1,
            id + 2,
            id + 1
        );
        profiles.push(format!("#{id}"));
        places.push(format!("#{}", id + 2));
    }
    body + &format!(
        "#5=IFCSECTIONEDSOLIDHORIZONTAL(#50,({}),({}));\n",
        profiles.join(","),
        places.join(",")
    )
}

#[test]
fn sectioned_solid_runs_between_its_sections_and_blends_them() {
    let mesh = evaluate(&sectioned(LINE_AND_ARC, &[(10.0, 4.0, 2.0), (30.0, 2.0, 1.0)]));
    let (min, max) = bounds(&mesh);
    near(min, DVec3::new(10.0, -2.0, -1.0), 1e-6);
    near(max, DVec3::new(30.0, 2.0, 1.0), 1e-6);
    // A frustum of 8 to 2 m2 over 20 m.
    close(mesh.volume(), 20.0 / 3.0 * (8.0 + 2.0 + 4.0), 1e-6);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn sectioned_solid_takes_its_profile_x_to_the_left_of_the_curve() {
    let curves = format!(
        "{STRAIGHT_BASE}#50=IFCCOMPOSITECURVE((#48),.F.);\n\
         #80=IFCCARTESIANPOINT((1.,0.5));\n#81=IFCAXIS2PLACEMENT2D(#80,$);\n\
         #82=IFCRECTANGLEPROFILEDEF(.AREA.,$,#81,0.2,0.2);\n\
         #83=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),$,$,$,#50);\n\
         #84=IFCAXIS2PLACEMENTLINEAR(#83,$,$);\n\
         #85=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(10.),$,$,$,#50);\n\
         #86=IFCAXIS2PLACEMENTLINEAR(#85,$,$);\n\
         #5=IFCSECTIONEDSOLIDHORIZONTAL(#50,(#82,#82),(#84,#86));\n"
    );
    let mesh = evaluate(&curves);
    let (min, max) = bounds(&mesh);
    let middle = (min + max) / 2.0;
    close(middle.y, 1.0, 1e-9);
    close(middle.z, 0.5, 1e-9);
}

#[test]
fn sectioned_solid_follows_a_curved_directrix() {
    let mesh = evaluate(&sectioned(LINE_AND_ARC, &[(100.0, 2.0, 1.0), (100.0 + 50.0 * PI, 2.0, 1.0)]));
    assert_eq!(mesh.open_edges(), 0);
    // Pappus on a quarter circle of radius 100.
    close(mesh.volume(), 2.0 * 50.0 * PI, 0.1);
    // At the end of the arc the curve runs up +Y, so its left is -X.
    let (_, max) = bounds(&mesh);
    close(max.x, 201.0, 0.1);
    close(max.y, 100.0, 0.2);
}

#[test]
fn road_curves_stay_within_a_chord_tolerance_however_wide_they_are() {
    // At a fixed count per turn, chords on this radius would miss the curve by 2.4 m.
    let radius = 500.0;
    let quarter = FRAC_PI_2 * radius;
    let curves = format!(
        "#20=IFCCARTESIANPOINT((0.,{radius:?}));\n#21=IFCAXIS2PLACEMENT2D(#20,$);\n\
         #24=IFCCIRCLE(#21,{radius:?});\n\
         #48=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE({quarter:?}),#24);\n\
         #50=IFCCOMPOSITECURVE((#48),.F.);\n"
    );
    let mesh = evaluate(&sectioned(&curves, &[(0.0, 2.0, 1.0), (quarter, 2.0, 1.0)]));
    close(mesh.volume(), 2.0 * quarter, 0.2);
    // Stand something between samples: it has to be on the true circle.
    for at in [7.0, 111.0, 333.0, 700.0] {
        let placed = linear_placement(&curves, at, 0.0, 0.0, 0.0);
        let from_centre = placed.positions[0].truncate().distance(DVec2::new(0.0, radius));
        close(from_centre, radius, 0.03);
    }
}

#[test]
fn spirals_stay_within_the_chord_tolerance_where_they_curve_most() {
    let length = 400.0;
    let curves = single_segment("#30=IFCCLOTHOID(#905,300.);\n", 0.0, length);
    let heading = |s: f64| s * s / (2.0 * 300.0 * 300.0);
    assert_ends_at(&wire(&curves), integrated(heading, 0.0, length));
    let at = 390.0;
    let placed = linear_placement(&curves, at, 0.0, 0.0, 0.0);
    let expected = integrated(heading, 0.0, at);
    close(placed.positions[0].truncate().distance(expected), 0.0, 0.03);
}

#[test]
fn linear_placement_between_samples_is_on_the_true_arc_and_its_tangent() {
    // Chords of radius 500 sag by up to 2 cm between samples; a placement must not.
    let radius = 500.0_f64;
    let quarter = FRAC_PI_2 * radius;
    let curves = format!(
        "#20=IFCCARTESIANPOINT((0.,{radius:?}));\n#21=IFCAXIS2PLACEMENT2D(#20,$);\n\
         #24=IFCCIRCLE(#21,{radius:?});\n\
         #48=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE({quarter:?}),#24);\n\
         #50=IFCCOMPOSITECURVE((#48),.F.);\n"
    );
    for at in [7.0, 111.0, 333.3, 700.0] {
        let corner = linear_placement(&curves, at, 0.0, 0.0, 0.0).positions[0];
        let angle = at / radius;
        let expected = DVec3::new(radius * angle.sin(), radius - radius * angle.cos(), 0.0);
        near(corner, expected, 1e-6);
        // Offset to the left, towards the centre: a chord's direction would turn the offset.
        let inside = linear_placement(&curves, at, 7.0, 0.0, 0.0).positions[0];
        let towards = DVec3::new(angle.sin(), -angle.cos(), 0.0);
        near(inside, DVec3::new(0.0, radius, 0.0) + towards * (radius - 7.0), 1e-6);
    }
    // The block's 2 m side lies along the tangent there, not along a chord.
    let at = 333.3;
    let angle = at / radius;
    let mesh = linear_placement(&curves, at, 0.0, 0.0, 0.0);
    let tip = DVec3::new(radius * angle.sin(), radius - radius * angle.cos(), 0.0)
        + DVec3::new(angle.cos(), angle.sin(), 0.0) * 2.0;
    assert!(mesh.positions.iter().any(|point| point.distance(tip) < 1e-6), "{tip}");
}

#[test]
fn linear_placement_at_the_end_heads_along_the_curve_and_past_it_carries_on_straight() {
    // The arc of LINE_AND_ARC ends at (200, 100) heading along +Y, 100 + 50 pi along.
    let end = 100.0 + 50.0 * PI;
    let placed = linear_placement(LINE_AND_ARC, end, 0.0, 0.0, 0.0);
    near(placed.positions[0], DVec3::new(200.0, 100.0, 0.0), 1e-6);
    let tip = DVec3::new(200.0, 102.0, 0.0);
    assert!(placed.positions.iter().any(|point| point.distance(tip) < 1e-6), "{tip}");
    // Not on round the circle, which would be half a metre to the left by then.
    near(linear_placement(LINE_AND_ARC, end + 10.0, 0.0, 0.0, 0.0).positions[0], DVec3::new(200.0, 110.0, 0.0), 1e-6);
}

#[test]
fn linear_placement_on_a_part_with_no_segment_follows_its_polyline() {
    // Up +Y to the origin as a plain polyline, 100 m along +X as a segment, then up +Y again.
    let curves = "#20=IFCCARTESIANPOINT((0.,-50.));\n#21=IFCCARTESIANPOINT((100.,0.));\n\
        #22=IFCCARTESIANPOINT((100.,50.));\n\
        #23=IFCPOLYLINE((#20,#904));\n#24=IFCPOLYLINE((#21,#22));\n\
        #40=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#23);\n\
        #41=IFCCURVESEGMENT(.CONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#908);\n\
        #42=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#24);\n\
        #50=IFCCOMPOSITECURVE((#40,#41,#42),.F.);\n";
    near(linear_placement(curves, 25.0, 0.0, 0.0, 0.0).positions[0], DVec3::new(0.0, -25.0, 0.0), 1e-6);
    near(linear_placement(curves, 170.0, 0.0, 0.0, 0.0).positions[0], DVec3::new(100.0, 20.0, 0.0), 1e-6);
}

#[test]
fn linear_placement_between_samples_is_on_the_true_spiral_entered_from_either_end() {
    let heading = |s: f64| s * s / (2.0 * 300.0 * 300.0);
    let curves = single_segment("#30=IFCCLOTHOID(#905,300.);\n", 0.0, 400.0);
    for at in [123.4, 250.0, 390.0] {
        let placed = linear_placement(&curves, at, 0.0, 0.0, 0.0);
        near(placed.positions[0], integrated(heading, 0.0, at).extend(0.0), 1e-5);
    }
    // A segment run backwards from 400 m towards the origin, straightening as it goes, as an
    // exporter writes a transition out of a curve. Its own start is the placement origin.
    let curves = single_segment("#30=IFCCLOTHOID(#905,300.);\n", 400.0, -400.0);
    // 150 m along is 250 m from the spiral's origin. In the spiral's own frame, from its end:
    let moved = integrated(heading, 0.0, 250.0) - integrated(heading, 0.0, 400.0);
    // The segment's X runs back along the spiral's tangent at 400 m, and its Y to the left of that.
    let end = heading(400.0);
    let x = DVec2::new(-end.cos(), -end.sin());
    let y = DVec2::new(end.sin(), -end.cos());
    let placed = linear_placement(&curves, 150.0, 0.0, 0.0, 0.0);
    let corner = DVec3::new(moved.dot(x), moved.dot(y), 0.0);
    near(placed.positions[0], corner, 1e-5);
    // Its 2 m side points the way the segment runs: back along the spiral.
    let back = DVec2::new(-heading(250.0).cos(), -heading(250.0).sin());
    let tip = corner + DVec3::new(back.dot(x), back.dot(y), 0.0) * 2.0;
    assert!(placed.positions.iter().any(|point| point.distance(tip) < 1e-5), "{tip}");
}

#[test]
fn linear_placement_between_samples_of_a_crest_takes_its_true_height() {
    // Samples of the crest are 1.56 m apart, so a chord between them sags by 0.06 mm.
    let height = |x: f64| 11.0 + 0.02 * x - 0.0001 * x * x;
    for along in [50.78, 63.3, 99.2] {
        let placed = linear_placement(&format!("{STRAIGHT_BASE}{GRADIENT}"), along, 0.0, 0.0, 0.0);
        close(placed.positions[0].z, height(along - 50.0), 1e-7);
        // Its 2 m side climbs with the gradient there.
        let rising = DVec3::new(1.0, 0.0, 0.02 - 0.0002 * (along - 50.0)).normalize();
        let tip = placed.positions[0] + rising * 2.0;
        assert!(placed.positions.iter().any(|point| point.distance(tip) < 1e-6), "{tip}");
    }
}

#[test]
fn a_profile_segment_running_past_the_next_one_gives_way_to_it() {
    // The 2% grade is written 10 m too long, over the start of the crest at 50 m.
    let overlapping = GRADIENT.replace("IFCLENGTHMEASURE(50.0100),#908", "IFCLENGTHMEASURE(60.),#908");
    assert_ne!(overlapping, GRADIENT);
    let placed = linear_placement(&format!("{STRAIGHT_BASE}{overlapping}"), 55.0, 0.0, 0.0, 0.0);
    // The crest's 11.0975 m, not the grade's 11.1 m.
    close(placed.positions[0].z, 11.0 + 0.02 * 5.0 - 0.0001 * 25.0, 1e-7);
}

#[test]
fn past_the_end_of_a_gradient_the_height_carries_on_at_its_last_gradient() {
    // The crest ends at 100 m, 11.75 m high, rising 1%.
    let placed = linear_placement(&format!("{STRAIGHT_BASE}{GRADIENT}"), 110.0, 0.0, 0.0, 0.0);
    near(placed.positions[0], DVec3::new(110.0, 0.0, 11.85), 1e-7);
    let tip = placed.positions[0] + DVec3::new(1.0, 0.0, 0.01).normalize() * 2.0;
    assert!(placed.positions.iter().any(|point| point.distance(tip) < 1e-7), "{tip}");
    // Before a profile that starts on the crest, back down its first gradient of 2%.
    let crest_first = "#30=IFCCARTESIANPOINT((0.,10.));\n#31=IFCDIRECTION((1.,0.02));\n\
        #32=IFCAXIS2PLACEMENT2D(#30,#31);\n\
        #35=IFCPOLYNOMIALCURVE(#905,(0.,1.),(0.,0.02,-0.0001),$);\n\
        #37=IFCCURVESEGMENT(.DISCONTINUOUS.,#32,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#35);\n\
        #50=IFCGRADIENTCURVE((#37),.F.,#49,$);\n";
    let placed = linear_placement(&format!("{STRAIGHT_BASE}{crest_first}"), -10.0, 0.0, 0.0, 0.0);
    near(placed.positions[0], DVec3::new(-10.0, 0.0, 9.8), 1e-7);
    let tip = placed.positions[0] + DVec3::new(1.0, 0.0, 0.02).normalize() * 2.0;
    assert!(placed.positions.iter().any(|point| point.distance(tip) < 1e-7), "{tip}");
}

#[test]
fn a_profile_that_ends_in_a_plain_polyline_carries_on_along_it() {
    // Level at 10 m to 20 m, the crest to 70 m, level again at 10.75 m to 100 m.
    let profile = "#20=IFCCARTESIANPOINT((0.,10.));\n#21=IFCCARTESIANPOINT((20.,10.));\n\
        #22=IFCCARTESIANPOINT((70.,10.75));\n#23=IFCCARTESIANPOINT((100.,10.75));\n\
        #24=IFCPOLYLINE((#20,#21));\n#25=IFCPOLYLINE((#22,#23));\n\
        #26=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#24);\n#27=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#25);\n\
        #31=IFCDIRECTION((1.,0.02));\n#32=IFCAXIS2PLACEMENT2D(#21,#31);\n\
        #35=IFCPOLYNOMIALCURVE(#905,(0.,1.),(0.,0.02,-0.0001),$);\n\
        #37=IFCCURVESEGMENT(.CONTINUOUS.,#32,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(50.),#35);\n\
        #50=IFCGRADIENTCURVE((#26,#37,#27),.F.,#49,$);\n";
    let curves = format!("{STRAIGHT_BASE}{profile}");
    // Past either end of the crest, but on the level parts: not on along the crest's gradients.
    close(linear_placement(&curves, 110.0, 0.0, 0.0, 0.0).positions[0].z, 10.75, 1e-7);
    close(linear_placement(&curves, -10.0, 0.0, 0.0, 0.0).positions[0].z, 10.0, 1e-7);
    close(linear_placement(&curves, 45.0, 0.0, 0.0, 0.0).positions[0].z, 10.0 + 0.5 - 0.0625, 1e-7);
}

#[test]
fn a_profile_segment_running_back_against_the_distance_is_left_to_the_polyline() {
    // The crest, turned to run back from 100 m towards 0: it heads along -X from 11.75 m.
    let profile = "#30=IFCCARTESIANPOINT((100.,11.75));\n#31=IFCDIRECTION((-1.,0.));\n\
        #32=IFCAXIS2PLACEMENT2D(#30,#31);\n\
        #35=IFCPOLYNOMIALCURVE(#905,(0.,1.),(0.,0.02,-0.0001),$);\n\
        #37=IFCCURVESEGMENT(.DISCONTINUOUS.,#32,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#35);\n\
        #50=IFCGRADIENTCURVE((#37),.F.,#49,$);\n";
    // In world terms the curve's tangent (1, 0.02) is turned onto (-1, 0).
    let turn = PI - 0.02_f64.atan();
    let world = |t: f64| {
        let (u, v) = (t, 0.02 * t - 0.0001 * t * t);
        DVec2::new(100.0 + u * turn.cos() - v * turn.sin(), 11.75 + u * turn.sin() + v * turn.cos())
    };
    let (mut low, mut high) = (0.0, 100.0);
    for _ in 0..80 {
        let middle = (low + high) / 2.0;
        if world(middle).x > 50.0 { low = middle } else { high = middle }
    }
    let height = world(low).y;
    // About 12 m: carrying on level from the segment's start would say 11.75 m.
    assert!((height - 11.75).abs() > 0.2, "{height}");
    let placed = linear_placement(&format!("{STRAIGHT_BASE}{profile}"), 50.0, 0.0, 0.0, 0.0);
    close(placed.positions[0].z, height, 1e-3);
}

/// The authored alignment's stations, as `(station, [x, y, z], [tolerance; 3])` from its
/// expected values file, read without a JSON library: each station holds `fields` values in order.
fn authored_stations(json: &str, fields: usize) -> Vec<(f64, DVec3, DVec3)> {
    let stations = &json[json.rfind("\"stations\"").expect("a stations list")..]; let stations = &stations[..stations.find("\n  }").unwrap_or(stations.len())];
    let numbers = |key: &str| -> Vec<f64> {
        stations
            .split(key)
            .skip(1)
            .map(|rest| rest.split([',', '\n']).next().unwrap().trim().parse().unwrap())
            .collect()
    };
    let (values, tolerances) = (numbers("\"value\":"), numbers("\"tolerance\":"));
    values
        .chunks(fields)
        .zip(tolerances.chunks(fields))
        .map(|(value, tolerance)| {
            (value[0], DVec3::new(value[1], value[2], value[3]), DVec3::new(tolerance[1], tolerance[2], tolerance[3]))
        })
        .collect()
}

/// Places a 2 cm probe cube at each `(station, expected, tolerance)` along `curve_entity` in `text`,
/// checks every probe's centre against `expected`, and returns the evaluator's diagnostics.
fn check_authored_stations(
    text: &str,
    curve_entity: &str,
    stations: &[(f64, DVec3, DVec3)],
) -> Vec<Diagnostic> {
    let curve = text.lines().find(|line| line.contains(curve_entity)).expect(curve_entity);
    let curve = &curve[..curve.find('=').unwrap()];
    let mut probes = String::from(
        "#100000=IFCCARTESIANPOINT((-0.01,-0.01,-0.01));\n#100001=IFCAXIS2PLACEMENT3D(#100000,$,$);\n\
         #100002=IFCBLOCK(#100001,0.02,0.02,0.02);\n\
         #100003=IFCSHAPEREPRESENTATION($,'Body','CSG',(#100002));\n\
         #100004=IFCPRODUCTDEFINITIONSHAPE($,$,(#100003));\n",
    );
    for (index, (station, _, _)) in stations.iter().enumerate() {
        let id = 100_010 + index * 4;
        probes += &format!(
            "#{id}=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE({station:?}),$,$,$,{curve});\n\
             #{}=IFCAXIS2PLACEMENTLINEAR(#{id},$,$);\n#{}=IFCLINEARPLACEMENT($,#{},$);\n\
             #{}=IFCBUILDINGELEMENTPROXY('probe{index}',$,$,$,$,#{},#100004,$,$);\n",
            id + 1,
            id + 2,
            id + 1,
            id + 3,
            id + 2
        );
    }
    let end = text.rfind("ENDSEC;").unwrap();
    let text = format!("{}{probes}{}", &text[..end], &text[end..]);
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    for (index, (station, expected, tolerance)) in stations.iter().enumerate() {
        let element = evaluator.evaluate((100_013 + index * 4) as u32).expect("the probe evaluates");
        let mesh = &element.meshes[0].mesh;
        let (min, max) = bounds(mesh);
        let centre = (min + max) / 2.0;
        let off = (centre - *expected).abs();
        assert!(off.cmple(*tolerance).all(), "station {station}: {centre} against {expected}");
    }
    evaluator.diagnostics().to_vec()
}

#[test]
fn authored_road_stations_are_where_their_expected_values_say() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/authored");
    let text = std::fs::read_to_string(folder.join("road-alignment.ifc")).unwrap();
    let stations = authored_stations(&std::fs::read_to_string(folder.join("road-alignment.expected.json")).unwrap(), 4);
    assert_eq!(stations.len(), 14);
    let diagnostics = check_authored_stations(&text, "=IFCGRADIENTCURVE(", &stations);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
}

#[test]
fn authored_rail_cant_stations_follow_the_centreline_and_report_cant_ignored() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/authored");
    let text = std::fs::read_to_string(folder.join("rail-cant.ifc")).unwrap();
    let stations = authored_stations(&std::fs::read_to_string(folder.join("rail-cant.expected.json")).unwrap(), 6);
    assert_eq!(stations.len(), 16);
    let diagnostics = check_authored_stations(&text, "=IFCSEGMENTEDREFERENCECURVE(", &stations);
    assert!(diagnostics.iter().any(|item| item.code == "cant-ignored"), "{diagnostics:?}");
    assert!(diagnostics.iter().all(|item| item.code == "cant-ignored"), "{diagnostics:?}");
}

/// The `(value, tolerance)` reached by finding each key of `path` in turn in `json`.
fn expected_quantity(json: &str, path: &[&str]) -> (f64, f64) {
    let mut at = 0;
    for key in path {
        at += json[at..].find(key).unwrap_or_else(|| panic!("{key} of {path:?}")) + key.len();
    }
    let number = |key: &str| -> f64 {
        let start = at + json[at..].find(key).unwrap() + key.len();
        let rest = json[start..].trim_start();
        rest[..rest.find([',', '\n', '}']).unwrap()].trim().parse().unwrap()
    };
    (number("\"value\":"), number("\"tolerance\":"))
}

#[test]
fn authored_linear_placement_boxes_match_their_expected_values() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/authored");
    let text = std::fs::read_to_string(folder.join("linear-placement.ifc")).unwrap();
    let json = std::fs::read_to_string(folder.join("linear-placement.expected.json")).unwrap();
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    for box_index in 1..=10 {
        let name = format!("BOX-{box_index:02}");
        let tag = format!("'{name}'");
        let line = text
            .lines()
            .find(|line| line.contains("=IFCBUILDINGELEMENTPROXY(") && line.contains(&tag))
            .expect(&name);
        let id: u32 = line[1..line.find('=').unwrap()].parse().unwrap();
        let element = evaluator.evaluate(id).expect(&name);
        let mesh = &element.meshes[0].mesh;
        assert_eq!(mesh.open_edges(), 0, "{name}");
        let box_key = format!("\"{name}\"");
        let at = |field: &str| expected_quantity(&json, &["\"placements\":", &box_key, field]);
        let (vol, vol_tol) = at("\"volume\":");
        close(mesh.volume(), vol, vol_tol);
        let (min, max) = bounds(mesh);
        let centre = (min + max) / 2.0;
        let size = max - min;
        for (actual, field) in [
            (centre.x, "\"centre_x\":"),
            (centre.y, "\"centre_y\":"),
            (centre.z, "\"centre_z\":"),
            (size.x, "\"bbox_size_x\":"),
            (size.y, "\"bbox_size_y\":"),
            (size.z, "\"bbox_size_z\":"),
            (min.x, "\"bbox_min_x\":"),
            (max.x, "\"bbox_max_x\":"),
            (min.y, "\"bbox_min_y\":"),
            (max.y, "\"bbox_max_y\":"),
            (min.z, "\"bbox_min_z\":"),
            (max.z, "\"bbox_max_z\":"),
        ] {
            let (wanted, tol) = at(field);
            assert!((actual - wanted).abs() <= tol, "{name} {field}: {actual} against {wanted} +- {tol}");
        }
    }
    assert!(evaluator.diagnostics().is_empty(), "{:?}", evaluator.diagnostics());
}

#[test]
fn authored_bridge_deck_and_piers_match_their_expected_values() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/authored");
    let text = std::fs::read_to_string(folder.join("bridge.ifc")).unwrap();
    let json = std::fs::read_to_string(folder.join("bridge.expected.json")).unwrap();
    let stations = authored_stations(&json, 5);
    assert_eq!(stations.len(), 9);
    let station_diags = check_authored_stations(&text, "=IFCGRADIENTCURVE(", &stations);
    assert!(station_diags.is_empty(), "{station_diags:?}");

    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();

    let deck_line = text
        .lines()
        .find(|line| line.contains("=IFCSLAB(") && line.contains("'guBIM bridge deck'"))
        .expect("bridge deck");
    let deck_id: u32 = deck_line[1..deck_line.find('=').unwrap()].parse().unwrap();
    let deck_elem = evaluator.evaluate(deck_id).expect("deck mesh");
    let deck_mesh = &deck_elem.meshes[0].mesh;
    assert_eq!(deck_mesh.open_edges(), 0, "deck must be closed");
    let (deck_vol, deck_vol_tol) = expected_quantity(&json, &["\"deck\":", "\"volume\":"]);
    close(deck_mesh.volume(), deck_vol, deck_vol_tol);
    let (dmin, dmax) = bounds(deck_mesh);
    for (actual, field) in [
        (dmin.x, "\"x_min\":"),
        (dmax.x, "\"x_max\":"),
        (dmin.y, "\"y_min\":"),
        (dmax.y, "\"y_max\":"),
        (dmin.z, "\"z_min\":"),
        (dmax.z, "\"z_max\":"),
    ] {
        let (wanted, tol) = expected_quantity(&json, &["\"deck\":", "\"bbox_local\":", field]);
        assert!((actual - wanted).abs() <= tol, "deck {field}: {actual} against {wanted} +- {tol}");
    }

    for pier_index in 1..=3 {
        let name = format!("guBIM pier {pier_index}");
        let tag = format!("'{name}'");
        let line = text
            .lines()
            .find(|line| line.contains("=IFCCOLUMN(") && line.contains(&tag))
            .expect(&name);
        let id: u32 = line[1..line.find('=').unwrap()].parse().unwrap();
        let element = evaluator.evaluate(id).expect(&name);
        let mesh = &element.meshes[0].mesh;
        assert_eq!(mesh.open_edges(), 0, "{name}");
        let pier_key = format!("\"{name}\"");
        let at = |field: &str| expected_quantity(&json, &["\"piers\":", &pier_key, field]);
        let (vol, vol_tol) = at("\"volume\":");
        close(mesh.volume(), vol, vol_tol);
        let (min, max) = bounds(mesh);
        let centre = (min + max) / 2.0;
        for (actual, field) in [
            (centre.x, "\"centre_x\":"),
            (centre.y, "\"centre_y\":"),
            (centre.z, "\"centre_z\":"),
            (min.x, "\"x_min\":"),
            (max.x, "\"x_max\":"),
            (min.y, "\"y_min\":"),
            (max.y, "\"y_max\":"),
            (min.z, "\"z_min\":"),
            (max.z, "\"z_max\":"),
        ] {
            let (wanted, tol) = at(field);
            assert!(
                (actual - wanted).abs() <= tol.max(1e-3),
                "{name} {field}: {actual} against {wanted} +- {tol}"
            );
        }
    }
    assert!(evaluator.diagnostics().is_empty(), "{:?}", evaluator.diagnostics());
}

#[test]
fn sectioned_solid_blends_the_offsets_of_its_sections() {
    let curves = format!(
        "{STRAIGHT_BASE}#50=IFCCOMPOSITECURVE((#48),.F.);\n\
         #80=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,2.,1.);\n\
         #83=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),3.,1.,$,#50);\n\
         #84=IFCAXIS2PLACEMENTLINEAR(#83,$,$);\n\
         #85=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(10.),5.,2.,$,#50);\n\
         #86=IFCAXIS2PLACEMENTLINEAR(#85,$,$);\n\
         #5=IFCSECTIONEDSOLIDHORIZONTAL(#50,(#80,#80),(#84,#86));\n"
    );
    let mesh = evaluate(&curves);
    let (min, max) = bounds(&mesh);
    near(min, DVec3::new(0.0, 2.0, 0.5), 1e-9);
    near(max, DVec3::new(10.0, 6.0, 2.5), 1e-9);
    close(mesh.volume(), 2.0 * 10.0, 1e-6);
}

#[test]
fn sectioned_solid_with_many_sections_keeps_each_span() {
    let mesh = evaluate(&sectioned(
        LINE_AND_ARC,
        &[(0.0, 2.0, 1.0), (10.0, 4.0, 1.0), (30.0, 2.0, 1.0)],
    ));
    close(mesh.volume(), 3.0 * 10.0 + 3.0 * 20.0, 1e-6);
    close(bounds(&mesh).1.y, 2.0, 1e-9);
}

#[test]
fn sectioned_solid_climbs_with_a_gradient() {
    let mesh = evaluate(&sectioned(&format!("{STRAIGHT_BASE}{GRADIENT}"), &[(0.0, 2.0, 1.0), (100.0, 2.0, 1.0)]));
    let (_, max) = bounds(&mesh);
    close(max.x, 100.0, 0.05);
    close(max.z, 11.75 + 0.5, 0.05);
}

#[test]
fn sectioned_solid_with_mismatched_lists_says_so() {
    let curves = format!(
        "{LINE_AND_ARC}#80=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,1.,1.);\n\
         #83=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),$,$,$,#50);\n\
         #84=IFCAXIS2PLACEMENTLINEAR(#83,$,$);\n\
         #5=IFCSECTIONEDSOLIDHORIZONTAL(#50,(#80,#80),(#84));\n"
    );
    let (_, diagnostics) = run(&curves, "$");
    assert!(diagnostics.iter().any(|item| item.code == "bad-sections"), "{diagnostics:?}");
}

#[test]
fn area_sweeps_follow_alignment_curves() {
    let body = format!(
        "{STRAIGHT_BASE}{GRADIENT}#70=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,2.,1.);\n\
         #5=IFCFIXEDREFERENCESWEPTAREASOLID(#70,#903,#50,$,$,#901);\n"
    );
    let mesh = evaluate(&body);
    assert_eq!(mesh.open_edges(), 0);
    close(bounds(&mesh).1.x, 100.0, 0.1);
}

#[test]
fn offset_curve_2d_runs_to_the_left() {
    let curves = format!("{STRAIGHT_BASE}#50=IFCOFFSETCURVE2D(#49,2.,.F.);\n");
    let (min, max) = bounds(&wire(&curves));
    close(min.y, 2.0, 2.0 * WIRE);
    close(max.x, 100.0, 2.0 * WIRE);
}

#[test]
fn offset_curve_3d_runs_along_the_tangent_cross_its_reference() {
    let curves = format!("{STRAIGHT_BASE}#50=IFCOFFSETCURVE3D(#49,2.,.F.,#901);\n");
    close(bounds(&wire(&curves)).0.y, -2.0, 2.0 * WIRE);
}

#[test]
fn offset_curve_by_distances_varies_between_its_offsets() {
    let curves = format!(
        "{STRAIGHT_BASE}#60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),1.,0.5,$,#49);\n\
         #61=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(100.),3.,0.5,$,#49);\n\
         #50=IFCOFFSETCURVEBYDISTANCES(#49,(#60,#61),$);\n"
    );
    let (min, max) = bounds(&wire(&curves));
    close(min.y, 1.0, 2.0 * WIRE);
    close(max.y, 3.0, 2.0 * WIRE);
    close(max.z, 0.5, 2.0 * WIRE);
}

#[test]
fn offset_curve_bends_at_an_offset_between_vertices_of_its_base() {
    let curves = format!(
        "{STRAIGHT_BASE}#60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),1.,$,$,#49);\n\
         #61=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(50.),5.,$,$,#49);\n\
         #62=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(100.),1.,$,$,#49);\n\
         #50=IFCOFFSETCURVEBYDISTANCES(#49,(#60,#61,#62),$);\n"
    );
    close(bounds(&wire(&curves)).1.y, 5.0, 2.0 * WIRE);
}

#[test]
fn offset_curve_interpolates_between_its_offsets_at_vertices_of_its_base() {
    // A vertex at 50 m of a base offset from 0 to 10 m over 100 m.
    let curves = "#20=IFCCARTESIANPOINT((50.,0.));\n#21=IFCAXIS2PLACEMENT2D(#20,$);\n\
        #47=IFCCURVESEGMENT(.CONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(50.),#908);\n\
        #48=IFCCURVESEGMENT(.DISCONTINUOUS.,#21,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(50.),#908);\n\
        #49=IFCCOMPOSITECURVE((#47,#48),.F.);\n\
        #60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),0.,$,$,#49);\n\
        #61=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(100.),10.,$,$,#49);\n\
        #50=IFCOFFSETCURVEBYDISTANCES(#49,(#60,#61),$);\n";
    let mesh = wire(curves);
    let middle = mesh.positions.iter().min_by(|a, b| (a.x - 50.0).abs().total_cmp(&(b.x - 50.0).abs()));
    close(middle.unwrap().y, 5.0, 0.1);
}

#[test]
fn offset_curve_with_one_distance_keeps_it_all_the_way() {
    let curves = format!(
        "{STRAIGHT_BASE}#60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(40.),1.5,$,$,#49);\n\
         #50=IFCOFFSETCURVEBYDISTANCES(#49,(#60),$);\n"
    );
    let (min, max) = bounds(&wire(&curves));
    close(min.y, 1.5, 2.0 * WIRE);
    close(max.y, 1.5, 2.0 * WIRE);
    close(min.x, 0.0, 2.0 * WIRE);
}

#[test]
fn hostile_curves_stay_bounded() {
    let started = Instant::now();
    // A spiral that spins millions of times, and thousands of segments of it.
    let mut body = String::from("#30=IFCCLOTHOID(#905,1e-6);\n");
    let mut segments = Vec::new();
    for id in 0..5000 {
        body += &format!(
            "#{}=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(1e9),#30);\n",
            10_000 + id
        );
        segments.push(format!("#{}", 10_000 + id));
    }
    body += &format!("#50=IFCCOMPOSITECURVE(({}),.F.);\n", segments.join(","));
    body += &format!("#5=IFCSWEPTDISKSOLID(#50,{WIRE:?},$,$,$);\n");
    let (_, diagnostics) = run(&body, "$");
    assert!(started.elapsed() < Duration::from_secs(20), "{:?}", started.elapsed());
    assert!(diagnostics.iter().any(|item| item.code == "curve-too-long"), "{diagnostics:?}");
}

/// Evaluates on a stack the size of the WASM one, where unbounded recursion would abort.
fn on_a_small_stack(body: String) -> Vec<Diagnostic> {
    std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(move || run(&body, "$").1)
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn segment_placed_along_its_own_curve_stops_at_the_depth_limit() {
    let body = "#60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(1.),$,$,$,#50);\n\
         #61=IFCAXIS2PLACEMENTLINEAR(#60,$,$);\n\
         #40=IFCCURVESEGMENT(.DISCONTINUOUS.,#61,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(10.),#908);\n\
         #50=IFCCOMPOSITECURVE((#40),.F.);\n\
         #5=IFCSWEPTDISKSOLID(#50,0.1,$,$,$);\n".to_string();
    let diagnostics = on_a_small_stack(body);
    assert!(diagnostics.iter().any(|item| item.code == "nesting-too-deep"), "{diagnostics:?}");
}

#[test]
fn composite_holding_itself_stops_at_the_depth_limit() {
    let body = "#40=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(10.),#908);\n\
         #41=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#50);\n\
         #50=IFCCOMPOSITECURVE((#40,#41),.F.);\n\
         #5=IFCSWEPTDISKSOLID(#50,0.1,$,$,$);\n".to_string();
    let diagnostics = on_a_small_stack(body);
    assert!(diagnostics.iter().any(|item| item.code == "nesting-too-deep"), "{diagnostics:?}");
}

#[test]
fn curves_offset_from_themselves_stop_at_the_depth_limit() {
    let diagnostics = on_a_small_stack("#50=IFCOFFSETCURVE2D(#50,1.,.F.);\n#5=IFCSWEPTDISKSOLID(#50,0.1,$,$,$);\n".into());
    assert!(diagnostics.iter().any(|item| item.code == "nesting-too-deep"), "{diagnostics:?}");
    let body = "#50=IFCGRADIENTCURVE((),.F.,#50,$);\n#5=IFCSWEPTDISKSOLID(#50,0.1,$,$,$);\n".to_string();
    assert!(on_a_small_stack(body).iter().any(|item| item.code == "nesting-too-deep"));
}

#[test]
fn segment_with_no_finite_points_says_so() {
    let body = "#30=IFCCLOTHOID(#905,1e308);\n\
        #40=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(1e308),IFCLENGTHMEASURE(1e308),#30);\n\
        #50=IFCCOMPOSITECURVE((#40),.F.);\n\
        #5=IFCSWEPTDISKSOLID(#50,0.1,$,$,$);\n";
    let (_, diagnostics) = run(body, "$");
    assert!(diagnostics.iter().any(|item| item.code == "bad-curve"), "{diagnostics:?}");
}

#[test]
fn zero_length_segment_is_skipped() {
    let curves = "#40=IFCCURVESEGMENT(.CONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#908);\n\
        #41=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(10.),#908);\n\
        #50=IFCCOMPOSITECURVE((#40,#41),.F.);\n";
    close(bounds(&wire(curves)).1.x, 10.0, 1e-6);
}

#[test]
fn unknown_parent_curve_says_so() {
    let body = "#30=IFCCARTESIANPOINT((0.,0.));\n\
        #40=IFCCURVESEGMENT(.DISCONTINUOUS.,#905,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(10.),#30);\n\
        #50=IFCCOMPOSITECURVE((#40),.F.);\n\
        #5=IFCSWEPTDISKSOLID(#50,0.1,$,$,$);\n";
    let (_, diagnostics) = run(body, "$");
    assert!(diagnostics.iter().any(|item| item.code == "unsupported-curve"), "{diagnostics:?}");
}
