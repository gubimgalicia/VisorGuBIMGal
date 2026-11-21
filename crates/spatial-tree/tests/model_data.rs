//! Spatial data checked against facts read from the fixtures by hand.

use spatial_tree::{AttributeValue, ModelData, PropertyValue, SpatialNode};
use std::fs;
use std::path::{Path, PathBuf};
use step_parser::index;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: &str) -> Vec<u8> {
    fs::read(root().join(path)).unwrap()
}

fn transform(matrix: &[f64; 16], point: [f64; 3]) -> [f64; 3] {
    let [x, y, z] = point;
    [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ]
}

#[test]
fn simple_wall_has_the_expected_hierarchy() {
    let bytes = read("public/samples/SimpleWall.ifc");
    let file = index(&bytes).unwrap();
    let data = ModelData::open(&file).unwrap();
    let tree = data.spatial_tree().unwrap();

    assert_eq!(tree.root.express_id, 121);
    assert_eq!(tree.root.type_name, "IfcProject");
    let site = &tree.root.children[0];
    assert_eq!((site.express_id, site.type_name.as_str()), (150, "IfcSite"));
    let building = &site.children[0];
    assert_eq!(building.express_id, 131);
    let storey = &building.children[0];
    assert_eq!(storey.express_id, 140);
    assert_eq!(storey.name.as_deref(), Some("Level 1"));
    assert_eq!(storey.elevation, Some(0.0));
    let elements: Vec<u32> = storey.elements.iter().map(|element| element.express_id).collect();
    assert_eq!(elements, [219, 572], "ascending, without the opening");
    assert!(tree.unassigned.is_empty());
}

#[test]
fn simple_wall_summary() {
    let bytes = read("public/samples/SimpleWall.ifc");
    let file = index(&bytes).unwrap();
    let summary = ModelData::open(&file).unwrap().summary();
    assert_eq!(summary.schema, "IFC2X3");
    assert_eq!(summary.entity_count, 548);
    assert_eq!(summary.element_count, 2);
    assert_eq!(summary.length_unit_scale, 0.001);
    assert!(summary.length_declared);
    let site = &summary.coordinate_reference;
    assert_eq!(site.source, "ifc-site");
    assert_eq!(site.confidence, "unknown");
    let [lat, lng] = site.lat_lng.unwrap();
    assert!((lat - (42.0 + 21.0 / 60.0 + 31.181945 / 3600.0)).abs() < 1e-9);
    assert!((lng - -(71.0 + 3.0 / 60.0 + 24.263305 / 3600.0)).abs() < 1e-9);
}

#[test]
fn wall_details_carry_names_properties_quantities_and_materials() {
    let bytes = read("public/samples/SimpleWall.ifc");
    let file = index(&bytes).unwrap();
    let data = ModelData::open(&file).unwrap();
    let wall = data.element_details(219).unwrap();

    assert_eq!(wall.type_name, "IfcWallStandardCase");
    assert_eq!(wall.name.as_deref(), Some("Basic Wall:Bearing Wall:346660"));
    assert_eq!(wall.global_id.as_deref(), Some("1F6umJ5H50aeL3A1As_wTm"));
    let tag = wall.attributes.iter().find(|(name, _)| name == "Tag").unwrap();
    assert_eq!(tag.1, AttributeValue::Text("346660".to_string()));

    let mut names: Vec<&str> = wall.property_sets.iter().map(|set| set.name.as_str()).collect();
    println!("{} sets: {names:?}", names.len());
    assert!(names.len() >= 14, "the wall's own 14 sets are all kept");
    let total = names.len();
    names.sort_unstable();
    names.dedup();
    // A type's set never repeats a name; only the element's own sets may.
    assert!(total - names.len() <= 1, "{names:?}");
    let quantities = wall
        .property_sets
        .iter()
        .find(|set| set.properties.iter().any(|item| item.is_quantity))
        .unwrap();
    let height = quantities.properties.iter().find(|item| item.name == "Height").unwrap();
    assert_eq!(height.value, PropertyValue::Single(AttributeValue::Number(4000.0)));
    assert_eq!(height.unit.as_deref(), Some("mm"), "raw value in the project unit");

    let common = wall.property_sets.iter().find(|set| set.name == "Pset_WallCommon").unwrap();
    assert!(!common.properties.is_empty());

    let [material] = wall.materials.as_slice() else {
        panic!("{:?}", wall.materials)
    };
    assert_eq!(material.kind, "layer-set");
    assert!(material.from_instance);
    assert_eq!(material.layers[0].material.as_deref(), Some("Default Wall"));
    assert_eq!(material.layers[0].thickness, Some(0.2));
    assert!(wall.type_object.is_some());
}

