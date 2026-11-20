//! DXF R12 checked by reading the file back: header, line ends, bytes and layer names.

mod common;

use cad_slicer::{
    Cut, DrawingMesh, DrawingOptions, DxfOptions, HatchStyle, SpaceInput, draw, draw_with_spaces,
    to_dxf, to_dxf_with,
};
use common::{cuboid, v};

/// Splits the file into (group code, value) pairs. Panics unless every line ends in CRLF.
fn groups(bytes: &[u8]) -> Vec<(i16, String)> {
    assert!(bytes.ends_with(b"\r\n"), "the file does not end in CRLF");
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            assert!(index > 0 && bytes[index - 1] == b'\r', "LF without CR at {index}");
        }
        if *byte == b'\r' {
            assert_eq!(bytes.get(index + 1), Some(&b'\n'), "CR without LF at {index}");
        }
    }
    let lines: Vec<&[u8]> = bytes
        .split(|byte| *byte == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line))
        .collect();
    // The final CRLF leaves an empty tail.
    assert_eq!(lines.len() % 2, 1, "an odd number of lines");
    lines[..lines.len() - 1]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let code: i16 = std::str::from_utf8(pair[0])
                .expect("group codes are ASCII")
                .parse()
                .expect("group code is a number");
            (code, String::from_utf8_lossy(pair[1]).into_owned())
        })
        .collect()
}

fn header_value<'a>(groups: &'a [(i16, String)], name: &str) -> Option<(i16, &'a str)> {
    let index = groups
        .iter()
        .position(|(code, value)| *code == 9 && value == name)?;
    let (code, value) = groups.get(index + 1)?;
    Some((*code, value.as_str()))
}

fn box_drawing() -> cad_slicer::Drawing {
    let item = DrawingMesh::new(
        1,
        10,
        "Muros",
        cuboid(v(0.0, 0.0, 0.0), v(4.0, 3.0, 2.0)),
    );
    draw(&[item], &DrawingOptions::cut_only(Cut::Plan { z: 1.0 }))
}

#[test]
fn the_header_says_r12_and_cp1252() {
    let bytes = to_dxf(&box_drawing());
    let groups = groups(&bytes);
    assert_eq!(header_value(&groups, "$ACADVER"), Some((1, "AC1009")));
    assert_eq!(header_value(&groups, "$DWGCODEPAGE"), Some((3, "ANSI_1252")));
    assert!(groups.contains(&(0, "EOF".into())));
}

#[test]
fn the_undefined_bytes_never_appear() {
    let bytes = to_dxf(&box_drawing());
    for undefined in [0x81_u8, 0x8D, 0x8F, 0x90, 0x9D] {
        assert!(
            !bytes.contains(&undefined),
            "byte {undefined:#04x} is not allowed in DXF"
        );
    }
    // Everything we write is ASCII here, so nothing was smuggled in as UTF-8.
    assert!(bytes.is_ascii());
}

#[test]
fn a_rectangle_is_a_line_per_cut_segment() {
    let drawing = box_drawing();
    let bytes = to_dxf(&drawing);
    let groups = groups(&bytes);
    let lines = groups
        .iter()
        .filter(|(code, value)| *code == 0 && value == "LINE")
        .count();
    // The cut loop closes through as many segments as it has points.
    let expected: usize = common::layer(&drawing, "Muros")
        .loops
        .iter()
        .map(|ring| ring.points.len())
        .sum();
    assert_eq!(lines, expected);
    assert_eq!(expected, 8, "four sides, each cut in two by a quad diagonal");
    assert_eq!(
        groups
            .iter()
            .filter(|(code, value)| *code == 2 && value == "Muros")
            .count(),
        1,
        "the layer table holds Muros once"
    );
    for (index, (code, value)) in groups.iter().enumerate() {
        if *code == 8 {
            assert_eq!(value, "Muros");
            assert_eq!(groups[index - 1], (0, "LINE".to_string()));
        }
    }
}

#[test]
fn hidden_lines_go_to_their_own_layer() {
    let slab = DrawingMesh::new(1, 1, "Slab", cuboid(v(0.0, 0.0, 1.5), v(4.0, 4.0, 2.0)));
    let under = DrawingMesh::new(1, 2, "Slab", cuboid(v(1.0, 1.0, 0.0), v(2.0, 2.0, 1.0)));
    let options = DrawingOptions {
        cut: Cut::Plan { z: 2.0 },
        depth: None,
        include_projection: true,
        include_hatching: false,
    };
    let drawing = draw(&[slab, under], &options);
    let bytes = to_dxf(&drawing);
    let groups = groups(&bytes);
    let names: Vec<&str> = groups
        .iter()
        .filter(|(code, _)| *code == 2)
        .map(|(_, value)| value.as_str())
        .collect();
    assert!(names.contains(&"Slab"), "{names:?}");
    assert!(names.contains(&"Slab-HIDDEN"), "{names:?}");

    let hidden = groups
        .iter()
        .filter(|(code, value)| *code == 0 && value == "LINE")
        .zip(groups.iter().filter(|(code, _)| *code == 8))
        .filter(|((_, _), (_, layer))| layer == "Slab-HIDDEN")
        .count();
    assert_eq!(hidden, 4);

    // A caller may leave the hidden layer out; the file then has none of it.
    let plain = to_dxf_with(
        &drawing,
        &DxfOptions {
            include_hidden: false,
            include_hatch: true,
            ..DxfOptions::default()
        },
    );
    assert!(!String::from_utf8_lossy(&plain).contains("HIDDEN"));
}

