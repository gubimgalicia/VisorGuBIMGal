//! Schema tables checked against every real IFC file in the repository.

use ifc_schema::{SchemaId, schema};
use std::fs;
use std::path::{Path, PathBuf};
use step_parser::{Value, index};

fn ifc_files() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for folder in ["public/samples", "test/fixtures", "test/fixtures/authored"] {
        for entry in fs::read_dir(root.join(folder)).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "ifc") {
                files.push(path);
            }
        }
    }
    assert!(files.len() >= 15, "only {} files found", files.len());
    files
}

#[test]
fn every_entity_in_every_file_matches_its_schema() {
    let mut checked = 0usize;
    let mut problems = Vec::new();
    for path in ifc_files() {
        let bytes = fs::read(&path).unwrap();
        let file = index(&bytes).unwrap();
        // The parser keeps the first of two records with one id, so a test file that repeats
        // an id tests something other than what it reads as.
        if !file.duplicate_ids().is_empty() {
            problems.push(format!("{}: repeated ids {:?}", path.display(), file.duplicate_ids()));
        }
        let id = SchemaId::from_identifiers(file.schema_identifiers())
            .unwrap_or_else(|| panic!("{}: unsupported schema", path.display()));
        let tables = schema(id);
        for express_id in file.ids() {
            let entity = file.decode(express_id).unwrap();
            for (type_name, params) in entity.parts() {
                let Some(def) = tables.entity(type_name) else {
                    problems.push(format!("{}: unknown {type_name}", path.display()));
                    continue;
                };
                checked += 1;
                let attributes = def.attributes();
                if entity.other_parts.is_empty() && attributes.len() != params.len() {
                    problems.push(format!(
                        "{}: #{express_id} {type_name} has {} parameters, schema says {}",
                        path.display(),
                        params.len(),
                        attributes.len()
                    ));
                }
                for (attribute, value) in attributes.iter().zip(params) {
                    let star = matches!(value, Value::Derived);
                    if star != attribute.derived {
                        problems.push(format!(
                            "{}: #{express_id} {type_name}.{} star={star} derived={}",
                            path.display(),
                            attribute.name,
                            attribute.derived
                        ));
                    }
                }
            }
        }
    }
    println!("checked {checked} entities");
    assert!(
        problems.is_empty(),
        "{} problems, first: {:#?}",
        problems.len(),
        &problems[..problems.len().min(12)]
    );
    assert!(checked >= 19_000, "only {checked} entities checked");
}

#[test]
fn schema_identifiers_map_to_canonical_ids() {
    let ids = |text: &str| SchemaId::from_identifiers(&[text.to_string()]);
    assert_eq!(ids("IFC2X3"), Some(SchemaId::Ifc2x3));
    assert_eq!(ids("ifc4"), Some(SchemaId::Ifc4));
    assert_eq!(ids("IFC4X3_ADD2"), Some(SchemaId::Ifc4x3));
    assert_eq!(ids("IFC4X1"), None);
    assert_eq!(ids("AP214"), None);
    assert_eq!(SchemaId::from_identifiers(&[]), None);
}

#[test]
fn inheritance_is_walked() {
    let tables = schema(SchemaId::Ifc2x3);
    let wall = tables.entity("IFCWALLSTANDARDCASE").unwrap();
    assert_eq!(wall.name(), "IfcWallStandardCase");
    assert!(wall.is_a("IfcWall"));
    assert!(wall.is_a("IFCPRODUCT"));
    assert!(wall.is_a("IfcRoot"));
    assert!(wall.is_a("IfcWallStandardCase"));
    assert!(!wall.is_a("IfcSlab"));
    assert_eq!(wall.parent().unwrap().name(), "IfcWall");
    assert!(tables.entity("IfcRoot").unwrap().parent().is_none());
}

#[test]
fn attribute_positions_follow_step_order() {
    let wall = schema(SchemaId::Ifc4).entity("IFCWALL").unwrap();
    assert_eq!(wall.attribute_index("GlobalId"), Some(0));
    assert_eq!(wall.attribute_index("Name"), Some(2));
    assert_eq!(wall.attribute_index("ObjectPlacement"), Some(5));
    assert_eq!(wall.attribute_index("Representation"), Some(6));
    assert_eq!(wall.attribute_index("Tag"), Some(7));
    assert_eq!(wall.attribute_index("PredefinedType"), Some(8));
    assert_eq!(wall.attribute_index("Nonsense"), None);
    let listed: Vec<&str> = wall.attributes().iter().map(|a| a.name).collect();
    assert_eq!(listed.len(), wall.attribute_count());
    for (position, name) in listed.iter().enumerate() {
        assert_eq!(wall.attribute_index(name), Some(position));
    }
}

#[test]
fn optional_attributes_are_marked() {
    let attributes = schema(SchemaId::Ifc4).entity("IfcRoot").unwrap().attributes();
    assert!(!attributes[0].optional, "GlobalId");
    assert!(attributes[2].optional, "Name");
}

#[test]
fn a_redeclared_attribute_keeps_its_position() {
    for id in [SchemaId::Ifc2x3, SchemaId::Ifc4, SchemaId::Ifc4x3] {
        let unit = schema(id).entity("IfcSIUnit").unwrap();
        let attributes = unit.attributes();
        assert_eq!(attributes[0].name, "Dimensions");
        assert!(attributes[0].derived);
        assert!(!attributes[1].derived, "UnitType");
        assert_eq!(unit.attribute_index("Dimensions"), Some(0));
        assert_eq!(unit.attribute_count(), 4);
        // The supertype itself holds a real value.
        assert!(!schema(id).entity("IfcNamedUnit").unwrap().attributes()[0].derived);
    }
}

#[test]
fn schemas_differ_where_ifc_changed() {
    assert!(schema(SchemaId::Ifc2x3).entity("IfcWallStandardCase").is_some());
    assert!(schema(SchemaId::Ifc2x3).entity("IfcTriangulatedFaceSet").is_none());
    assert!(schema(SchemaId::Ifc4).entity("IfcTriangulatedFaceSet").is_some());
    assert!(schema(SchemaId::Ifc4).entity("IfcAlignment").is_none());
    assert!(schema(SchemaId::Ifc4x3).entity("IfcAlignment").is_some());
    assert!(schema(SchemaId::Ifc4x3).entity("IfcRoad").is_some());
}

#[test]
fn subtypes_exclude_abstract_entities() {
    let products = schema(SchemaId::Ifc4).subtypes_of("IfcProduct");
    assert!(products.contains(&"IfcWall"));
    assert!(products.contains(&"IfcOpeningElement"));
    assert!(!products.contains(&"IfcProduct"), "abstract");
    assert!(!products.contains(&"IfcBuildingElement"), "abstract");
    assert!(!products.contains(&"IfcPropertySet"), "not a product");
}
