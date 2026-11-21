//! Solids checked against closed-form volumes and the normative IFC definitions.

use glam::DVec3;
use ifc_geometry::{Mesh, ModelEvaluator};
use std::f64::consts::{PI, TAU};
use std::fs;
use std::path::Path;
use step_parser::index;

const COMMON: &str = "#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
    #2=IFCWALL('w',$,$,$,$,$,#3,$);\n\
    #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
    #4=IFCSHAPEREPRESENTATION($,'Body','SolidModel',(#5));\n\
    #900=IFCCARTESIANPOINT((0.,0.,0.));\n\
    #901=IFCDIRECTION((0.,0.,1.));\n\
    #902=IFCDIRECTION((1.,0.,0.));\n\
    #903=IFCAXIS2PLACEMENT3D(#900,$,$);\n\
    #904=IFCCARTESIANPOINT((0.,0.));\n\
    #905=IFCAXIS2PLACEMENT2D(#904,$);\n";

/// A regular polygon of 32 sides, as circles are faceted, against the true circle.
fn faceted_circle_area(radius: f64) -> f64 {
    16.0 * radius * radius * (TAU / 32.0).sin()
}

fn bounds(mesh: &Mesh) -> (DVec3, DVec3) {
    let start = (DVec3::INFINITY, DVec3::NEG_INFINITY);
    mesh.positions
        .iter()
        .fold(start, |(min, max), point| (min.min(*point), max.max(*point)))
}

fn evaluate_with(body: &str, expect_diagnostics: bool) -> Mesh {
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{COMMON}{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(2).expect("the element evaluates");
    if !expect_diagnostics {
        assert!(evaluator.diagnostics().is_empty(), "{:?}", evaluator.diagnostics());
    }
    let mut meshes = element.meshes;
    assert_eq!(meshes.len(), 1);
    meshes.remove(0).mesh
}

fn evaluate(body: &str) -> Mesh {
    evaluate_with(body, false)
}

fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!((actual - expected).abs() <= tolerance, "{actual} against {expected}");
}

#[test]
fn block_starts_at_its_position_and_grows_along_the_axes() {
    let mesh = evaluate("#5=IFCBLOCK(#903,2.,3.,4.);\n");
    close(mesh.volume(), 24.0, 1e-9);
    assert_eq!(bounds(&mesh), (DVec3::ZERO, DVec3::new(2.0, 3.0, 4.0)));
}