#[test]
fn galicia_fixture_georeferences_to_utm_29n() {
    let bytes = read("test/fixtures/georef-galicia-utm29n.ifc");
    let file = index(&bytes).unwrap();
    let reference = ModelData::open(&file).unwrap().summary().coordinate_reference;

    assert_eq!(reference.source, "ifc-map-conversion");
    assert_eq!(reference.crs_id.as_deref(), Some("EPSG:25829"));
    assert_eq!(reference.confidence, "verified");
    assert_eq!(reference.map_zone.as_deref(), Some("29N"));

    let matrix = reference.local_to_map.unwrap();
    let origin = transform(&matrix, [0.0, 0.0, 0.0]);
    assert_eq!(origin, [536000.0, 4747000.0, 260.0]);
    let [lat, lng] = reference.lat_lng.unwrap();
    assert!((lat - (42.0 + 52.0 / 60.0 + 50.0 / 3600.0)).abs() < 1e-9);
    // The file writes (-8, 32, 40, 0), and Santiago is at 8.54 degrees west, not 7.46.
    assert!((lng - -(8.0 + 32.0 / 60.0 + 40.0 / 3600.0)).abs() < 1e-9, "{lng}");
}

#[test]
fn rotation_and_absent_scale_follow_the_contract() {
    let bytes = read("test/fixtures/geographic-referencing.ifc");
    let file = index(&bytes).unwrap();
    let summary = ModelData::open(&file).unwrap().summary();
    let reference = &summary.coordinate_reference;
    assert_eq!(reference.crs_id.as_deref(), Some("EPSG:25832"));
    assert!(summary.diagnostics.iter().any(|item| item.code == "map-scale-from-units"));

    let matrix = reference.local_to_map.unwrap();
    assert_eq!(transform(&matrix, [0.0, 0.0, 0.0]), [458658.78, 5438232.79, 113.7]);

    // A metre along model X moves along (XAxisAbscissa, XAxisOrdinate), and stays a metre.
    let moved = transform(&matrix, [1.0, 0.0, 0.0]);
    let (dx, dy) = (moved[0] - 458658.78, moved[1] - 5438232.79);
    let length = (0.270600445976_f64.powi(2) + 0.962691746426_f64.powi(2)).sqrt();
    assert!((dx - 0.270600445976 / length).abs() < 1e-6, "{dx}");
    assert!((dy - 0.962691746426 / length).abs() < 1e-6, "{dy}");
    assert!((dx.hypot(dy) - 1.0).abs() < 1e-6);
}

fn count_elements(node: &SpatialNode) -> usize {
    node.elements.len() + node.children.iter().map(count_elements).sum::<usize>()
}

#[test]
fn every_file_yields_summary_tree_and_details() {
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
    for path in files {
        let bytes = fs::read(&path).unwrap();
        let file = index(&bytes).unwrap();
        let data = ModelData::open(&file).unwrap();
        let summary = data.summary();
        let tree = data.spatial_tree().expect("every fixture has an IfcProject");
        let placed = count_elements(&tree.root);
        for id in file.ids() {
            let _ = data.element_details(id);
        }
        println!(
            "{:<34} {:<7} {:>4} elements, {:>3} placed, {:>2} unassigned, {} {:?}",
            path.file_name().unwrap().to_string_lossy(),
            summary.schema,
            summary.element_count,
            placed,
            tree.unassigned.len(),
            summary.coordinate_reference.source,
            summary.coordinate_reference.crs_id,
        );
    }
}

