//! DXF R12 writer, following §5 of `docs/05_kernel_contract.md`.
//!
//! The file is bytes, not text: `$ACADVER` is `AC1009`, `$DWGCODEPAGE` is `ANSI_1252`, every
//! line ends in CRLF and every group value is encoded in CP1252. Nothing that could end a
//! line early or land on an undefined byte reaches the file.

use crate::text::dxf_bytes;
use crate::Drawing;
use std::collections::BTreeSet;

/// Longest R12 group value.
const MAX_VALUE: usize = 255;
/// Longest R12 layer name.
const MAX_LAYER: usize = 31;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DxfOptions {
    /// Dashed geometry goes on its own layer.
    pub include_hidden: bool,
    pub include_hatch: bool,
    /// Written as a 999 comment at the top of the file, sanitised like any group value.
    pub comment: Option<String>,
}

impl Default for DxfOptions {
    fn default() -> Self {
        Self {
            include_hidden: true,
            include_hatch: true,
            comment: None,
        }
    }
}

pub fn to_dxf(drawing: &Drawing) -> Vec<u8> {
    to_dxf_with(drawing, &DxfOptions::default())
}

/// Writes the drawing. Layers with nothing on them are left out of the table.
pub fn to_dxf_with(drawing: &Drawing, options: &DxfOptions) -> Vec<u8> {
    let mut names = Names::default();
    let mut layers: Vec<Planned> = Vec::new();
    for layer in crate::used_layers(drawing) {
        let hatch = options.include_hatch && !layer.hatch.is_empty();
        let hidden = options.include_hidden && !layer.hidden.is_empty();
        if layer.loops.is_empty() && layer.visible.is_empty() && !hatch && !hidden {
            continue;
        }
        let name = names.assign(&layer.name);
        let hidden_name = hidden.then(|| names.assign(&format!("{}-HIDDEN", layer.name)));
        layers.push(Planned {
            name,
            hidden: hidden_name,
            layer,
        });
    }

    let space_layer = (!drawing.spaces.is_empty()).then(|| names.assign("SPACES"));

    let mut out = Writer::default();
    if let Some(comment) = &options.comment {
        out.text(999, comment);
    }
    out.header(drawing);
    out.layer_table(&layers, space_layer.as_deref());
    out.section("ENTITIES");
    for planned in &layers {
        let name_bytes = dxf_bytes(&planned.name, MAX_VALUE);
        for ring in &planned.layer.loops {
            for (from, to) in ring.segments() {
                out.line_bytes(&name_bytes, from, to);
            }
        }
        for segment in &planned.layer.visible {
            out.line_bytes(&name_bytes, segment.a, segment.b);
        }
        if options.include_hatch {
            for segment in &planned.layer.hatch {
                out.line_bytes(&name_bytes, segment.a, segment.b);
            }
        }
        if let Some(hidden) = &planned.hidden {
            let hidden_bytes = dxf_bytes(hidden, MAX_VALUE);
            for segment in &planned.layer.hidden {
                out.line_bytes(&hidden_bytes, segment.a, segment.b);
            }
        }
    }
    if let Some(space_layer) = &space_layer {
        let (low, high) = bounds(drawing);
        let span = (high.0 - low.0).max(high.1 - low.1).max(1.0);
        let text_height = (span / 60.0).clamp(span * 0.005, span * 0.03);
        let layer_bytes = dxf_bytes(space_layer, MAX_VALUE);
        for space in &drawing.spaces {
            if !space.position.is_finite() {
                continue;
            }
            let name_pos = glam::DVec2::new(space.position.x, space.position.y + text_height * 0.65);
            let area_pos = glam::DVec2::new(space.position.x, space.position.y - text_height * 0.65);
            let area_text = format!("{:.2} m²", space.area_m2);
            out.centered_text(&layer_bytes, name_pos, text_height, &space.name);
            out.centered_text(&layer_bytes, area_pos, text_height, &area_text);
        }
    }
    out.end_section();
    out.group(0, b"EOF");
    out.bytes
}

struct Planned<'a> {
    name: String,
    hidden: Option<String>,
    layer: &'a crate::Layer,
}

