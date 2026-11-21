//! `decode_references` and `decode_reference_and_boolean` are fast paths: whenever they
//! answer, they must agree with `decode`.

use step_parser::{Value, index};

fn file(record: &str) -> Vec<u8> {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{record}\nENDSEC;END-ISO-10303-21;")
        .into_bytes()
}

/// What `decode` makes of the record: its references, if its only parameter is a list of
/// nothing else.
fn decoded_list(record: &str) -> Option<Vec<u32>> {
    let bytes = file(record);
    let file = index(&bytes).ok()?;
    let entity = file.decode(1).ok()?;
    let [Value::List(items)] = entity.params.as_slice() else { return None };
    items
        .iter()
        .map(|item| match item {
            Value::Ref(id) => Some(*id),
            _ => None,
        })
        .collect()
}

fn fast_list(record: &str) -> Option<Vec<u32>> {
    let bytes = file(record);
    let file = index(&bytes).ok()?;
    // Left over from an earlier record, which a read must not keep.
    let mut out = vec![99, 98];
    let read = file.decode_references(file.get(1)?, &mut out);
    if !read {
        assert!(out.is_empty(), "{record} declined but left {out:?}");
        return None;
    }
    Some(out)
}

/// What `decode` makes of the record: a reference then `.T.` or `.F.`, and nothing else.
fn decoded_pair(record: &str) -> Option<(u32, bool)> {
    let bytes = file(record);
    let file = index(&bytes).ok()?;
    let entity = file.decode(1).ok()?;
    let [Value::Ref(id), Value::Enum(flag)] = entity.params.as_slice() else { return None };
    match flag.as_str() {
        "T" => Some((*id, true)),
        "F" => Some((*id, false)),
        _ => None,
    }
}

fn fast_pair(record: &str) -> Option<(u32, bool)> {
    let bytes = file(record);
    let file = index(&bytes).ok()?;
    file.decode_reference_and_boolean(file.get(1)?)
}

#[test]
fn the_usual_ways_of_writing_a_list_of_references_take_the_fast_path_and_agree() {
    for (record, expected) in [
        ("#1=IFCPOLYLOOP((#2,#3,#4));", vec![2, 3, 4]),
        ("#1=IFCFACE((#7));", vec![7]),
        ("#1=IFCFACE(());", vec![]),
        ("#1=IfcPolyLoop((#20,#10,#4000000000));", vec![20, 10, 4_000_000_000]),
        ("#1 = IFCPOLYLOOP ( ( #2 , #3 , #4 ) ) ;", vec![2, 3, 4]),
        ("#1=IFCPOLYLOOP(/* a */(#2,/* b */#3,#4)/* c */);", vec![2, 3, 4]),
    ] {
        let fast = fast_list(record).unwrap_or_else(|| panic!("no fast path for {record}"));
        assert_eq!(fast, expected, "{record}");
        assert_eq!(decoded_list(record), Some(expected), "{record}");
    }
}

#[test]
fn the_usual_ways_of_writing_a_bound_take_the_fast_path_and_agree() {
    for (record, expected) in [
        ("#1=IFCFACEOUTERBOUND(#2,.T.);", (2, true)),
        ("#1=IFCFACEBOUND(#30,.F.);", (30, false)),
        ("#1=ifcfacebound(#5,.t.);", (5, true)),
        ("#1=IFCFACEBOUND(#5,.f.);", (5, false)),
        ("#1 = IFCFACEBOUND ( #5 , .T. ) ;", (5, true)),
        ("#1=IFCFACEBOUND(/* a */#5,/* b */.F./* c */);", (5, false)),
    ] {
        let fast = fast_pair(record).unwrap_or_else(|| panic!("no fast path for {record}"));
        assert_eq!(fast, expected, "{record}");
        assert_eq!(decoded_pair(record), Some(expected), "{record}");
    }
}

#[test]
fn any_other_list_falls_back_to_the_full_decoder() {
    for record in [
        // Shapes the full decoder reads but the fast path leaves to it.
        "#1=IFCPOLYLOOP((#2,$,#4));",
        "#1=IFCPOLYLOOP((#2,3,#4));",
        "#1=IFCPOLYLOOP((#2,(#3)));",
        "#1=IFCPOLYLOOP(#2);",
        "#1=IFCPOLYLOOP((#2),#3);",
        "#1=IFCPOLYLOOP((#2),.T.);",
        "#1=IFCPOLYLOOP();",
        "#1=IFCPOLYLOOP($);",
        "#1=(IFCPOLYLOOP((#2,#3))IFCREPRESENTATIONITEM());",
        // Malformed records, which the full decoder rejects.
        "#1=IFCPOLYLOOP((#2,#3)",
        "#1=IFCPOLYLOOP((#2,,#3));",
        "#1=IFCPOLYLOOP((#2,));",
        "#1=IFCPOLYLOOP((# 2));",
        "#1=IFCPOLYLOOP((#4294967296));",
        "#1=IFCPOLYLOOP((#2)));",
    ] {
        assert_eq!(fast_list(record), None, "{record}");
    }
}

#[test]
fn any_other_bound_falls_back_to_the_full_decoder() {
    for record in [
        // Shapes the full decoder reads but the fast path leaves to it.
        "#1=IFCFACEBOUND(#2,.U.);",
        "#1=IFCFACEBOUND(#2,.TRUE.);",
        "#1=IFCFACEBOUND(#2,$);",
        "#1=IFCFACEBOUND($,.T.);",
        "#1=IFCFACEBOUND(#2);",
        "#1=IFCFACEBOUND(#2,.T.,#3);",
        "#1=IFCFACEBOUND((#2),.T.);",
        "#1=IFCFACEBOUND(#2,IFCBOOLEAN(.T.));",
        "#1=(IFCFACEBOUND(#2,.T.)IFCREPRESENTATIONITEM());",
        // Malformed records, which the full decoder rejects.
        "#1=IFCFACEBOUND(#2,.T.",
        "#1=IFCFACEBOUND(#2,.T);",
        "#1=IFCFACEBOUND(#2,T.);",
        "#1=IFCFACEBOUND(#2.T.);",
        "#1=IFCFACEBOUND(# 2,.T.);",
        "#1=IFCFACEBOUND(#2,.T.));",
    ] {
        assert_eq!(fast_pair(record), None, "{record}");
    }
}

#[test]
fn whenever_a_fast_path_answers_it_agrees_with_the_full_decoder() {
    // Every record built from these pieces: a fast path may decline, but never differ.
    let pieces = ["#2", "#30", "$", ".T.", ".F.", ".t.", ".U.", "()", "(#4)", "3", "#", "# 5", ""];
    let mut lists = 0;
    let mut pairs = 0;
    for first in pieces {
        for second in pieces {
            for third in ["", ",#6", ",.F.", ",$"] {
                let record = format!("#1=IFCX(({first},{second}{third}));");
                if let Some(fast) = fast_list(&record) {
                    assert_eq!(Some(fast), decoded_list(&record), "{record}");
                    lists += 1;
                }
                let record = format!("#1=IFCX({first},{second}{third});");
                if let Some(fast) = fast_pair(&record) {
                    assert_eq!(Some(fast), decoded_pair(&record), "{record}");
                    pairs += 1;
                }
            }
        }
    }
    assert!(lists >= 8, "only {lists} lists took the fast path");
    assert!(pairs >= 6, "only {pairs} pairs took the fast path");
}