/// Forty levels where each entity links twice to the next: 2^40 paths from 80 entities.
#[test]
fn shared_links_do_not_multiply_the_work() {
    let mut body = String::from("#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n");
    for level in 0..40u32 {
        let (from, a, b) = (2 + level * 2, 4 + level * 2, 5 + level * 2);
        body.push_str(&format!("#{from}=IFCWALL('a',$,$,$,$,$,$,$,$);\n"));
        body.push_str(&format!("#{}=IFCWALL('b',$,$,$,$,$,$,$,$);\n", from + 1));
        body.push_str(&format!("#{}=IFCRELAGGREGATES('x',$,$,$,#{from},(#{a},#{b}));\n", 1000 + level * 2));
        body.push_str(&format!("#{}=IFCRELAGGREGATES('y',$,$,$,#{},(#{a},#{b}));\n", 1001 + level * 2, from + 1));
        body.push_str(&format!(
            "#{}=IFCCOMPLEXPROPERTY('c',$,'u',(#{},#{}));\n",
            3000 + level,
            3001 + level,
            3001 + level
        ));
    }
    body.push_str("#900=IFCRELAGGREGATES('r',$,$,$,#1,(#2));\n");
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let data = ModelData::open(&file).unwrap();
    assert!(data.spatial_tree().is_some());
    let _ = data.summary();
}

#[test]
fn cyclic_hierarchy_does_not_hang_or_crash() {
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
        #2=IFCSITE('s',$,$,$,$,$,$,$,.ELEMENT.,$,$,$,$,$);\n\
        #3=IFCRELAGGREGATES('a',$,$,$,#1,(#2));\n\
        #4=IFCRELAGGREGATES('b',$,$,$,#2,(#1,#2));\n\
        #5=IFCCOMPLEXPROPERTY('c',$,'u',(#5));\n\
        ENDSEC;END-ISO-10303-21;";
    let file = index(text.as_bytes()).unwrap();
    let data = ModelData::open(&file).unwrap();
    let tree = data.spatial_tree().unwrap();
    assert_eq!(tree.root.express_id, 1);
    let _ = data.element_details(5);
}

/// A wasm stack is far smaller than a native one, so these chains must not recurse with length.
#[test]
fn chains_as_long_as_the_file_do_not_exhaust_the_stack() {
    const LENGTH: u32 = 200_000;
    let mut body = String::from(
        "#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         #2=IFCBUILDINGSTOREY('s',$,$,$,$,$,$,$,.ELEMENT.,0.);\n\
         #3=IFCRELAGGREGATES('a',$,$,$,#1,(#2));\n\
         #4=IFCWALL('w',$,$,$,$,$,$,$);\n\
         #5=IFCRELCONTAINEDINSPATIALSTRUCTURE('c',$,$,$,(#4),#2);\n\
         #6=IFCPROPERTYSET('g',$,'Pset',$,(#1000000));\n\
         #7=IFCRELDEFINESBYPROPERTIES('r',$,$,$,(#4),#6);\n",
    );
    for level in 0..LENGTH {
        let (part, relation, property) = (100_000 + level, 400_000 + level, 1_000_000 + level);
        let parent = if level == 0 { 4 } else { part - 1 };
        body.push_str(&format!("#{part}=IFCWALL('w',$,$,$,$,$,$,$);\n"));
        body.push_str(&format!("#{relation}=IFCRELAGGREGATES('a',$,$,$,#{parent},(#{part}));\n"));
        body.push_str(&format!("#{property}=IFCCOMPLEXPROPERTY('c',$,'u',(#{}));\n", property + 1));
    }
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let data = ModelData::open(&file).unwrap();

    // The stack a wasm build gets.
    let handle = std::thread::Builder::new().stack_size(1024 * 1024);
    std::thread::scope(|scope| {
        handle
            .spawn_scoped(scope, || {
                let tree = data.spatial_tree().unwrap();
                assert_eq!(tree.root.children[0].elements.len(), LENGTH as usize + 1);
                let wall = data.element_details(4).unwrap();
                assert_eq!(wall.property_sets[0].name, "Pset");
            })
            .unwrap()
            .join()
            .unwrap();
    });
}