#[derive(Default)]
struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    fn group(&mut self, code: i16, value: &[u8]) {
        self.bytes.extend_from_slice(code.to_string().as_bytes());
        self.bytes.extend_from_slice(b"\r\n");
        self.bytes.extend_from_slice(value);
        self.bytes.extend_from_slice(b"\r\n");
    }

    fn text(&mut self, code: i16, value: &str) {
        let bytes = dxf_bytes(value, MAX_VALUE);
        self.group(code, &bytes);
    }

    fn number(&mut self, code: i16, value: f64) {
        self.bytes.extend_from_slice(code.to_string().as_bytes());
        self.bytes.extend_from_slice(b"\r\n");
        push_format_number(&mut self.bytes, value);
        self.bytes.extend_from_slice(b"\r\n");
    }

    fn integer(&mut self, code: i16, value: i64) {
        let text = value.to_string();
        self.group(code, text.as_bytes());
    }

    fn section(&mut self, name: &str) {
        self.group(0, b"SECTION");
        self.text(2, name);
    }

    fn end_section(&mut self) {
        self.group(0, b"ENDSEC");
    }

    fn header(&mut self, drawing: &Drawing) {
        let (low, high) = bounds(drawing);
        self.section("HEADER");
        self.text(9, "$ACADVER");
        self.text(1, "AC1009");
        self.text(9, "$DWGCODEPAGE");
        self.text(3, "ANSI_1252");
        self.text(9, "$EXTMIN");
        self.number(10, low.0);
        self.number(20, low.1);
        self.number(30, 0.0);
        self.text(9, "$EXTMAX");
        self.number(10, high.0);
        self.number(20, high.1);
        self.number(30, 0.0);
        self.end_section();
    }

    /// Layers can only name a linetype that the file defines.
    fn linetype_table(&mut self) {
        self.group(0, b"TABLE");
        self.text(2, "LTYPE");
        self.integer(70, 2);
        self.linetype_entry("CONTINUOUS", "Solid line", &[]);
        self.linetype_entry("DASHED", "Dashed", &[0.5, -0.25]);
        self.group(0, b"ENDTAB");
    }

    /// `pattern` holds dash lengths in drawing units, negative for gaps.
    fn linetype_entry(&mut self, name: &str, description: &str, pattern: &[f64]) {
        self.group(0, b"LTYPE");
        self.text(2, name);
        self.integer(70, 0);
        self.text(3, description);
        self.integer(72, 65);
        self.integer(73, pattern.len() as i64);
        self.number(40, pattern.iter().map(|dash| dash.abs()).sum());
        for dash in pattern {
            self.number(49, *dash);
        }
    }

    fn layer_table(&mut self, layers: &[Planned], space_layer: Option<&str>) {
        self.section("TABLES");
        self.linetype_table();
        self.group(0, b"TABLE");
        self.text(2, "LAYER");
        // A hidden layer is an entry of the table too, so the count covers every kind.
        let entries = layers.len()
            + layers.iter().filter(|planned| planned.hidden.is_some()).count()
            + usize::from(space_layer.is_some());
        self.integer(70, entries as i64);
        for planned in layers {
            self.layer_entry(&planned.name, 7, "CONTINUOUS");
            if let Some(hidden) = &planned.hidden {
                self.layer_entry(hidden, 8, "DASHED");
            }
        }
        if let Some(space_layer) = space_layer {
            self.layer_entry(space_layer, 3, "CONTINUOUS");
        }
        self.group(0, b"ENDTAB");
        self.end_section();
    }

    fn layer_entry(&mut self, name: &str, colour: u8, linetype: &str) {
        self.group(0, b"LAYER");
        self.text(2, name);
        self.integer(70, 0);
        self.integer(62, colour as i64);
        self.text(6, linetype);
    }

    fn line_bytes(&mut self, layer: &[u8], from: glam::DVec2, to: glam::DVec2) {
        self.bytes.extend_from_slice(b"0\r\nLINE\r\n8\r\n");
        self.bytes.extend_from_slice(layer);
        self.bytes.extend_from_slice(b"\r\n10\r\n");
        push_format_number(&mut self.bytes, from.x);
        self.bytes.extend_from_slice(b"\r\n20\r\n");
        push_format_number(&mut self.bytes, from.y);
        self.bytes.extend_from_slice(b"\r\n30\r\n0.000000\r\n11\r\n");
        push_format_number(&mut self.bytes, to.x);
        self.bytes.extend_from_slice(b"\r\n21\r\n");
        push_format_number(&mut self.bytes, to.y);
        self.bytes.extend_from_slice(b"\r\n31\r\n0.000000\r\n");
    }

    fn centered_text(&mut self, layer: &[u8], pos: glam::DVec2, height: f64, value: &str) {
        self.bytes.extend_from_slice(b"0\r\nTEXT\r\n8\r\n");
        self.bytes.extend_from_slice(layer);
        self.bytes.extend_from_slice(b"\r\n10\r\n");
        push_format_number(&mut self.bytes, pos.x);
        self.bytes.extend_from_slice(b"\r\n20\r\n");
        push_format_number(&mut self.bytes, pos.y);
        self.bytes.extend_from_slice(b"\r\n30\r\n0.000000\r\n40\r\n");
        push_format_number(&mut self.bytes, height);
        self.bytes.extend_from_slice(b"\r\n1\r\n");
        self.bytes.extend_from_slice(&dxf_bytes(value, MAX_VALUE));
        self.bytes.extend_from_slice(b"\r\n72\r\n1\r\n11\r\n");
        push_format_number(&mut self.bytes, pos.x);
        self.bytes.extend_from_slice(b"\r\n21\r\n");
        push_format_number(&mut self.bytes, pos.y);
        self.bytes.extend_from_slice(b"\r\n31\r\n0.000000\r\n");
    }
}

