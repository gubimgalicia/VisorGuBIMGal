//! SVG checked against the whitelist of docs/05: elements, attributes and escaping.

mod common;

use cad_slicer::{
    AreaSource, Cut, DrawingMesh, DrawingOptions, SpaceInput, SvgOptions, draw, draw_with_spaces,
    to_svg, to_svg_with,
};
use common::{cuboid, v};

const ELEMENTS: [&str; 9] = [
    "svg", "g", "path", "line", "polyline", "polygon", "circle", "text", "tspan",
];

const ATTRIBUTES: [&str; 17] = [
    "xmlns",
    "width",
    "height",
    "viewBox",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linejoin",
    "stroke-dasharray",
    "font-size",
    "d",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
];

/// Every element name the document opens.
fn elements(svg: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = svg;
    while let Some(start) = rest.find('<') {
        rest = &rest[start + 1..];
        let name: String = rest
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric())
            .collect();
        if !name.is_empty() {
            found.push(name);
        }
    }
    found
}

/// Every attribute name, taken from inside the tags.
fn attributes(svg: &str) -> Vec<String> {
    let mut found = Vec::new();
    for tag in svg.split('<').skip(1) {
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let body = tag.split('>').next().unwrap_or("");
        for token in body.split_whitespace().skip(1) {
            if let Some((name, _)) = token.split_once('=') {
                found.push(name.trim_end_matches('/').to_string());
            }
        }
    }
    found
}

fn drawing_with(layer: &str) -> cad_slicer::Drawing {
    let item = DrawingMesh::new(1, 1, layer, cuboid(v(0.0, 0.0, 0.0), v(4.0, 3.0, 2.0)));
    draw(&[item], &DrawingOptions::cut_only(Cut::Plan { z: 1.0 }))
}

