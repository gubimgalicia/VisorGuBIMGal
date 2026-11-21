//! Faces on analytic surfaces, checked against closed-form areas.

use glam::DVec3;
use ifc_geometry::{Diagnostic, Mesh, ModelEvaluator};
use std::f64::consts::{FRAC_PI_2, PI, TAU};
use step_parser::index;

/// Writes the entities of a test file, handing out their ids.
struct Model {
    next: u32,
    text: String,
}

impl Model {
    fn new() -> Self {
        Self { next: 2000, text: String::new() }
    }

    fn add(&mut self, entity: String) -> u32 {
        let id = self.next;
        self.next += 1;
        self.text += &format!("#{id}={entity};\n");
        id
    }

    fn point(&mut self, at: DVec3) -> u32 {
        self.add(format!("IFCCARTESIANPOINT(({:?},{:?},{:?}))", at.x, at.y, at.z))
    }

    fn direction(&mut self, along: DVec3) -> u32 {
        self.add(format!("IFCDIRECTION(({:?},{:?},{:?}))", along.x, along.y, along.z))
    }

    fn frame(&mut self, origin: DVec3, axis: DVec3, x: DVec3) -> u32 {
        let (origin, axis, x) = (self.point(origin), self.direction(axis), self.direction(x));
        self.add(format!("IFCAXIS2PLACEMENT3D(#{origin},#{axis},#{x})"))
    }

    fn vertex(&mut self, at: DVec3) -> u32 {
        let point = self.point(at);
        self.add(format!("IFCVERTEXPOINT(#{point})"))
    }

    fn line(&mut self, from: u32, to: u32, start: DVec3, end: DVec3) -> u32 {
        let origin = self.point(start);
        let direction = self.direction((end - start).normalize());
        let vector = self.add(format!("IFCVECTOR(#{direction},1.)"));
        let line = self.add(format!("IFCLINE(#{origin},#{vector})"));
        self.add(format!("IFCEDGECURVE(#{from},#{to},#{line},.T.)"))
    }

    /// An arc from `from` to `to`, counter-clockwise about `axis`.
    fn arc(&mut self, from: u32, to: u32, center: DVec3, axis: DVec3, x: DVec3, radius: f64) -> u32 {
        let frame = self.frame(center, axis, x);
        let circle = self.add(format!("IFCCIRCLE(#{frame},{radius:?})"));
        self.add(format!("IFCEDGECURVE(#{from},#{to},#{circle},.T.)"))
    }

    fn edge_loop(&mut self, edges: &[(u32, bool)]) -> u32 {
        let oriented: Vec<String> = edges
            .iter()
            .map(|(edge, forward)| {
                let flag = if *forward { ".T." } else { ".F." };
                format!("#{}", self.add(format!("IFCORIENTEDEDGE(*,*,#{edge},{flag})")))
            })
            .collect();
        self.add(format!("IFCEDGELOOP(({}))", oriented.join(",")))
    }

    fn face(&mut self, surface: u32, outer: u32, holes: &[u32], same_sense: bool) -> u32 {
        let mut bounds = vec![format!("#{}", self.add(format!("IFCFACEOUTERBOUND(#{outer},.T.)")))];
        for hole in holes {
            bounds.push(format!("#{}", self.add(format!("IFCFACEBOUND(#{hole},.T.)"))));
        }
        let sense = if same_sense { ".T." } else { ".F." };
        self.add(format!("IFCADVANCEDFACE(({}),#{surface},{sense})", bounds.join(",")))
    }

    fn file(&self, face: u32) -> String {
        format!(
            "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
             #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
             #2=IFCWALL('w',$,$,$,$,$,#3,$);\n\
             #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
             #4=IFCSHAPEREPRESENTATION($,'Body','SurfaceModel',(#5));\n\
             #5=IFCSHELLBASEDSURFACEMODEL((#6));\n\
             #6=IFCOPENSHELL((#{face}));\n\
             {}ENDSEC;END-ISO-10303-21;",
            self.text
        )
    }

