//! Regression tests for the review of commit 5dc34b8 (T-020).
//!
//! Each test targets one defect: unbounded nesting, whole-file aborts on a
//! single bad record, complex entity instances, raw UTF-8 strings and
//! non-finite reals.

use step_parser::{ErrorKind, Value, index};

fn complete(body: &str) -> Vec<u8> {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\n\
         FILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n{body}\nENDSEC;\n\
         END-ISO-10303-21;\n"
    )
    .into_bytes()
}

fn nested_list_input(depth: usize) -> Vec<u8> {
    let mut text = String::from("DATA;\n#1=IFCA(");
    for _ in 0..depth {
        text.push('(');
    }
    text.push('1');
    for _ in 0..depth {
        text.push(')');
    }
    text.push_str(");\nENDSEC;\n");
    text.into_bytes()
}

fn nested_typed_input(depth: usize) -> Vec<u8> {
    let mut text = String::from("DATA;\n#1=IFCA(");
    for _ in 0..depth {
        text.push_str("A(");
    }
    text.push('1');
    for _ in 0..depth {
        text.push(')');
    }
    text.push_str(");\nENDSEC;\n");
    text.into_bytes()
}

fn nested_header_input(depth: usize) -> Vec<u8> {
    let mut text = String::from("ISO-10303-21;\nHEADER;\nFILE_SCHEMA((");
    for _ in 0..depth {
        text.push('(');
    }
    text.push_str("'IFC2X3'");
    for _ in 0..depth {
        text.push(')');
    }
    text.push_str(
        "));\nENDSEC;\nDATA;\n#1=IFCA(1);\nENDSEC;\nEND-ISO-10303-21;\n",
    );
    text.into_bytes()
}

fn list_nesting(value: &Value) -> usize {
    match value {
        Value::List(values) if values.len() == 1 => 1 + list_nesting(&values[0]),
        _ => 0,
    }
}

fn typed_nesting(value: &Value) -> usize {
    match value {
        Value::Typed { value, .. } => 1 + typed_nesting(value),
        _ => 0,
    }
}

#[test]
fn nesting_up_to_64_decodes_through_index_and_decode() {
    for depth in [1usize, 63, 64] {
        let bytes = nested_list_input(depth);
        let index = index(&bytes).unwrap();
        assert!(index.skipped().is_empty());
        assert_eq!(index.entity_count(), 1);
        let entity = index.decode(1).unwrap();
        assert_eq!(list_nesting(&entity.params[0]), depth);
    }

    for depth in [1usize, 63, 64] {
        let bytes = nested_typed_input(depth);
        let index = index(&bytes).unwrap();
        assert!(index.skipped().is_empty());
        assert_eq!(index.entity_count(), 1);
        let entity = index.decode(1).unwrap();
        assert_eq!(typed_nesting(&entity.params[0]), depth);
    }
}

#[test]
fn nesting_beyond_64_fails_cleanly_through_index_and_decode() {
    // The 1_000_000 case would overflow the stack and abort the test process
    // without the depth guard.
    for depth in [65usize, 10_000, 1_000_000] {
        for bytes in [nested_list_input(depth), nested_typed_input(depth)] {
            let index = index(&bytes).unwrap_or_else(|err| {
                panic!("index failed at depth {depth} instead of returning an index: {err}")
            });
            assert_eq!(index.entity_count(), 1, "depth {depth}");
            assert!(index.skipped().is_empty(), "depth {depth}");
            let err = index.decode(1).unwrap_err();
            assert_eq!(err.kind, ErrorKind::NestingTooDeep, "depth {depth}");
        }
    }
}

#[test]
fn nesting_inside_a_header_is_bounded_during_indexing() {
    // This exercises the recursive parser through `index`, not `decode`.
    for depth in [65usize, 10_000, 1_000_000] {
        let bytes = nested_header_input(depth);
        let index = index(&bytes).unwrap_or_else(|err| {
            panic!("index failed at header depth {depth}: {err}")
        });
        assert_eq!(index.entity_count(), 1, "header depth {depth}");
        assert_eq!(index.skipped().len(), 1, "header depth {depth}");
        assert_eq!(
            index.skipped()[0].kind,
            ErrorKind::NestingTooDeep,
            "header depth {depth}"
        );
        assert_eq!(index.decode(1).unwrap().params, [Value::Integer(1)]);
    }
}

#[test]
fn malformed_middle_record_is_skipped_and_later_records_survive() {
    let input = complete(
        "#1=IFCA(1);\n\
         #2=IFCB 'a;b' /* a comment with ; inside */ );\n\
         #3=IFCC(3);",
    );
    let index = index(&input).unwrap();

    assert_eq!(index.entity_count(), 2);
    assert_eq!(index.ids().collect::<Vec<_>>(), [1, 3]);
    assert_eq!(index.skipped().len(), 1);
    assert_eq!(index.skipped()[0].kind, ErrorKind::MalformedEntity);
    assert_eq!(index.decode(1).unwrap().params, [Value::Integer(1)]);
    assert_eq!(index.decode(3).unwrap().params, [Value::Integer(3)]);
    assert!(index.decode(2).is_err());
}

