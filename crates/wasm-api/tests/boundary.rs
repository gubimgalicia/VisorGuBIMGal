//! What crosses the WASM boundary, checked natively over every file we have.

use glam::DVec3;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use wasm_api::batches::{Batch, MAX_BATCH_RADIUS};
use wasm_api::loaded::{LoadedModel, OpenError};

const RECORD_WORDS: usize = 7;
const DEGRADED: u32 = 1 << 1;
const HIDDEN: u32 = 1 << 2;
const CLOSED: u32 = 1 << 3;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn all_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for folder in ["public/samples", "test/fixtures"] {
        for entry in fs::read_dir(root().join(folder)).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|extension| extension == "ifc") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn stream(model: &mut LoadedModel, max_triangles: usize) -> Vec<Batch> {
    model.start_stream();
    std::iter::from_fn(|| model.next_batch(max_triangles)).collect()
}

/// The same rules as `findBatchError` in `GeometryBatch.ts`, plus the radius.
fn check(batch: &Batch) {
    assert_eq!(batch.positions.len() % 3, 0);
    assert_eq!(batch.normals.len(), batch.positions.len());
    assert_eq!(batch.indices.len() % 3, 0);
    assert_eq!(batch.mesh_table.len() % RECORD_WORDS, 0);
    assert!(batch.positions.iter().all(|value| value.is_finite()));
    // The box is exactly the least and greatest position on each axis: the renderer culls by it.
    let corners = batch.positions.as_chunks::<3>().0;
    for axis in 0..3 {
        let values = corners.iter().map(|corner| corner[axis]);
        let (least, greatest) = (values.clone().reduce(f32::min), values.reduce(f32::max));
        assert_eq!(batch.min[axis], least.unwrap_or(0.0), "min {axis}");
        assert_eq!(batch.max[axis], greatest.unwrap_or(0.0), "max {axis}");
    }

    for normal in batch.normals.as_chunks::<3>().0 {
        let length = normal.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!((length - 1.0).abs() < 1e-3, "{normal:?}");
    }
    let vertex_total = (batch.positions.len() / 3) as u32;
    for record in batch.mesh_table.as_chunks::<RECORD_WORDS>().0 {
        let [express_id, first_vertex, vertex_count, first_index, index_count, _, flags] = *record;
        assert_ne!(express_id, 0);
        assert!(first_vertex + vertex_count <= vertex_total);
        assert!((first_index + index_count) as usize <= batch.indices.len());
        assert_eq!(index_count % 3, 0);
        let range = first_vertex..first_vertex + vertex_count;
        for index in &batch.indices[first_index as usize..(first_index + index_count) as usize] {
            assert!(range.contains(index), "index {index} leaves {range:?}");
        }
        if flags & DEGRADED == 0 {
            for at in range {
                let start = at as usize * 3;
                let position = &batch.positions[start..start + 3];
                let length = position.iter().map(|value| (*value as f64).powi(2)).sum::<f64>();
                assert!(length.sqrt() <= MAX_BATCH_RADIUS + 1e-3);
            }
        }
    }
}

