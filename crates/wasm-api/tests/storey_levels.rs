//! Storey `level`: the height of the storey's own placement in model coordinates, which the
//! plan's default projection depth stops at. Expected values come from the fixture's generator
//! script or from summing the placements written below by hand, never from this code.

use std::fs;
use std::path::Path;
use wasm_api::loaded::LoadedModel;

/// (name, elevation, level) of every storey in a spatial tree's JSON, in document order.
fn storeys(json: &str) -> Vec<(String, Option<f64>, Option<f64>)> {
    let number = |object: &str, key: &str| -> Option<f64> {
        let at = object.find(&format!("\"{key}\":"))? + key.len() + 3;
        let end = object[at..].find([',', '}']).map(|end| at + end)?;
        object[at..end].parse().ok()
    };
    json.match_indices("\"type\":\"IfcBuildingStorey\"")
        .map(|(at, _)| {
            // The node's own fields come before its children.
            let rest = &json[at..];
            let own = &rest[..rest.find("\"children\"").unwrap_or(rest.len())];
            let name = own
                .split("\"name\":\"")
                .nth(1)
                .and_then(|tail| tail.split('"').next())
                .unwrap_or_default()
                .to_string();
            (name, number(own, "elevation"), number(own, "level"))
        })
        .collect()
}

#[test]
fn levels_of_the_authored_two_storey_building() {
    // building-booleans.py: storey 1 at z = 0, storey 2 at STOREY_2_ELEV = 3.20 m.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/authored/building-booleans.ifc");
    let mut model = LoadedModel::open(fs::read(path).unwrap()).unwrap();
    let tree = model.spatial_tree_json().unwrap();
    let mut levels: Vec<f64> = storeys(&tree).iter().map(|s| s.2.expect("a level")).collect();
    levels.sort_by(f64::total_cmp);
    assert_eq!(levels.len(), 2, "{tree}");
    assert!((levels[0] - 0.0).abs() < 1e-9 && (levels[1] - 3.2).abs() < 1e-9, "{levels:?}");
}

#[test]
fn a_level_follows_the_placement_chain_not_the_elevation_attribute() {
    // Millimetres. Site 100 mm up; building 14,300 mm above the site and turned 90 degrees
    // about Z; storey A 3,000 mm above the building with Elevation 3000 (relative, as IFC
    // defines it); storey B 6,000 mm above with no Elevation.
    // Levels, summed by hand: A = 0.1 + 14.3 + 3.0 = 17.4 m, B = 0.1 + 14.3 + 6.0 = 20.4 m.
    let text = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n\
        #1=IFCPROJECT('p',$,$,$,$,$,$,$,#3);\n\
        #3=IFCUNITASSIGNMENT((#4));\n\
        #4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n\
        #20=IFCSITE('s',$,$,$,$,#21,$,$,.ELEMENT.,$,$,$,$,$);\n\
        #21=IFCLOCALPLACEMENT($,#22);\n\
        #22=IFCAXIS2PLACEMENT3D(#23,$,$);\n\
        #23=IFCCARTESIANPOINT((0.,0.,100.));\n\
        #30=IFCBUILDING('b',$,$,$,$,#31,$,$,.ELEMENT.,$,$,$);\n\
        #31=IFCLOCALPLACEMENT(#21,#32);\n\
        #32=IFCAXIS2PLACEMENT3D(#33,#34,#35);\n\
        #33=IFCCARTESIANPOINT((500.,0.,14300.));\n\
        #34=IFCDIRECTION((0.,0.,1.));\n\
        #35=IFCDIRECTION((0.,1.,0.));\n\
        #40=IFCBUILDINGSTOREY('a',$,'A',$,$,#41,$,$,.ELEMENT.,3000.);\n\
        #41=IFCLOCALPLACEMENT(#31,#42);\n\
        #42=IFCAXIS2PLACEMENT3D(#43,$,$);\n\
        #43=IFCCARTESIANPOINT((0.,0.,3000.));\n\
        #50=IFCBUILDINGSTOREY('c',$,'B',$,$,#51,$,$,.ELEMENT.,$);\n\
        #51=IFCLOCALPLACEMENT(#31,#52);\n\
        #52=IFCAXIS2PLACEMENT3D(#53,$,$);\n\
        #53=IFCCARTESIANPOINT((0.,0.,6000.));\n\
        #60=IFCRELAGGREGATES('r1',$,$,$,#1,(#20));\n\
        #61=IFCRELAGGREGATES('r2',$,$,$,#20,(#30));\n\
        #62=IFCRELAGGREGATES('r3',$,$,$,#30,(#40,#50));\n\
        ENDSEC;END-ISO-10303-21;";
    let mut model = LoadedModel::open(text.as_bytes().to_vec()).unwrap();
    let tree = model.spatial_tree_json().unwrap();
    let found = storeys(&tree);
    let get = |name: &str| found.iter().find(|s| s.0 == name).unwrap_or_else(|| panic!("{name} in {tree}"));
    let (_, elevation_a, level_a) = get("A");
    let (_, elevation_b, level_b) = get("B");
    assert!((elevation_a.unwrap() - 3.0).abs() < 1e-12, "{tree}");
    assert!((level_a.unwrap() - 17.4).abs() < 1e-9, "{tree}");
    assert_eq!(*elevation_b, None, "{tree}");
    assert!((level_b.unwrap() - 20.4).abs() < 1e-9, "{tree}");
}