/// Six decimals is a micrometre: far finer than any drawing, and short enough to read.
#[inline]
fn push_format_number(out: &mut Vec<u8>, value: f64) {
    if !value.is_finite() {
        out.extend_from_slice(b"0.000000");
        return;
    }
    crate::fixed::push_fixed_clean_bytes(out, value, 6);
}

/// Everything the drawing draws, in drawing coordinates.
fn bounds(drawing: &Drawing) -> ((f64, f64), (f64, f64)) {
    let mut low = (f64::MAX, f64::MAX);
    let mut high = (f64::MIN, f64::MIN);
    let mut take = |point: glam::DVec2| {
        if point.is_finite() {
            low = (low.0.min(point.x), low.1.min(point.y));
            high = (high.0.max(point.x), high.1.max(point.y));
        }
    };
    for layer in &drawing.layers {
        for ring in &layer.loops {
            ring.points.iter().copied().for_each(&mut take);
        }
        for segment in layer
            .visible
            .iter()
            .chain(&layer.hidden)
            .chain(&layer.hatch)
        {
            take(segment.a);
            take(segment.b);
        }
    }
    for space in &drawing.spaces {
        take(space.position);
    }
    if low.0 > high.0 {
        ((0.0, 0.0), (0.0, 0.0))
    } else {
        (low, high)
    }
}

/// Hands out R12 layer names: cleaned, cut to 31 characters and never shared.
#[derive(Default)]
struct Names {
    used: BTreeSet<String>,
}

impl Names {
    fn assign(&mut self, raw: &str) -> String {
        let base = clean(raw);
        // AutoCAD compares layer names without case.
        if self.used.insert(base.to_lowercase()) {
            return base;
        }
        // Cut first, then add the suffix: two long names that share a prefix stay distinct.
        for suffix in 1..=9999 {
            let suffix = format!("-{suffix}");
            let keep = MAX_LAYER.saturating_sub(suffix.len());
            let mut candidate: String = base.chars().take(keep).collect();
            candidate.push_str(&suffix);
            if self.used.insert(candidate.to_lowercase()) {
                return candidate;
            }
        }
        "LAYER".into()
    }
}

/// R12 allows letters, digits and `$ _ - .` in a layer name, up to 31 of them.
fn clean(raw: &str) -> String {
    let mut out = String::new();
    for character in raw.chars() {
        if out.len() >= MAX_LAYER {
            break;
        }
        if character.is_ascii_alphanumeric() || matches!(character, '$' | '_' | '-' | '.') {
            out.push(character);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("LAYER");
    }
    out
}
