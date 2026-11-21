//! Evaluated geometry checked against quantities written by the authoring tool.

use ifc_geometry::{ElementGeometry, Mesh, ModelEvaluator};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use step_parser::{StepIndex, Value, index};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn sample(name: &str) -> Vec<u8> {
    fs::read(root().join("public/samples").join(name)).unwrap()
}

fn volume(element: &ElementGeometry) -> f64 {
    element.meshes.iter().map(|part| part.mesh.volume()).sum()
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Real(number) => Some(*number),
        Value::Integer(number) => Some(*number as f64),
        _ => None,
    }
}

/// Reads NetVolume per element. Revit writes it twice, in mm3 and m3, so the smallest wins.
fn net_volumes(file: &StepIndex<'_>) -> HashMap<u32, f64> {
    let mut volumes = HashMap::new();
    for id in file.ids_by_type("IFCRELDEFINESBYPROPERTIES") {
        let relation = file.decode(id).unwrap();
        let (Some(Value::List(objects)), Some(Value::Ref(definition))) =
            (relation.params.get(4), relation.params.get(5))
        else {
            continue;
        };
        let definition = file.decode(*definition).unwrap();
        if definition.type_name != "IFCELEMENTQUANTITY" {
            continue;
        }
        let Some(Value::List(quantities)) = definition.params.get(5) else {
            continue;
        };
        let smallest = quantities
            .iter()
            .filter_map(|quantity| {
                let Value::Ref(quantity) = quantity else { return None };
                let quantity = file.decode(*quantity).ok()?;
                let named = matches!(quantity.params.first(), Some(Value::String(name)) if name == "NetVolume");
                (quantity.type_name == "IFCQUANTITYVOLUME" && named)
                    .then(|| number(quantity.params.get(3)))
                    .flatten()
            })
            .fold(f64::INFINITY, f64::min);
        if smallest.is_finite() {
            for object in objects {
                if let Value::Ref(object) = object {
                    volumes.insert(*object, smallest);
                }
            }
        }
    }
    volumes
}

#[test]
fn simple_wall_matches_the_volume_revit_reported() {
    let bytes = sample("SimpleWall.ifc");
    let file = index(&bytes).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    assert_eq!(evaluator.units().length, 0.001);

    let wall = evaluator.evaluate(219).unwrap();
    assert_eq!(wall.type_name, "IfcWallStandardCase");
    assert!(!wall.degraded, "{:?}", evaluator.diagnostics());
    let net = volume(&wall);
    assert!((net - 2.809478).abs() < 1e-5, "net volume {net}");
    for part in &wall.meshes {
        assert_eq!(part.mesh.open_edges(), 0);
    }
}

#[test]
fn walls_in_many_simple_walls_match_their_quantities() {
    let bytes = sample("ManySimpleWalls.ifc");
    let file = index(&bytes).unwrap();
    let expected = net_volumes(&file);
    let mut evaluator = ModelEvaluator::new(&file).unwrap();

    let mut compared = 0;
    let mut problems = Vec::new();
    for id in evaluator.element_ids() {
        let element = evaluator.evaluate(id).unwrap();
        if !element.type_name.contains("Wall") {
            continue;
        }
        let Some(reported) = expected.get(&id) else { continue };
        compared += 1;
        let computed = volume(&element);
        if (computed - reported).abs() > 1e-5 {
            problems.push(format!("#{id}: computed {computed:.6}, reported {reported:.6}"));
        }
    }
    println!("{compared} walls compared");
    assert!(compared > 0, "no walls had quantities");
    assert!(problems.is_empty(), "{} of {compared}:\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn mirrored_and_scaled_transforms_keep_solids_outward_facing() {
    let bytes = sample("ManySimpleWalls.ifc");
    let file = index(&bytes).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    for id in evaluator.element_ids() {
        let element = evaluator.evaluate(id).unwrap();
        for part in &element.meshes {
            if part.mesh.open_edges() == 0 {
                assert!(part.mesh.volume() > 0.0, "#{id} is inside out");
            }
        }
    }
}

/// R8: a damaged file degrades, and never brings the evaluator down.
#[test]
fn corrupted_files_never_panic() {
    let original = sample("SimpleWall.ifc");
    let replacements = *b"90#$(),.E'";
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut evaluated = 0usize;
    for round in 0..3000 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let mut bytes = original.clone();
        let position = (state % bytes.len() as u64) as usize;
        bytes[position] = replacements[round % replacements.len()];
        let Ok(file) = index(&bytes) else { continue };
        let Ok(mut evaluator) = ModelEvaluator::new(&file) else { continue };
        for id in evaluator.element_ids() {
            if let Some(element) = evaluator.evaluate(id) {
                evaluated += 1;
                for part in element.meshes {
                    let _ = part.mesh.volume();
                }
            }
        }
    }
    assert!(evaluated > 1000, "only {evaluated} elements evaluated");
}