#[test]
fn only_whitelisted_elements_and_attributes_appear() {
    let svg = to_svg(&drawing_with("Muros"));
    assert!(svg.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg "));
    assert!(svg.ends_with("</svg>\n"));

    let names = elements(&svg);
    assert!(!names.is_empty());
    for name in &names {
        assert!(ELEMENTS.contains(&name.as_str()), "{name} is not whitelisted");
    }
    for name in attributes(&svg) {
        assert!(
            ATTRIBUTES.contains(&name.as_str()),
            "attribute {name} is not whitelisted"
        );
    }
    for forbidden in [
        "<style",
        "<use",
        "<image",
        "<a ",
        "<animate",
        "<set",
        "<foreignObject",
        "href",
        "onload",
        "onclick",
        "DOCTYPE",
        "ENTITY",
    ] {
        assert!(!svg.contains(forbidden), "{forbidden} must never be written");
    }
}

#[test]
fn a_hostile_layer_name_is_escaped_text_and_nothing_else() {
    let hostile = "Evil <script>alert(\"x\")</script> & 'quoted'";
    let drawing = drawing_with(hostile);
    let options = SvgOptions { layer_labels: true, ..SvgOptions::default() };
    let svg = to_svg_with(&drawing, &options);

    assert!(!svg.contains("<script"), "the name opened an element");
    assert!(
        svg.contains("Evil &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;quoted&apos;"),
        "{svg}"
    );
    // The name never reaches an attribute, so it cannot become a handler or a URL.
    for name in attributes(&svg) {
        assert!(
            ATTRIBUTES.contains(&name.as_str()),
            "attribute {name} came from the name"
        );
    }
    for name in elements(&svg) {
        assert!(ELEMENTS.contains(&name.as_str()));
    }
}

#[test]
fn control_characters_are_removed() {
    let drawing = drawing_with("Muro\u{0001}\u{0007}Alto");
    let svg = to_svg_with(&drawing, &SvgOptions { layer_labels: true, ..SvgOptions::default() });
    assert!(svg.contains(">MuroAlto<"), "{svg}");
    assert!(!svg.contains('\u{0001}'));
}

#[test]
fn the_sheet_covers_the_cut() {
    let svg = to_svg(&drawing_with("Muros"));
    let view_box = svg
        .split("viewBox=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("a viewBox");
    let values: Vec<f64> = view_box
        .split_whitespace()
        .map(|value| value.parse().expect("a number"))
        .collect();
    assert_eq!(values.len(), 4);
    // 4 by 3 metres plus a 2 % margin of the 4 m span on each side: 4.16 by 3.16.
    assert!((values[2] - 4.16).abs() < 1e-3, "{view_box}");
    assert!((values[3] - 3.16).abs() < 1e-3, "{view_box}");

    // One closed path with the eight points of the cut.
    let paths: Vec<&str> = svg.match_indices("<path d=\"").map(|(at, _)| &svg[at..]).collect();
    assert_eq!(paths.len(), 1, "{svg}");
    let commands = paths[0].matches(" L ").count();
    assert_eq!(commands, 7, "M plus seven L: eight corners");
    assert!(paths[0].contains(" Z\""));
}

#[test]
fn without_labels_the_layer_name_does_not_appear() {
    let svg = to_svg(&drawing_with("Muros"));
    assert!(!svg.contains("Muros"));
}


#[test]
fn a_sheet_opens_at_a_printed_scale() {
    // 40 by 20 m plus 2% of 40 on each side, at 1:100.
    let meshes = [DrawingMesh::new(1, 1, "wall", cuboid(v(0.0, 0.0, 0.0), v(40.0, 20.0, 3.0)))];
    let drawing = draw(&meshes, &DrawingOptions::cut_only(Cut::Plan { z: 1.0 }));
    let svg = to_svg(&drawing);
    assert!(svg.contains(r#"width="416.0000mm" height="216.0000mm" viewBox="0 0 41.6000 21.6000""#), "{}", &svg[..200]);

    // The same sheet in millimetres keeps its printed size.
    let options = SvgOptions { millimetres_per_unit: 0.01, ..SvgOptions::default() };
    let svg = to_svg_with(&drawing.scaled(1000.0), &options);
    assert!(svg.contains(r#"width="416.0000mm""#), "{}", &svg[..200]);
}

#[test]
fn space_labels_render_whitelisted_svg_with_escaped_name_and_area() {
    let walls = [DrawingMesh::new(1, 1, "Muros", cuboid(v(0.0, 0.0, 0.0), v(10.0, 8.0, 3.0)))];
    let spaces = [SpaceInput {
        model_id: 1,
        element_id: 42,
        name: "Sala <A> & B".into(),
        quantity_area_m2: Some(69.56),
        mesh: cuboid(v(0.3, 0.3, 0.0), v(9.7, 7.7, 3.0)),
    }];
    let drawing = draw_with_spaces(&walls, &spaces, &DrawingOptions::cut_only(Cut::Plan { z: 1.5 }));
    assert_eq!(drawing.spaces.len(), 1);
    assert_eq!(drawing.spaces[0].area_source, AreaSource::Quantity);
    let svg = to_svg(&drawing);
    assert!(svg.contains(">Sala &lt;A&gt; &amp; B<"), "{svg}");
    assert!(svg.contains(">69.56 m²<"), "{svg}");
    for name in elements(&svg) {
        assert!(ELEMENTS.contains(&name.as_str()), "{name} is not whitelisted");
    }
    for name in attributes(&svg) {
        assert!(ATTRIBUTES.contains(&name.as_str()), "attribute {name} is not whitelisted");
    }
}

#[test]
fn overall_dimensions_render_whitelisted_lines_and_bounding_box_text() {
    let walls = [DrawingMesh::new(1, 1, "Muros", cuboid(v(0.0, 0.0, 0.0), v(10.0, 8.0, 3.0)))];
    let mut drawing = draw(&walls, &DrawingOptions::cut_only(Cut::Plan { z: 1.5 }));
    drawing.compute_overall_dimensions();
    assert!(drawing.dimensions.is_some());
    let svg = to_svg(&drawing);
    assert!(svg.contains("<line "), "expected <line> elements for dimensions: {svg}");
    assert!(svg.contains(">10.00 m<"), "expected width 10.00 m: {svg}");
    assert!(svg.contains(">8.00 m<"), "expected height 8.00 m: {svg}");
    for name in elements(&svg) {
        assert!(ELEMENTS.contains(&name.as_str()), "{name} is not whitelisted");
    }
    for name in attributes(&svg) {
        assert!(ATTRIBUTES.contains(&name.as_str()), "attribute {name} is not whitelisted");
    }
}