    fn evaluate(&self, face: u32) -> (Mesh, Vec<Diagnostic>) {
        let text = self.file(face);
        let file = index(text.as_bytes()).unwrap();
        let mut evaluator = ModelEvaluator::new(&file).unwrap();
        let element = evaluator.evaluate(2).expect("the element evaluates");
        let diagnostics = evaluator.diagnostics().to_vec();
        let mesh = element.meshes.into_iter().next().map(|item| item.mesh).unwrap_or_default();
        (mesh, diagnostics)
    }

    fn mesh(&self, face: u32) -> Mesh {
        let (mesh, diagnostics) = self.evaluate(face);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        mesh
    }

    /// A loop on a cylinder of `radius` about Z through `center`, between two angles and
    /// heights, wound counter-clockwise seen from outside.
    fn cylinder_patch(&mut self, center: DVec3, radius: f64, angles: (f64, f64), heights: (f64, f64)) -> u32 {
        let at = |angle: f64, z: f64| center + DVec3::new(angle.cos() * radius, angle.sin() * radius, z);
        let (a0, a1) = angles;
        let (z0, z1) = heights;
        let corners = [at(a0, z0), at(a1, z0), at(a1, z1), at(a0, z1)];
        let [p, q, r, s] = corners.map(|corner| self.vertex(corner));
        let bottom = self.arc(p, q, center + DVec3::Z * z0, DVec3::Z, DVec3::X, radius);
        let side = self.line(q, r, corners[1], corners[2]);
        let top = self.arc(s, r, center + DVec3::Z * z1, DVec3::Z, DVec3::X, radius);
        let back = self.line(s, p, corners[3], corners[0]);
        self.edge_loop(&[(bottom, true), (side, true), (top, false), (back, true)])
    }
}

fn area(mesh: &Mesh) -> f64 {
    let corner = |id: u32| mesh.positions[id as usize];
    mesh.triangles
        .iter()
        .map(|[a, b, c]| (corner(*b) - corner(*a)).cross(corner(*c) - corner(*a)).length() / 2.0)
        .sum()
}

fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!((actual - expected).abs() <= tolerance, "{actual} against {expected}");
}

/// Every vertex of `mesh` at `distance` from the line through `center` along Z.
fn on_cylinder(mesh: &Mesh, center: DVec3, distance: f64) {
    assert!(!mesh.positions.is_empty());
    for point in &mesh.positions {
        close((*point - center).truncate().length(), distance, 1e-6);
    }
}

#[test]
fn half_cylinder_stays_a_half_wherever_the_seam_of_its_surface_falls() {
    // The surface's zero angle at each of these sits outside, inside and on the edge of the face.
    for x in [DVec3::X, DVec3::Y, DVec3::NEG_Y, DVec3::NEG_X, DVec3::new(0.6, 0.8, 0.0)] {
        let mut model = Model::new();
        let frame = model.frame(DVec3::ZERO, DVec3::Z, x);
        let surface = model.add(format!("IFCCYLINDRICALSURFACE(#{frame},2.)"));
        let boundary = model.cylinder_patch(DVec3::ZERO, 2.0, (0.0, PI), (0.0, 3.0));
        let face = model.face(surface, boundary, &[], true);
        let mesh = model.mesh(face);
        on_cylinder(&mesh, DVec3::ZERO, 2.0);
        close(area(&mesh), PI * 2.0 * 3.0, 0.05);
        assert!(mesh.positions.iter().all(|point| point.y >= -1e-6), "{x}");
    }
}