/// Hand-written hostile cases: cycles, huge numbers and impossible references.
#[test]
fn hostile_models_never_panic() {
    let header = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n";
    let wall = "#1=IFCWALL('a',$,$,$,$,#2,#3,$,$);\n#3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
                #4=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#5));\n";
    let cases = [
        // A placement that is its own parent.
        "#2=IFCLOCALPLACEMENT(#2,$);\n#5=IFCTRIANGULATEDFACESET(#6,$,$,((1,2,3)),$);\n#6=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));",
        // A mapped item that maps itself.
        "#2=IFCLOCALPLACEMENT($,$);\n#5=IFCMAPPEDITEM(#6,$);\n#6=IFCREPRESENTATIONMAP(#7,#4);\n#7=IFCAXIS2PLACEMENT3D(#8,$,$);\n#8=IFCCARTESIANPOINT((0.,0.,0.));",
        // Indices past the end of the coordinate list, and index zero.
        "#2=IFCLOCALPLACEMENT($,$);\n#5=IFCTRIANGULATEDFACESET(#6,$,$,((1,2,9),(0,1,2),(-1,1,2)),$);\n#6=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));",
        // Coordinates at the limit of f64.
        "#2=IFCLOCALPLACEMENT($,$);\n#5=IFCTRIANGULATEDFACESET(#6,$,$,((1,2,3)),$);\n#6=IFCCARTESIANPOINTLIST3D(((1.E308,0.,0.),(-1.E308,1.E308,0.),(1.E308,-1.E308,1.E308)));",
        // A zero-depth extrusion of a degenerate profile with a zero direction.
        "#2=IFCLOCALPLACEMENT($,$);\n#5=IFCEXTRUDEDAREASOLID(#6,$,#7,0.);\n#6=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.,0.);\n#7=IFCDIRECTION((0.,0.,0.));",
        // A face with repeated and collinear points.
        "#2=IFCLOCALPLACEMENT($,$);\n#5=IFCFACETEDBREP(#6);\n#6=IFCCLOSEDSHELL((#7));\n#7=IFCFACE((#8));\n#8=IFCFACEOUTERBOUND(#9,.T.);\n#9=IFCPOLYLOOP((#10,#10,#11,#10));\n#10=IFCCARTESIANPOINT((0.,0.,0.));\n#11=IFCCARTESIANPOINT((1.,0.,0.));",
    ];
    for case in cases {
        let text = format!("{header}{wall}{case}\nENDSEC;END-ISO-10303-21;");
        let file = index(text.as_bytes()).unwrap();
        let mut evaluator = ModelEvaluator::new(&file).unwrap();
        for id in evaluator.element_ids() {
            let _ = evaluator.evaluate(id);
        }
    }
}

/// Thirty levels of maps that each map the next twice: 2^30 expansions from 90 entities.
#[test]
fn shared_maps_do_not_multiply_the_work() {
    let mut body = String::from(
        "#1=IFCWALL('a',$,$,$,$,#2,#3,$,$);\n#2=IFCLOCALPLACEMENT($,$);\n\
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#10));\n#7=IFCAXIS2PLACEMENT3D(#8,$,$);\n\
         #8=IFCCARTESIANPOINT((0.,0.,0.));\n",
    );
    for level in 0..30u32 {
        let (representation, map) = (10 + level * 4, 11 + level * 4);
        let (first, second) = (12 + level * 4, 13 + level * 4);
        let next = representation + 4;
        body.push_str(&format!(
            "#{representation}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{first},#{second}));\n\
             #{first}=IFCMAPPEDITEM(#{map},$);\n#{second}=IFCMAPPEDITEM(#{map},$);\n\
             #{map}=IFCREPRESENTATIONMAP(#7,#{next});\n"
        ));
    }
    body.push_str(
        "#130=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#131));\n\
         #131=IFCTRIANGULATEDFACESET(#132,$,$,((1,2,3)),$);\n\
         #132=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));\n",
    );
    let text =
        format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{body}ENDSEC;END-ISO-10303-21;");
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(1).unwrap();
    assert!(element.degraded);
    assert!(evaluator.diagnostics().iter().any(|item| item.code == "too-many-items"));
}

/// Coverage over every real file. Never panics, and reports what is not evaluated yet.
#[test]
fn every_file_evaluates_without_panicking() {
    let mut files: Vec<PathBuf> = Vec::new();
    for folder in ["public/samples", "test/fixtures"] {
        for entry in fs::read_dir(root().join(folder)).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "ifc") {
                files.push(path);
            }
        }
    }
    files.sort();

    let (mut total_elements, mut total_with_geometry) = (0, 0);
    for path in files {
        let bytes = fs::read(&path).unwrap();
        let file = index(&bytes).unwrap();
        let mut evaluator = ModelEvaluator::new(&file).unwrap();
        let ids = evaluator.element_ids();
        let (mut with_geometry, mut triangles, mut closed) = (0, 0, 0);
        let mut meshes: Vec<Mesh> = Vec::new();
        for id in &ids {
            let element = evaluator.evaluate(*id).unwrap();
            if !element.meshes.is_empty() {
                with_geometry += 1;
            }
            for part in element.meshes {
                triangles += part.mesh.triangles.len();
                if part.mesh.open_edges() == 0 {
                    closed += 1;
                }
                assert!(
                    part.mesh.positions.iter().all(|p| p.is_finite()),
                    "{}: non-finite vertex",
                    path.display()
                );
                meshes.push(part.mesh);
            }
        }
        let mut issues: HashMap<&str, usize> = HashMap::new();
        for diagnostic in evaluator.diagnostics() {
            *issues.entry(diagnostic.code).or_default() += 1;
        }
        let mut issues: Vec<_> = issues.into_iter().collect();
        issues.sort();
        println!(
            "{:<34} {:>3}/{:<3} elements, {:>6} tris, {:>3}/{:<3} closed, {issues:?}",
            path.file_name().unwrap().to_string_lossy(),
            with_geometry,
            ids.len(),
            triangles,
            closed,
            meshes.len()
        );
        total_elements += ids.len();
        total_with_geometry += with_geometry;
    }
    println!("TOTAL {total_with_geometry}/{total_elements} elements with geometry");
    assert!(total_with_geometry > 0);
}
