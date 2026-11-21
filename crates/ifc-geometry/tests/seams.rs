//! Closed shells whose faces do not quite meet, as real exporters write them: a corner on the
//! middle of a neighbour's edge, or one corner written twice a rounding apart. Voids and booleans
//! need a closed mesh, so these used to be left uncut.

use glam::DVec3;
use ifc_geometry::{Mesh, ModelEvaluator, seal};
use step_parser::index;

fn v(x: f64, y: f64, z: f64) -> DVec3 {
    DVec3::new(x, y, z)
}

#[track_caller]
fn assert_solid(mesh: &Mesh, volume: f64) {
    assert_eq!(mesh.open_edges(), 0, "not watertight");
    assert!((mesh.volume() - volume).abs() < 1e-9, "volume {} != {volume}", mesh.volume());
}

/// A 1 by 2 by 3 box whose front face has a corner on the middle of the top face's edge.
fn box_with_t_junction() -> Mesh {
    let mut mesh = Mesh::cuboid(v(0.0, 0.0, 0.0), v(1.0, 2.0, 3.0));
    mesh.positions.push(v(0.5, 0.0, 3.0));
    // The front face was [0, 1, 5] and [0, 5, 4]; now 0, 1, 5, 8, 4 around.
    mesh.triangles.retain(|triangle| *triangle != [0, 5, 4]);
    mesh.triangles.extend([[0, 5, 8], [0, 8, 4]]);
    mesh
}

#[test]
fn a_corner_on_a_neighbours_edge_is_sealed() {
    let mesh = box_with_t_junction();
    assert!(mesh.open_edges() > 0);
    assert_solid(&seal(&mesh), 6.0);
}

#[test]
fn a_corner_written_twice_a_rounding_apart_is_sealed() {
    let mut mesh = Mesh::cuboid(v(0.0, 0.0, 0.0), v(1.0, 2.0, 3.0));
    mesh.positions.push(v(1.0, 2.0, 3.0 + 5e-7));
    // The right face, [1, 2, 6] and [1, 6, 5], takes the copy of corner 6.
    for triangle in &mut mesh.triangles[6..8] {
        for corner in triangle.iter_mut().filter(|corner| **corner == 6) {
            *corner = 8;
        }
    }
    assert!(mesh.open_edges() > 0);
    assert_solid(&seal(&mesh), 6.0);
}

#[test]
fn corners_further_apart_than_a_micrometre_stay_apart() {
    let mut mesh = Mesh::cuboid(v(0.0, 0.0, 0.0), v(1.0, 2.0, 3.0));
    mesh.positions.push(v(1.0, 2.0, 3.0 + 1e-5));
    for triangle in &mut mesh.triangles[6..8] {
        for corner in triangle.iter_mut().filter(|corner| **corner == 6) {
            *corner = 8;
        }
    }
    assert!(seal(&mesh).open_edges() > 0);
}

#[test]
fn a_missing_face_stays_missing() {
    let mut mesh = Mesh::cuboid(v(0.0, 0.0, 0.0), v(1.0, 2.0, 3.0));
    mesh.triangles.truncate(10);
    assert!(seal(&mesh).open_edges() > 0);
}

#[test]
fn a_closed_mesh_keeps_its_volume() {
    let mesh = Mesh::cuboid(v(0.0, 0.0, 0.0), v(1.0, 2.0, 3.0));
    assert_solid(&seal(&mesh), 6.0);
}