#[test]
fn cylinder_faces_outwards_along_the_surface_normal() {
    let mesh_for = |same_sense: bool| {
        let mut model = Model::new();
        let frame = model.frame(DVec3::ZERO, DVec3::Z, DVec3::X);
        let surface = model.add(format!("IFCCYLINDRICALSURFACE(#{frame},2.)"));
        let boundary = model.cylinder_patch(DVec3::ZERO, 2.0, (0.0, PI), (0.0, 3.0));
        let face = model.face(surface, boundary, &[], same_sense);
        model.mesh(face)
    };
    let outwards = |mesh: &Mesh| {
        let corner = |id: u32| mesh.positions[id as usize];
        let [a, b, c] = mesh.triangles[mesh.triangles.len() / 2];
        let normal = (corner(b) - corner(a)).cross(corner(c) - corner(a));
        let middle = (corner(a) + corner(b) + corner(c)) / 3.0;
        normal.dot(DVec3::new(middle.x, middle.y, 0.0)) > 0.0
    };
    assert!(outwards(&mesh_for(true)));
    assert!(!outwards(&mesh_for(false)));
}

#[test]
fn cylinder_off_the_origin_and_tilted_meshes_where_its_position_says() {
    let center = DVec3::new(10.0, -4.0, 2.0);
    let mut model = Model::new();
    let frame = model.frame(center, DVec3::Z, DVec3::X);
    let surface = model.add(format!("IFCCYLINDRICALSURFACE(#{frame},1.5)"));
    let boundary = model.cylinder_patch(center, 1.5, (FRAC_PI_2, PI), (1.0, 4.0));
    let face = model.face(surface, boundary, &[], true);
    let mesh = model.mesh(face);
    on_cylinder(&mesh, center, 1.5);
    close(area(&mesh), FRAC_PI_2 * 1.5 * 3.0, 0.02);
}

#[test]
fn whole_cylinder_between_two_circles() {
    let mut model = Model::new();
    let frame = model.frame(DVec3::ZERO, DVec3::Z, DVec3::X);
    let surface = model.add(format!("IFCCYLINDRICALSURFACE(#{frame},2.)"));
    let (low, high) = (DVec3::new(2.0, 0.0, 0.0), DVec3::new(2.0, 0.0, 3.0));
    let (bottom, top) = (model.vertex(low), model.vertex(high));
    let low_circle = model.arc(bottom, bottom, DVec3::ZERO, DVec3::Z, DVec3::X, 2.0);
    let high_circle = model.arc(top, top, DVec3::Z * 3.0, DVec3::Z, DVec3::X, 2.0);
    let outer = model.edge_loop(&[(low_circle, true)]);
    let inner = model.edge_loop(&[(high_circle, false)]);
    let face = model.face(surface, outer, &[inner], true);
    let mesh = model.mesh(face);
    on_cylinder(&mesh, DVec3::ZERO, 2.0);
    close(area(&mesh), TAU * 2.0 * 3.0, 0.1);
    close(mesh.positions.iter().map(|point| point.z).fold(0.0, f64::max), 3.0, 1e-6);
}

#[test]
fn window_in_a_curved_wall_is_cut_out() {
    let mut model = Model::new();
    let frame = model.frame(DVec3::ZERO, DVec3::Z, DVec3::X);
    let surface = model.add(format!("IFCCYLINDRICALSURFACE(#{frame},5.)"));
    let boundary = model.cylinder_patch(DVec3::ZERO, 5.0, (0.0, FRAC_PI_2), (0.0, 3.0));
    let window = model.cylinder_patch(DVec3::ZERO, 5.0, (0.5, 1.0), (1.0, 2.0));
    let face = model.face(surface, boundary, &[window], true);
    let mesh = model.mesh(face);
    close(area(&mesh), 5.0 * FRAC_PI_2 * 3.0 - 5.0 * 0.5 * 1.0, 0.05);
}

/// A sphere of radius 2 about the origin, bounded by the equator running as asked.
fn dome(eastwards: bool, same_sense: bool) -> Mesh {
    let mut model = Model::new();
    let frame = model.frame(DVec3::ZERO, DVec3::Z, DVec3::X);
    let surface = model.add(format!("IFCSPHERICALSURFACE(#{frame},2.)"));
    let start = model.vertex(DVec3::new(2.0, 0.0, 0.0));
    let equator = model.arc(start, start, DVec3::ZERO, DVec3::Z, DVec3::X, 2.0);
    let boundary = model.edge_loop(&[(equator, eastwards)]);
    let face = model.face(surface, boundary, &[], same_sense);
    model.mesh(face)
}

