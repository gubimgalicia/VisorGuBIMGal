//! Areas swept along directrices, checked against closed-form volumes and positions.

use glam::DVec3;
use ifc_geometry::{Diagnostic, Mesh, ModelEvaluator};
use std::f64::consts::{FRAC_PI_2, PI, TAU};
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
    #905=IFCAXIS2PLACEMENT2D(#904,$);\n\
    #906=IFCRECTANGLEPROFILEDEF(.AREA.,$,#905,2.,1.);\n\
    #907=IFCCARTESIANPOINT((10.,0.,0.));\n\
    #908=IFCCARTESIANPOINT((10.,10.,0.));\n\
    #909=IFCPOLYLINE((#900,#907));\n\
    #910=IFCPOLYLINE((#900,#907,#908));\n";

fn evaluated(schema: &str, body: &str) -> (Mesh, Vec<Diagnostic>) {
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{COMMON}{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(2).expect("the element evaluates");
    let diagnostics = evaluator.diagnostics().to_vec();
    (element.meshes.into_iter().next().map(|item| item.mesh).unwrap_or_default(), diagnostics)
}

fn evaluate(body: &str) -> Mesh {
    let (mesh, diagnostics) = evaluated("IFC4", body);
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

fn vector(actual: DVec3, expected: DVec3, tolerance: f64) {
    assert!(actual.distance(expected) <= tolerance, "{actual} against {expected}");
}

#[test]
fn fixed_reference_sets_the_x_axis_of_the_profile() {
    let mesh = evaluate("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#906,#903,#909,$,$,#901);\n");
    close(mesh.volume(), 2.0 * 1.0 * 10.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
    // The profile's 2 m X dimension stands along the reference, up the Z axis.
    let (min, max) = bounds(&mesh);
    vector(min, DVec3::new(0.0, -0.5, -1.0), 1e-9);
    vector(max, DVec3::new(10.0, 0.5, 1.0), 1e-9);
}

#[test]
fn profile_y_axis_completes_a_right_handed_frame_with_the_tangent() {
    // An off-centre profile. Along +X with X up, Y is the tangent cross Z: towards -Y.
    let body = "#6=IFCCARTESIANPOINT((0.5,0.25));\n#7=IFCAXIS2PLACEMENT2D(#6,$);\n\
        #8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,0.2,0.1);\n\
        #5=IFCFIXEDREFERENCESWEPTAREASOLID(#8,#903,#909,$,$,#901);\n";
    let mesh = evaluate(body);
    let (min, max) = bounds(&mesh);
    let middle = (min + max) / 2.0;
    close(middle.z, 0.5, 1e-9);
    close(middle.y, -0.25, 1e-9);
}

#[test]
fn mitred_bend_keeps_the_volume_of_a_centred_profile() {
    let mesh = evaluate("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#906,#903,#910,$,$,#901);\n");
    close(mesh.volume(), 2.0 * 20.0, 1e-9);
    assert_eq!(mesh.open_edges(), 0);
    let (_, max) = bounds(&mesh);
    close(max.x, 10.5, 1e-9);
    close(max.y, 10.0, 1e-9);
}

#[test]
fn legs_that_climb_keep_their_own_frame_up_to_the_mitre() {
    // The reference is upright, so the frame tilts where the path starts to climb.
    let body = "#6=IFCCARTESIANPOINT((10.,8.,3.));\n#7=IFCPOLYLINE((#900,#907,#6));\n\
        #5=IFCFIXEDREFERENCESWEPTAREASOLID(#906,#903,#7,$,$,#901);\n";
    let mesh = evaluate(body);
    assert_eq!(mesh.open_edges(), 0);
    // Each leg is a prism cut through its axis, so it keeps the volume of its length. A leg
    // that twists from one frame into the other does not.
    let climbing = (64.0_f64 + 9.0).sqrt();
    close(mesh.volume(), 2.0 * (10.0 + climbing), 1e-6);
}

#[test]
fn sweep_follows_an_arc() {
    let body = "#6=IFCCIRCLE(#905,10.);\n\
        #7=IFCTRIMMEDCURVE(#6,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.570796326794897)),.T.,.PARAMETER.);\n\
        #5=IFCFIXEDREFERENCESWEPTAREASOLID(#906,#903,#7,$,$,#901);\n";
    let mesh = evaluate(body);
    assert_eq!(mesh.open_edges(), 0);
    // Pappus, along eight chords of the quarter circle.
    let chords = 8.0 * 2.0 * 10.0 * (FRAC_PI_2 / 16.0).sin();
    close(mesh.volume(), 2.0 * chords, 0.05);
    for point in &mesh.positions {
        assert!(point.truncate().length() >= 9.4 && point.truncate().length() <= 10.6, "{point}");
    }
}

#[test]
fn sweep_stops_between_its_parameters() {
    let mesh = evaluate("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#906,#903,#910,0.5,1.5,#901);\n");
    let (min, max) = bounds(&mesh);
    close(min.x, 5.0, 1e-9);
    close(max.y, 5.0, 1e-9);
    close(mesh.volume(), 2.0 * 10.0, 1e-9);
}

#[test]
fn sweep_on_a_circle_takes_its_parameters_as_angles() {
    let body = "#6=IFCCIRCLE(#905,10.);\n\
        #5=IFCFIXEDREFERENCESWEPTAREASOLID(#906,#903,#6,0.,1.570796326794897,#901);\n";
    let mesh = evaluate(body);
    // A quarter of the circle, not all of it. End sections stand square to the last chord,
    // so they lean by half a facet.
    let (min, max) = bounds(&mesh);
    assert!(min.x > -0.1 && min.y > -0.1, "{min}");
    close(max.x, 10.5, 0.05);
    close(max.y, 10.5, 0.05);
}

#[test]
fn sweep_may_be_bounded_by_length() {
    let body = "#5=IFCFIXEDREFERENCESWEPTAREASOLID(#906,#903,#910,\
        IFCNONNEGATIVELENGTHMEASURE(4.),IFCNONNEGATIVELENGTHMEASURE(13.),#901);\n";
    let (mesh, diagnostics) = evaluated("IFC4X3", body);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (min, max) = bounds(&mesh);
    close(min.x, 4.0, 1e-9);
    close(max.y, 3.0, 1e-9);
    close(mesh.volume(), 2.0 * 9.0, 1e-9);
}

#[test]
fn position_places_the_swept_solid() {
    let body = "#6=IFCCARTESIANPOINT((1.,2.,3.));\n#7=IFCAXIS2PLACEMENT3D(#6,$,$);\n\
        #5=IFCFIXEDREFERENCESWEPTAREASOLID(#906,#7,#909,$,$,#901);\n";
    let mesh = evaluate(body);
    let (min, max) = bounds(&mesh);
    vector(min, DVec3::new(1.0, 1.5, 2.0), 1e-9);
    vector(max, DVec3::new(11.0, 2.5, 4.0), 1e-9);
}

#[test]
fn directrix_derived_reference_behaves_as_the_fixed_one_off_cant() {
    let body = "#5=IFCDIRECTRIXDERIVEDREFERENCESWEPTAREASOLID(#906,#903,#909,$,$,#901);\n";
    let (mesh, diagnostics) = evaluated("IFC4X3", body);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    close(mesh.volume(), 20.0, 1e-9);
}

#[test]
fn surface_curve_sweep_on_a_plane_uses_its_normal() {
    let body = "#6=IFCPLANE(#903);\n#5=IFCSURFACECURVESWEPTAREASOLID(#906,#903,#909,$,$,#6);\n";
    let mesh = evaluate(body);
    let (min, max) = bounds(&mesh);
    vector(min, DVec3::new(0.0, -0.5, -1.0), 1e-9);
    vector(max, DVec3::new(10.0, 0.5, 1.0), 1e-9);
}

#[test]
fn surface_curve_sweep_keeps_the_profile_on_the_surface_normal() {
    // A ring around a vertical cylinder. The 2 m X dimension lies along the radius.
    let body = "#6=IFCCYLINDRICALSURFACE(#903,5.);\n#7=IFCCIRCLE(#905,5.);\n\
        #5=IFCSURFACECURVESWEPTAREASOLID(#906,#903,#7,$,$,#6);\n";
    let mesh = evaluate(body);
    let (min, max) = bounds(&mesh);
    close(min.z, -0.5, 1e-6);
    close(max.z, 0.5, 1e-6);
    close(max.x, 6.0, 0.05);
    // Pappus, with a centroid 5 m from the axis, on a 32-sided ring.
    let perimeter = 32.0 * 2.0 * 5.0 * (TAU / 64.0).sin();
    close(mesh.volume(), 2.0 * perimeter, 0.2);
    assert_eq!(mesh.open_edges(), 0);
    let _ = PI;
}

#[test]
fn surface_curve_sweep_off_its_surface_says_so() {
    let body = "#6=IFCTOROIDALSURFACE(#903,0.,1.);\n\
        #5=IFCSURFACECURVESWEPTAREASOLID(#906,#903,#909,$,$,#6);\n";
    let (_, diagnostics) = evaluated("IFC4", body);
    assert!(diagnostics.iter().any(|item| item.code == "bad-surface"), "{diagnostics:?}");
}


/// A wall along an arc: the two faces, in one composite curve, and the two ends.
fn curved_wall(outer: f64, inner: f64, turn: f64) -> String {
    let point = |id: u32, radius: f64, angle: f64| {
        format!("#{id}=IFCCARTESIANPOINT(({},{}));\n", radius * angle.cos(), radius * angle.sin())
    };
    format!(
        "#5=IFCEXTRUDEDAREASOLID(#20,#903,#901,6.75);\n\
         #20=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#21);\n\
         #21=IFCCOMPOSITECURVE((#22,#23,#24,#25),.F.);\n\
         #22=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#30);\n\
         #23=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#32);\n\
         #24=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#31);\n\
         #25=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#33);\n\
         #30=IFCTRIMMEDCURVE(#40,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE({turn})),.T.,.PARAMETER.);\n\
         #31=IFCTRIMMEDCURVE(#41,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE({turn})),.T.,.PARAMETER.);\n\
         #32=IFCPOLYLINE((#50,#51));\n\
         #33=IFCPOLYLINE((#52,#53));\n\
         #40=IFCCIRCLE(#905,{outer});\n\
         #41=IFCCIRCLE(#905,{inner});\n\
         {}{}{}{}",
        point(50, outer, turn),
        point(51, inner, turn),
        point(52, inner, 0.0),
        point(53, outer, 0.0),
    )
}

#[test]
fn a_thin_wall_on_a_wide_curve_keeps_its_thickness() {
    // Chords laid at 32 per turn would cut 370 mm into a 250 mm wall, and the wall would cross
    // itself.
    let (outer, inner, turn) = (43.3, 43.05, 32.0_f64.to_radians());
    let mesh = evaluate(&curved_wall(outer, inner, turn));
    let exact = turn * (outer * outer - inner * inner) / 2.0 * 6.75;
    close(mesh.volume(), exact, exact * 1e-3);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn chords_stay_close_on_a_very_wide_curve() {
    let (outer, inner, turn) = (500.0, 499.8, 0.05);
    let mesh = evaluate(&curved_wall(outer, inner, turn));
    let exact = turn * (outer * outer - inner * inner) / 2.0 * 6.75;
    close(mesh.volume(), exact, exact * 1e-3);
    for point in &mesh.positions {
        let radius = point.truncate().length();
        assert!(radius > inner - 0.006 && radius < outer + 0.006, "{point}");
    }
}

#[test]
fn a_small_curve_keeps_its_facet_count() {
    // 200 mm is well inside the tolerance, so the count per turn still decides.
    let mesh = evaluate(&curved_wall(0.2, 0.1, FRAC_PI_2));
    assert_eq!(mesh.positions.len(), 2 * (2 * 9));
}

/// A box 2 by 1 by 3 at the origin, cut by a half space through x = 0.5 that keeps +X.
fn boxed(enclosure: &str) -> Mesh {
    evaluate(&format!(
        "#5=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#20,#21);\n\
         #20=IFCEXTRUDEDAREASOLID(#906,#903,#901,3.);\n\
         #21=IFCBOXEDHALFSPACE(#22,.F.,#26);\n\
         #22=IFCPLANE(#23);\n\
         #23=IFCAXIS2PLACEMENT3D(#24,#25,#901);\n\
         #24=IFCCARTESIANPOINT((0.5,0.,1.5));\n\
         #25=IFCDIRECTION((-1.,0.,0.));\n\
         {enclosure}"
    ))
}

#[test]
fn a_box_centred_on_the_plane_limits_the_cut_as_revit_means_it() {
    // Revit writes the corner as half the box, in either sign. The notch is 0.2 deep.
    for corner in ["1.5,0.5,0.", "-1.5,-0.5,0.", "1.5,-0.5,0."] {
        let mesh = boxed(&format!(
            "#26=IFCBOUNDINGBOX(#27,3.,1.,0.2);\n#27=IFCCARTESIANPOINT(({corner}));\n"
        ));
        close(mesh.volume(), 6.0 - 0.2 * 1.0 * 3.0, 1e-9);
        assert_eq!(mesh.open_edges(), 0);
    }
}

#[test]
fn any_other_box_only_helps_searching_as_the_schema_says() {
    // Each of these misses the shape in one way only, and all are the size of the notch above.
    for corner in ["-1.5,-0.5,-0.1", "0.,-0.5,0.", "1.5,0.,0.", "0.,0.,0."] {
        let mesh = boxed(&format!(
            "#26=IFCBOUNDINGBOX(#27,3.,1.,0.2);\n#27=IFCCARTESIANPOINT(({corner}));\n"
        ));
        close(mesh.volume(), 0.5 * 1.0 * 3.0, 1e-9);
    }
}

#[test]
fn an_arc_given_by_three_points_holds_the_tolerance_at_its_real_size() {
    // A quarter of a 100 m circle through three indexed points: the bar has to stay on the
    // circle between them.
    let mesh = evaluate(
        "#5=IFCSWEPTDISKSOLID(#20,0.1,$,$,$);\n\
         #20=IFCINDEXEDPOLYCURVE(#21,(IFCARCINDEX((1,2,3))),$);\n\
         #21=IFCCARTESIANPOINTLIST3D(((100.,0.,0.),(70.71067811865476,70.71067811865476,0.),(0.,100.,0.)));\n",
    );
    for [a, b, c] in mesh.triangle_corners() {
        for middle in [(a + b) / 2.0, (b + c) / 2.0, (c + a) / 2.0] {
            let off = (middle.truncate().length() - 100.0).abs();
            assert!(off <= 0.1 + 0.006, "{middle} is {off} from the circle");
        }
    }
}

#[test]
fn ends_that_miss_an_arc_by_a_hair_still_close_the_wall() {
    // Exporters round arc ends and line ends apart: here by 2 microns, on a 160 m wall.
    let (outer, inner, turn) = (160.979, 160.629, 15.0_f64.to_radians());
    let hair = 2e-6;
    let body = curved_wall(outer, inner, turn).replace(
        &format!("#53=IFCCARTESIANPOINT(({},{}));", outer, 0.0),
        &format!("#53=IFCCARTESIANPOINT(({},{}));", outer, hair),
    );
    assert!(body.contains(&format!("{hair}")), "the end moved");
    let mesh = evaluate(&body);
    assert_eq!(mesh.open_edges(), 0);
    let exact = turn * (outer * outer - inner * inner) / 2.0 * 6.75;
    close(mesh.volume(), exact, exact * 1e-3);
}

#[test]
fn a_hole_too_small_to_keep_is_reported_not_quietly_filled() {
    // Three points within 10 microns of each other merge into one, and the hole is gone.
    let (mesh, diagnostics) = evaluated(
        "IFC4",
        "#5=IFCEXTRUDEDAREASOLID(#20,#903,#901,1.);\n\
         #20=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#21,(#22));\n\
         #21=IFCPOLYLINE((#30,#31,#32,#33,#30));\n\
         #22=IFCPOLYLINE((#34,#35,#36,#34));\n\
         #30=IFCCARTESIANPOINT((0.,0.));\n#31=IFCCARTESIANPOINT((10.,0.));\n\
         #32=IFCCARTESIANPOINT((10.,10.));\n#33=IFCCARTESIANPOINT((0.,10.));\n\
         #34=IFCCARTESIANPOINT((1.,1.));\n#35=IFCCARTESIANPOINT((1.000005,1.));\n\
         #36=IFCCARTESIANPOINT((1.,1.000005));\n",
    );
    close(mesh.volume(), 100.0, 1e-6);
    assert!(diagnostics.iter().any(|item| item.code == "bad-profile-hole"), "{diagnostics:?}");
}