//! SVG export under the whitelist of §5 of `docs/05_kernel_contract.md`.
//!
//! The panel inserts this with `dangerouslySetInnerHTML` and the names come from the IFC file,
//! so the writer can only emit the permitted elements and a fixed set of attributes that it
//! computes itself. A name from the file appears as escaped text and nowhere else.

use crate::text::xml_text;
use crate::{Drawing, Loop, Segment};
use glam::DVec2;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SvgOptions {
    /// Writes one line of text per layer below the drawing. Off by default: a drawing for a
    /// customer does not carry its layer list.
    pub layer_labels: bool,
    pub include_hidden: bool,
    pub include_hatch: bool,
    /// Printed size of one drawing unit, so the file opens at a scale rather than as a speck:
    /// a browser reads a bare width of 40 as 40 pixels. 10 is 1:100 for a drawing in metres.
    pub millimetres_per_unit: f64,
}

impl Default for SvgOptions {
    fn default() -> Self {
        Self {
            layer_labels: false,
            include_hidden: true,
            include_hatch: true,
            millimetres_per_unit: 10.0,
        }
    }
}

/// Share of the drawing's longest side left blank around it.
const MARGIN_FRACTION: f64 = 0.02;

pub fn to_svg(drawing: &Drawing) -> String {
    to_svg_with(drawing, &SvgOptions::default())
}

pub fn to_svg_with(drawing: &Drawing, options: &SvgOptions) -> String {
    let (low, high) = bounds(drawing);
    let span = (high - low).max_element().max(1e-3);
    let margin = (span * MARGIN_FRACTION).max(0.01);
    let stroke = (span / 1000.0).clamp(0.0005, 0.05);
    let font = (span / 50.0).clamp(0.002, 0.5);

    let named: Vec<&crate::Layer> = crate::used_layers(drawing).collect();
    let labels = if options.layer_labels { named.len() } else { 0 };
    let label_height = labels as f64 * font * 1.4;

    let width = high.x - low.x + margin * 2.0;
    let height = high.y - low.y + margin * 2.0 + label_height;
    let place = |point: DVec2| -> Option<DVec2> {
        if !point.is_finite() {
            return None;
        }
        // SVG counts Y downwards, the sheet upwards.
        Some(DVec2::new(
            point.x - low.x + margin,
            high.y - point.y + margin,
        ))
    };

    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}mm\" height=\"{}mm\" viewBox=\"0 0 {} {}\">\n",
        number(width * options.millimetres_per_unit),
        number(height * options.millimetres_per_unit),
        number(width),
        number(height)
    ));

    // Cut outlines and visible edges.
    out.push_str(&format!(
        "<g fill=\"none\" stroke=\"#1a1a1a\" stroke-width=\"{}\" stroke-linejoin=\"round\">\n",
        number(stroke)
    ));
    for layer in &named {
        let mut path = String::new();
        for ring in &layer.loops {
            push_ring(&mut path, ring, place);
        }
        for segment in &layer.visible {
            push_segment(&mut path, segment, place);
        }
        if !path.is_empty() {
            out.push_str(&format!("<path d=\"{path}\"/>\n"));
        }
    }
    out.push_str("</g>\n");

    if options.include_hidden && named.iter().any(|layer| !layer.hidden.is_empty()) {
        out.push_str(&format!(
            "<g fill=\"none\" stroke=\"#8a8a8a\" stroke-width=\"{}\" stroke-dasharray=\"{} {}\">\n",
            number(stroke),
            number(stroke * 6.0),
            number(stroke * 3.0)
        ));
        let mut path = String::new();
        for layer in &named {
            for segment in &layer.hidden {
                push_segment(&mut path, segment, place);
            }
        }
        if !path.is_empty() {
            out.push_str(&format!("<path d=\"{path}\"/>\n"));
        }
        out.push_str("</g>\n");
    }

    if options.include_hatch && named.iter().any(|layer| !layer.hatch.is_empty()) {
        out.push_str(&format!(
            "<g fill=\"none\" stroke=\"#555555\" stroke-width=\"{}\">\n",
            number(stroke * 0.6)
        ));
        let mut path = String::new();
        for layer in &named {
            for segment in &layer.hatch {
                push_segment(&mut path, segment, place);
            }
        }
        if !path.is_empty() {
            out.push_str(&format!("<path d=\"{path}\"/>\n"));
        }
        out.push_str("</g>\n");
    }

    if labels > 0 {
        out.push_str(&format!(
            "<g fill=\"#1a1a1a\" stroke=\"none\" font-size=\"{}\">\n",
            number(font)
        ));
        for (index, layer) in named.iter().enumerate() {
            let y = height - label_height + index as f64 * font * 1.4 + font;
            out.push_str(&format!(
                "<text x=\"{}\" y=\"{}\">{}</text>\n",
                number(margin),
                number(y),
                xml_text(&layer.name)
            ));
        }
        out.push_str("</g>\n");
    }

    out.push_str("</svg>\n");
    out
}

fn push_ring(path: &mut String, ring: &Loop, place: impl Fn(DVec2) -> Option<DVec2>) {
    if ring.points.len() < 2 {
        return;
    }
    let mut started = false;
    for point in &ring.points {
        let Some(point) = place(*point) else {
            continue;
        };
        if started {
            path.push_str(" L ");
        } else {
            path.push_str("M ");
            started = true;
        }
        push_number(path, point.x);
        path.push(' ');
        push_number(path, point.y);
    }
    if started && ring.closed {
        path.push_str(" Z");
    }
}

fn push_segment(path: &mut String, segment: &Segment, place: impl Fn(DVec2) -> Option<DVec2>) {
    let (Some(from), Some(to)) = (place(segment.a), place(segment.b)) else {
        return;
    };
    path.push_str("M ");
    push_number(path, from.x);
    path.push(' ');
    push_number(path, from.y);
    path.push_str(" L ");
    push_number(path, to.x);
    path.push(' ');
    push_number(path, to.y);
}

#[inline]
fn push_number(out: &mut String, value: f64) {
    if !value.is_finite() {
        out.push('0');
        return;
    }
    crate::fixed::push_fixed_clean(out, value, 4);
}

/// Four decimals in metres is 0.1 mm, and always the same string for the same number.
fn number(value: f64) -> String {
    let mut out = String::with_capacity(16);
    push_number(&mut out, value);
    out
}

fn bounds(drawing: &Drawing) -> (DVec2, DVec2) {
    let mut low = DVec2::splat(f64::MAX);
    let mut high = DVec2::splat(f64::MIN);
    let mut take = |point: DVec2| {
        if point.is_finite() {
            low = low.min(point);
            high = high.max(point);
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
    if low.x > high.x {
        (DVec2::ZERO, DVec2::ZERO)
    } else {
        (low, high)
    }
}