/// A wall with one property per unit label, so each label is checked character by character.
const UNIT_LABELS: &str = "ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0',$,'p',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3,#4,#5));
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#5=IFCSIUNIT(*,.VOLUMEUNIT.,.MILLI.,.CUBIC_METRE.);
#6=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.DEGREE_CELSIUS.);
#7=IFCSIUNIT(*,.LENGTHUNIT.,.MICRO.,.METRE.);
#8=IFCSIUNIT(*,.PRESSUREUNIT.,.MEGA.,.PASCAL.);
#10=IFCWALL('1',$,'w',$,$,$,$,$,$);
#11=IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(1.5),$);
#12=IFCPROPERTYSINGLEVALUE('Volume',$,IFCVOLUMEMEASURE(1.5),$);
#13=IFCPROPERTYSINGLEVALUE('Temperature',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(20.),#6);
#14=IFCPROPERTYSINGLEVALUE('Roughness',$,IFCLENGTHMEASURE(3.),#7);
#15=IFCPROPERTYSINGLEVALUE('Strength',$,IFCPRESSUREMEASURE(30.),#8);
#16=IFCPROPERTYSET('2',$,'P',$,(#11,#12,#13,#14,#15));
#17=IFCRELDEFINESBYPROPERTIES('3',$,$,$,(#10),#16);
ENDSEC;
END-ISO-10303-21;
";

#[test]
fn unit_labels_are_written_as_their_symbols() {
    let file = index(UNIT_LABELS.as_bytes()).unwrap();
    let data = ModelData::open(&file).unwrap();
    let details = data.element_details(10).unwrap();
    let unit = |name: &str| {
        let items = details.property_sets.iter().flat_map(|set| &set.properties);
        let item = items.into_iter().find(|item| item.name == name).unwrap();
        item.unit.clone().unwrap()
    };
    assert_eq!(unit("Area"), "m\u{b2}");
    // SI writes a prefix on the unit before its power: mm3 is (mm)3, not a thousandth of m3.
    assert_eq!(unit("Volume"), "mm\u{b3}");
    assert_eq!(unit("Temperature"), "\u{b0}C");
    assert_eq!(unit("Roughness"), "\u{b5}m");
    assert_eq!(unit("Strength"), "MPa");
}

/// A project with a map conversion, for the cases no fixture holds. `length` and `map_unit` are
/// `IFCSIUNIT` prefixes; `conversion` is everything after the two CRS references.
fn map_file(length: &str, map_unit: &str, conversion: &str, true_north: &str) -> String {
    format!(
        "ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4X3_ADD2'));ENDSEC;
DATA;
#1=IFCPROJECT('0',$,'p',$,$,$,$,(#4),#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.LENGTHUNIT.,{length},.METRE.);
#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,{true_north});
#5=IFCAXIS2PLACEMENT3D(#6,$,$);
#6=IFCCARTESIANPOINT((0.,0.,0.));
#7=IFCDIRECTION((1.,0.));
#8=IFCDIRECTION((-1.,0.));
#9=IFCDIRECTION((0.,0.));
#10=IFCPROJECTEDCRS('EPSG:25829',$,$,$,$,$,#11);
#11=IFCSIUNIT(*,.LENGTHUNIT.,{map_unit},.METRE.);
#12={conversion};
ENDSEC;
END-ISO-10303-21;
"
    )
}

fn summary_of(text: &str) -> spatial_tree::ModelSummary {
    let file = index(text.as_bytes()).unwrap();
    ModelData::open(&file).unwrap().summary()
}

fn codes(summary: &spatial_tree::ModelSummary) -> Vec<&'static str> {
    summary.diagnostics.iter().map(|item| item.code).collect()
}

#[test]
fn a_missing_scale_is_harmless_only_when_the_units_agree() {
    let same = "IFCMAPCONVERSION(#4,#10,10.,20.,30.,$,$,$)";
    let summary = summary_of(&map_file("$", "$", same, "$"));
    assert_eq!(codes(&summary), ["map-scale-default"]);
    let matrix = summary.coordinate_reference.local_to_map.unwrap();
    assert_eq!(transform(&matrix, [1.0, 0.0, 0.0]), [11.0, 20.0, 30.0]);

    // A file in millimetres with a map in metres: the literal default of 1 would put one model
    // metre at 1000 map metres.
    let summary = summary_of(&map_file(".MILLI.", "$", same, "$"));
    assert_eq!(codes(&summary), ["map-scale-from-units"]);
    let matrix = summary.coordinate_reference.local_to_map.unwrap();
    assert_eq!(transform(&matrix, [1.0, 0.0, 0.0]), [11.0, 20.0, 30.0]);
}

