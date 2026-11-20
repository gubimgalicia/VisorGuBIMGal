//! Overall bounding-box dimensions on two sides (bottom and left) of a 2D plan.

use crate::geom::Segment;
use crate::Layer;
use glam::DVec2;

/// Bounding-box overall dimensions in drawing coordinates, keeping exact metre labels across scaling.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OverallDimensions {
    pub min: DVec2,
    pub max: DVec2,
    /// Horizontal overall extent (sheet X), in metres.
    pub width_m: f64,
    /// Vertical overall extent (sheet Y), in metres.
    pub height_m: f64,
}

/// Geometry and metadata for one linear dimension (horizontal or vertical).
#[derive(Debug, Clone, PartialEq)]
pub struct LinearDimension {
    pub origin_a: DVec2,
    pub origin_b: DVec2,
    pub def_point: DVec2,
    pub text_pos: DVec2,
    pub text: String,
    /// Rotation angle in degrees for DXF `DIMENSION` group 50 (0 horizontal, 90 vertical).
    pub angle_degrees: f64,
    pub lines: Vec<Segment>,
}

/// Ready-to-draw overall dimension primitives for SVG and DXF writers.
#[derive(Debug, Clone, PartialEq)]
pub struct DimensionLayout {
    pub horizontal: Option<LinearDimension>,
    pub vertical: Option<LinearDimension>,
    pub text_height: f64,
    /// Minimum corner enclosing both dimension lines and their labels, in drawing coordinates.
    pub bounds_min: DVec2,
}

const MIN_EXTENT: f64 = 1e-6;

/// Computes overall dimensions from the drawing's geometry layers.
pub(crate) fn compute_overall(layers: &[Layer]) -> Option<OverallDimensions> {
    let mut low = DVec2::splat(f64::MAX);
    let mut high = DVec2::splat(f64::MIN);
    let mut take = |p: DVec2| {
        if p.is_finite() {
            low = low.min(p);
            high = high.max(p);
        }
    };
    for layer in layers {
        for ring in &layer.loops {
            ring.points.iter().copied().for_each(&mut take);
        }
        for seg in layer
            .visible
            .iter()
            .chain(&layer.hidden)
            .chain(&layer.hatch)
        {
            take(seg.a);
            take(seg.b);
        }
    }
    if low.x > high.x || low.y > high.y {
        return None;
    }
    let width_m = high.x - low.x;
    let height_m = high.y - low.y;
    if width_m <= MIN_EXTENT && height_m <= MIN_EXTENT {
        return None;
    }
    Some(OverallDimensions { min: low, max: high, width_m, height_m })
}

