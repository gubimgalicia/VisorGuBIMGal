//! `elementSnapshotsJson`: the input of the model comparison, one snapshot per drawn product.
//! Expected values come from `public/samples/SimpleWall.ifc` read by hand below.

use std::fs;
use std::path::Path;
use wasm_api::loaded::LoadedModel;

/// The top-level objects of a JSON array. Quotes are respected, so a property value may hold
/// braces.
fn objects(json: &str) -> Vec<&str> {
    let body = json
        .strip_prefix('[')
        .and_then(|body| body.strip_suffix(']'))
        .unwrap_or_else(|| panic!("not a JSON array: {json}"));
    let mut found = Vec::new();
    let (mut depth, mut start, mut quoted, mut escaped) = (0_i32, 0_usize, false, false);
    for (at, character) in body.char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
        } else if character == '"' {
            quoted = true;
        } else if character == '{' {
            depth += 1;
        } else if character == '}' {
            depth -= 1;
            if depth == 0 {
                found.push(&body[start..=at]);
                start = at + 1;
            }
        }
    }
    found
}

#[test]
fn snapshots_of_the_simple_wall_sample() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/samples/SimpleWall.ifc");
    let model = LoadedModel::open(fs::read(path).unwrap()).unwrap();
    let json = model.element_snapshots_json();
    let snapshots = objects(&json);
    assert_eq!(snapshots.len(), 2, "{json}");

    // Ascending expressId, and one snapshot per product the geometry stream draws.
    assert!(snapshots[0].contains("\"expressId\":219"), "{}", snapshots[0]);
    assert!(snapshots[1].contains("\"expressId\":572"), "{}", snapshots[1]);

    // #219= IFCWALLSTANDARDCASE('1F6umJ5H50aeL3A1As_wTm',#42,
    //      'Basic Wall:Bearing Wall:346660',$,'Basic Wall:Bearing Wall',#188,#215,'346660');
    let wall = snapshots[0];
    assert!(wall.contains("\"globalId\":\"1F6umJ5H50aeL3A1As_wTm\""), "{wall}");
    assert!(wall.contains("\"ifcType\":\"IfcWallStandardCase\""), "{wall}");
    assert!(wall.contains("\"name\":\"Basic Wall:Bearing Wall:346660\""), "{wall}");

    // #228= IFCQUANTITYLENGTH('Height',$,$,4000.); in #236 IFCELEMENTQUANTITY 'BaseQuantities',
    // and #43= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.). The panel shows the unit too.
    assert!(wall.contains("\"BaseQuantities.Height\":\"4000 mm\""), "{wall}");

    // #405= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$); in #408 Pset_WallCommon.
    assert!(wall.contains("\"Pset_WallCommon.IsExternal\":\"true\""), "{wall}");

    // #572= IFCDOOR('1F6umJ5H50aeL3A1As_wUF', ... 'M_Single-Flush:Outside door:346843' ...);
    let door = snapshots[1];
    assert!(door.contains("\"globalId\":\"1F6umJ5H50aeL3A1As_wUF\""), "{door}");
    assert!(door.contains("\"ifcType\":\"IfcDoor\""), "{door}");
    assert!(door.contains("\"name\":\"M_Single-Flush:Outside door:346843\""), "{door}");
}
