use step_parser::{index, Entity, ErrorKind, Value};

fn decode_first(input: &[u8]) -> Entity {
    let index = index(input).unwrap();
    index.decode(1).unwrap()
}

fn params(input: &[u8]) -> Vec<Value> {
    decode_first(input).params
}

#[test]
fn value_null() {
    assert_eq!(params(b"DATA;\n#1=IFCA($);\nENDSEC;"), [Value::Null]);
}

#[test]
fn value_derived() {
    assert_eq!(params(b"DATA;\n#1=IFCA(*);\nENDSEC;"), [Value::Derived]);
}

#[test]
fn value_integer_and_real() {
    let values = params(
        br"DATA;
#1=IFCA(42,-7,+5,1.,.5,1.E-5,-0.,-1.25E+2);
ENDSEC;",
    );

    assert_eq!(values[0], Value::Integer(42));
    assert_eq!(values[1], Value::Integer(-7));
    assert_eq!(values[2], Value::Integer(5));
    assert_eq!(values[3], Value::Real(1.0));
    assert_eq!(values[4], Value::Real(0.5));
    assert_eq!(values[5], Value::Real(1.0e-5));
    match values[6] {
        Value::Real(value) => {
            assert_eq!(value, 0.0);
            assert!(value.is_sign_negative(), "-0. must keep its sign");
        }
        ref other => panic!("expected real for -0., got {other:?}"),
    }
    assert_eq!(values[7], Value::Real(-125.0));
}

#[test]
fn value_string_plain_and_doubled_apostrophe() {
    let values = params(br"DATA;
#1=IFCA('plain text');
#2=IFCB('it''s a (test); with punctuation');
ENDSEC;");
    assert_eq!(values[0], Value::String("plain text".to_owned()));
    let index = index(br"DATA;
#1=IFCA('plain text');
#2=IFCB('it''s a (test); with punctuation');
ENDSEC;")
    .unwrap();
    assert_eq!(
        index.decode(2).unwrap().params,
        [Value::String("it's a (test); with punctuation".to_owned())]
    );
}

#[test]
fn value_string_x2_utf16_escape() {
    let values = params(br"DATA;
#1=IFCA('A\X2\00E9\X0\B');
#2=IFCB('\X2\D83DDE00\X0\');
ENDSEC;");
    assert_eq!(values[0], Value::String("AéB".to_owned()));

    let index = index(br"DATA;
#1=IFCA('A\X2\00E9\X0\B');
#2=IFCB('\X2\D83DDE00\X0\');
ENDSEC;")
    .unwrap();
    assert_eq!(
        index.decode(2).unwrap().params,
        [Value::String("😀".to_owned())]
    );
}

#[test]
fn value_string_x4_utf32_escape() {
    assert_eq!(
        params(br"DATA;
#1=IFCA('\X4\0001F600\X0\');
ENDSEC;"),
        [Value::String("😀".to_owned())]
    );
}

#[test]
fn value_string_x_hex_escape() {
    assert_eq!(
        params(br"DATA;
#1=IFCA('caf\X\E9');
ENDSEC;"),
        [Value::String("café".to_owned())]
    );
}

#[test]
fn value_string_s_shift_escape() {
    // \S\A is the upper half of ISO-8859-1: 0x80 + 'A' = U+00C1 (Á).
    assert_eq!(
        params(br"DATA;
#1=IFCA('\S\A');
ENDSEC;"),
        [Value::String("Á".to_owned())]
    );
}

#[test]
fn value_string_backslash_and_control_escapes() {
    assert_eq!(
        params(br"DATA;
#1=IFCA('back\\slash\N\new\T\tab');
ENDSEC;"),
        [Value::String("back\\slash\nnew\ttab".to_owned())]
    );
}

#[test]
fn value_string_latin1_and_invalid_utf8_do_not_panic() {
    let input = b"DATA;\n#1=IFCA('caf\xE9 \xFF\xFE');\nENDSEC;";
    let values = params(input);
    assert_eq!(values, [Value::String("café ÿþ".to_owned())]);
}

#[test]
fn value_enum() {
    assert_eq!(
        params(b"DATA;\n#1=IFCA(.foo.);\nENDSEC;"),
        [Value::Enum("FOO".to_owned())]
    );
}

#[test]
fn names_and_enumerations_keep_every_character_upper_cased() {
    let index = index(
        b"DATA;\n#1=ifc_a2(.not_Defined2.,ifcLabel_x9('a'));\n#2=(ifcb()ifc_c(.t.));\nENDSEC;",
    )
    .unwrap();
    let first = index.decode(1).unwrap();
    assert_eq!(first.type_name, "IFC_A2");
    assert_eq!(
        first.params,
        [
            Value::Enum("NOT_DEFINED2".to_owned()),
            Value::Typed {
                name: "IFCLABEL_X9".to_owned(),
                value: Box::new(Value::String("a".to_owned())),
            },
        ]
    );
    let complex = index.decode(2).unwrap();
    assert_eq!(complex.type_name, "IFCB");
    assert_eq!(
        complex.other_parts,
        [("IFC_C".to_owned(), vec![Value::Enum("T".to_owned())])]
    );
}

#[test]
fn a_broken_enumeration_is_an_error_at_the_byte_that_breaks_it() {
    let text = b"DATA;\n#1=IFCA(.AB-C.);\n#2=IFCA(..);\nENDSEC;";
    let index = index(text).unwrap();
    let error = |id| index.decode(id).unwrap_err();
    let at = |needle: &[u8]| text.windows(needle.len()).position(|w| w == needle).unwrap();
    assert_eq!(error(1).kind, ErrorKind::UnexpectedByte(b'-'));
    assert_eq!(error(1).offset, at(b"-C."));
    assert_eq!(error(2).kind, ErrorKind::InvalidIdentifier);
    assert_eq!(error(2).offset, at(b"..)") + 2);
}

#[test]
fn value_ref() {
    assert_eq!(
        params(b"DATA;\n#1=IFCA(#42);\nENDSEC;"),
        [Value::Ref(42)]
    );
}

#[test]
fn value_typed() {
    let value = params(br"DATA;
#1=IFCA(IFCLABEL('x'),IFCRATIOMEASURE(0.5));
ENDSEC;");
    assert_eq!(
        value,
        [
            Value::Typed {
                name: "IFCLABEL".to_owned(),
                value: Box::new(Value::String("x".to_owned())),
            },
            Value::Typed {
                name: "IFCRATIOMEASURE".to_owned(),
                value: Box::new(Value::Real(0.5)),
            },
        ]
    );
}

#[test]
fn value_list_nested() {
    assert_eq!(
        params(b"DATA;\n#1=IFCA((1,(2,3),()),());\nENDSEC;"),
        [
            Value::List(vec![
                Value::Integer(1),
                Value::List(vec![Value::Integer(2), Value::Integer(3)]),
                Value::List(vec![]),
            ]),
            Value::List(vec![]),
        ]
    );
}

#[test]
fn value_binary() {
    assert_eq!(
        params(br#"DATA;
#1=IFCA("0FF");
ENDSEC;"#),
        [Value::Binary(vec![0xFF])]
    );
}

#[test]
fn case_insensitive_keywords_and_type_names() {
    let index = index(b"data;\n#1=ifcwallstandardcase($);\nendsec;").unwrap();
    let entity = index.decode(1).unwrap();
    assert_eq!(entity.type_name, "IFCWALLSTANDARDCASE");
    assert_eq!(index.get(1).unwrap().type_name, "IFCWALLSTANDARDCASE");
    assert_eq!(index.ids_by_type("IfcWallStandardCase").count(), 1);
}