impl OverallDimensions {
    /// Builds bottom (X) and left (Y) overall dimension lines, ticks and label positions.
    pub(crate) fn layout(&self) -> DimensionLayout {
        let dx = (self.max.x - self.min.x).max(0.0);
        let dy = (self.max.y - self.min.y).max(0.0);
        let span = dx.max(dy).max(1e-3);
        let offset = span * 0.08;
        let gap = offset * 0.2;
        let overshoot = offset * 0.25;
        let tick = offset * 0.16;
        let text_height = (span / 45.0).clamp(span * 0.012, span * 0.04);

        let mut bounds_min = self.min;

        let horizontal = (dx > MIN_EXTENT).then(|| {
            let y_dim = self.min.y - offset;
            let text = format!("{:.2} m", self.width_m);
            let lines = vec![
                // Extension lines
                Segment::new(DVec2::new(self.min.x, self.min.y - gap), DVec2::new(self.min.x, y_dim - overshoot)),
                Segment::new(DVec2::new(self.max.x, self.min.y - gap), DVec2::new(self.max.x, y_dim - overshoot)),
                // Main dimension line
                Segment::new(DVec2::new(self.min.x, y_dim), DVec2::new(self.max.x, y_dim)),
                // 45-degree architectural ticks
                Segment::new(DVec2::new(self.min.x - tick, y_dim - tick), DVec2::new(self.min.x + tick, y_dim + tick)),
                Segment::new(DVec2::new(self.max.x - tick, y_dim - tick), DVec2::new(self.max.x + tick, y_dim + tick)),
            ];
            let text_pos = DVec2::new((self.min.x + self.max.x) * 0.5, y_dim - text_height * 1.15);
            bounds_min.y = bounds_min.y.min(text_pos.y - text_height * 0.8);
            LinearDimension {
                origin_a: DVec2::new(self.min.x, self.min.y),
                origin_b: DVec2::new(self.max.x, self.min.y),
                def_point: DVec2::new(self.max.x, y_dim),
                text_pos,
                text,
                angle_degrees: 0.0,
                lines,
            }
        });

        let vertical = (dy > MIN_EXTENT).then(|| {
            let x_dim = self.min.x - offset;
            let text = format!("{:.2} m", self.height_m);
            let lines = vec![
                // Extension lines
                Segment::new(DVec2::new(self.min.x - gap, self.min.y), DVec2::new(x_dim - overshoot, self.min.y)),
                Segment::new(DVec2::new(self.min.x - gap, self.max.y), DVec2::new(x_dim - overshoot, self.max.y)),
                // Main dimension line
                Segment::new(DVec2::new(x_dim, self.min.y), DVec2::new(x_dim, self.max.y)),
                // 45-degree architectural ticks
                Segment::new(DVec2::new(x_dim - tick, self.min.y - tick), DVec2::new(x_dim + tick, self.min.y + tick)),
                Segment::new(DVec2::new(x_dim - tick, self.max.y - tick), DVec2::new(x_dim + tick, self.max.y + tick)),
            ];
            let est_width = text.chars().count() as f64 * text_height * 0.58;
            let text_pos = DVec2::new(x_dim - overshoot - est_width * 0.5 - text_height * 0.3, (self.min.y + self.max.y) * 0.5);
            bounds_min.x = bounds_min.x.min(text_pos.x - est_width * 0.55);
            LinearDimension {
                origin_a: DVec2::new(self.min.x, self.min.y),
                origin_b: DVec2::new(self.min.x, self.max.y),
                def_point: DVec2::new(x_dim, self.max.y),
                text_pos,
                text,
                angle_degrees: 90.0,
                lines,
            }
        });

        DimensionLayout { horizontal, vertical, text_height, bounds_min }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Loop;

    #[test]
    fn computes_exact_overall_dimensions_and_places_them_outside_the_box() {
        let layer = Layer {
            name: "Walls".into(),
            loops: vec![Loop {
                points: vec![
                    DVec2::new(1.0, 2.0),
                    DVec2::new(11.0, 2.0),
                    DVec2::new(11.0, 10.0),
                    DVec2::new(1.0, 10.0),
                ],
                closed: true,
            }],
            ..Layer::default()
        };
        let dims = compute_overall(&[layer]).expect("dimensions");
        assert!((dims.width_m - 10.0).abs() < 1e-9);
        assert!((dims.height_m - 8.0).abs() < 1e-9);

        let layout = dims.layout();
        let h = layout.horizontal.as_ref().expect("horizontal");
        let v = layout.vertical.as_ref().expect("vertical");
        assert_eq!(h.text, "10.00 m");
        assert_eq!(v.text, "8.00 m");
        assert!(h.def_point.y < dims.min.y, "horizontal dim sits below min.y");
        assert!(v.def_point.x < dims.min.x, "vertical dim sits left of min.x");
        assert!(layout.bounds_min.x < dims.min.x);
        assert!(layout.bounds_min.y < dims.min.y);
    }

    #[test]
    fn empty_layers_yield_no_dimensions() {
        assert!(compute_overall(&[]).is_none());
        assert!(compute_overall(&[Layer::default()]).is_none());
    }
}