/// The same box as a faceted BRep, `#41`. `front` is the front face's loop: `#10,#11,#15,#14`
/// is clean, `#10,#11,#15,#18,#14` has a corner on the top face's edge, and `#10,#11,#19,#14`
/// has a copy of `#15` half a micrometre up.
fn brep(front: &str, body: &str) -> String {
    let loops = [
        "#10,#13,#12,#11",
        "#14,#15,#16,#17",
        front,
        "#11,#12,#16,#15",
        "#12,#13,#17,#16",
        "#13,#10,#14,#17",
    ];
    let mut text = String::from(
        "#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         #2=IFCWALL('w',$,$,$,$,$,#3,$);\n\
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
         #4=IFCSHAPEREPRESENTATION($,'Body','Brep',(#5));\n\
         #10=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #11=IFCCARTESIANPOINT((1.,0.,0.));\n\
         #12=IFCCARTESIANPOINT((1.,2.,0.));\n\
         #13=IFCCARTESIANPOINT((0.,2.,0.));\n\
         #14=IFCCARTESIANPOINT((0.,0.,3.));\n\
         #15=IFCCARTESIANPOINT((1.,0.,3.));\n\
         #16=IFCCARTESIANPOINT((1.,2.,3.));\n\
         #17=IFCCARTESIANPOINT((0.,2.,3.));\n\
         #18=IFCCARTESIANPOINT((0.5,0.,3.));\n\
         #19=IFCCARTESIANPOINT((1.,0.,3.0000005));\n",
    );
    let mut faces = Vec::new();
    for (index, points) in loops.iter().filter(|points| !points.is_empty()).enumerate() {
        let at = 20 + index * 3;
        text += &format!(
            "#{at}=IFCPOLYLOOP(({points}));\n#{}=IFCFACEOUTERBOUND(#{at},.T.);\n#{}=IFCFACE((#{}));\n",
            at + 1,
            at + 2,
            at + 1
        );
        faces.push(format!("#{}", at + 2));
    }
    text += &format!("#40=IFCCLOSEDSHELL(({}));\n#41=IFCFACETEDBREP(#40);\n", faces.join(","));
    // A 0.4 m square block from 1 m below the box to 1 m above it, through its middle; and a
    // 3 by 4 by 3 block around the box.
    text += "#63=IFCEXTRUDEDAREASOLID(#64,#66,#67,5.);\n\
             #64=IFCRECTANGLEPROFILEDEF(.AREA.,$,#65,0.4,0.4);\n\
             #65=IFCAXIS2PLACEMENT2D(#68,$);\n\
             #66=IFCAXIS2PLACEMENT3D(#69,$,$);\n\
             #67=IFCDIRECTION((0.,0.,1.));\n\
             #68=IFCCARTESIANPOINT((0.5,1.));\n\
             #69=IFCCARTESIANPOINT((0.,0.,-1.));\n\
             #80=IFCEXTRUDEDAREASOLID(#81,#82,#67,3.);\n\
             #81=IFCRECTANGLEPROFILEDEF(.AREA.,$,#65,3.,4.);\n\
             #82=IFCAXIS2PLACEMENT3D(#10,$,$);\n";
    text + body
}

/// The block `#63` as an opening in the wall.
const OPENING: &str = "#5=IFCFACETEDBREP(#40);\n\
    #60=IFCOPENINGELEMENT('o',$,$,$,$,$,#61,$);\n\
    #61=IFCPRODUCTDEFINITIONSHAPE($,$,(#62));\n\
    #62=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#63));\n\
    #70=IFCRELVOIDSELEMENT('v',$,$,$,#2,#60);\n";

fn evaluate(body: &str) -> (Mesh, Vec<String>) {
    let text = format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;\n{body}ENDSEC;END-ISO-10303-21;");
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(2).expect("the element evaluates");
    let mut meshes = element.meshes.into_iter();
    let mesh = meshes.next().expect("a mesh").mesh;
    assert!(meshes.next().is_none(), "one mesh");
    (mesh, evaluator.diagnostics().iter().map(|item| item.code.to_string()).collect())
}

const FRONTS: [&str; 3] = ["#10,#11,#15,#14", "#10,#11,#15,#18,#14", "#10,#11,#19,#14"];

#[test]
fn a_void_is_cut_from_a_shell_whose_faces_nearly_meet() {
    for front in FRONTS {
        let (mesh, codes) = evaluate(&brep(front, OPENING));
        assert!(codes.is_empty(), "{front}: {codes:?}");
        assert_solid(&mesh, 6.0 - 0.4 * 0.4 * 3.0);
    }
}

#[test]
fn a_boolean_cuts_from_a_shell_whose_faces_nearly_meet() {
    for front in FRONTS {
        let (mesh, codes) = evaluate(&brep(front, "#5=IFCBOOLEANRESULT(.DIFFERENCE.,#41,#63);\n"));
        assert!(codes.is_empty(), "{front}: {codes:?}");
        assert_solid(&mesh, 6.0 - 0.4 * 0.4 * 3.0);
    }
}

#[test]
fn a_boolean_cuts_with_a_shell_whose_faces_nearly_meet() {
    for front in FRONTS {
        let (mesh, codes) = evaluate(&brep(front, "#5=IFCBOOLEANRESULT(.DIFFERENCE.,#80,#41);\n"));
        assert!(codes.is_empty(), "{front}: {codes:?}");
        assert_solid(&mesh, 36.0 - 6.0);
    }
}