#[test]
fn dome_runs_from_its_one_loop_to_the_pole_on_the_loops_left() {
    let z = |mesh: &Mesh| {
        mesh.positions.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), point| {
            (low.min(point.z), high.max(point.z))
        })
    };
    let north = dome(true, true);
    close(area(&north), TAU * 4.0, 0.25);
    close(z(&north).0, 0.0, 1e-6);
    close(z(&north).1, 2.0, 1e-6);

    let south = dome(false, true);
    close(area(&south), TAU * 4.0, 0.25);
    close(z(&south).1, 0.0, 1e-6);
    close(z(&south).0, -2.0, 1e-6);

    // A face against its surface has its left the other way round.
    close(z(&dome(true, false)).0, -2.0, 1e-6);
}

#[test]
fn sphere_octant_touches_a_pole() {
    let radius = 2.0;
    let mut model = Model::new();
    let frame = model.frame(DVec3::ZERO, DVec3::Z, DVec3::X);
    let surface = model.add(format!("IFCSPHERICALSURFACE(#{frame},{radius:?})"));
    let a = model.vertex(DVec3::X * radius);
    let b = model.vertex(DVec3::Y * radius);
    let c = model.vertex(DVec3::Z * radius);
    let east = model.arc(a, b, DVec3::ZERO, DVec3::Z, DVec3::X, radius);
    let up = model.arc(b, c, DVec3::ZERO, DVec3::X, DVec3::Y, radius);
    let down = model.arc(c, a, DVec3::ZERO, DVec3::Y, DVec3::Z, radius);
    let boundary = model.edge_loop(&[(east, true), (up, true), (down, true)]);
    let face = model.face(surface, boundary, &[], true);
    let mesh = model.mesh(face);
    // An eighth of a sphere's 4 pi r^2.
    close(area(&mesh), PI * radius * radius / 2.0, 0.1);
    for point in &mesh.positions {
        close(point.length(), radius, 1e-6);
        assert!(point.min_element() >= -1e-6, "{point}");
    }
}

#[test]
fn torus_patch_has_the_area_of_its_outer_half_quarter() {
    let (major, minor) = (5.0, 1.0);
    let mut model = Model::new();
    let frame = model.frame(DVec3::ZERO, DVec3::Z, DVec3::X);
    let surface = model.add(format!("IFCTOROIDALSURFACE(#{frame},{major:?},{minor:?})"));
    let [a, b, c, d] = [
        DVec3::new(major, 0.0, -minor),
        DVec3::new(0.0, major, -minor),
        DVec3::new(0.0, major, minor),
        DVec3::new(major, 0.0, minor),
    ]
    .map(|corner| model.vertex(corner));
    let low = model.arc(a, b, DVec3::Z * -minor, DVec3::Z, DVec3::X, major);
    let far = model.arc(b, c, DVec3::Y * major, DVec3::X, DVec3::NEG_Z, minor);
    let high = model.arc(d, c, DVec3::Z * minor, DVec3::Z, DVec3::X, major);
    let near = model.arc(a, d, DVec3::X * major, DVec3::NEG_Y, DVec3::NEG_Z, minor);
    let boundary = model.edge_loop(&[(low, true), (far, true), (high, false), (near, false)]);
    let face = model.face(surface, boundary, &[], true);
    let mesh = model.mesh(face);
    // The integral of (R + r cos v) r over a quarter turn and -90 to 90 degrees of the tube.
    close(area(&mesh), FRAC_PI_2 * minor * (major * PI + 2.0 * minor), 0.2);
    for point in &mesh.positions {
        let from_ring = DVec3::new(point.truncate().length() - major, 0.0, point.z).length();
        close(from_ring, minor, 1e-6);
        assert!(point.truncate().length() >= major - 1e-6, "{point}");
    }
}

