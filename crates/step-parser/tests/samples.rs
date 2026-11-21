use std::fs;
use std::path::PathBuf;

use step_parser::{index, Value};

fn sample_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("public")
        .join("samples")
        .join(name)
}

/// Independent fixture check: count records that start a line with `#<digits>=`.
fn count_line_start_records(bytes: &[u8]) -> usize {
    let mut count = 0;
    for line in bytes.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.first() != Some(&b'#') {
            continue;
        }
        let mut idx = 1;
        let digit_start = idx;
        while line.get(idx).is_some_and(u8::is_ascii_digit) {
            idx += 1;
        }
        if idx > digit_start && line.get(idx) == Some(&b'=') {
            count += 1;
        }
    }
    count
}

fn sample(name: &str) -> (String, Vec<u8>) {
    let path = sample_path(name);
    let bytes = fs::read(&path).unwrap_or_else(|err| panic!("cannot read {path:?}: {err}"));
    (name.to_owned(), bytes)
}

#[test]
fn sample_entity_counts_match_line_start_count() {
    let expected = [("SimpleWall.ifc", 548usize), ("ManySimpleWalls.ifc", 9776usize)];

    for (name, expected_count) in expected {
        let (_, bytes) = sample(name);
        let line_count = count_line_start_records(&bytes);
        assert_eq!(
            line_count, expected_count,
            "{name}: independent line-start count differs from the brief; investigate, do not weaken the test"
        );

        let index = index(&bytes).unwrap_or_else(|err| panic!("{name}: index failed: {err}"));
        assert_eq!(
            index.entity_count(),
            expected_count,
            "{name}: index entity_count differs from line-start count"
        );
        assert_eq!(index.schema_identifiers(), ["IFC2X3"]);
        assert!(index.duplicate_ids().is_empty(), "{name}: unexpected duplicates");
    }
}

#[test]
fn every_entity_in_both_samples_decodes() {
    for name in ["SimpleWall.ifc", "ManySimpleWalls.ifc"] {
        let (_, bytes) = sample(name);
        let index = index(&bytes).unwrap_or_else(|err| panic!("{name}: index failed: {err}"));

        let mut decoded = 0usize;
        for entity in index.entities() {
            let value = index
                .decode(entity.id)
                .unwrap_or_else(|err| panic!("{name}: decode #{} failed: {err}", entity.id));
            assert_eq!(value.type_name, entity.type_name);
            decoded += 1;
        }
        assert_eq!(decoded, index.entity_count(), "{name}: decoded count mismatch");
    }
}

#[test]
fn lookup_and_type_iteration_work_on_samples() {
    let (_, bytes) = sample("SimpleWall.ifc");
    let index = index(&bytes).unwrap();

    let organization = index.get(1).expect("#1 should be indexed");
    assert_eq!(organization.type_name, "IFCORGANIZATION");
    assert_eq!(organization.byte_range().len(), organization.end - organization.start);
    assert!(organization.byte_range().start < organization.byte_range().end);

    let decoded = index.decode(1).unwrap();
    assert_eq!(decoded.type_name, "IFCORGANIZATION");
    assert_eq!(decoded.params.first(), Some(&Value::Null));

    // Type iteration must agree with a scan of the index.
    let by_type: Vec<u32> = index.ids_by_type("ifccartesianpoint").collect();
    let scanned: Vec<u32> = index
        .entities()
        .filter(|entity| entity.type_name == "IFCCARTESIANPOINT")
        .map(|entity| entity.id)
        .collect();
    assert_eq!(by_type, scanned);
    assert!(!by_type.is_empty());
    assert!(index.ids_by_type("NO_SUCH_ENTITY").next().is_none());

    // Ids are unique and forward-lookup agrees with the entry list.
    let mut ids: Vec<u32> = index.ids().collect();
    let original_len = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), original_len);
    for id in index.ids() {
        assert_eq!(index.get(id).map(|entity| entity.id), Some(id));
    }
}

#[test]
fn header_schema_and_comments_are_handled() {
    let input = b"/* leading comment with #99= HIDDEN(); */\n\
ISO-10303-21;\r\n\
HEADER;\r\n\
FILE_DESCRIPTION(('a;b'),'2;1');\r\n\
FILE_SCHEMA(('IFC4','IFC4X3'));\r\n\
ENDSEC;\r\n\
DATA;\r\n\
#1=IFCFOO($);\r\n\
ENDSEC;\r\n\
END-ISO-10303-21;\r\n";
    let index = index(input).unwrap();
    assert_eq!(index.schema_identifiers(), ["IFC4", "IFC4X3"]);
    assert_eq!(index.entity_count(), 1);
    assert!(index.get(99).is_none());
    assert_eq!(index.decode(1).unwrap().type_name, "IFCFOO");
}

#[test]
fn several_entities_on_one_line_and_spanning_lines() {
    let input = b"DATA;\n#1=IFCA(1); #2=IFCB(\n  2,\n  3\n); #3=IFCC('x');\nENDSEC;";
    let index = index(input).unwrap();
    assert_eq!(index.entity_count(), 3);
    assert_eq!(index.decode(2).unwrap().params, [Value::Integer(2), Value::Integer(3)]);
}

#[test]
fn duplicate_ids_are_tolerated_and_first_wins() {
    let input = b"DATA;\n#7=IFCFIRST(1);\n#7=IFCSECOND(2);\nENDSEC;";
    let index = index(input).unwrap();
    assert_eq!(index.entity_count(), 1);
    assert_eq!(index.duplicate_ids(), [7]);
    assert_eq!(index.decode(7).unwrap().type_name, "IFCFIRST");
}

#[test]
fn dangling_reference_decodes_as_a_reference() {
    let input = b"DATA;\n#1=IFCA((#99,#100));\nENDSEC;";
    let index = index(input).unwrap();
    let entity = index.decode(1).unwrap();
    assert_eq!(
        entity.params,
        [Value::List(vec![Value::Ref(99), Value::Ref(100)])]
    );
}

#[test]
fn malformed_records_are_skipped_and_reported() {
    let unterminated = b"DATA;\n#1=IFCA('oops);\nENDSEC;";
    let parsed = index(unterminated).unwrap();
    assert_eq!(parsed.entity_count(), 0);
    assert_eq!(parsed.skipped().len(), 1);
    assert_eq!(
        parsed.skipped()[0].kind,
        step_parser::ErrorKind::UnterminatedString
    );
    assert!(parsed.skipped()[0].offset >= 12);

    let missing = index(b"DATA;\n#1=IFCA($);\nENDSEC;").unwrap();
    assert_eq!(
        missing.decode(404).unwrap_err().kind,
        step_parser::ErrorKind::UnknownEntity(404)
    );

    // A malformed record no longer fails the whole file, but a file without a
    // usable DATA section still does.
    let no_paren = index(b"DATA;\n#1=IFCA;\nENDSEC;").unwrap();
    assert_eq!(no_paren.entity_count(), 0);
    assert_eq!(no_paren.skipped().len(), 1);
    assert_eq!(
        no_paren.skipped()[0].kind,
        step_parser::ErrorKind::MalformedEntity
    );

    let no_data = index(b"HEADER;\nENDSEC;\n").unwrap_err();
    assert_eq!(no_data.kind, step_parser::ErrorKind::MalformedEntity);
}
