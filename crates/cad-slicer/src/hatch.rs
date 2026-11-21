//! Hatching of the cut loops.
//!
//! # The rule
//!
//! A caller that has `IfcFillAreaStyleHatching` passes its own [`HatchStyle`]s, one per row of
//! lines, so two rows cross. Without one the style comes from the layer or material name, in
//! this order:
//!
//! 1. The name is lowercased and searched for one of the keywords below, in table order. The
//!    first hit wins, so the result depends on the name alone, never on the element order.
//! 2. A name with no keyword takes one of four fallback patterns, chosen by FNV-1a over the
//!    lowercased name. The hash is part of the drawing, not of the process: the same model
//!    always draws the same hatch.
//!
//! Lines are spaced `spacing` metres apart at `angle_degrees` counter-clockwise from the
//! sheet's X axis. A line is clipped against every loop of its element by the even-odd rule,
//! so material is filled and holes are left empty without looking for containment.

use crate::geom::{Loop, Segment};
use glam::DVec2;

/// Lines one element may receive, all its rows together, before the hatch stops and says so.
const MAX_HATCH_LINES: usize = 4096;
/// Closest spacing a caller may ask for. Metres.
const MIN_SPACING: f64 = 0.005;
/// Widest spacing worth generating. Metres.
const MAX_SPACING: f64 = 10.0;

/// A hatch pattern: parallel lines at an angle, in metres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HatchStyle {
    /// Counter-clockwise from the sheet's X axis.
    pub angle_degrees: f64,
    pub spacing: f64,
    /// From the sheet's origin to a line, across the lines.
    pub offset: f64,
}

impl HatchStyle {
    pub fn new(angle_degrees: f64, spacing: f64) -> Self {
        Self {
            angle_degrees,
            spacing,
            offset: 0.0,
        }
    }

    pub fn shifted(self, offset: f64) -> Self {
        Self { offset, ..self }
    }
}

/// Name keywords, angle in degrees and spacing in metres. Order matters: the first hit wins.
const KEYWORDS: [(&str, f64, f64); 22] = [
    ("hormig", 45.0, 0.20),
    ("formig", 45.0, 0.20),
    ("concret", 45.0, 0.20),
    ("ladrill", 45.0, 0.12),
    ("masonry", 45.0, 0.12),
    ("brick", 45.0, 0.12),
    ("fabric", 45.0, 0.12),
    ("fábric", 45.0, 0.12),
    ("acero", 45.0, 0.05),
    ("aceiro", 45.0, 0.05),
    ("steel", 45.0, 0.05),
    ("metal", 45.0, 0.05),
    ("mader", 90.0, 0.10),
    ("madeir", 90.0, 0.10),
    ("wood", 90.0, 0.10),
    ("aisl", 30.0, 0.15),
    ("illament", 30.0, 0.15),
    ("insulat", 30.0, 0.15),
    ("vidrio", 0.0, 0.25),
    ("vidro", 0.0, 0.25),
    ("glass", 0.0, 0.25),
    ("terreno", 45.0, 0.30),
];

/// Patterns for names the keyword table does not know: angle in degrees and spacing in metres.
const FALLBACK: [(f64, f64); 4] = [(45.0, 0.20), (-45.0, 0.20), (0.0, 0.15), (90.0, 0.15)];

/// The deterministic style for a layer or material name.
pub(crate) fn style_for(name: &str) -> HatchStyle {
    let lower = name.to_lowercase();
    for (keyword, angle, spacing) in KEYWORDS {
        if lower.contains(keyword) {
            return HatchStyle::new(angle, spacing);
        }
    }
    let (angle, spacing) = FALLBACK[(fnv1a(lower.as_bytes()) % FALLBACK.len() as u64) as usize];
    HatchStyle::new(angle, spacing)
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HatchReport {
    /// A given style was unusable and was left out. If none was left, the name's rule took over.
    pub bad_style: bool,
    pub truncated: bool,
}

/// Fills the closed loops, keeping out of the holes: one row of lines per given style, or the
/// name's rule when none is usable.
pub(crate) fn hatch_loops(
    loops: &[Loop],
    requested: &[HatchStyle],
    name: &str,
    out: &mut Vec<Segment>,
) -> HatchReport {
    let mut report = HatchReport::default();
    let mut styles: Vec<HatchStyle> = requested
        .iter()
        .copied()
        .filter(|style| {
            style.angle_degrees.is_finite()
                && style.spacing.is_finite()
                && style.spacing > 0.0
                && style.offset.is_finite()
        })
        .collect();
    report.bad_style = styles.len() < requested.len();
    if styles.is_empty() {
        styles.push(style_for(name));
    }
    let mut budget = MAX_HATCH_LINES;
    for style in styles {
        budget -= hatch_row(loops, style, budget, out, &mut report);
    }
    report
}

/// One row of parallel lines, at most `budget` of them. Returns how many it drew.
fn hatch_row(
    loops: &[Loop],
    style: HatchStyle,
    budget: usize,
    out: &mut Vec<Segment>,
    report: &mut HatchReport,
) -> usize {
    let spacing = style.spacing.clamp(MIN_SPACING, MAX_SPACING);
    let angle = style.angle_degrees.to_radians();
    let direction = DVec2::new(angle.cos(), angle.sin());
    let normal = DVec2::new(-direction.y, direction.x);

    let mut low = f64::MAX;
    let mut high = f64::MIN;
    for ring in loops.iter().filter(|ring| ring.closed && ring.points.len() >= 3) {
        for point in &ring.points {
            let across = normal.dot(*point);
            low = low.min(across);
            high = high.max(across);
        }
    }
    if !(low.is_finite() && high.is_finite()) || high < low {
        return 0;
    }

    // Lines are anchored at the sheet's origin, shifted by the style's offset, so neighbouring
    // elements on a layer hatch continuously. A line lying on the boundary itself is left out.
    let margin = 1e-9;
    let shift = style.offset.rem_euclid(spacing);
    let first = ((low - shift + margin) / spacing).ceil() as i64;
    let mut last = ((high - shift - margin) / spacing).floor() as i64;
    if last < first {
        return 0;
    }
    if last.abs_diff(first) >= budget as u64 {
        report.truncated = true;
        if budget == 0 {
            return 0;
        }
        last = first + budget as i64 - 1;
    }

    let mut cuts: Vec<f64> = Vec::new();
    for line in first..=last {
        let offset = shift + line as f64 * spacing;
        cuts.clear();
        for ring in loops.iter().filter(|ring| ring.closed && ring.points.len() >= 3) {
            for (from, to) in ring.segments() {
                let at_from = normal.dot(from) - offset;
                let at_to = normal.dot(to) - offset;
                // Half open: a vertex exactly on the line is counted once.
                let crosses = (at_from <= 0.0 && at_to > 0.0) || (at_to <= 0.0 && at_from > 0.0);
                if crosses {
                    let t = at_from / (at_from - at_to);
                    cuts.push(direction.dot(from.lerp(to, t)));
                }
            }
        }
        cuts.sort_by(f64::total_cmp);
        for pair in cuts.as_chunks::<2>().0 {
            if pair[1] - pair[0] <= 1e-9 {
                continue;
            }
            out.push(Segment::new(
                normal * offset + direction * pair[0],
                normal * offset + direction * pair[1],
            ));
        }
    }
    (last - first) as usize + 1
}