#[test]
fn an_incomplete_rotation_is_reported_and_ignored() {
    for conversion in [
        "IFCMAPCONVERSION(#4,#10,0.,0.,0.,1.,$,1.)",
        "IFCMAPCONVERSION(#4,#10,0.,0.,0.,$,1.,1.)",
        "IFCMAPCONVERSION(#4,#10,0.,0.,0.,0.,0.,1.)",
    ] {
        let summary = summary_of(&map_file("$", "$", conversion, "$"));
        assert_eq!(codes(&summary), ["map-rotation-invalid"], "{conversion}");
        let matrix = summary.coordinate_reference.local_to_map.unwrap();
        assert_eq!(transform(&matrix, [1.0, 2.0, 0.0]), [1.0, 2.0, 0.0], "{conversion}");
    }

    let absent = "IFCMAPCONVERSION(#4,#10,0.,0.,0.,$,$,1.)";
    assert!(codes(&summary_of(&map_file("$", "$", absent, "$"))).is_empty());
}

#[test]
fn a_conversion_that_would_mirror_or_collapse_gives_no_transform() {
    for conversion in [
        "IFCMAPCONVERSION(#4,#10,0.,0.,0.,1.,0.,0.)",
        "IFCMAPCONVERSION(#4,#10,0.,0.,0.,1.,0.,-1.)",
        "IFCMAPCONVERSIONSCALED(#4,#10,0.,0.,0.,1.,0.,1.,-1.,1.,1.)",
        "IFCMAPCONVERSIONSCALED(#4,#10,0.,0.,0.,1.,0.,1.,1.,0.,1.)",
    ] {
        let summary = summary_of(&map_file("$", "$", conversion, "$"));
        assert_eq!(codes(&summary), ["map-conversion-invalid"], "{conversion}");
        assert!(summary.coordinate_reference.local_to_map.is_none(), "{conversion}");
        assert_eq!(summary.coordinate_reference.source, "unknown", "{conversion}");
    }
}

#[test]
fn true_north_is_an_angle_from_project_y_and_never_moves_the_map() {
    let conversion = "IFCMAPCONVERSION(#4,#10,0.,0.,0.,1.,0.,1.)";
    let north = |direction: &str| {
        summary_of(&map_file("$", "$", conversion, direction)).coordinate_reference
    };
    assert_eq!(north("$").true_north, None);
    // North along +X is 90 degrees clockwise from +Y, and along -X counter-clockwise.
    assert_eq!(north("#7").true_north, Some(-90.0));
    assert_eq!(north("#8").true_north, Some(90.0));
    assert_eq!(north("#9").true_north, None, "a zero vector has no direction");
    assert_eq!(north("#7").local_to_map, north("$").local_to_map);
}

/// `(angle in degrees, spacing and offset in metres)` of each row, rounded to a micrometre.
fn hatching(path: &str, id: u32) -> Vec<(f64, f64, f64)> {
    let bytes = read(path);
    let file = index(&bytes).unwrap();
    let data = ModelData::open(&file).unwrap();
    let round = |value: f64| (value * 1e6).round() / 1e6;
    data.layer_hatching(id)
        .iter()
        .map(|row| (round(row.angle_degrees), round(row.spacing), round(row.offset)))
        .collect()
}

#[test]
fn hatching_comes_from_the_material_that_names_the_layer() {
    let file = "test/fixtures/hatching-materials.ifc";
    // In millimetres and degrees. The level row starts 100 mm up; the upright row's vector is
    // 707.1 mm at 45 degrees to it. The dashed row and the copy of the level one are left out.
    let concrete = [(0.0, 0.25, 0.1), (90.0, 0.5, 0.0)];
    assert_eq!(hatching(file, 100), concrete, "both rows, in their order");
    assert_eq!(hatching(file, 110), [(45.0, 0.1, 0.0)], "a layer set: its first layer only");
    assert_eq!(hatching(file, 120), [(30.0, 0.15, 0.0)], "from the type");
    assert_eq!(hatching(file, 130), concrete, "its own before its type's");
    assert!(hatching(file, 140).is_empty(), "measured on paper");
    assert_eq!(hatching(file, 150), [(0.0, 0.0, 0.0)], "a vector along the lines spaces nothing");
    assert!(hatching(file, 160).is_empty(), "a surface style is no hatch");
    assert!(hatching(file, 100000).is_empty(), "no such element");
}