#[test]
fn cylinder_base_is_at_the_origin_and_rises_along_z() {
    let mesh = evaluate("#5=IFCRIGHTCIRCULARCYLINDER(#903,3.,0.5);\n");
    close(mesh.volume(), faceted_circle_area(0.5) * 3.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
    let (min, max) = bounds(&mesh);
    close(min.z, 0.0, 1e-12);
    close(max.z, 3.0, 1e-12);
}

#[test]
fn cone_tapers_to_its_apex() {
    let mesh = evaluate("#5=IFCRIGHTCIRCULARCONE(#903,3.,1.);\n");
    close(mesh.volume(), faceted_circle_area(1.0), 1e-9);
    assert_eq!(mesh.open_edges(), 0);
    assert!(mesh.positions.contains(&DVec3::new(0.0, 0.0, 3.0)));
}

#[test]
fn sphere_is_centred_on_its_position() {
    let mesh = evaluate("#5=IFCSPHERE(#903,2.);\n");
    close(mesh.volume(), 4.0 / 3.0 * PI * 8.0, 2.0);
    assert_eq!(mesh.open_edges(), 0);
    let (min, max) = bounds(&mesh);
    close(min.z, -2.0, 1e-9);
    close(max.z, 2.0, 1e-9);
}

#[test]
fn pyramid_apex_sits_over_the_middle_of_its_base() {
    let mesh = evaluate("#5=IFCRECTANGULARPYRAMID(#903,2.,4.,3.);\n");
    close(mesh.volume(), 8.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
    assert!(mesh.positions.contains(&DVec3::new(1.0, 2.0, 3.0)));
}

const TWO_HIGH_BLOCK: &str = "#10=IFCBLOCK(#903,1.,1.,2.);\n\
    #11=IFCCARTESIANPOINT((0.,0.,1.));\n\
    #12=IFCAXIS2PLACEMENT3D(#11,$,$);\n\
    #13=IFCPLANE(#12);\n";

#[test]
fn agreement_flag_true_means_the_normal_points_away_from_the_material() {
    let mesh = evaluate(&format!(
        "{TWO_HIGH_BLOCK}#14=IFCHALFSPACESOLID(#13,.T.);\n\
         #5=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#14);\n"
    ));
    close(mesh.volume(), 1.0, 1e-9);
    close(bounds(&mesh).0.z, 1.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn agreement_flag_false_keeps_the_other_side() {
    let mesh = evaluate(&format!(
        "{TWO_HIGH_BLOCK}#14=IFCHALFSPACESOLID(#13,.F.);\n\
         #5=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#14);\n"
    ));
    close(mesh.volume(), 1.0, 1e-9);
    close(bounds(&mesh).1.z, 1.0, 1e-9);
}

#[test]
fn polygonal_bound_limits_the_clip_to_its_outline() {
    // Removes the upper half of the block, but only where x is below 0.5.
    let mesh = evaluate(&format!(
        "{TWO_HIGH_BLOCK}#20=IFCCARTESIANPOINT((-1.,-1.));\n\
         #21=IFCCARTESIANPOINT((0.5,-1.));\n\
         #22=IFCCARTESIANPOINT((0.5,2.));\n\
         #23=IFCCARTESIANPOINT((-1.,2.));\n\
         #24=IFCPOLYLINE((#20,#21,#22,#23,#20));\n\
         #14=IFCPOLYGONALBOUNDEDHALFSPACE(#13,.F.,#903,#24);\n\
         #5=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#14);\n"
    ));
    close(mesh.volume(), 1.5, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn a_bounded_half_space_whose_segments_do_not_meet_is_not_used() {
    // The outline above as two segments, the second starting `gap` metres further along Y than
    // the first ends. Revit writes some boundaries with arcs centred kilometres away, whose
    // ends then lie that far apart; joined up, the outline covers what it should not.
    for (gap, volume, broken) in [(0.0, 1.5, false), (0.009, 1.5, false), (0.011, 2.0, true), (1000.0, 2.0, true)] {
        let body = format!(
            "{TWO_HIGH_BLOCK}#20=IFCCARTESIANPOINT((-1.,-1.));\n\
             #21=IFCCARTESIANPOINT((0.5,-1.));\n\
             #22=IFCCARTESIANPOINT((0.5,2.));\n\
             #23=IFCCARTESIANPOINT((-1.,2.));\n\
             #26=IFCCARTESIANPOINT((0.5,{}));\n\
             #24=IFCPOLYLINE((#20,#21,#22));\n\
             #25=IFCPOLYLINE((#26,#23,#20));\n\
             #27=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#24);\n\
             #28=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#25);\n\
             #29=IFCCOMPOSITECURVE((#27,#28),.F.);\n\
             #14=IFCPOLYGONALBOUNDEDHALFSPACE(#13,.F.,#903,#29);\n\
             #5=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#14);\n",
            2.0 + gap
        );
        let text = format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{COMMON}{body}ENDSEC;END-ISO-10303-21;");
        let file = index(text.as_bytes()).unwrap();
        let mut evaluator = ModelEvaluator::new(&file).unwrap();
        let mesh = evaluator.evaluate(2).expect("the element evaluates").meshes.remove(0).mesh;
        let codes: Vec<&str> = evaluator.diagnostics().iter().map(|item| item.code).collect();
        close(mesh.volume(), volume, 1e-9);
        assert_eq!(mesh.open_edges(), 0, "{gap}");
        assert_eq!(codes.contains(&"broken-boundary"), broken, "{gap}: {codes:?}");
        assert_eq!(codes.is_empty(), !broken, "{gap}: {codes:?}");
    }
}

/// The block of `TWO_HIGH_BLOCK` with a half space `#14` whose material lies above its top,
/// as Revit clips walls at their own height, under `operator`.
fn clear_of_the_top(half_space: &str, operator: &str) -> String {
    format!(
        "#10=IFCBLOCK(#903,1.,1.,2.);\n\
         #11=IFCCARTESIANPOINT((0.,0.,2.));\n\
         #12=IFCAXIS2PLACEMENT3D(#11,$,$);\n\
         #13=IFCPLANE(#12);\n\
         #20=IFCCARTESIANPOINT((-1.,-1.));\n\
         #21=IFCCARTESIANPOINT((0.5,-1.));\n\
         #22=IFCCARTESIANPOINT((2.,-1.));\n\
         #23=IFCCARTESIANPOINT((2.,2.));\n\
         #24=IFCCARTESIANPOINT((-1.,2.));\n\
         {half_space}\n\
         #6=IFCBOOLEANRESULT(.{operator}.,#10,#14);\n\
         #5=IFCCSGSOLID(#6);\n"
    )
}

/// Half spaces above the block: unbounded; bounded by three points on one line; and bounded
/// by a ring that crosses itself. However it is bounded, none reaches the block.
const CLEAR_HALF_SPACES: [&str; 3] = [
    "#14=IFCHALFSPACESOLID(#13,.F.);",
    "#25=IFCPOLYLINE((#20,#21,#22,#20));\n#14=IFCPOLYGONALBOUNDEDHALFSPACE(#13,.F.,#903,#25);",
    "#25=IFCPOLYLINE((#20,#23,#22,#24,#20));\n#14=IFCPOLYGONALBOUNDEDHALFSPACE(#13,.F.,#903,#25);",
];

#[test]
fn a_half_space_clear_of_the_solid_leaves_it_whole_however_it_is_bounded() {
    // Also when the solid reaches half a micrometre into it, as rounding leaves a wall's top.
    for top in ["(0.,0.,2.)", "(0.,0.,1.9999995)"] {
        for half_space in CLEAR_HALF_SPACES {
            let mesh = evaluate(&clear_of_the_top(half_space, "DIFFERENCE").replace("(0.,0.,2.)", top));
            close(mesh.volume(), 2.0, 1e-12);
            assert_eq!(mesh.triangles.len(), 12, "{top} {half_space}: the block's own triangles");
        }
    }
}

#[test]
fn a_half_space_clear_of_the_solid_has_nothing_in_common_with_it() {
    for half_space in CLEAR_HALF_SPACES {
        let text = format!(
            "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{COMMON}{}ENDSEC;END-ISO-10303-21;",
            clear_of_the_top(half_space, "INTERSECTION")
        );
        let file = index(text.as_bytes()).unwrap();
        let mut evaluator = ModelEvaluator::new(&file).unwrap();
        let element = evaluator.evaluate(2).expect("the element evaluates");
        assert!(element.meshes.iter().all(|item| item.mesh.is_empty()), "{half_space}");
        assert!(evaluator.diagnostics().is_empty(), "{half_space}: {:?}", evaluator.diagnostics());
    }
}

#[test]
fn a_half_space_reaching_a_hair_into_the_solid_still_cuts() {
    // Material from 1 mm below the block's top: a 1 mm slice comes off.
    let mesh = evaluate(&clear_of_the_top(CLEAR_HALF_SPACES[0], "DIFFERENCE").replace("(0.,0.,2.)", "(0.,0.,1.999)"));
    close(mesh.volume(), 1.999, 1e-9);
}

#[test]
fn clipping_a_rotated_plane_cuts_on_the_diagonal() {
    let mesh = evaluate(
        "#10=IFCBLOCK(#903,1.,1.,1.);\n\
         #11=IFCCARTESIANPOINT((1.,0.,0.));\n\
         #12=IFCDIRECTION((1.,0.,1.));\n\
         #15=IFCAXIS2PLACEMENT3D(#11,#12,$);\n\
         #13=IFCPLANE(#15);\n\
         #14=IFCHALFSPACESOLID(#13,.F.);\n\
         #5=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#14);\n",
    );
    close(mesh.volume(), 0.5, 1e-9);
}

const OVERLAPPING: &str = "#10=IFCBLOCK(#903,2.,2.,2.);\n\
    #11=IFCCARTESIANPOINT((1.,1.,1.));\n\
    #12=IFCAXIS2PLACEMENT3D(#11,$,$);\n\
    #13=IFCBLOCK(#12,2.,2.,2.);\n";

#[test]
fn boolean_operators_follow_their_names() {
    for (operator, expected) in [("UNION", 15.0), ("INTERSECTION", 1.0), ("DIFFERENCE", 7.0)] {
        let mesh = evaluate(&format!(
            "{OVERLAPPING}#6=IFCBOOLEANRESULT(.{operator}.,#10,#13);\n#5=IFCCSGSOLID(#6);\n"
        ));
        close(mesh.volume(), expected, 1e-9);
        assert_eq!(mesh.open_edges(), 0, "{operator}");
    }
}

#[test]
fn a_full_revolution_makes_a_ring_with_no_caps() {
    let mesh = evaluate(
        "#10=IFCCARTESIANPOINT((1.5,0.));\n\
         #11=IFCAXIS2PLACEMENT2D(#10,$);\n\
         #12=IFCRECTANGLEPROFILEDEF(.AREA.,$,#11,1.,1.);\n\
         #13=IFCDIRECTION((0.,1.,0.));\n\
         #14=IFCAXIS1PLACEMENT(#900,#13);\n\
         #5=IFCREVOLVEDAREASOLID(#12,#903,#14,6.283185307179586);\n",
    );
    close(mesh.volume(), faceted_circle_area(2.0) - faceted_circle_area(1.0), 1e-9);
    assert_eq!(mesh.open_edges(), 0);
    let (min, max) = bounds(&mesh);
    close(max.x, 2.0, 1e-9);
    close(min.x, -2.0, 1e-9);
    close(max.y - min.y, 1.0, 1e-9);
}

#[test]
fn a_part_revolution_is_capped_and_turns_by_the_right_hand_rule() {
    let mesh = evaluate(
        "#10=IFCCARTESIANPOINT((1.5,0.));\n\
         #11=IFCAXIS2PLACEMENT2D(#10,$);\n\
         #12=IFCRECTANGLEPROFILEDEF(.AREA.,$,#11,1.,1.);\n\
         #13=IFCDIRECTION((0.,1.,0.));\n\
         #14=IFCAXIS1PLACEMENT(#900,#13);\n\
         #5=IFCREVOLVEDAREASOLID(#12,#903,#14,1.5707963267948966);\n",
    );
    close(mesh.volume(), (faceted_circle_area(2.0) - faceted_circle_area(1.0)) / 4.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
    // Turning +X about +Y by a quarter leads to -Z.
    let (min, max) = bounds(&mesh);
    close(min.z, -2.0, 1e-9);
    close(max.z, 0.0, 1e-9);
}

fn twelve_gon_area(radius: f64) -> f64 {
    6.0 * radius * radius * (TAU / 12.0).sin()
}

#[test]
fn a_straight_pipe_has_the_volume_of_its_section() {
    let mesh = evaluate(
        "#10=IFCCARTESIANPOINT((0.,0.,5.));\n\
         #11=IFCPOLYLINE((#900,#10));\n\
         #5=IFCSWEPTDISKSOLID(#11,0.5,$,$,$);\n",
    );
    close(mesh.volume(), twelve_gon_area(0.5) * 5.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn a_mitred_bend_keeps_section_times_centre_line() {
    let mesh = evaluate(
        "#10=IFCCARTESIANPOINT((0.,0.,5.));\n\
         #12=IFCCARTESIANPOINT((3.,0.,5.));\n\
         #11=IFCPOLYLINE((#900,#10,#12));\n\
         #5=IFCSWEPTDISKSOLID(#11,0.25,$,$,$);\n",
    );
    close(mesh.volume(), twelve_gon_area(0.25) * 8.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn inner_radius_makes_a_hollow_tube() {
    let mesh = evaluate(
        "#10=IFCCARTESIANPOINT((0.,0.,5.));\n\
         #11=IFCPOLYLINE((#900,#10));\n\
         #5=IFCSWEPTDISKSOLID(#11,0.5,0.25,$,$);\n",
    );
    close(mesh.volume(), (twelve_gon_area(0.5) - twelve_gon_area(0.25)) * 5.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
}

fn extruded(curve: u32) -> String {
    format!(
        "#50=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#{curve});\n\
         #5=IFCEXTRUDEDAREASOLID(#50,#903,#901,1.);\n"
    )
}

#[test]
fn indexed_arcs_are_curves_not_chords() {
    // A half disc of radius 1: arc from (1,0) through (0,1) to (-1,0), closed by a line.
    let mesh = evaluate(&format!(
        "#10=IFCCARTESIANPOINTLIST2D(((1.,0.),(0.,1.),(-1.,0.)));\n\
         #11=IFCINDEXEDPOLYCURVE(#10,(IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,1))),$);\n{}",
        extruded(11)
    ));
    close(mesh.volume(), faceted_circle_area(1.0) / 2.0, 1e-9);
}

#[test]
fn composite_curves_join_trimmed_circles_and_lines() {
    // A stadium: two half circles of radius 1, centred 2 apart.
    let mesh = evaluate(&format!(
        "#10=IFCCARTESIANPOINT((0.,0.));\n\
         #11=IFCAXIS2PLACEMENT2D(#10,$);\n\
         #12=IFCCIRCLE(#11,1.);\n\
         #13=IFCTRIMMEDCURVE(#12,(IFCPARAMETERVALUE(1.5707963267948966)),(IFCPARAMETERVALUE(4.71238898038469)),.T.,.PARAMETER.);\n\
         #20=IFCCARTESIANPOINT((2.,0.));\n\
         #21=IFCAXIS2PLACEMENT2D(#20,$);\n\
         #22=IFCCIRCLE(#21,1.);\n\
         #23=IFCTRIMMEDCURVE(#22,(IFCPARAMETERVALUE(4.71238898038469)),(IFCPARAMETERVALUE(1.5707963267948966)),.T.,.PARAMETER.);\n\
         #30=IFCCARTESIANPOINT((0.,-1.));\n\
         #31=IFCCARTESIANPOINT((2.,-1.));\n\
         #32=IFCPOLYLINE((#30,#31));\n\
         #33=IFCCARTESIANPOINT((2.,1.));\n\
         #34=IFCCARTESIANPOINT((0.,1.));\n\
         #35=IFCPOLYLINE((#33,#34));\n\
         #40=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#13);\n\
         #41=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#32);\n\
         #42=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#23);\n\
         #43=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#35);\n\
         #44=IFCCOMPOSITECURVE((#40,#41,#42,#43),.F.);\n{}",
        extruded(44)
    ));
    close(mesh.volume(), faceted_circle_area(1.0) + 4.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn against_the_sense_a_trim_runs_the_short_way_back() {
    // From 90 to 0 degrees clockwise: a quarter arc, closed through the centre.
    let mesh = evaluate(&format!(
        "#12=IFCCIRCLE(#905,1.);\n\
         #13=IFCTRIMMEDCURVE(#12,(IFCPARAMETERVALUE(1.5707963267948966)),(IFCPARAMETERVALUE(0.)),.F.,.PARAMETER.);\n\
         #30=IFCCARTESIANPOINT((1.,0.));\n\
         #31=IFCCARTESIANPOINT((0.,0.));\n\
         #32=IFCCARTESIANPOINT((0.,1.));\n\
         #33=IFCPOLYLINE((#30,#31,#32));\n\
         #40=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#13);\n\
         #41=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#33);\n\
         #44=IFCCOMPOSITECURVE((#40,#41),.F.);\n{}",
        extruded(44)
    ));
    close(mesh.volume(), faceted_circle_area(1.0) / 4.0, 1e-9);
}

/// Weights of cos(45 degrees) make the middle of a quadratic exactly a quarter circle.
#[test]
fn rational_splines_draw_true_circles() {
    let mesh = evaluate(&format!(
        "#10=IFCCARTESIANPOINT((1.,0.));\n\
         #11=IFCCARTESIANPOINT((1.,1.));\n\
         #12=IFCCARTESIANPOINT((0.,1.));\n\
         #13=IFCCARTESIANPOINT((0.,0.));\n\
         #14=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#10,#11,#12),.CIRCULAR_ARC.,.F.,.U.,(3,3),(0.,1.),.UNSPECIFIED.,(1.,0.7071067811865476,1.));\n\
         #15=IFCPOLYLINE((#12,#13,#10));\n\
         #16=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#14);\n\
         #17=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#15);\n\
         #18=IFCCOMPOSITECURVE((#16,#17),.F.);\n{}",
        extruded(18)
    ));
    // Without the weight this curve is a parabola enclosing 5/6, far outside this margin.
    close(mesh.volume(), PI / 4.0, 6e-3);
    assert!(mesh.volume() < PI / 4.0, "chords stay inside the arc");
}

/// A flat surface in spline form, with a trim, so its area is known exactly.
#[test]
fn trimmed_spline_surfaces_follow_their_boundary() {
    let mesh = evaluate(
        "#20=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #21=IFCCARTESIANPOINT((0.,4.,0.));\n\
         #22=IFCCARTESIANPOINT((4.,0.,0.));\n\
         #23=IFCCARTESIANPOINT((4.,4.,0.));\n\
         #24=IFCBSPLINESURFACEWITHKNOTS(1,1,((#20,#21),(#22,#23)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\n\
         #30=IFCCARTESIANPOINT((1.,1.,0.));\n\
         #31=IFCCARTESIANPOINT((3.,1.,0.));\n\
         #32=IFCCARTESIANPOINT((3.,3.,0.));\n\
         #33=IFCPOLYLOOP((#30,#31,#32));\n\
         #34=IFCFACEOUTERBOUND(#33,.T.);\n\
         #35=IFCADVANCEDFACE((#34),#24,.T.);\n\
         #36=IFCOPENSHELL((#35));\n\
         #5=IFCSHELLBASEDSURFACEMODEL((#36));\n",
    );
    let area: f64 = mesh
        .triangle_corners()
        .map(|[a, b, c]| (b - a).cross(c - a).length() / 2.0)
        .sum();
    close(area, 2.0, 1e-6);
}

fn surface_area(mesh: &Mesh) -> f64 {
    mesh.triangle_corners().map(|[a, b, c]| (b - a).cross(c - a).length() / 2.0).sum()
}

/// A slot crossing many grid cells, and a concave outline: both defeat per-cell clipping.
#[test]
fn trims_with_slots_and_concave_outlines_keep_their_exact_area() {
    let surface = "#20=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #21=IFCCARTESIANPOINT((0.,10.,0.));\n\
         #22=IFCCARTESIANPOINT((10.,0.,0.));\n\
         #23=IFCCARTESIANPOINT((10.,10.,0.));\n\
         #24=IFCBSPLINESURFACEWITHKNOTS(1,1,((#20,#21),(#22,#23)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\n";
    let ring = |first: u32, points: &[(f64, f64)]| {
        let mut text = String::new();
        let mut ids = Vec::new();
        for (index, (x, y)) in points.iter().enumerate() {
            let id = first + index as u32;
            text.push_str(&format!("#{id}=IFCCARTESIANPOINT(({x:?},{y:?},0.));\n"));
            ids.push(format!("#{id}"));
        }
        (text, ids.join(","))
    };

    // A comb: a 9 by 9 square with a deep notch, whose outline wanders in and out of cells.
    let (outer, outer_ids) = ring(100, &[(0.5, 0.5), (9.5, 0.5), (9.5, 9.5), (5.5, 9.5), (5.5, 2.5), (4.5, 2.5), (4.5, 9.5), (0.5, 9.5)]);
    // A thin slot right across the left part.
    let (slot, slot_ids) = ring(200, &[(1.0, 1.0), (1.2, 1.0), (1.2, 9.0), (1.0, 9.0)]);
    let mesh = evaluate(&format!(
        "{surface}{outer}{slot}#30=IFCPOLYLOOP(({outer_ids}));\n\
         #31=IFCFACEOUTERBOUND(#30,.T.);\n\
         #32=IFCPOLYLOOP(({slot_ids}));\n\
         #33=IFCFACEBOUND(#32,.T.);\n\
         #35=IFCADVANCEDFACE((#31,#33),#24,.T.);\n\
         #36=IFCOPENSHELL((#35));\n\
         #5=IFCSHELLBASEDSURFACEMODEL((#36));\n"
    ));
    close(surface_area(&mesh), 81.0 - 7.0 - 1.6, 1e-9);
}

/// A sharp ridge between clustered knots must not fall between grid lines.
#[test]
fn clustered_knots_get_their_own_grid_lines() {
    let mut points = String::new();
    let mut rows = Vec::new();
    let heights = [0.0, 0.0, 5.0, 0.0, 0.0];
    for (i, x) in [0.0, 3.25, 3.3, 3.35, 10.0].iter().enumerate() {
        let (a, b) = (300 + i * 2, 301 + i * 2);
        points.push_str(&format!(
            "#{a}=IFCCARTESIANPOINT(({x:?},0.,{:?}));\n#{b}=IFCCARTESIANPOINT(({x:?},10.,{:?}));\n",
            heights[i], heights[i]
        ));
        rows.push(format!("(#{a},#{b})"));
    }
    let mesh = evaluate(&format!(
        "{points}#24=IFCBSPLINESURFACEWITHKNOTS(1,1,({}),.UNSPECIFIED.,.F.,.F.,.F.,(2,1,1,1,2),(2,2),(0.,0.325,0.33,0.335,1.),(0.,1.),.UNSPECIFIED.);\n\
         #30=IFCCARTESIANPOINT((0.,0.,0.));\n#31=IFCCARTESIANPOINT((10.,0.,0.));\n\
         #32=IFCCARTESIANPOINT((10.,10.,0.));\n#33=IFCCARTESIANPOINT((0.,10.,0.));\n\
         #34=IFCPOLYLOOP((#30,#31,#32,#33));\n\
         #35=IFCFACEOUTERBOUND(#34,.T.);\n\
         #36=IFCADVANCEDFACE((#35),#24,.T.);\n\
         #37=IFCOPENSHELL((#36));\n\
         #5=IFCSHELLBASEDSURFACEMODEL((#37));\n",
        rows.join(",")
    ));
    close(bounds(&mesh).1.z, 5.0, 1e-6);
}

/// Each edge's polyline overshoots both of its vertices. Only the vertices may count.
#[test]
fn edges_use_only_the_part_of_a_curve_between_their_vertices() {
    let mut body = String::from(
        "#20=IFCCARTESIANPOINT((0.,0.,0.));\n#21=IFCCARTESIANPOINT((2.,0.,0.));\n\
         #22=IFCCARTESIANPOINT((2.,2.,0.));\n#23=IFCCARTESIANPOINT((0.,2.,0.));\n\
         #30=IFCVERTEXPOINT(#20);\n#31=IFCVERTEXPOINT(#21);\n\
         #32=IFCVERTEXPOINT(#22);\n#33=IFCVERTEXPOINT(#23);\n",
    );
    let corners = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];
    for side in 0..4usize {
        let (a, b) = (corners[side], corners[(side + 1) % 4]);
        let direction = ((b.0 - a.0) / 2.0, (b.1 - a.1) / 2.0);
        let id = 40 + side * 10;
        body.push_str(&format!(
            "#{id}=IFCCARTESIANPOINT(({:.1},{:.1},0.));\n\
             #{}=IFCCARTESIANPOINT(({:.1},{:.1},0.));\n\
             #{}=IFCCARTESIANPOINT(({:.1},{:.1},0.));\n\
             #{}=IFCCARTESIANPOINT(({:.1},{:.1},0.));\n\
             #{}=IFCPOLYLINE((#{},#{id},#{},#{},#{},#{}));\n\
             #{}=IFCEDGECURVE(#{},#{},#{},.T.);\n\
             #{}=IFCORIENTEDEDGE(*,*,#{},.T.);\n",
            a.0 - direction.0, a.1 - direction.1,
            id + 1, b.0 + direction.0, b.1 + direction.1,
            id + 5, a.0 - direction.0 * 2.0, a.1 - direction.1 * 2.0,
            id + 6, b.0 + direction.0 * 2.0, b.1 + direction.1 * 2.0,
            id + 2, id + 5, 20 + side, 20 + (side + 1) % 4, id + 1, id + 6,
            id + 3, 30 + side, 30 + (side + 1) % 4, id + 2,
            id + 4, id + 3,
        ));
    }
    body.push_str(
        "#90=IFCEDGELOOP((#44,#54,#64,#74));\n\
         #91=IFCFACEOUTERBOUND(#90,.T.);\n\
         #92=IFCPLANE(#903);\n\
         #93=IFCADVANCEDFACE((#91),#92,.T.);\n\
         #94=IFCOPENSHELL((#93));\n\
         #5=IFCSHELLBASEDSURFACEMODEL((#94));\n",
    );
    let mesh = evaluate(&body);
    let (min, max) = bounds(&mesh);
    assert_eq!((min, max), (DVec3::ZERO, DVec3::new(2.0, 2.0, 0.0)));
}

#[test]
fn absurd_spline_data_gives_a_diagnostic_not_a_crash() {
    for (degree, multiplicities) in [("1000000", "(3,3)"), ("2", "(1,1)"), ("2", "(100000000,100000000)")] {
        let text = format!(
            "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{COMMON}\
             #10=IFCCARTESIANPOINT((1.,0.));\n#11=IFCCARTESIANPOINT((1.,1.));\n#12=IFCCARTESIANPOINT((0.,1.));\n\
             #14=IFCBSPLINECURVEWITHKNOTS({degree},(#10,#11,#12),.UNSPECIFIED.,.F.,.U.,{multiplicities},(0.,1.),.UNSPECIFIED.);\n\
             #50=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#14);\n\
             #5=IFCEXTRUDEDAREASOLID(#50,#903,#901,1.);\nENDSEC;END-ISO-10303-21;"
        );
        let file = index(text.as_bytes()).unwrap();
        let mut evaluator = ModelEvaluator::new(&file).unwrap();
        assert!(evaluator.evaluate(2).is_some_and(|element| element.meshes.is_empty()));
    }
}

fn profile_area(profile: &str) -> f64 {
    let mesh = evaluate(&format!("{profile}\n#5=IFCEXTRUDEDAREASOLID(#50,#903,#901,1.);\n"));
    assert_eq!(mesh.open_edges(), 0, "{profile}");
    mesh.volume()
}

#[test]
fn section_profiles_have_the_area_of_their_parts() {
    // What a fillet takes from or adds to a square corner, with its arc in eight facets.
    let quarter_fillet = |r: f64| r * r * (1.0 - 4.0 * (PI / 16.0).sin());
    let cases = [
        ("IFCISHAPEPROFILEDEF(.AREA.,$,#905,0.2,0.3,0.01,0.02,$,$,$)", 2.0 * 0.2 * 0.02 + 0.26 * 0.01),
        ("IFCISHAPEPROFILEDEF(.AREA.,$,#905,0.2,0.3,0.01,0.02,0.01,$,$)", 2.0 * 0.2 * 0.02 + 0.26 * 0.01 + 4.0 * quarter_fillet(0.01)),
        ("IFCLSHAPEPROFILEDEF(.AREA.,$,#905,0.2,0.1,0.01,$,$,$)", 0.2 * 0.01 + 0.09 * 0.01),
        ("IFCTSHAPEPROFILEDEF(.AREA.,$,#905,0.2,0.1,0.01,0.02,$,$,$,$,$)", 0.1 * 0.02 + 0.18 * 0.01),
        ("IFCUSHAPEPROFILEDEF(.AREA.,$,#905,0.2,0.1,0.01,0.02,$,$,$)", 0.2 * 0.01 + 2.0 * 0.09 * 0.02),
        ("IFCCSHAPEPROFILEDEF(.AREA.,$,#905,0.2,0.1,0.01,0.03,$)", 0.2 * 0.01 + 2.0 * 0.09 * 0.01 + 2.0 * 0.02 * 0.01),
        ("IFCZSHAPEPROFILEDEF(.AREA.,$,#905,0.2,0.1,0.01,0.02,$,$)", 0.2 * 0.01 + 2.0 * 0.09 * 0.02),
        ("IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#905,0.2,0.1,0.01,$,$)", 0.2 * 0.1 - 0.18 * 0.08),
        ("IFCROUNDEDRECTANGLEPROFILEDEF(.AREA.,$,#905,0.2,0.1,0.02)", 0.2 * 0.1 - 4.0 * quarter_fillet(0.02)),
    ];
    for (profile, expected) in cases {
        close(profile_area(&format!("#50={profile};")), expected, 1e-12);
    }
}

#[test]
fn hollow_and_elliptical_profiles() {
    close(
        profile_area("#50=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,#905,1.,0.25);"),
        faceted_circle_area(1.0) - faceted_circle_area(0.75),
        1e-9,
    );
    // Against the true area: 2 m across is wide enough for the chord tolerance to decide, and
    // 32 stretched facets miss this by 0.04.
    close(profile_area("#50=IFCELLIPSEPROFILEDEF(.AREA.,$,#905,2.,1.);"), PI * 2.0, 0.025);
}

#[test]
fn composite_profiles_extrude_every_part() {
    let mesh = evaluate(
        "#51=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,1.,1.);\n\
         #52=IFCCARTESIANPOINT((3.,0.));\n\
         #53=IFCAXIS2PLACEMENT2D(#52,$);\n\
         #54=IFCRECTANGLEPROFILEDEF(.AREA.,$,#53,1.,2.);\n\
         #50=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#51,#54),$);\n\
         #5=IFCEXTRUDEDAREASOLID(#50,#903,#901,1.);\n",
    );
    close(mesh.volume(), 3.0, 1e-9);
}

#[test]
fn derived_profiles_apply_their_operator_and_mirrors_flip_across_y() {
    let shape = "#51=IFCCARTESIANPOINT((2.,0.));\n\
         #52=IFCAXIS2PLACEMENT2D(#51,$);\n\
         #53=IFCRECTANGLEPROFILEDEF(.AREA.,$,#52,1.,1.);\n";
    let mesh = evaluate(&format!(
        "{shape}#54=IFCCARTESIANPOINT((0.,5.));\n\
         #55=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#54,$);\n\
         #50=IFCDERIVEDPROFILEDEF(.AREA.,$,#53,#55,$);\n\
         #5=IFCEXTRUDEDAREASOLID(#50,#903,#901,1.);\n"
    ));
    close(bounds(&mesh).0.y, 4.5, 1e-9);
    close(bounds(&mesh).0.x, 1.5, 1e-9);

    let mesh = evaluate(&format!(
        "{shape}#50=IFCMIRROREDPROFILEDEF(.AREA.,$,#53,$,$);\n\
         #5=IFCEXTRUDEDAREASOLID(#50,#903,#901,1.);\n"
    ));
    close(mesh.volume(), 1.0, 1e-9);
    close(bounds(&mesh).1.x, -1.5, 1e-9);
}

#[test]
fn a_boolean_on_an_open_mesh_keeps_the_first_operand_and_says_so() {
    let mesh = evaluate_with(
        "#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));\n\
         #11=IFCTRIANGULATEDFACESET(#10,$,$,((1,2,3)),$);\n\
         #12=IFCBLOCK(#903,1.,1.,1.);\n\
         #5=IFCBOOLEANRESULT(.DIFFERENCE.,#11,#12);\n",
        true,
    );
    assert_eq!(mesh.triangles.len(), 1);
}

/// Forty levels that each use the level below twice: 2^40 paths.
#[test]
fn shared_boolean_operands_do_not_multiply_the_work() {
    let mut body = String::from("#5=IFCBOOLEANRESULT(.UNION.,#100,#100);\n");
    for level in 0..40 {
        let id = 100 + level;
        body.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#{0},#{0});\n", id + 1));
    }
    body.push_str("#140=IFCBLOCK(#903,1.,1.,1.);\n");
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{COMMON}{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let started = std::time::Instant::now();
    evaluator.evaluate(2).unwrap();
    assert!(started.elapsed().as_secs() < 30, "{:?}", started.elapsed());
    assert!(evaluator.diagnostics().iter().any(|item| item.code == "too-many-booleans"));
}

#[test]
fn cyclic_operands_and_curves_end_with_a_diagnostic() {
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{COMMON}\
         #5=IFCBOOLEANRESULT(.UNION.,#5,#5);\nENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    evaluator.evaluate(2);
    assert!(evaluator.diagnostics().iter().any(|item| item.code == "nesting-too-deep"));
}

const SQUARE_TAPER: &str = "#6=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,2.,2.);\n\
    #7=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,1.,1.);\n";

#[test]
fn tapered_extrusion_narrows_to_its_end_section() {
    let body = format!("{SQUARE_TAPER}#5=IFCEXTRUDEDAREASOLIDTAPERED(#6,#903,#901,3.,#7);\n");
    let mesh = evaluate(&body);
    // A frustum: h/3 (A1 + A2 + sqrt(A1 A2)).
    close(mesh.volume(), 7.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
    let top: Vec<_> = mesh.positions.iter().filter(|point| point.z > 2.9).collect();
    assert!(!top.is_empty() && top.iter().all(|point| point.x.abs() <= 0.5 + 1e-9));
    assert!(mesh.positions.iter().any(|point| point.x > 0.9));
}

#[test]
fn tapered_extrusion_may_lean() {
    let body = format!(
        "{SQUARE_TAPER}#8=IFCDIRECTION((0.6,0.,0.8));\n#5=IFCEXTRUDEDAREASOLIDTAPERED(#6,#903,#8,5.,#7);\n"
    );
    let mesh = evaluate(&body);
    // A depth of 5 along this direction rises 4 and moves 3 sideways.
    close(mesh.volume(), 4.0 / 3.0 * 7.0, 1e-9);
    let top: Vec<_> = mesh.positions.iter().filter(|point| point.z > 3.9).collect();
    assert!(top.iter().all(|point| (point.x - 3.0).abs() <= 0.5 + 1e-9));
}

#[test]
fn tapered_extrusion_with_twisted_walls_follows_the_ruled_surface() {
    let body = "#6=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,4.,1.);\n\
        #7=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,1.,4.);\n\
        #5=IFCEXTRUDEDAREASOLIDTAPERED(#6,#903,#901,2.,#7);\n";
    let mesh = evaluate(body);
    // The prismoidal formula: h/6 (A1 + 4 Am + A2), with a 2.5 by 2.5 mid-section.
    close(mesh.volume(), 11.0, 0.05);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn tapered_extrusion_keeps_holes() {
    let body = "#6=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#905,2.,2.,0.5,$,$);\n\
        #7=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#905,1.,1.,0.25,$,$);\n\
        #5=IFCEXTRUDEDAREASOLIDTAPERED(#6,#903,#901,3.,#7);\n";
    let mesh = evaluate(body);
    close(mesh.volume(), 7.0 - 7.0 / 4.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn tapered_extrusion_between_different_outlines_is_still_closed() {
    let body = "#6=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,2.,2.);\n\
        #7=IFCCIRCLEPROFILEDEF(.AREA.,$,#905,1.);\n\
        #5=IFCEXTRUDEDAREASOLIDTAPERED(#6,#903,#901,3.,#7);\n";
    let mesh = evaluate(body);
    assert_eq!(mesh.open_edges(), 0);
    assert!(mesh.volume() > 3.0 * faceted_circle_area(1.0) && mesh.volume() < 12.0);
    let top = mesh.positions.iter().filter(|point| point.z > 2.9);
    top.for_each(|point| close(point.x.hypot(point.y), 1.0, 1e-9));
}

#[test]
fn tapered_extrusion_with_unmatched_sections_says_so() {
    let body = "#6=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,2.,2.);\n\
        #7=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#905,1.,1.,0.25,$,$);\n\
        #5=IFCEXTRUDEDAREASOLIDTAPERED(#6,#903,#901,3.,#7);\n";
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{COMMON}{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(2).unwrap();
    close(element.meshes[0].mesh.volume(), 12.0, 1e-9);
    assert!(evaluator.diagnostics().iter().any(|item| item.code == "taper-ignored"));
}

#[test]
fn tapered_revolution_changes_section_along_the_turn() {
    // Sections centred 3 m from the Y axis, 0.8 wide at the start and 0.4 at the end.
    let body = "#6=IFCCARTESIANPOINT((3.,0.));\n#7=IFCAXIS2PLACEMENT2D(#6,$);\n\
        #8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,0.8,1.);\n\
        #9=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,0.4,1.);\n\
        #10=IFCDIRECTION((0.,1.,0.));\n#11=IFCAXIS1PLACEMENT(#900,#10);\n\
        #5=IFCREVOLVEDAREASOLIDTAPERED(#8,#903,#11,1.570796326794897,#9);\n";
    let mesh = evaluate(body);
    // Pappus: the centroid stays at 3 m and the mean area is 0.6.
    close(mesh.volume(), 3.0 * 0.6 * PI / 2.0, 0.02);
    assert_eq!(mesh.open_edges(), 0);
    // A positive turn about +Y carries +X to -Z, where the end section is the narrow one.
    let (min, _) = bounds(&mesh);
    close(min.z, -3.2, 1e-9);
    let (_, max) = bounds(&mesh);
    close(max.x, 3.4, 1e-9);
}

/// A closed shell of six quads around a box, wound outwards or inwards.
fn box_shell(first: u32, low: f64, high: f64, outwards: bool) -> String {
    let corner = |x: bool, y: bool, z: bool| {
        let value = |high_side: bool| if high_side { high } else { low };
        format!("({:?},{:?},{:?})", value(x), value(y), value(z))
    };
    let mut text = String::new();
    for (index, (x, y, z)) in (0..8).map(|bits| (bits & 1 != 0, bits & 2 != 0, bits & 4 != 0)).enumerate() {
        text += &format!("#{}=IFCCARTESIANPOINT({});\n", first + index as u32, corner(x, y, z));
    }
    let quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    let mut faces = Vec::new();
    for (index, quad) in quads.iter().enumerate() {
        let id = first + 10 + index as u32 * 3;
        let mut points: Vec<String> = quad.iter().map(|corner| format!("#{}", first + corner)).collect();
        if !outwards {
            points.reverse();
        }
        text += &format!("#{id}=IFCPOLYLOOP(({}));\n", points.join(","));
        text += &format!("#{}=IFCFACEOUTERBOUND(#{id},.T.);\n", id + 1);
        text += &format!("#{}=IFCFACE((#{}));\n", id + 2, id + 1);
        faces.push(format!("#{}", id + 2));
    }
    text + &format!("#{}=IFCCLOSEDSHELL(({}));\n", first + 40, faces.join(","))
}

#[test]
fn voids_are_taken_out_of_a_brep_however_their_shell_is_wound() {
    for inwards_as_specified in [true, false] {
        let body = format!(
            "{}{}#5=IFCFACETEDBREPWITHVOIDS(#1040,(#2040));\n",
            box_shell(1000, 0.0, 2.0, true),
            box_shell(2000, 0.5, 1.5, !inwards_as_specified),
        );
        let mesh = evaluate(&body);
        close(mesh.volume(), 7.0, 1e-9);
        assert_eq!(mesh.open_edges(), 0);
    }
}

#[test]
fn swept_disk_runs_between_its_parameters_on_a_polyline() {
    let body = "#6=IFCCARTESIANPOINT((10.,0.,0.));\n#7=IFCCARTESIANPOINT((10.,10.,0.));\n\
        #8=IFCPOLYLINE((#900,#6,#7));\n#5=IFCSWEPTDISKSOLID(#8,0.5,$,0.5,1.5);\n";
    let mesh = evaluate(body);
    let (min, max) = bounds(&mesh);
    close(min.x, 5.0, 1e-9);
    close(max.y, 5.0, 1e-9);
}

#[test]
fn swept_disk_keeps_the_whole_bar_when_its_parameters_are_ambiguous() {
    let body = "#6=IFCCARTESIANPOINT((10.,0.,0.));\n#7=IFCCARTESIANPOINT((10.,10.,0.));\n\
        #8=IFCPOLYLINE((#900,#6,#7));\n#5=IFCSWEPTDISKSOLID(#8,0.5,$,0.,1.);\n";
    let mesh = evaluate_with(body, true);
    close(bounds(&mesh).1.y, 10.0, 1e-9);
}

#[test]
fn swept_disk_on_a_curve_without_simple_parameters_says_it_ignored_them() {
    let body = "#6=IFCCIRCLE(#905,5.);\n#5=IFCSWEPTDISKSOLID(#6,0.5,$,0.,1.);\n";
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{COMMON}{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    evaluator.evaluate(2).unwrap();
    assert!(evaluator.diagnostics().iter().any(|item| item.code == "sweep-trim-ignored"));
}

#[test]
fn polygonal_swept_disk_rounds_its_corners() {
    let body = "#6=IFCCARTESIANPOINT((10.,0.,0.));\n#7=IFCCARTESIANPOINT((10.,10.,0.));\n\
        #8=IFCPOLYLINE((#900,#6,#7));\n#5=IFCSWEPTDISKSOLIDPOLYGONAL(#8,0.5,$,$,$,2.);\n";
    let mesh = evaluate(body);
    assert_eq!(mesh.open_edges(), 0);
    // A sharp mitre would reach this corner of the outside of the bend.
    let corner = DVec3::new(10.5, -0.5, 0.0);
    assert!(mesh.positions.iter().all(|point| point.distance(corner) > 0.5));
    // Two 8 m legs and a quarter circle of 2 m radius, around a twelve-sided disk.
    let dodecagon = 3.0 * 0.5 * 0.5;
    close(mesh.volume(), dodecagon * (16.0 + PI), 0.05);
}

/// Reports what each fixture still lacks, and pins the ones this work made complete.
#[test]
fn fixtures_that_use_these_solids_now_evaluate() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures");
    let mut names: Vec<_> = fs::read_dir(&folder).unwrap().map(|entry| entry.unwrap().path()).collect();
    names.retain(|path| path.extension().is_some_and(|extension| extension == "ifc"));
    names.sort();

    for path in names {
        let bytes = fs::read(&path).unwrap();
        let file = index(&bytes).unwrap();
        let mut evaluator = ModelEvaluator::new(&file).unwrap();
        let ids = evaluator.element_ids();
        let (mut solids, mut volume) = (0, 0.0);
        for id in &ids {
            if let Some(element) = evaluator.evaluate(*id) {
                solids += !element.meshes.is_empty() as usize;
                volume += element.meshes.iter().map(|item| item.mesh.volume()).sum::<f64>();
            }
        }
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let mut codes: Vec<String> =
            evaluator.diagnostics().iter().map(|item| format!("{}: {}", item.code, item.message)).collect();
        codes.sort();
        codes.dedup();
        println!("{name:<30} {solids:>3}/{:<3} {volume:>12.6}  {:?}", ids.len(), &codes[..codes.len().min(3)]);

        if name == "bspline-surface" {
            // A terrain and a flat plate, both 15 by 15 m. Backwards edges halve them.
            let area = |id: u32, evaluator: &mut ModelEvaluator<'_>| {
                surface_area(&evaluator.evaluate(id).unwrap().meshes[0].mesh)
            };
            assert!(area(101, &mut evaluator) > 225.0);
            close(area(96, &mut evaluator), 225.0, 1e-6);
            // The hole of the plate is 0.2658 of its parameter square.
            close(area(103, &mut evaluator), 225.0 * (1.0 - 0.2658), 0.05);
            // A box with windows in two sides, all on one surface wrapped around a seam.
            let box_sides = 2.0 * 15.0 * 7.5 + 2.0 * 7.5 * 7.5;
            assert!(area(102, &mut evaluator) < box_sides - 5.0);
            // Round shapes, against their areas integrated apart from the kernel: a cone and a
            // torus whose circles are three rational arcs each.
            assert!(area(99, &mut evaluator) > 200.529 * 0.995);
            assert!(area(21, &mut evaluator) > 1062.851 * 0.99);
        }
        if name == "alignment-sweeps" {
            // Every solid but the alignment, which has an axis and no body.
            assert_eq!(solids, ids.len() - 1);
            assert!(codes.is_empty(), "{name}: {codes:?}");
        }
        if ["bath-csg-solid", "beam-revolved-solid", "boolean-clipping-halfspace", "reinforcing-stirrup", "geographic-referencing", "basin-advanced-brep", "bspline-surface", "bspline-profile-csg"]
            .contains(&name.as_str())
        {
            assert_eq!(solids, ids.len(), "{name}");
            assert!(volume > 0.0, "{name}: {volume}");
            assert!(codes.is_empty(), "{name}: {codes:?}");
        }
    }
}