#[test]
fn surface_of_revolution_turns_its_profile_about_its_axis() {
    // A cone: from (3,0) on the X axis to the apex (0,4) on the Y axis, about Y.
    let mut model = Model::new();
    let base = model.point(DVec3::new(3.0, 0.0, 0.0));
    let apex = model.point(DVec3::new(0.0, 4.0, 0.0));
    let line = model.add(format!("IFCPOLYLINE((#{base},#{apex}))"));
    let profile = model.add(format!("IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#{line})"));
    let origin = model.point(DVec3::ZERO);
    let axis = model.direction(DVec3::Y);
    let axis = model.add(format!("IFCAXIS1PLACEMENT(#{origin},#{axis})"));
    let surface = model.add(format!("IFCSURFACEOFREVOLUTION(#{profile},$,#{axis})"));
    let start = model.vertex(DVec3::new(3.0, 0.0, 0.0));
    let circle = model.arc(start, start, DVec3::ZERO, DVec3::Y, DVec3::X, 3.0);
    let boundary = model.edge_loop(&[(circle, true)]);
    let face = model.face(surface, boundary, &[], true);
    let mesh = model.mesh(face);
    // The lateral area of a cone: pi r l, with l = 5.
    close(area(&mesh), PI * 3.0 * 5.0, 0.3);
    for point in &mesh.positions {
        close(point.x.hypot(point.z), 3.0 - point.y * 0.75, 1e-6);
    }
    close(mesh.positions.iter().map(|point| point.y).fold(0.0, f64::max), 4.0, 1e-6);
}

#[test]
fn surface_of_linear_extrusion_sweeps_its_profile() {
    // An angled strip: (0,0) to (4,0) to (4,3), raised 2 m.
    let corners = [DVec3::ZERO, DVec3::new(4.0, 0.0, 0.0), DVec3::new(4.0, 3.0, 0.0)];
    let mut model = Model::new();
    let points: Vec<String> = corners.iter().map(|at| format!("#{}", model.point(*at))).collect();
    let line = model.add(format!("IFCPOLYLINE(({}))", points.join(",")));
    let profile = model.add(format!("IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#{line})"));
    let up = model.direction(DVec3::Z);
    let surface = model.add(format!("IFCSURFACEOFLINEAREXTRUSION(#{profile},$,#{up},2.)"));

    let lifted = corners.map(|corner| corner + DVec3::Z * 2.0);
    let low = corners.map(|corner| model.vertex(corner));
    let high = lifted.map(|corner| model.vertex(corner));
    let edges = [
        (model.line(low[0], low[1], corners[0], corners[1]), true),
        (model.line(low[1], low[2], corners[1], corners[2]), true),
        (model.line(low[2], high[2], corners[2], lifted[2]), true),
        (model.line(high[1], high[2], lifted[1], lifted[2]), false),
        (model.line(high[0], high[1], lifted[0], lifted[1]), false),
        (model.line(high[0], low[0], lifted[0], corners[0]), true),
    ];
    let boundary = model.edge_loop(&edges);
    let face = model.face(surface, boundary, &[], true);
    let mesh = model.mesh(face);
    close(area(&mesh), 7.0 * 2.0, 1e-6);
    let bend = DVec3::new(4.0, 0.0, 1.0);
    let beyond = mesh.positions.iter().any(|point| point.x > 4.0 + 1e-6 || point.y < -1e-6);
    assert!(!beyond, "the strip follows the bend at {bend}");
}

#[test]
fn surface_with_no_usable_radius_falls_back_and_says_so() {
    let mut model = Model::new();
    let frame = model.frame(DVec3::ZERO, DVec3::Z, DVec3::X);
    let surface = model.add(format!("IFCCYLINDRICALSURFACE(#{frame},0.)"));
    let boundary = model.cylinder_patch(DVec3::ZERO, 2.0, (0.0, PI), (0.0, 3.0));
    let face = model.face(surface, boundary, &[], true);
    let (_, diagnostics) = model.evaluate(face);
    assert!(diagnostics.iter().any(|item| item.code == "bad-surface"), "{diagnostics:?}");
}