#[test]
fn every_file_produces_valid_batches() {
    for path in all_files() {
        let bytes = fs::read(&path).unwrap();
        let mut model = LoadedModel::open(bytes).unwrap();
        let batches = stream(&mut model, 2_000);
        batches.iter().for_each(check);
        let processed = model.processed_elements();
        assert_eq!(processed, model.total_elements(), "{}", path.display());
        let complete = model.finish_stream();
        let records: usize = batches.iter().map(|batch| batch.mesh_table.len() / RECORD_WORDS).sum();
        assert!(complete.starts_with(&format!(r#"{{"meshCount":{records}"#)), "{complete}");
        println!("{:<36} {:>3} batches {:>4} records", path.file_name().unwrap().display(), batches.len(), records);
    }
}

#[test]
fn batch_size_does_not_change_what_is_drawn() {
    let bytes = fs::read(root().join("public/samples/ManySimpleWalls.ifc")).unwrap();
    let mut model = LoadedModel::open(bytes).unwrap();

    // Origins differ between the two runs, so vertices may differ by one f32 step.
    let per_element = |batches: &[Batch]| {
        let mut elements: BTreeMap<u32, (usize, f64)> = BTreeMap::new();
        for batch in batches {
            let corner = |index: u32| -> [f64; 3] {
                let at = index as usize * 3;
                std::array::from_fn(|axis| batch.positions[at + axis] as f64 + batch.origin[axis])
            };
            for record in batch.mesh_table.as_chunks::<RECORD_WORDS>().0 {
                let entry = elements.entry(record[0]).or_default();
                let first = record[3] as usize;
                for [a, b, c] in batch.indices[first..first + record[4] as usize].as_chunks::<3>().0 {
                    let ([ax, ay, az], [bx, by, bz], [cx, cy, cz]) = (corner(*a), corner(*b), corner(*c));
                    entry.0 += 1;
                    entry.1 += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz)
                        + az * (bx * cy - by * cx))
                        / 6.0;
                }
            }
        }
        elements
    };

    let whole = stream(&mut model, usize::MAX);
    let small = stream(&mut model, 50);
    assert!(small.len() > whole.len(), "{} and {}", small.len(), whole.len());
    let (whole, small) = (per_element(&whole), per_element(&small));
    assert_eq!(whole.len(), small.len());
    for ((id, a), (other, b)) in whole.iter().zip(&small) {
        assert_eq!((id, a.0), (other, b.0));
        assert!((a.1 - b.1).abs() < 1e-3, "#{id}: {} and {}", a.1, b.1);
    }
}

#[test]
fn far_apart_elements_get_separate_batches_near_real_coordinates() {
    let wall = |id: u32, x: f64| {
        format!(
            "#{id}=IFCWALL('{id}',$,$,$,$,#{},#10,$);\n\
             #{}=IFCLOCALPLACEMENT($,#{});\n\
             #{}=IFCAXIS2PLACEMENT3D(#{},$,$);\n\
             #{}=IFCCARTESIANPOINT(({x},4747000.,260.));\n",
            id + 1,
            id + 1,
            id + 2,
            id + 2,
            id + 3,
            id + 3
        )
    };
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
         #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
         #11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));\n\
         #12=IFCEXTRUDEDAREASOLID(#13,#15,#16,3.);\n\
         #13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#14,4.,0.2);\n\
         #14=IFCAXIS2PLACEMENT2D(#17,$);\n\
         #15=IFCAXIS2PLACEMENT3D(#17,$,$);\n\
         #16=IFCDIRECTION((0.,0.,1.));\n\
         #17=IFCCARTESIANPOINT((0.,0.,0.));\n\
         {}{}{}ENDSEC;END-ISO-10303-21;",
        wall(20, 536000.0),
        wall(30, 536010.0),
        wall(40, 590000.0)
    );
    let mut model = LoadedModel::open(text.into_bytes()).unwrap();
    let batches = stream(&mut model, usize::MAX);
    batches.iter().for_each(check);

    assert_eq!(batches.len(), 2, "{:?}", batches.iter().map(|b| b.origin).collect::<Vec<_>>());
    assert_eq!(batches[0].origin, [536000.0, 4747000.0, 262.0]);
    assert_eq!(batches[0].mesh_table.len() / RECORD_WORDS, 2);
    assert_eq!(batches[1].origin, [590000.0, 4747000.0, 262.0]);
    let complete = model.finish_stream();
    assert!(complete.contains(r#""min":{"x":535998,"#), "{complete}");
    assert!(complete.contains(r#""max":{"x":590002,"#), "{complete}");
}

#[test]
fn a_box_shares_corners_within_a_side_and_splits_them_between_sides() {
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCWALL('w',$,$,$,$,$,#10,$);\n\
        #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
        #11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));\n\
        #12=IFCEXTRUDEDAREASOLID(#13,#15,#16,3.);\n\
        #13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#14,4.,0.2);\n\
        #14=IFCAXIS2PLACEMENT2D(#17,$);\n\
        #15=IFCAXIS2PLACEMENT3D(#17,$,$);\n\
        #16=IFCDIRECTION((0.,0.,1.));\n\
        #17=IFCCARTESIANPOINT((0.,0.,0.));\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    let batches = stream(&mut model, usize::MAX);
    batches.iter().for_each(check);
    let batch = &batches[0];
    // Eight corners, each on three sides, and two triangles per side.
    assert_eq!((batch.positions.len() / 3, batch.indices.len() / 3), (24, 12));
    assert_normals_follow_triangles(batch);
}

#[test]
fn corners_whose_facings_differ_only_above_the_low_byte_are_not_shared() {
    // Facings (0, -9636, 31318) and (0, -22692, 23638): equal in each low byte.
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCPROXY('w',$,$,$,$,$,#3,$,.PRODUCT.,$);\n\
        #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
        #4=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#5));\n\
        #5=IFCTRIANGULATEDFACESET(#6,$,$,((1,2,3),(2,1,4)),$);\n\
        #6=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,13.,4.),(0.,-200.,-192.)));\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    let batches = stream(&mut model, usize::MAX);
    batches.iter().for_each(check);
    assert_eq!(batches[0].positions.len() / 3, 6);
    assert_normals_follow_triangles(&batches[0]);
}

/// Each corner's normal is the normal of every triangle that uses it.
fn assert_normals_follow_triangles(batch: &Batch) {
    let vector = |values: &[f32], index: u32| -> [f32; 3] {
        std::array::from_fn(|axis| values[index as usize * 3 + axis])
    };
    for triangle in batch.indices.as_chunks::<3>().0 {
        let [a, b, c] = triangle.map(|index| vector(&batch.positions, index));
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        for index in triangle {
            let normal = vector(&batch.normals, *index);
            let along: f32 = normal.iter().zip(cross).map(|(n, c)| n * c).sum();
            let length = cross.iter().map(|value| value * value).sum::<f32>().sqrt();
            assert!((along - length).abs() < 1e-4 * length, "{normal:?} against {cross:?}");
        }
    }
}
/// One triangle of the given corners as element #2.
fn one_triangle(corners: [[f64; 3]; 3]) -> String {
    let [a, b, c] = corners.map(|[x, y, z]| format!("({x:.1},{y:.1},{z:.1})"));
    faces("IFCPROXY('w',$,$,$,$,$,#3,$,.PRODUCT.,$)", &format!("{a},{b},{c}"), "(1,2,3)")
}

/// Element #2, given as its entity with representation #3, of a triangulated face set.
fn faces(element: &str, points: &str, triangles: &str) -> String {
    format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
         #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         #2={element};\n\
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
         #4=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#5));\n\
         #5=IFCTRIANGULATEDFACESET(#6,$,$,({triangles}),$);\n\
         #6=IFCCARTESIANPOINTLIST3D(({points}));\n\
         ENDSEC;END-ISO-10303-21;"
    )
}

#[test]
fn an_element_whose_box_is_wider_than_the_radius_but_whose_corners_are_not_stays_whole() {
    // An octahedron with corners 4000 m from its centre: its box reaches 6928 m.
    let points = "(4000.,0.,0.),(-4000.,0.,0.),(0.,4000.,0.),(0.,-4000.,0.),(0.,0.,4000.),(0.,0.,-4000.)";
    let triangles = "(1,3,5),(3,2,5),(2,4,5),(4,1,5),(3,1,6),(2,3,6),(4,2,6),(1,4,6)";
    let mut model = LoadedModel::open(faces("IFCPROXY('w',$,$,$,$,$,#3,$,.PRODUCT.,$)", points, triangles).into_bytes()).unwrap();
    let batches = stream(&mut model, usize::MAX);
    batches.iter().for_each(check);
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].indices.len(), 24);
    assert!(flags(&batches).iter().all(|flags| flags & DEGRADED == 0));
}

#[test]
fn closed_meshes_are_flagged_and_others_are_not() {
    const OCTAHEDRON: &str = "(4.,0.,0.),(-4.,0.,0.),(0.,4.,0.),(0.,-4.,0.),(0.,0.,4.),(0.,0.,-4.)";
    const ALL: &str = "(1,3,5),(3,2,5),(2,4,5),(4,1,5),(3,1,6),(2,3,6),(4,2,6),(1,4,6)";
    let proxy = "IFCPROXY('w',$,$,$,$,$,#3,$,.PRODUCT.,$)";
    let flag_of = |points: &str, triangles: &str| {
        let mut model = LoadedModel::open(faces(proxy, points, triangles).into_bytes()).unwrap();
        let batches = stream(&mut model, usize::MAX);
        batches.iter().for_each(check);
        flags(&batches)
    };
    assert_eq!(flag_of(OCTAHEDRON, ALL), [CLOSED]);
    // A face missing.
    assert_eq!(flag_of(OCTAHEDRON, "(1,3,5),(3,2,5),(2,4,5),(4,1,5),(3,1,6),(2,3,6),(4,2,6)"), [0]);
    // A face with no area is dropped without a gap: the faces either side meet along it. Here
    // (3,1,7) lies on the side from corner 1 to 3, between the whole face above and the face
    // below split at 7.
    let flat = "(4.,0.,0.),(-4.,0.,0.),(0.,4.,0.),(0.,-4.,0.),(0.,0.,4.),(0.,0.,-4.),(2.,2.,0.)";
    let with_sliver = "(1,3,5),(3,2,5),(2,4,5),(4,1,5),(3,1,7),(7,1,6),(3,7,6),(2,3,6),(4,2,6),(1,4,6)";
    assert_eq!(flag_of(flat, with_sliver), [CLOSED | DEGRADED]);
    // A corrupt corner drops the faces it touches and leaves a hole.
    let corrupt = "(4.,0.,0.),(-4.,0.,0.),(0.,4.,0.),(0.,-4.,0.),(0.,0.,4.),(0.,0.,-4.E300)";
    assert_eq!(flag_of(corrupt, ALL), [DEGRADED]);

    // An extruded wall.
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCWALL('w',$,$,$,$,$,#10,$);\n\
        #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
        #11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));\n\
        #12=IFCEXTRUDEDAREASOLID(#13,#15,#16,3.);\n\
        #13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#14,4.,0.2);\n\
        #14=IFCAXIS2PLACEMENT2D(#17,$);\n\
        #15=IFCAXIS2PLACEMENT3D(#17,$,$);\n\
        #16=IFCDIRECTION((0.,0.,1.));\n\
        #17=IFCCARTESIANPOINT((0.,0.,0.));\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    assert_eq!(flags(&stream(&mut model, usize::MAX)), [CLOSED]);
}

/// Walls #2 and #6 placing one mapped face set, `points` and `triangles`, through operators
/// written as their Axis2, LocalOrigin and Scale3.
fn mapped(points: &str, triangles: &str, first: (&str, &str, &str), second: (&str, &str, &str)) -> String {
    format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
         #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         #2=IFCWALL('w',$,$,$,$,$,#3,$);\n\
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
         #4=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#50));\n\
         #6=IFCWALL('x',$,$,$,$,$,#7,$);\n\
         #7=IFCPRODUCTDEFINITIONSHAPE($,$,(#8));\n\
         #8=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#51));\n\
         #50=IFCMAPPEDITEM(#52,#53);\n\
         #51=IFCMAPPEDITEM(#52,#54);\n\
         #52=IFCREPRESENTATIONMAP(#55,#56);\n\
         #53=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,{},{},$,$,$,{});\n\
         #54=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,{},{},$,$,$,{});\n\
         #55=IFCAXIS2PLACEMENT3D(#59,$,$);\n\
         #56=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#60));\n\
         #59=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #60=IFCTRIANGULATEDFACESET(#61,$,$,({triangles}),$);\n\
         #61=IFCCARTESIANPOINTLIST3D(({points}));\n\
         #70=IFCDIRECTION((0.,-1.,0.));\n\
         #71=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #72=IFCCARTESIANPOINT((20.,0.,0.));\n\
         #73=IFCCARTESIANPOINT((1000000.,0.,0.));\n\
         #74=IFCCARTESIANPOINT((1000000.,20.,0.));\n\
         ENDSEC;END-ISO-10303-21;",
        first.0, first.1, first.2, second.0, second.1, second.2
    )
}

#[test]
fn a_mapped_shape_is_checked_once_and_its_copies_keep_what_they_are() {
    const OCTAHEDRON: &str = "(4.,0.,0.),(-4.,0.,0.),(0.,4.,0.),(0.,-4.,0.),(0.,0.,4.),(0.,0.,-4.)";
    const ALL: &str = "(1,3,5),(3,2,5),(2,4,5),(4,1,5),(3,1,6),(2,3,6),(4,2,6),(1,4,6)";
    let stream_of = |text: String| {
        let mut model = LoadedModel::open(text.into_bytes()).unwrap();
        let batches = stream(&mut model, usize::MAX);
        batches.iter().for_each(check);
        let volumes: Vec<f64> = measure(&batches, [0.0; 3]).values().map(|element| element.3).collect();
        (flags(&batches), volumes)
    };
    let plain = ("$", "#71", "$");
    // A closed shape, its second copy mirrored: both stay closed, and both wind outward.
    let (flags_of, volumes) = stream_of(mapped(OCTAHEDRON, ALL, plain, ("#70", "#72", "$")));
    assert_eq!(flags_of, [CLOSED, CLOSED]);
    assert!(volumes.iter().all(|volume| (volume - 4.0 * 4.0 * 4.0 * 4.0 / 3.0).abs() < 1e-6), "{volumes:?}");
    // An open one: neither copy is marked.
    let open = "(1,3,5),(3,2,5),(2,4,5),(4,1,5),(3,1,6),(2,3,6),(4,2,6)";
    assert_eq!(stream_of(mapped(OCTAHEDRON, open, plain, ("$", "#72", "$"))).0, [0, 0]);
    // A unit cube whose second copy is stretched upward past any real coordinate: its top
    // corners are dropped as corrupt and its bottom face stays, open, so the mark goes.
    let cube = "(0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.)";
    let sides = "(1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5),(4,5,8)";
    let (flags_of, _) = stream_of(mapped(cube, sides, plain, ("$", "#72", "1.E300")));
    assert_eq!(flags_of, [CLOSED, DEGRADED]);
    // Flattened to no height, its sides have no area and the rest encloses nothing.
    let (flags_of, _) = stream_of(mapped(cube, sides, plain, ("$", "#72", "0.")));
    assert_eq!(flags_of, [CLOSED, DEGRADED]);
    // Open as written, with a corner 1e-12 m off its neighbour, but closed once placed 1000 km
    // away, where the two round to one: every copy is checked as placed.
    let split = format!("{OCTAHEDRON},(4.000000000001,0.,0.)");
    let parted = "(1,3,5),(3,2,5),(2,4,5),(4,1,5),(3,7,6),(2,3,6),(4,2,6),(7,4,6)";
    assert_eq!(stream_of(mapped(&split, parted, plain, ("$", "#72", "$"))).0, [0, 0], "open near the origin");
    let far = ("$", "#73", "$");
    assert_eq!(stream_of(mapped(&split, parted, far, ("$", "#74", "$"))).0, [CLOSED, CLOSED], "closed far away");
}

#[test]
fn pieces_keep_their_element_flags() {
    // A space of 20 km: every piece starts hidden, and hidden things leave the bounds alone.
    let space = "IFCSPACE('s',$,$,$,$,$,#3,$,.ELEMENT.,.INTERNAL.,$)";
    let mut model = LoadedModel::open(faces(space, "(0.,0.,0.),(20000.,0.,0.),(0.,20000.,0.)", "(1,2,3)").into_bytes()).unwrap();
    let batches = stream(&mut model, usize::MAX);
    batches.iter().for_each(check);
    assert!(batches.len() >= 9, "{} batches", batches.len());
    assert!(flags(&batches).iter().all(|flags| flags & (DEGRADED | HIDDEN) == HIDDEN), "{:?}", flags(&batches));
    assert!(!model.finish_stream().contains(r#""bounds""#));
}

/// Per element: records, triangles, area, and signed volume about `reference`, all from the
/// absolute corners the batches give, in f64.
fn measure(batches: &[Batch], reference: [f64; 3]) -> BTreeMap<u32, (usize, usize, f64, f64)> {
    let mut elements: BTreeMap<u32, (usize, usize, f64, f64)> = BTreeMap::new();
    for batch in batches {
        let corner = |index: u32| -> [f64; 3] {
            let at = index as usize * 3;
            std::array::from_fn(|axis| batch.positions[at + axis] as f64 + batch.origin[axis] - reference[axis])
        };
        for record in batch.mesh_table.as_chunks::<RECORD_WORDS>().0 {
            let entry = elements.entry(record[0]).or_default();
            entry.0 += 1;
            let first = record[3] as usize;
            for [a, b, c] in batch.indices[first..first + record[4] as usize].as_chunks::<3>().0 {
                let ([ax, ay, az], [bx, by, bz], [cx, cy, cz]) = (corner(*a), corner(*b), corner(*c));
                let (u, v) = ([bx - ax, by - ay, bz - az], [cx - ax, cy - ay, cz - az]);
                let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
                entry.1 += 1;
                entry.2 += cross.iter().map(|value| value * value).sum::<f64>().sqrt() / 2.0;
                entry.3 += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6.0;
            }
        }
    }
    elements
}

fn flags(batches: &[Batch]) -> Vec<u32> {
    batches.iter().flat_map(|batch| batch.mesh_table.as_chunks::<RECORD_WORDS>().0.iter().map(|record| record[6])).collect()
}

#[test]
fn a_huge_triangle_is_split_into_pieces_within_the_radius() {
    // Sides of 20, 20 and 28.3 km: halved six times to 442 m at most, so 4^6 triangles.
    let text = one_triangle([[0.0, 0.0, 0.0], [20000.0, 0.0, 0.0], [0.0, 20000.0, 0.0]]);
    let mut model = LoadedModel::open(text.into_bytes()).unwrap();
    for max_triangles in [usize::MAX, 100] {
        let batches = stream(&mut model, max_triangles);
        batches.iter().for_each(check);
        batches.iter().for_each(assert_normals_follow_triangles);
        assert!(batches.len() >= 9, "{} batches", batches.len());
        assert!(flags(&batches).iter().all(|flags| flags & DEGRADED == 0));
        let elements = measure(&batches, [0.0; 3]);
        let (records, triangles, area, _) = elements[&2];
        assert_eq!(elements.len(), 1);
        assert_eq!(triangles, 4096);
        assert!((area - 2.0e8).abs() < 1.0, "area {area}");
        let complete = model.finish_stream();
        assert!(!complete.contains("batch-radius-exceeded"), "{complete}");
        assert!(complete.starts_with(&format!(r#"{{"meshCount":{records}"#)), "{complete}");
        assert!(complete.contains(r#""min":{"x":0,"y":0,"z":0}"#), "{complete}");
        assert!(complete.contains(r#""max":{"x":20000,"y":20000,"z":0}"#), "{complete}");
    }
    let (first, second) = (stream(&mut model, usize::MAX), stream(&mut model, usize::MAX));
    assert_eq!(first, second, "the same pieces each time");
}

#[test]
fn a_triangle_of_ten_kilometres_or_tilted_on_every_axis_is_split_within_the_radius() {
    // The first reaches 7071 m from its centre though its box diagonal is only 14 km; the
    // second puts pieces across cells on all three axes, where their boxes are widest.
    for corners in [
        [[0.0, 0.0, 0.0], [10000.0, 0.0, 0.0], [0.0, 10000.0, 0.0]],
        [[0.0, 0.0, 0.0], [30000.0, 1000.0, 29000.0], [1000.0, 30000.0, 29500.0]],
    ] {
        let mut model = LoadedModel::open(one_triangle(corners).into_bytes()).unwrap();
        let batches = stream(&mut model, usize::MAX);
        batches.iter().for_each(check);
        assert!(batches.len() >= 2, "{} batches", batches.len());
        assert!(flags(&batches).iter().all(|flags| flags & DEGRADED == 0));
        let [a, b, c] = corners.map(DVec3::from_array);
        let area = (b - a).cross(c - a).length() / 2.0;
        let measured = measure(&batches, [0.0; 3])[&2].2;
        assert!((measured - area).abs() < 1e-6 * area, "{measured} against {area}");
    }
}

#[test]
fn a_long_slab_at_real_coordinates_keeps_its_volume_when_split() {
    // 20 km x 10 m x 0.3 m along a diagonal, near UTM coordinates: 60 000 m3, and
    // 2 x 200 000 + 2 x 6000 + 2 x 3 = 412 006 m2.
    let text = String::from(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
         #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         #2=IFCSLAB('s',$,$,$,$,#20,#10,$,$);\n\
         #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
         #11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));\n\
         #12=IFCEXTRUDEDAREASOLID(#13,#15,#16,0.3);\n\
         #13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#14,20000.,10.);\n\
         #14=IFCAXIS2PLACEMENT2D(#17,$);\n\
         #15=IFCAXIS2PLACEMENT3D(#17,$,$);\n\
         #16=IFCDIRECTION((0.,0.,1.));\n\
         #17=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #20=IFCLOCALPLACEMENT($,#21);\n\
         #21=IFCAXIS2PLACEMENT3D(#22,$,#23);\n\
         #22=IFCCARTESIANPOINT((536000.,4747000.,260.));\n\
         #23=IFCDIRECTION((1.,1.,0.));\n\
         ENDSEC;END-ISO-10303-21;"
    );
    let mut model = LoadedModel::open(text.into_bytes()).unwrap();
    let batches = stream(&mut model, usize::MAX);
    batches.iter().for_each(check);
    batches.iter().for_each(assert_normals_follow_triangles);
    assert!(batches.len() >= 4, "{} batches", batches.len());
    assert!(flags(&batches).iter().all(|flags| flags & DEGRADED == 0));
    // Each piece still lies on the closed surface of the whole, so keeps its flag.
    assert!(flags(&batches).iter().all(|flags| flags & CLOSED == CLOSED), "{:?}", flags(&batches));
    let (_, _, area, volume) = measure(&batches, [536000.0, 4747000.0, 260.0])[&2];
    assert!((volume - 60000.0).abs() < 0.5, "volume {volume}");
    assert!((area - (400000.0 + 12000.0 + 6.0)).abs() < 0.5, "area {area}");
    assert!(!model.finish_stream().contains("batch-radius-exceeded"));

    // Corners of the long sides lie 5 m across the axis. Within 3843 m of an origin, f32 keeps
    // each coordinate to 1.22e-4 m, so at most 1.73e-4 m across; whole, the slab would reach
    // 7071 m from its origin and twice that.
    let mut worst: f64 = 0.0;
    for batch in &batches {
        for (position, normal) in batch.positions.as_chunks::<3>().0.iter().zip(batch.normals.as_chunks::<3>().0) {
            let across = (f64::from(normal[1]) - f64::from(normal[0])) / 2f64.sqrt();
            if across.abs() < 0.99 {
                continue;
            }
            let [x, y] = [0, 1].map(|axis| f64::from(position[axis]) + batch.origin[axis]);
            let offset = (-(x - 536000.0) + (y - 4747000.0)) / 2f64.sqrt();
            worst = worst.max((offset * across.signum() - 5.0).abs());
        }
    }
    assert!(worst > 0.0 && worst <= 1.73e-4, "{worst} m off the side");
}

#[test]
fn an_element_too_big_to_split_stays_whole_and_flagged() {
    // 100 000 km sides need 4^18 triangles to reach 512 m: past the budget.
    let text = one_triangle([[0.0, 0.0, 0.0], [1.0e8, 0.0, 0.0], [0.0, 1.0e8, 0.0]]);
    let mut model = LoadedModel::open(text.into_bytes()).unwrap();
    let batches = stream(&mut model, usize::MAX);
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].indices.len(), 3);
    assert_eq!(batches[0].mesh_table[6] & DEGRADED, DEGRADED);
    assert!(model.finish_stream().contains("batch-radius-exceeded"));
}

#[test]
fn degenerate_and_corrupt_triangles_are_dropped_and_reported() {
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCPROXY('w',$,$,$,$,$,#3,$,.PRODUCT.,$);\n\
        #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
        #4=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#5));\n\
        #5=IFCTRIANGULATEDFACESET(#6,$,$,((1,2,3),(1,1,2),(1,2,4)),$);\n\
        #6=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(1.E300,1.,0.)));\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    let batches = stream(&mut model, usize::MAX);
    batches.iter().for_each(check);
    assert_eq!(batches[0].indices.len(), 3, "only the good triangle stays");
    assert_eq!(batches[0].mesh_table[6] & DEGRADED, DEGRADED);
    assert!(model.finish_stream().contains(r#""code":"invalid-triangles""#));
}

#[test]
fn open_reports_what_went_wrong() {
    let error = LoadedModel::open(b"not an ifc file".to_vec()).err().unwrap();
    assert!(matches!(error, OpenError::Parse(_)), "{error:?}");

    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('AP214'));ENDSEC;DATA;\nENDSEC;END-ISO-10303-21;";
    let error = LoadedModel::open(text.as_bytes().to_vec()).err().unwrap();
    assert!(matches!(error, OpenError::UnsupportedSchema(_)), "{error:?}");
}

#[test]
fn streaming_twice_gives_the_same_geometry_and_diagnostics() {
    let bytes = fs::read(root().join("public/samples/SimpleWall.ifc")).unwrap();
    let mut model = LoadedModel::open(bytes).unwrap();
    let first = stream(&mut model, usize::MAX);
    let first_end = model.finish_stream();
    let second = stream(&mut model, usize::MAX);
    assert_eq!(first, second);
    assert_eq!(first_end, model.finish_stream());
}

#[test]
fn summary_and_details_use_the_contract_field_names() {
    let bytes = fs::read(root().join("public/samples/SimpleWall.ifc")).unwrap();
    let mut model = LoadedModel::open(bytes).unwrap();

    let summary = model.summary_json();
    for expected in [
        r#""schema":"IFC2X3""#,
        r#""entityCount":548"#,
        r#""elementCount":2"#,
        r#""lengthUnitScale":0.001"#,
        r#""lengthUnitSource":"ifc""#,
        r#""source":"ifc-site""#,
    ] {
        assert!(summary.contains(expected), "{expected} in {summary}");
    }

    let tree = model.spatial_tree_json().unwrap();
    assert!(tree.starts_with(r#"{"root":{"expressId":121,"type":"IfcProject""#), "{tree}");
    assert!(tree.contains(r#""via":"contains""#), "{tree}");

    let wall = model.element_details_json(219).unwrap();
    for expected in [
        r#""type":"IfcWallStandardCase""#,
        r#""globalId":"1F6umJ5H50aeL3A1As_wTm""#,
        r#""Tag":"346660""#,
        r#""kind":"quantity""#,
        r#""unit":"mm""#,
        r#""kind":"layer-set""#,
        r#""source":"instance""#,
        r#""name":"Default Wall","thickness":0.2"#,
    ] {
        assert!(wall.contains(expected), "{expected} in {wall}");
    }
    assert!(model.element_details_json(999_999).is_none());
}

#[test]
fn search_fields_cross_by_their_contract_names() {
    let bytes = fs::read(root().join("public/samples/SimpleWall.ifc")).unwrap();
    let model = LoadedModel::open(bytes).unwrap();
    // #219 is the wall and #572 the door, by their lines in the file.
    assert_eq!(model.find_elements("name", "bearing wall", None), Some(vec![219]));
    assert_eq!(model.find_elements("class", "door", None), Some(vec![572]));
    assert_eq!(model.find_elements("globalId", "As_wUF", None), Some(vec![572]));
    assert_eq!(model.find_elements("any", "346", None), Some(vec![219, 572]));
    let external = model.find_elements("property", "", Some("IsExternal"));
    assert!(external.is_some_and(|ids| !ids.is_empty()));
    assert_eq!(model.find_elements("Name", "wall", None), None, "names are exact");
    assert_eq!(model.find_elements("", "wall", None), None);
}