#[test]
fn hatching_reads_ifc2x3_repeat_factors_in_radians() {
    // 30 degrees, and a 0.3 m vector straight up: 0.3 cos 30 across the lines.
    let rows = hatching("test/fixtures/hatching-materials-ifc2x3.ifc", 100);
    assert_eq!(rows, [(30.0, 0.259808, 0.0)], "{rows:?}");
}

#[test]
fn a_row_runs_through_its_start_point_and_only_solid_rows_are_drawn() {
    // No units, so radians. #11 has only the older reference point, 3 m along X and 4 m along
    // Y: at 90 degrees the lines run along Y, so it lies 3 m to their right, at -3 across. #12
    // has both, and its pattern start, 1 m up, holds. #13 to #15 are drawn dashed: by a pattern
    // that calls itself continuous, a predefined name and an external font. #16 says continuous
    // in capitals.
    let rest = "#10=IFCFILLAREASTYLE($,(#11,#12,#13,#14,#15,#16),$);\n\
                #11=IFCFILLAREASTYLEHATCHING($,IFCPOSITIVELENGTHMEASURE(2.),#20,$,1.5707963267948966);\n\
                #12=IFCFILLAREASTYLEHATCHING($,IFCPOSITIVELENGTHMEASURE(2.),#20,#21,0.);\n\
                #13=IFCFILLAREASTYLEHATCHING(#30,IFCPOSITIVELENGTHMEASURE(3.),$,$,0.);\n\
                #14=IFCFILLAREASTYLEHATCHING(#31,IFCPOSITIVELENGTHMEASURE(3.),$,$,0.);\n\
                #15=IFCFILLAREASTYLEHATCHING(#32,IFCPOSITIVELENGTHMEASURE(3.),$,$,0.);\n\
                #16=IFCFILLAREASTYLEHATCHING(#33,IFCPOSITIVELENGTHMEASURE(4.),$,$,0.);\n\
                #20=IFCCARTESIANPOINT((3.,4.));\n\
                #21=IFCCARTESIANPOINT((0.,1.));\n\
                #30=IFCCURVESTYLE($,#40,$,$,$);\n\
                #31=IFCCURVESTYLE($,#41,$,$,$);\n\
                #32=IFCCURVESTYLE($,#42,$,$,$);\n\
                #33=IFCCURVESTYLE($,#43,$,$,$);\n\
                #40=IFCCURVESTYLEFONT('continuous',(#44));\n\
                #41=IFCDRAUGHTINGPREDEFINEDCURVEFONT('dashed');\n\
                #42=IFCEXTERNALLYDEFINEDCURVEFONT($,'dash',$);\n\
                #43=IFCDRAUGHTINGPREDEFINEDCURVEFONT('CONTINUOUS');\n\
                #44=IFCCURVESTYLEFONTPATTERN(1.,1.);\n";
    let rows: Vec<(f64, f64, f64)> = hatching_in("IFC4", &styled_wall(1, "#10", rest), 1)
        .iter()
        .map(|row| (row.angle_degrees, row.spacing, row.offset))
        .collect();
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert!((rows[0].0 - 90.0).abs() < 1e-12 && (rows[0].2 + 3.0).abs() < 1e-12, "{rows:?}");
    assert_eq!(rows[1], (0.0, 2.0, 1.0));
    assert_eq!(rows[2], (0.0, 4.0, 0.0));
}

/// Wall `#wall` with material `#wall + 1`, whose styled item has `styles`; `rest` adds entities.
fn styled_wall(wall: u32, styles: &str, rest: &str) -> String {
    let (material, relation, definition, representation, item) =
        (wall + 1, wall + 2, wall + 3, wall + 4, wall + 5);
    format!(
        "#{wall}=IFCWALL('w',$,$,$,$,$,$,$,$);\n\
         #{material}=IFCMATERIAL('m',$,$);\n\
         #{relation}=IFCRELASSOCIATESMATERIAL('r',$,$,$,(#{wall}),#{material});\n\
         #{definition}=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#{representation}),#{material});\n\
         #{representation}=IFCSTYLEDREPRESENTATION($,$,$,(#{item}));\n\
         #{item}=IFCSTYLEDITEM($,({styles}),$);\n{rest}"
    )
}

