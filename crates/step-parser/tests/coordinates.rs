//! `decode_coordinates` is a fast path: whenever it answers, it must agree with `decode`.

use step_parser::{Value, index};

fn file(record: &str) -> Vec<u8> {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n{record}\nENDSEC;END-ISO-10303-21;")
        .into_bytes()
}

/// What `decode` makes of the first parameter: its numbers, if it is a list of nothing else.
fn decoded(record: &str) -> Option<Vec<f64>> {
    let bytes = file(record);
    let file = index(&bytes).ok()?;
    let entity = file.decode(1).ok()?;
    let Some(Value::List(items)) = entity.params.first() else { return None };
    items
        .iter()
        .map(|item| match item {
            Value::Real(value) => Some(*value),
            Value::Integer(value) => Some(*value as f64),
            _ => None,
        })
        .collect()
}

fn fast(record: &str) -> Option<Vec<f64>> {
    let bytes = file(record);
    let file = index(&bytes).ok()?;
    let (values, count) = file.decode_coordinates(file.get(1)?)?;
    Some(values[..count].to_vec())
}

fn bits(values: &[f64]) -> Vec<u64> {
    values.iter().map(|value| value.to_bits()).collect()
}

#[test]
fn the_usual_ways_of_writing_a_point_take_the_fast_path_and_agree() {
    for record in [
        "#1=IFCCARTESIANPOINT((1.,2.,3.));",
        "#1=IFCCARTESIANPOINT((0.,-1.5));",
        "#1=IFCCARTESIANPOINT((12,-4,0));",
        "#1=IFCCARTESIANPOINT((1.5E3,-2.25e-2,.5));",
        "#1=IfcCartesianPoint((-0.,+7.,1.E+2));",
        "#1 = IFCCARTESIANPOINT ( ( 1. , 2. , 3. ) ) ;",
        "#1=IFCCARTESIANPOINT(/* note */(1.,/* x */2.,3.));",
        "#1=IFCCARTESIANPOINT((536000.123456789,4747000.987654321,12.000000001));",
    ] {
        let fast = fast(record).unwrap_or_else(|| panic!("no fast path for {record}"));
        let decoded = decoded(record).expect("the full decoder reads it");
        assert_eq!(bits(&fast), bits(&decoded), "{record}");
    }
}

#[test]
fn anything_else_falls_back_to_the_full_decoder() {
    for record in [
        // Shapes the full decoder reads but the fast path leaves to it.
        "#1=IFCCARTESIANPOINT((IFCLENGTHMEASURE(1.),2.,3.));",
        "#1=IFCCARTESIANPOINT(($,2.,3.));",
        "#1=IFCCARTESIANPOINT((1.,2.,3.,4.));",
        "#1=IFCCARTESIANPOINT((1.));",
        "#1=IFCCARTESIANPOINT(());",
        "#1=IFCCARTESIANPOINT((1.,2.,3.),$);",
        "#1=IFCCARTESIANPOINT(#2);",
        "#1=(IFCCARTESIANPOINT((1.,2.,3.))IFCREPRESENTATIONITEM());",
        // Malformed records, which the full decoder rejects.
        "#1=IFCCARTESIANPOINT((1.,2.,3.)",
        "#1=IFCCARTESIANPOINT((1.,,3.));",
        "#1=IFCCARTESIANPOINT((1.E400,2.,3.));",
        "#1=IFCCARTESIANPOINT((1.,2.,3.)));",
    ] {
        assert_eq!(fast(record), None, "{record}");
    }
}

#[test]
fn whenever_the_fast_path_answers_it_agrees_with_the_full_decoder() {
    // Every record built from these pieces: the fast path may decline, but never differ.
    let numbers = ["1.", "-2.5", "3", ".5", "1.E400", "$", "IFCREAL(1.)", "0x1", "1.2.3", "-"];
    let mut checked = 0;
    for first in numbers {
        for second in numbers {
            for third in ["", ",4.", ",-0.", ",$"] {
                let record = format!("#1=IFCCARTESIANPOINT(({first},{second}{third}));");
                if let Some(fast) = fast(&record) {
                    let decoded = decoded(&record).unwrap_or_else(|| panic!("{record}"));
                    assert_eq!(bits(&fast), bits(&decoded), "{record}");
                    checked += 1;
                }
            }
        }
    }
    assert!(checked >= 30, "only {checked} records took the fast path");
}