#[test]
fn index_still_requires_data_and_a_declared_header() {
    let no_data = index(b"HEADER;\nENDSEC;\n").unwrap_err();
    assert_eq!(no_data.kind, ErrorKind::MalformedEntity);

    let no_header = index(b"ISO-10303-21;\nDATA;\n#1=IFCA(1);\nENDSEC;\n").unwrap_err();
    assert_eq!(no_header.kind, ErrorKind::MalformedEntity);
}

#[test]
fn complex_entity_instances_index_and_decode() {
    let input = complete("#1=(IFCA(1)IFCB(2));\n#2 = IFCX ( 3 ) ;");
    let index = index(&input).unwrap();

    assert_eq!(index.entity_count(), 2);
    assert_eq!(index.get(1).unwrap().type_name, "IFCA");
    assert_eq!(index.ids_by_type("IFCA").collect::<Vec<_>>(), [1]);
    assert_eq!(index.ids_by_type("ifcb").collect::<Vec<_>>(), [1]);

    let complex = index.decode(1).unwrap();
    assert_eq!(complex.type_name, "IFCA");
    assert_eq!(complex.params, [Value::Integer(1)]);
    assert_eq!(
        complex.parts().collect::<Vec<_>>(),
        [
            ("IFCA", &[Value::Integer(1)][..]),
            ("IFCB", &[Value::Integer(2)][..]),
        ]
    );

    let ordinary = index.decode(2).unwrap();
    assert_eq!(ordinary.type_name, "IFCX");
    assert_eq!(ordinary.params, [Value::Integer(3)]);
    assert_eq!(
        ordinary.parts().collect::<Vec<_>>(),
        [("IFCX", &[Value::Integer(3)][..])]
    );
}

#[test]
fn space_inside_an_entity_name_is_a_skipped_record() {
    let input = complete("# 1=IFCA(1);\n#2=IFCB(2);");
    let index = index(&input).unwrap();

    assert_eq!(index.entity_count(), 1);
    assert_eq!(index.ids().collect::<Vec<_>>(), [2]);
    assert_eq!(index.skipped().len(), 1);
    assert_eq!(index.skipped()[0].kind, ErrorKind::InvalidIdentifier);
    assert!(index.get(1).is_none());
}

#[test]
fn raw_utf8_and_latin1_strings_both_decode() {
    let utf8 = b"DATA;\n#1=IFCA('caf\xC3\xA9');\nENDSEC;";
    let utf8_index = index(utf8).unwrap();
    assert_eq!(
        utf8_index.decode(1).unwrap().params,
        [Value::String("café".to_owned())]
    );

    let latin1 = b"DATA;\n#1=IFCA('caf\xE9');\nENDSEC;";
    let latin1_index = index(latin1).unwrap();
    assert_eq!(
        latin1_index.decode(1).unwrap().params,
        [Value::String("café".to_owned())]
    );
}

#[test]
fn non_finite_reals_are_invalid_numbers() {
    for literal in ["1.E999", "-1.E999", "1.0E400"] {
        let input = format!("DATA;\n#1=IFCA({literal});\nENDSEC;");
        let index = index(input.as_bytes()).unwrap();
        let err = index.decode(1).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidNumber, "literal {literal}");
    }

    // A finite real near the top of the range still decodes.
    let index = index(b"DATA;\n#1=IFCA(1.0E308);\nENDSEC;").unwrap();
    assert!(matches!(index.decode(1).unwrap().params[0], Value::Real(_)));
}

#[test]
fn lookup_by_id_works_for_dense_sparse_and_missing_ids() {
    // Dense: ids close together, with a gap.
    let dense = complete("#1=IFCA(1);\n#2=IFCB(2);\n#4=IFCC(4);");
    let dense = index(&dense).unwrap();
    assert_eq!(dense.get(1).unwrap().type_name, "IFCA");
    assert_eq!(dense.get(4).unwrap().type_name, "IFCC");
    assert!(dense.get(3).is_none());
    assert!(dense.get(0).is_none());
    assert!(dense.get(5).is_none());
    assert!(dense.get(u32::MAX).is_none());

    // Sparse: an id far beyond the entity count must not need a table that large.
    let sparse = complete("#7=IFCA(1);\n#4294967295=IFCB(2);\n#4000000000=IFCC(3);");
    let sparse = index(&sparse).unwrap();
    assert_eq!(sparse.get(7).unwrap().type_name, "IFCA");
    assert_eq!(sparse.get(u32::MAX).unwrap().type_name, "IFCB");
    assert_eq!(sparse.decode(4_000_000_000).unwrap().params, [Value::Integer(3)]);
    assert!(sparse.get(8).is_none());
    assert!(sparse.get(4_000_000_001).is_none());

    // A duplicate keeps the first record in both layouts.
    for text in ["#1=IFCA(1);\n#1=IFCB(2);", "#1=IFCA(1);\n#1=IFCB(2);\n#9000=IFCC(3);"] {
        let bytes = complete(text);
        let duplicate = index(&bytes).unwrap();
        assert_eq!(duplicate.get(1).unwrap().type_name, "IFCA", "{text}");
    }
}