fn hatching_in(schema: &str, body: &str, id: u32) -> Vec<spatial_tree::Hatching> {
    let text =
        format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{body}ENDSEC;END-ISO-10303-21;");
    let file = index(text.as_bytes()).unwrap();
    ModelData::open(&file).unwrap().layer_hatching(id)
}

#[test]
fn a_hatch_the_file_spoils_is_kept_as_nan_and_a_hostile_one_ends() {
    // Wall 1: #20 lists itself and #21 beside it, which #6 also lists; #30 has no angle and #31
    // a zero direction. Each row is read once.
    let mut body = styled_wall(
        1,
        "#20,#21",
        "#20=IFCPRESENTATIONSTYLEASSIGNMENT((#20,#21));\n\
         #21=IFCFILLAREASTYLE($,(#30,#31,#32),$);\n\
         #30=IFCFILLAREASTYLEHATCHING($,IFCPOSITIVELENGTHMEASURE(1.),$,$,$);\n\
         #31=IFCFILLAREASTYLEHATCHING($,#50,$,$,0.);\n\
         #32=IFCFILLAREASTYLEHATCHING($,IFCPOSITIVELENGTHMEASURE(2.),$,$,0.);\n\
         #50=IFCVECTOR(#51,1.);\n\
         #51=IFCDIRECTION((0.,0.));\n",
    );
    // Wall 100: eleven different rows, past the limit of eight.
    let rows: Vec<String> = (200..211).map(|id| format!("#{id}")).collect();
    body += &styled_wall(100, "#199", &format!("#199=IFCFILLAREASTYLE($,({}),$);\n", rows.join(",")));
    for id in 200..211 {
        let spacing = id - 199;
        body += &format!(
            "#{id}=IFCFILLAREASTYLEHATCHING($,IFCPOSITIVELENGTHMEASURE({spacing}.),$,$,0.);\n"
        );
    }
    // Wall 300: a hundred style assignments, each inside the next, before the fill.
    body += &styled_wall(300, "#400", "#500=IFCFILLAREASTYLE($,(#200),$);\n");
    for id in 400..500 {
        body += &format!("#{id}=IFCPRESENTATIONSTYLEASSIGNMENT((#{}));\n", id + 1);
    }
    // Wall 600: a layer set usage that is its own layer set.
    body += "#600=IFCWALL('w',$,$,$,$,$,$,$,$);\n\
             #601=IFCMATERIALLAYERSETUSAGE(#601,.AXIS2.,.POSITIVE.,0.,$);\n\
             #602=IFCRELASSOCIATESMATERIAL('r',$,$,$,(#600),#601);\n";

    let cycle = hatching_in("IFC4", &body, 1);
    assert_eq!(cycle.len(), 3, "{cycle:?}");
    assert!(cycle[0].angle_degrees.is_nan() && cycle[0].spacing == 1.0, "{:?}", cycle[0]);
    assert!(cycle[1].angle_degrees == 0.0 && cycle[1].spacing.is_nan(), "{:?}", cycle[1]);
    assert_eq!((cycle[2].angle_degrees, cycle[2].spacing), (0.0, 2.0));
    assert_eq!(hatching_in("IFC4", &body, 100).len(), 8);
    assert!(hatching_in("IFC4", &body, 300).is_empty(), "too deep to be a real style");
    assert!(hatching_in("IFC4", &body, 600).is_empty());
}

#[test]
fn the_paper_flag_holds_in_ifc4x3_too() {
    let paper = |flag: &str| {
        let rest = format!(
            "#10=IFCFILLAREASTYLE($,(#11),{flag});\n\
             #11=IFCFILLAREASTYLEHATCHING($,IFCPOSITIVELENGTHMEASURE(2.),$,$,0.);\n"
        );
        hatching_in("IFC4X3_ADD2", &styled_wall(1, "#10", &rest), 1).len()
    };
    assert_eq!((paper(".T."), paper("$"), paper(".F.")), (1, 1, 0));
}
