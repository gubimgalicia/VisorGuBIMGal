//! One element's triangles for measuring: absolute, merged, and the same surface the stream draws.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use wasm_api::loaded::{ElementShape, LoadedModel};

const RECORD_WORDS: usize = 7;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn corners(shape: &ElementShape) -> Vec<[[f64; 3]; 3]> {
    let point = |index: u32| {
        let at = index as usize * 3;
        [shape.positions[at], shape.positions[at + 1], shape.positions[at + 2]]
    };
    shape.indices.chunks(3).map(|t| [point(t[0]), point(t[1]), point(t[2])]).collect()
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn area(triangles: &[[[f64; 3]; 3]]) -> f64 {
    triangles
        .iter()
        .map(|[a, b, c]| {
            let n = cross(sub(*b, *a), sub(*c, *a));
            dot(n, n).sqrt() / 2.0
        })
        .sum()
}

/// Positive when every triangle runs counter-clockwise seen from outside.
fn volume(triangles: &[[[f64; 3]; 3]]) -> f64 {
    triangles.iter().map(|[a, b, c]| dot(*a, cross(*b, *c)) / 6.0).sum()
}

fn check_shape(shape: &ElementShape) {
    assert_eq!(shape.positions.len() % 3, 0);
    assert_eq!(shape.indices.len() % 3, 0);
    assert!(!shape.indices.is_empty());
    let vertices = (shape.positions.len() / 3) as u32;
    assert!(shape.indices.iter().all(|index| *index < vertices));
    assert!(shape.positions.iter().all(|value| value.is_finite()));
    for t in shape.indices.chunks(3) {
        assert!(t[0] != t[1] && t[1] != t[2] && t[0] != t[2], "{t:?}");
    }
    assert_eq!(shape.edges.len() % 2, 0);
    assert!(shape.edges.iter().all(|index| *index < vertices));
    assert!(shape.edges.chunks(2).all(|pair| pair[0] < pair[1]), "low index first");
}

#[test]
fn a_box_comes_back_as_its_eight_corners_in_absolute_coordinates() {
    // A 2 x 1 profile centred on the placement, extruded 3 up, placed at (10, 20, 30).
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCBUILDINGELEMENTPROXY('b',$,$,$,$,#20,#10,$,$);\n\
        #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
        #11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));\n\
        #12=IFCEXTRUDEDAREASOLID(#13,#15,#16,3.);\n\
        #13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#14,2.,1.);\n\
        #14=IFCAXIS2PLACEMENT2D(#17,$);\n\
        #15=IFCAXIS2PLACEMENT3D(#17,$,$);\n\
        #16=IFCDIRECTION((0.,0.,1.));\n\
        #17=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #20=IFCLOCALPLACEMENT($,#21);\n\
        #21=IFCAXIS2PLACEMENT3D(#22,$,$);\n\
        #22=IFCCARTESIANPOINT((10.,20.,30.));\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    let shape = model.element_mesh(2).expect("the box has a mesh");
    check_shape(&shape);

    let mut found: Vec<[f64; 3]> =
        shape.positions.chunks(3).map(|p| [p[0], p[1], p[2]]).collect();
    found.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut expected = Vec::new();
    for x in [9.0, 11.0] {
        for y in [19.5, 20.5] {
            for z in [30.0, 33.0] {
                expected.push([x, y, z]);
            }
        }
    }
    assert_eq!(found, expected);
    assert_eq!(shape.indices.len() / 3, 12);

    let triangles = corners(&shape);
    assert!((area(&triangles) - 22.0).abs() < 1e-9, "{}", area(&triangles));
    assert!((volume(&triangles) - 6.0).abs() < 1e-9, "{}", volume(&triangles));
}

#[test]
fn an_opening_is_cut_from_its_host_and_has_no_mesh_of_its_own() {
    // A 4 x 0.2 x 3 wall; a 1 x 0.6 x 1 opening from z = 1 goes right through its 0.2.
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCWALL('w',$,$,$,$,#20,#10,$,$);\n\
        #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
        #11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));\n\
        #12=IFCEXTRUDEDAREASOLID(#13,#15,#16,3.);\n\
        #13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#14,4.,0.2);\n\
        #14=IFCAXIS2PLACEMENT2D(#17,$);\n\
        #15=IFCAXIS2PLACEMENT3D(#17,$,$);\n\
        #16=IFCDIRECTION((0.,0.,1.));\n\
        #17=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #20=IFCLOCALPLACEMENT($,#21);\n\
        #21=IFCAXIS2PLACEMENT3D(#17,$,$);\n\
        #30=IFCOPENINGELEMENT('o',$,$,$,$,#31,#33,$,$);\n\
        #31=IFCLOCALPLACEMENT(#20,#32);\n\
        #32=IFCAXIS2PLACEMENT3D(#34,$,$);\n\
        #34=IFCCARTESIANPOINT((0.,0.,1.));\n\
        #33=IFCPRODUCTDEFINITIONSHAPE($,$,(#35));\n\
        #35=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#36));\n\
        #36=IFCEXTRUDEDAREASOLID(#37,#15,#16,1.);\n\
        #37=IFCRECTANGLEPROFILEDEF(.AREA.,$,#14,1.,0.6);\n\
        #40=IFCRELVOIDSELEMENT('r',$,$,$,#2,#30);\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    let shape = model.element_mesh(2).expect("the wall has a mesh");
    check_shape(&shape);
    let triangles = corners(&shape);
    // 2.4 m3 less the 0.2 m3 hole; 26.8 m2 of box, less 2 m2 of hole faces, plus 0.8 m2 of reveals.
    assert!((volume(&triangles) - 2.2).abs() < 1e-6, "{}", volume(&triangles));
    assert!((area(&triangles) - 25.6).abs() < 1e-6, "{}", area(&triangles));

    assert!(model.element_mesh(30).is_none(), "openings are not drawn");
}

#[test]
fn coincident_corners_are_merged_and_degenerate_triangles_dropped() {
    // Points 2 and 4 sit within a micrometre; triangle (1,2,6) is a line. Point 9 is 0.4 um
    // from point 6, so (1,2,9) has area until its corner merges into 6 and it becomes a line.
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCBUILDINGELEMENTPROXY('b',$,$,$,$,$,#3,$,$);\n\
        #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
        #4=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#5));\n\
        #5=IFCTRIANGULATEDFACESET(#6,$,$,((1,2,3),(4,5,3),(1,2,6),(6,7,8),(1,2,9)),$);\n\
        #6=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(1.0000001,0.,0.),(1.,1.,0.),\
        (2.,0.,0.),(2.,1.,0.),(3.,0.,0.),(2.,0.0000004,0.)));\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    let shape = model.element_mesh(2).expect("the faces have a mesh");
    check_shape(&shape);
    assert_eq!(shape.positions.len() / 3, 7, "{:?}", shape.positions);
    assert_eq!(shape.indices.len() / 3, 3, "{:?}", shape.indices);
    assert!(corners(&shape).iter().all(|t| area(&[*t]) > 1e-3), "no triangle is a line");
    let triangles = corners(&shape);
    assert!(triangles.iter().flatten().any(|p| *p == [1.0, 0.0, 0.0]), "the first copy is kept");
    assert!(triangles.iter().flatten().all(|p| p[0] != 1.0000001));
    // The two triangles share the edge from (1,0,0) to (0,1,0) by index.
    let first: Vec<u32> = shape.indices[0..3].to_vec();
    let shared = shape.indices[3..6].iter().filter(|index| first.contains(index)).count();
    assert_eq!(shared, 2, "{:?}", shape.indices);
    assert!((area(&triangles) - 1.5).abs() < 1e-6);
}

#[test]
fn ids_without_drawn_geometry_have_no_mesh() {
    let bytes = fs::read(root().join("public/samples/SimpleWall.ifc")).unwrap();
    let mut model = LoadedModel::open(bytes).unwrap();
    for id in [0, 1, u32::MAX] {
        assert!(model.element_mesh(id).is_none(), "#{id}");
    }
    assert!(model.element_mesh(219).is_some(), "the wall");
}

/// Edges as sorted pairs of positions, for comparing with edges written by hand.
fn edge_set(shape: &ElementShape) -> Vec<[[i64; 3]; 2]> {
    let key = |index: u32| {
        let at = index as usize * 3;
        [0, 1, 2].map(|axis| (shape.positions[at + axis] * 1e6).round() as i64)
    };
    let mut out: Vec<[[i64; 3]; 2]> = shape
        .edges
        .chunks(2)
        .map(|pair| {
            let (a, b) = (key(pair[0]), key(pair[1]));
            if a <= b { [a, b] } else { [b, a] }
        })
        .collect();
    out.sort();
    out
}

#[test]
fn a_box_has_its_twelve_edges_and_no_face_diagonal() {
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCBUILDINGELEMENTPROXY('b',$,$,$,$,$,#10,$,$);\n\
        #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
        #11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));\n\
        #12=IFCEXTRUDEDAREASOLID(#13,#15,#16,3.);\n\
        #13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#14,2.,1.);\n\
        #14=IFCAXIS2PLACEMENT2D(#17,$);\n\
        #15=IFCAXIS2PLACEMENT3D(#17,$,$);\n\
        #16=IFCDIRECTION((0.,0.,1.));\n\
        #17=IFCCARTESIANPOINT((0.,0.,0.));\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    let shape = model.element_mesh(2).unwrap();
    let corner = |x: f64, y: f64, z: f64| [x, y, z].map(|v| (v * 1e6).round() as i64);
    let mut expected = Vec::new();
    // Four along each axis of the box x -1..1, y -0.5..0.5, z 0..3.
    for (a, b) in [(-1.0, 1.0)] {
        for y in [-0.5, 0.5] {
            for z in [0.0, 3.0] {
                expected.push([corner(a, y, z), corner(b, y, z)]);
            }
        }
    }
    for x in [-1.0, 1.0] {
        for z in [0.0, 3.0] {
            expected.push([corner(x, -0.5, z), corner(x, 0.5, z)]);
        }
        for y in [-0.5, 0.5] {
            expected.push([corner(x, y, 0.0), corner(x, y, 3.0)]);
        }
    }
    expected.sort();
    assert_eq!(edge_set(&shape), expected);
}

/// A closed prism over a regular polygon of `sides`, radius 1, height 2, with fan caps.
fn prism(sides: usize) -> ElementShape {
    let mut points = Vec::new();
    for z in [0.0, 2.0] {
        for i in 0..sides {
            let angle = std::f64::consts::TAU * i as f64 / sides as f64;
            points.push(format!("({:.15},{:.15},{z:.1})", angle.cos(), angle.sin()));
        }
    }
    let mut faces = Vec::new();
    for i in 0..sides {
        let j = (i + 1) % sides;
        let (a, b, c, d) = (i + 1, j + 1, sides + j + 1, sides + i + 1);
        faces.push(format!("({a},{b},{c})"));
        faces.push(format!("({a},{c},{d})"));
    }
    for i in 1..sides - 1 {
        faces.push(format!("(1,{},{})", i + 2, i + 1));
        faces.push(format!("({},{},{})", sides + 1, sides + i + 1, sides + i + 2));
    }
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
         #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         #2=IFCBUILDINGELEMENTPROXY('b',$,$,$,$,$,#3,$,$);\n\
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
         #4=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#5));\n\
         #5=IFCTRIANGULATEDFACESET(#6,$,.T.,({}),$);\n\
         #6=IFCCARTESIANPOINTLIST3D(({}));\n\
         ENDSEC;END-ISO-10303-21;",
        faces.join(","),
        points.join(",")
    );
    LoadedModel::open(text.into_bytes()).unwrap().element_mesh(2).unwrap()
}

#[test]
fn smooth_facets_meet_without_an_edge_and_coarse_ones_with_one() {
    // 32 sides turn 11.25 degrees each: only the two rims are edges. 12 sides turn 30.
    assert_eq!(prism(32).edges.len() / 2, 64);
    assert_eq!(prism(12).edges.len() / 2, 36);
}

#[test]
fn an_open_sheet_is_edged_all_round() {
    // Two triangles making a flat square: four border edges, not the shared diagonal.
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCBUILDINGELEMENTPROXY('b',$,$,$,$,$,#3,$,$);\n\
        #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
        #4=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#5));\n\
        #5=IFCTRIANGULATEDFACESET(#6,$,$,((1,2,3),(1,3,4)),$);\n\
        #6=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.)));\n\
        ENDSEC;END-ISO-10303-21;";
    let shape = LoadedModel::open(text.as_bytes().to_vec()).unwrap().element_mesh(2).unwrap();
    let diagonal = [[0, 0, 0], [1_000_000, 1_000_000, 0]];
    let edges = edge_set(&shape);
    assert_eq!(edges.len(), 4, "{edges:?}");
    assert!(!edges.contains(&diagonal));
}

/// Triangle count and area per element, from absolute f32 corners as the renderer gets them.
fn streamed(model: &mut LoadedModel) -> BTreeMap<u32, (usize, f64)> {
    let mut out: BTreeMap<u32, (usize, f64)> = BTreeMap::new();
    model.start_stream();
    while let Some(batch) = model.next_batch(usize::MAX) {
        let point = |index: u32| {
            let at = index as usize * 3;
            [0, 1, 2].map(|axis| batch.origin[axis] + f64::from(batch.positions[at + axis]))
        };
        for record in batch.mesh_table.chunks(RECORD_WORDS) {
            let (first, count) = (record[3] as usize, record[4] as usize);
            let triangles: Vec<_> = batch.indices[first..first + count]
                .chunks(3)
                .map(|t| [point(t[0]), point(t[1]), point(t[2])])
                .collect();
            let entry = out.entry(record[0]).or_default();
            entry.0 += triangles.len();
            entry.1 += area(&triangles);
        }
    }
    model.finish_stream();
    out
}

#[test]
fn every_drawn_element_has_the_surface_the_stream_draws() {
    let mut checked = 0;
    for folder in ["public/samples", "test/fixtures"] {
        let mut files: Vec<PathBuf> = fs::read_dir(root().join(folder))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "ifc"))
            .collect();
        files.sort();
        for path in files {
            let Ok(mut model) = LoadedModel::open(fs::read(&path).unwrap()) else { continue };
            let drawn = streamed(&mut model);
            for (id, (count, drawn_area)) in &drawn {
                let shape = model
                    .element_mesh(*id)
                    .unwrap_or_else(|| panic!("{}: #{id} is drawn but has no mesh", path.display()));
                check_shape(&shape);
                let triangles = corners(&shape);
                assert!(triangles.len() <= *count, "{}: #{id}", path.display());
                let measured = area(&triangles);
                let tolerance = 1e-3 * drawn_area.max(1.0);
                assert!(
                    (measured - drawn_area).abs() < tolerance,
                    "{}: #{id} {measured} against {drawn_area}",
                    path.display()
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 100, "{checked}");
}