#[test]
fn a_layer_name_outside_cp1252_never_becomes_utf8() {
    let item = DrawingMesh::new(1, 1, "Muro 日本 ñ", cuboid(v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0)));
    let drawing = draw(&[item], &DrawingOptions::cut_only(Cut::Plan { z: 0.5 }));
    let bytes = to_dxf(&drawing);
    assert!(bytes.is_ascii(), "UTF-8 leaked into an ANSI_1252 file");
    let groups = groups(&bytes);
    let name = groups
        .iter()
        .find(|(code, value)| *code == 2 && value.starts_with("Muro"))
        .map(|(_, value)| value.clone())
        .expect("the layer is in the table");
    assert!(name.is_ascii());
    assert!(name.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '$' | '_' | '-' | '.')
    }));
}

#[test]
fn two_names_that_collide_after_truncation_stay_distinct() {
    let prefix = "WALLS-OF-THE-NORTH-ELEVATION-LINE-";
    assert!(prefix.len() >= 31);
    let first = format!("{prefix}AAAA");
    let second = format!("{prefix}BBBB");
    let meshes = vec![
        DrawingMesh::new(1, 1, &first, cuboid(v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0))),
        DrawingMesh::new(1, 2, &second, cuboid(v(2.0, 0.0, 0.0), v(3.0, 1.0, 1.0))),
    ];
    let drawing = draw(&meshes, &DrawingOptions::cut_only(Cut::Plan { z: 0.5 }));
    let bytes = to_dxf(&drawing);
    let groups = groups(&bytes);
    let names: Vec<String> = groups
        .iter()
        .filter(|(code, value)| *code == 2 && value.starts_with("WALLS"))
        .map(|(_, value)| value.clone())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert_ne!(names[0].to_lowercase(), names[1].to_lowercase());
    for name in &names {
        assert!(name.len() <= 31, "{name} is longer than 31");
    }
    // The first keeps the truncated name; the second is cut further to make room for a suffix.
    assert_eq!(names[0], prefix[..31]);
    assert_eq!(names[1].len(), 31);
    assert!(names[1].starts_with(&prefix[..28]), "{}", names[1]);
    assert!(names[1].ends_with("-1"), "{}", names[1]);
}

#[test]
fn hatch_lines_are_written_as_entities() {
    let mut item = DrawingMesh::new(1, 1, "Concrete", cuboid(v(0.0, 0.0, 0.0), v(2.0, 2.0, 1.0)));
    item.hatch = vec![HatchStyle::new(0.0, 0.5)];
    let options = DrawingOptions {
        cut: Cut::Plan { z: 0.5 },
        depth: None,
        include_projection: false,
        include_hatching: true,
    };
    let drawing = draw(&[item], &options);
    let all = groups(&to_dxf(&drawing))
        .iter()
        .filter(|(code, value)| *code == 0 && value == "LINE")
        .count();
    let without = groups(&to_dxf_with(
        &drawing,
        &DxfOptions {
            include_hidden: true,
            include_hatch: false,
            ..DxfOptions::default()
        },
    ))
    .iter()
    .filter(|(code, value)| *code == 0 && value == "LINE")
    .count();
    assert_eq!(all - without, 3, "three hatch lines were expected");
}

#[test]
fn space_labels_write_dxf_text_entities_in_cp1252() {
    let walls = [DrawingMesh::new(1, 1, "Muros", cuboid(v(0.0, 0.0, 0.0), v(10.0, 8.0, 3.0)))];
    let spaces = [SpaceInput {
        model_id: 1,
        element_id: 42,
        name: "Salón 1".into(),
        quantity_area_m2: None,
        mesh: cuboid(v(0.3, 0.3, 0.0), v(9.7, 7.7, 3.0)),
    }];
    let drawing = draw_with_spaces(&walls, &spaces, &DrawingOptions::cut_only(Cut::Plan { z: 1.5 }));
    let bytes = to_dxf(&drawing);
    // 'ó' (0xF3) and '²' (0xB2) are CP1252 single bytes, never UTF-8 sequences.
    assert!(!bytes.windows(2).any(|w| w == [0xC2, 0xB2]), "UTF-8 ² leaked into CP1252 DXF");
    assert!(bytes.windows(4).any(|w| w == b"69.5"), "expected 69.56 m²");
    assert!(bytes.contains(&0xB2), "CP1252 ² byte expected");
    assert!(bytes.contains(&0xF3), "CP1252 ó byte expected");
    let parsed = groups(&bytes);
    let text_entities = parsed.iter().filter(|(c, v)| *c == 0 && v == "TEXT").count();
    assert_eq!(text_entities, 2, "name and area TEXT entities");
    assert!(parsed.iter().any(|(c, v)| *c == 2 && v == "SPACES"));
}