/// The 1 by 2 by 3 box as an IFC4 face set whose top is a `cells` by `cells` grid, so each
/// side's top edge meets the grid's corners at T-junctions; with the opening of [`OPENING`].
fn gridded_box(cells: usize) -> String {
    let mut points = vec!["(0.,0.,0.)".to_string(), "(1.,0.,0.)".into(), "(1.,2.,0.)".into(), "(0.,2.,0.)".into()];
    for i in 0..=cells {
        for j in 0..=cells {
            points.push(format!("({},{},3.)", i as f64 / cells as f64, 2.0 * j as f64 / cells as f64));
        }
    }
    let g = |i: usize, j: usize| 5 + i * (cells + 1) + j;
    let (b0, b1, b2, b3) = (1, 2, 3, 4);
    let (t0, t1, t2, t3) = (g(0, 0), g(cells, 0), g(cells, cells), g(0, cells));
    let mut triangles = vec![
        [b0, b2, b1],
        [b0, b3, b2],
        [b0, b1, t1],
        [b0, t1, t0],
        [b1, b2, t2],
        [b1, t2, t1],
        [b2, b3, t3],
        [b2, t3, t2],
        [b3, b0, t0],
        [b3, t0, t3],
    ];
    for i in 0..cells {
        for j in 0..cells {
            triangles.push([g(i, j), g(i + 1, j), g(i + 1, j + 1)]);
            triangles.push([g(i, j), g(i + 1, j + 1), g(i, j + 1)]);
        }
    }
    let triangles: Vec<String> = triangles.iter().map(|[a, b, c]| format!("({a},{b},{c})")).collect();
    format!(
        "#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         #2=IFCWALL('w',$,$,$,$,$,#3,$,$);\n\
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
         #4=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#5));\n\
         #5=IFCTRIANGULATEDFACESET(#6,$,$,({}),$);\n\
         #6=IFCCARTESIANPOINTLIST3D(({}));\n\
         #60=IFCOPENINGELEMENT('o',$,$,$,$,$,#61,$,$);\n\
         #61=IFCPRODUCTDEFINITIONSHAPE($,$,(#62));\n\
         #62=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#63));\n\
         #63=IFCEXTRUDEDAREASOLID(#64,#66,#67,5.);\n\
         #64=IFCRECTANGLEPROFILEDEF(.AREA.,$,#65,0.4,0.4);\n\
         #65=IFCAXIS2PLACEMENT2D(#68,$);\n\
         #66=IFCAXIS2PLACEMENT3D(#69,$,$);\n\
         #67=IFCDIRECTION((0.,0.,1.));\n\
         #68=IFCCARTESIANPOINT((0.5,1.));\n\
         #69=IFCCARTESIANPOINT((0.,0.,-1.));\n\
         #70=IFCRELVOIDSELEMENT('v',$,$,$,#2,#60);\n",
        triangles.join(","),
        points.join(",")
    )
}

#[test]
fn only_meshes_small_enough_to_seal_quickly_are_sealed() {
    // Sealing scans each edge against the vertices beside it, which grows with the square of
    // a flat mesh. 2 * 70 * 70 + 10 triangles are under the limit of 10,000; 71 cells a side
    // are over it.
    let evaluate4 = |body: String| {
        let text = format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{body}ENDSEC;END-ISO-10303-21;");
        let file = index(text.as_bytes()).unwrap();
        let mut evaluator = ModelEvaluator::new(&file).unwrap();
        let element = evaluator.evaluate(2).expect("the element evaluates");
        let mesh = element.meshes.into_iter().next().expect("a mesh").mesh;
        (mesh, evaluator.diagnostics().iter().map(|item| item.code.to_string()).collect::<Vec<_>>())
    };
    for cells in [2, 70] {
        let (mesh, codes) = evaluate4(gridded_box(cells));
        assert!(codes.is_empty(), "{cells}: {codes:?}");
        assert_solid(&mesh, 6.0 - 0.4 * 0.4 * 3.0);
    }
    let (_, codes) = evaluate4(gridded_box(71));
    assert_eq!(codes, ["void-on-open-mesh"]);
}

#[test]
fn a_shell_with_a_face_missing_is_still_left_uncut() {
    let (mesh, codes) = evaluate(&brep("", OPENING));
    assert_eq!(codes, ["void-on-open-mesh"]);
    assert_eq!(mesh.triangles.len(), 10, "the five faces as they are");
    let (_, codes) = evaluate(&brep("", "#5=IFCBOOLEANRESULT(.DIFFERENCE.,#80,#41);\n"));
    assert_eq!(codes, ["boolean-on-open-mesh"]);
}
