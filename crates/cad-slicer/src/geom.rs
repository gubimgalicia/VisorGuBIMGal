//! 2D helpers shared by the cutters, the hatching and the exporters.

use glam::DVec2;
use std::collections::BTreeMap;

/// Points closer than this are the same point. Metres.
pub(crate) const POINT_EPSILON: f64 = 1e-6;
/// Segments shorter than this carry no line: a vertex exactly on the plane makes them.
pub(crate) const SEGMENT_EPSILON: f64 = 1e-9;

/// A closed or open ring of points on the sheet.
#[derive(Debug, Clone, PartialEq)]
pub struct Loop {
    /// The closing point is not repeated.
    pub points: Vec<DVec2>,
    pub closed: bool,
}

impl Loop {
    pub fn is_empty(&self) -> bool {
        self.points.len() < 2
    }

    /// Signed area; positive is counter-clockwise in the drawing frame.
    pub fn area(&self) -> f64 {
        let count = self.points.len();
        if count < 3 {
            return 0.0;
        }
        // Measured from the first point: at UTM coordinates the absolute products reach 1e13
        // and their rounding error swamps a small area, while the differences stay small.
        let origin = self.points[0];
        (0..count)
            .map(|i| {
                (self.points[i] - origin).perp_dot(self.points[(i + 1) % count] - origin)
            })
            .sum::<f64>()
            / 2.0
    }

    /// The segments of the ring, closing it when it is closed.
    pub fn segments(&self) -> impl Iterator<Item = (DVec2, DVec2)> + '_ {
        let count = self.points.len();
        let closing = (self.closed && count > 2) as usize;
        (0..count.saturating_sub(1) + closing).map(move |i| (self.points[i], self.points[(i + 1) % count]))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    pub a: DVec2,
    pub b: DVec2,
}

impl Segment {
    pub fn new(a: DVec2, b: DVec2) -> Self {
        Self { a, b }
    }

    pub fn length(&self) -> f64 {
        self.a.distance(self.b)
    }
}

/// Welds endpoints that rounding placed a hair apart. Cells are walked in a fixed order so
/// the same input always gives the same node numbers.
pub(crate) struct NodeIndex {
    cell: f64,
    cells: BTreeMap<(i64, i64), Vec<u32>>,
    points: Vec<DVec2>,
}

impl NodeIndex {
    pub(crate) fn new() -> Self {
        Self {
            cell: POINT_EPSILON,
            cells: BTreeMap::new(),
            points: Vec::new(),
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.points.len()
    }

    pub(crate) fn point(&self, id: u32) -> DVec2 {
        self.points[id as usize]
    }

    fn cell_of(&self, point: DVec2) -> (i64, i64) {
        (
            (point.x / self.cell).floor() as i64,
            (point.y / self.cell).floor() as i64,
        )
    }

    /// Returns the node within a cell of `point`, adding one when there is none.
    pub(crate) fn node(&mut self, point: DVec2) -> Option<u32> {
        if !point.is_finite() {
            return None;
        }
        let (cx, cy) = self.cell_of(point);
        let mut best: Option<(f64, u32)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(ids) = self.cells.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for id in ids {
                    let distance = self.points[*id as usize].distance_squared(point);
                    if distance > self.cell * self.cell {
                        continue;
                    }
                    let better = best.is_none_or(|(closest, found)| {
                        distance.total_cmp(&closest) == std::cmp::Ordering::Less
                            || (distance == closest && *id < found)
                    });
                    if better {
                        best = Some((distance, *id));
                    }
                }
            }
        }
        if let Some((_, id)) = best {
            return Some(id);
        }
        let id = self.points.len() as u32;
        self.points.push(point);
        self.cells.entry((cx, cy)).or_default().push(id);
        Some(id)
    }
}
