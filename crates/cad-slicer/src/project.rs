//! Projection and hidden lines.
//!
//! Lines come from the mesh's own features, not from every triangle edge: an edge on the
//! boundary of an open mesh, an edge where two faces meet at a crease, or an edge where a
//! curved surface turns away from the viewer. That is what a drawing shows, and it keeps the
//! output small.
//!
//! Visibility is exact: each projected edge is clipped against the projected triangles nearer
//! the viewer, found through a bounding volume hierarchy whose nodes know their box on the
//! sheet and their nearest depth, and the parts they cover are its hidden runs. The search
//! skips what lies off the edge or behind it, nearer parts first, so a fully covered edge
//! stops at once.

use crate::cut::Frame;
use crate::geom::{Segment, SEGMENT_EPSILON};
use glam::{DVec2, DVec3};
use ifc_geometry::Mesh;
use std::collections::BTreeMap;

/// Triangles one drawing may occlude with.
const MAX_OCCLUDERS: usize = 4_000_000;
/// Triangles one element may offer before its projection is skipped.
const MAX_ELEMENT_TRIANGLES: usize = 150_000;
/// Feature edges one element may contribute.
const MAX_FEATURE_EDGES: usize = 100_000;
/// Edge against triangle tests one drawing may run before the projection stops and says so.
/// Half a minute at worst, in a Worker of its own: a 4 m plan of a 77 MB model needs a third of it.
const MAX_OCCLUSION_TESTS: usize = 2_000_000_000;
/// Cosines above this are the same plane: a tessellated curve, not a crease.
const CREASE_COSINE: f64 = 0.94;
/// A point this far behind a surface is not hidden by the surface itself. Metres.
const OCCLUSION_EPSILON: f64 = 1e-6;
/// Triangles in a leaf of the occluder hierarchy.
const LEAF_SIZE: usize = 8;
/// A slack box is grown outward by this much of its largest coordinate, and by the absolute
/// pad, so rounding in its corners never leaves out an edge `covered` would reach. About 45
/// units in the last place; at map coordinates (6.6e6) 0.07 micrometres.
const BOX_PAD_RELATIVE: f64 = 1e-14;
const BOX_PAD_ABSOLUTE: f64 = 1e-12;
/// How far a point may lie outside a triangle and still count as on it, in the units of a
/// cross product: without this, an edge along a triangle's own border would flicker.
const COVER_SLACK: f64 = 1e-9;
/// Gaps between hidden spans narrower than this are rounding between neighbours. Metres.
const JOIN_GAP: f64 = 1e-7;
/// Hidden spans shorter than this are dropped. A triangle that only touches an edge, within
/// `COVER_SLACK`, hides a few micrometres of it at most; drawn, that is a dash of no length
/// between two visible pieces. Metres.
const MIN_HIDDEN_RUN: f64 = 1e-5;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProjectReport {
    pub non_finite: usize,
    pub too_large: bool,
    pub truncated: bool,
}

/// A projected triangle: two sheet coordinates and the depth at each corner, with what the
/// search needs side by side so a leaf reads memory in order: its nearest depth and the box of
/// the region `covered` treats as inside (the triangle grown by `COVER_SLACK` on each side,
/// corners included; unbounded for a sliver whose grown sides are nearly parallel). An edge
/// outside that box cannot be covered by the triangle.
#[derive(Debug, Clone, Copy)]
struct Flat {
    points: [DVec2; 3],
    depths: [f64; 3],
    area: f64,
    nearest: f64,
    low: DVec2,
    high: DVec2,
    /// Order of arrival, the tie-break that keeps the build the same on every run.
    id: u32,
}

/// The box of the triangle each of whose sides is moved out by the slack `covered` allows:
/// the corners of that grown triangle, where its moved sides meet.
fn slack_box(points: [DVec2; 3], area: f64) -> (DVec2, DVec2) {
    let (low, high) = slack_corners(points, area);
    if !low.is_finite() || !high.is_finite() {
        return (low, high);
    }
    // Outward by more than the rounding of these sums, so an edge on the box's border is kept.
    let pad = low.abs().max(high.abs()).max_element() * BOX_PAD_RELATIVE + BOX_PAD_ABSOLUTE;
    (low - DVec2::splat(pad), high + DVec2::splat(pad))
}

/// The box of the grown triangle's corners as computed, before the pad.
fn slack_corners(points: [DVec2; 3], area: f64) -> (DVec2, DVec2) {
    let unbounded = (DVec2::splat(f64::NEG_INFINITY), DVec2::splat(f64::INFINITY));
    let sign = area.signum();
    // Relative to the first corner: at map coordinates, normal · point would cancel away the
    // precision a sliver needs, and its box would miss the triangle.
    let base = points[0];
    let points = points.map(|point| point - base);
    // Side i as the half-plane n·x >= c: inside when sign * side.perp_dot(x - from) +
    // COVER_SLACK >= 0, as in `covered`.
    let line = |i: usize, j: usize| {
        let side = points[j] - points[i];
        let normal = DVec2::new(-side.y, side.x) * sign;
        (normal, normal.dot(points[i]) - COVER_SLACK)
    };
    let lines = [line(0, 1), line(1, 2), line(2, 0)];
    let mut low = DVec2::splat(f64::INFINITY);
    let mut high = DVec2::splat(f64::NEG_INFINITY);
    for (a, b) in [(0, 1), (1, 2), (2, 0)] {
        let ((n1, c1), (n2, c2)) = (lines[a], lines[b]);
        let det = n1.perp_dot(n2);
        if det.abs() <= 1e-12 * n1.length() * n2.length() {
            return unbounded;
        }
        let corner = DVec2::new(c1 * n2.y - c2 * n1.y, n1.x * c2 - n2.x * c1) / det;
        if !corner.is_finite() {
            return unbounded;
        }
        low = low.min(corner);
        high = high.max(corner);
    }
    (low + base, high + base)
}

/// A node of the hierarchy: the box around everything below it and the nearest depth there.
/// A leaf owns `triangles[start..start + count]`; an inner node has `count` 0 and its two
/// children at `start` and `start + 1`.
#[derive(Debug, Clone, Copy)]
struct Node {
    low: DVec2,
    high: DVec2,
    nearest: f64,
    start: u32,
    count: u32,
}

/// The projected triangles of every mesh, in a bounding volume hierarchy, so an edge only
/// meets what lies over it on the sheet and in front of it in depth.
pub(crate) struct Occluders {
    triangles: Vec<Flat>,
    nodes: Vec<Node>,
    tests_left: usize,
}

impl Occluders {
    /// `triangles` is an upper bound on what will be added: reserving it up front avoids the
    /// moment when a growing list and its copy are both alive, twice the memory at the peak.
    pub(crate) fn new(triangles: usize) -> Self {
        Self {
            triangles: Vec::with_capacity(triangles.min(MAX_OCCLUDERS)),
            nodes: Vec::new(),
            tests_left: MAX_OCCLUSION_TESTS,
        }
    }

    /// Call once everything is in: builds the hierarchy, splitting each node at the median of
    /// its triangles' centres along its longer side. Leaves list their triangles nearest first.
    pub(crate) fn finish(&mut self) {
        self.nodes.clear();
        if self.triangles.is_empty() {
            return;
        }
        self.nodes.push(Node { low: DVec2::ZERO, high: DVec2::ZERO, nearest: 0.0, start: 0, count: 0 });
        let mut pending = vec![(0usize, 0usize, self.triangles.len())];
        while let Some((node, start, end)) = pending.pop() {
            let slice = &mut self.triangles[start..end];
            let mut low = DVec2::splat(f64::INFINITY);
            let mut high = DVec2::splat(f64::NEG_INFINITY);
            let mut nearest = f64::INFINITY;
            let mut centre_low = DVec2::splat(f64::INFINITY);
            let mut centre_high = DVec2::splat(f64::NEG_INFINITY);
            for flat in slice.iter() {
                low = low.min(flat.low);
                high = high.max(flat.high);
                nearest = nearest.min(flat.nearest);
                let centre = (flat.points[0] + flat.points[1] + flat.points[2]) / 3.0;
                centre_low = centre_low.min(centre);
                centre_high = centre_high.max(centre);
            }
            if slice.len() <= LEAF_SIZE {
                slice.sort_by(|a, b| a.nearest.total_cmp(&b.nearest).then(a.id.cmp(&b.id)));
                self.nodes[node] = Node { low, high, nearest, start: start as u32, count: slice.len() as u32 };
                continue;
            }
            let extent = centre_high - centre_low;
            let axis = usize::from(extent.y > extent.x);
            let middle = slice.len() / 2;
            let key = |flat: &Flat| (flat.points[0][axis] + flat.points[1][axis] + flat.points[2][axis]) / 3.0;
            slice.select_nth_unstable_by(middle, |a, b| key(a).total_cmp(&key(b)).then(a.id.cmp(&b.id)));
            let left = self.nodes.len();
            let placeholder = Node { low: DVec2::ZERO, high: DVec2::ZERO, nearest: 0.0, start: 0, count: 0 };
            self.nodes.push(placeholder);
            self.nodes.push(placeholder);
            self.nodes[node] = Node { low, high, nearest, start: left as u32, count: 0 };
            pending.push((left, start, start + middle));
            pending.push((left + 1, start + middle, end));
        }
    }

    /// Adds a triangle, already projected.
    fn add(&mut self, points: [DVec2; 3], depths: [f64; 3]) -> bool {
        if self.triangles.len() >= MAX_OCCLUDERS {
            return false;
        }
        let area = (points[1] - points[0]).perp_dot(points[2] - points[0]);
        if !area.is_finite() || area.abs() <= 1e-12 {
            // Seen edge on: it covers no area and hides nothing.
            return true;
        }
        let (low, high) = slack_box(points, area);
        let id = self.triangles.len() as u32;
        self.triangles.push(Flat {
            points,
            depths,
            area,
            nearest: depths[0].min(depths[1]).min(depths[2]),
            low,
            high,
            id,
        });
        true
    }

    /// Clips the edge against one triangle: the span of it that lies under the triangle and
    /// behind it. Everything here is linear along the edge, so each test is one clip.
    fn covered(flat: &Flat, edge: &Edge) -> Option<(f64, f64)> {
        let (mut start, mut end) = (0.0_f64, 1.0_f64);
        let sign = flat.area.signum();
        let [p, q, r] = flat.points;
        let mut clip = |at_start: f64, at_end: f64| -> bool {
            if at_start < 0.0 && at_end < 0.0 {
                return false;
            }
            if at_start < 0.0 {
                start = start.max(at_start / (at_start - at_end));
            } else if at_end < 0.0 {
                end = end.min(at_start / (at_start - at_end));
            }
            start < end
        };
        for (from, to) in [(p, q), (q, r), (r, p)] {
            let side = to - from;
            let at_start = sign * side.perp_dot(edge.a - from) + COVER_SLACK;
            let at_end = sign * side.perp_dot(edge.b - from) + COVER_SLACK;
            if !clip(at_start, at_end) {
                return None;
            }
        }
        // The triangle's plane under a point, by barycentric weights; evaluated at the ends of
        // the span that lies on the triangle, not at the edge's ends far outside it.
        let depth_under = |point: DVec2| {
            let wp = (q - point).perp_dot(r - point) / flat.area;
            let wq = (r - point).perp_dot(p - point) / flat.area;
            let wr = (p - point).perp_dot(q - point) / flat.area;
            wp * flat.depths[0] + wq * flat.depths[1] + wr * flat.depths[2]
        };
        let point_at = |t: f64| edge.a + (edge.b - edge.a) * t;
        let depth_at = |t: f64| edge.depth_a + (edge.depth_b - edge.depth_a) * t;
        let (under_start, under_end) = (depth_under(point_at(start)), depth_under(point_at(end)));
        // Behind the triangle: never measured from nearer than its nearest corner. In the slack
        // strip of a sliver the plane runs away (to -7e9 m on a real file) and would hide the
        // edge behind a depth the triangle never reaches; floored, a triangle whose nearest corner
        // is not in front of the edge never covers it, which the hierarchy's pruning relies on.
        // The floor makes this concave along the span, so clipping by its ends keeps less, never
        // more. Only here: the plane itself still decides what was cut away in front (below), and
        // flooring that too put specks of hidden line where an edge meets a face seen nearly
        // edge-on (the oblique drawing cases).
        let behind_start = depth_at(start) - under_start.max(flat.nearest) - OCCLUSION_EPSILON;
        let behind_end = depth_at(end) - under_end.max(flat.nearest) - OCCLUSION_EPSILON;
        if !behind_start.is_finite() || !behind_end.is_finite() {
            return None;
        }
        // Both are linear across [start, end]; keep where each is not negative.
        fn sub_clip(span: &mut (f64, f64), at_start: f64, at_end: f64) -> bool {
            if at_start < 0.0 && at_end < 0.0 {
                return false;
            }
            let (from, to) = *span;
            if at_start < 0.0 {
                span.0 = from + (to - from) * (at_start / (at_start - at_end));
            } else if at_end < 0.0 {
                span.1 = from + (to - from) * (at_start / (at_start - at_end));
            }
            span.0 < span.1
        }
        let mut span = (start, end);
        if !sub_clip(&mut span, behind_start, behind_end) {
            return None;
        }
        // The part of a sloped triangle in front of the plane has been cut away.
        let (under_start, under_end) = (depth_under(point_at(span.0)), depth_under(point_at(span.1)));
        if !sub_clip(&mut span, under_start, under_end) {
            return None;
        }
        Some(span)
    }

    /// The hidden spans of an edge, as sorted parameters along it. `None` when the budget ran
    /// out, because a partial answer would draw hidden lines as visible. The nearer child is
    /// searched first, so a fully covered edge stops early.
    fn hidden_spans(&mut self, edge: &Edge) -> Option<Vec<(f64, f64)>> {
        let join = JOIN_GAP / edge.a.distance(edge.b).max(JOIN_GAP);
        let mut spans: Vec<(f64, f64)> = Vec::new();
        let mut merged: Vec<(f64, f64)> = Vec::new();
        if self.nodes.is_empty() {
            return Some(merged);
        }
        let reaches = |low: DVec2, high: DVec2, nearest: f64| {
            // A difference of exactly zero is covered (covered() keeps it), so only a triangle
            // whose nearest corner is strictly behind can be skipped.
            nearest + OCCLUSION_EPSILON <= edge.deepest
                && edge.high.x >= low.x
                && edge.low.x <= high.x
                && edge.high.y >= low.y
                && edge.low.y <= high.y
        };
        let mut stack = vec![0u32];
        while let Some(index) = stack.pop() {
            let node = self.nodes[index as usize];
            if !reaches(node.low, node.high, node.nearest) {
                continue;
            }
            if node.count == 0 {
                let (a, b) = (node.start, node.start + 1);
                // Pushed last, popped first: the child with the nearer triangle.
                if self.nodes[a as usize].nearest <= self.nodes[b as usize].nearest {
                    stack.push(b);
                    stack.push(a);
                } else {
                    stack.push(a);
                    stack.push(b);
                }
                continue;
            }
            let before = spans.len();
            let leaf = &self.triangles[node.start as usize..(node.start + node.count) as usize];
            for flat in leaf {
                if flat.nearest + OCCLUSION_EPSILON > edge.deepest {
                    break;
                }
                if !reaches(flat.low, flat.high, flat.nearest) {
                    continue;
                }
                if self.tests_left == 0 {
                    return None;
                }
                self.tests_left -= 1;
                if let Some(span) = Self::covered(flat, edge) {
                    spans.push(span);
                }
            }
            if spans.len() != before {
                merged = merge_spans(&mut spans, join);
                if merged.len() == 1 && merged[0].0 <= 0.0 && merged[0].1 >= 1.0 {
                    break;
                }
            }
        }
        Some(merged)
    }
}

/// An edge on the sheet, with the depth at each end, the deepest of the two, and its box.
struct Edge {
    a: DVec2,
    b: DVec2,
    depth_a: f64,
    depth_b: f64,
    deepest: f64,
    low: DVec2,
    high: DVec2,
}

/// Sorts and joins spans in place, snapping to the ends of the edge, and returns a copy.
fn merge_spans(spans: &mut Vec<(f64, f64)>, join: f64) -> Vec<(f64, f64)> {
    spans.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut out: Vec<(f64, f64)> = Vec::with_capacity(spans.len());
    for (start, end) in spans.iter().copied() {
        match out.last_mut() {
            Some(last) if start <= last.1 + join => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    if let Some(first) = out.first_mut().filter(|first| first.0 <= join) {
        first.0 = 0.0;
    }
    if let Some(last) = out.last_mut().filter(|last| last.1 >= 1.0 - join) {
        last.1 = 1.0;
    }
    spans.clone_from(&out);
    out
}


/// Projects one mesh's triangles into the occluder grid.
pub(crate) fn add_occluders(
    mesh: &Mesh,
    frame: &Frame,
    limit: Option<f64>,
    occluders: &mut Occluders,
) -> ProjectReport {
    let mut report = ProjectReport::default();
    if mesh.triangles.len() > MAX_ELEMENT_TRIANGLES {
        report.too_large = true;
        return report;
    }
    // A triangle entirely beyond the reach of the projection draws nothing and hides nothing.
    // One only partly beyond it still hides what lies behind its near part.
    let ceiling = limit.unwrap_or(f64::INFINITY);
    for [a, b, c] in mesh.triangle_corners() {
        if !(a.is_finite() && b.is_finite() && c.is_finite()) {
            report.non_finite += 1;
            continue;
        }
        let depths = [frame.depth(a), frame.depth(b), frame.depth(c)];
        if depths.iter().any(|depth| !depth.is_finite()) {
            continue;
        }
        if depths[0].min(depths[1]).min(depths[2]) > ceiling {
            continue;
        }
        if depths[0].max(depths[1]).max(depths[2]) < 0.0 {
            continue;
        }
        if !occluders.add([frame.project(a), frame.project(b), frame.project(c)], depths) {
            report.truncated = true;
            break;
        }
    }
    report
}

/// One undirected edge of the welded mesh and the faces that meet along it.
#[derive(Default)]
struct EdgeFaces {
    count: u32,
    normals: [DVec3; 2],
}

/// Projects one mesh's feature edges, splitting them into visible and hidden runs.
pub(crate) fn project_mesh(
    mesh: &Mesh,
    frame: &Frame,
    limit: Option<f64>,
    occluders: &mut Occluders,
    visible: &mut Vec<Segment>,
    hidden: &mut Vec<Segment>,
) -> ProjectReport {
    let mut report = ProjectReport::default();
    if mesh.triangles.len() > MAX_ELEMENT_TRIANGLES {
        report.too_large = true;
        return report;
    }
    let (edges, skipped, too_many) = feature_edges(mesh, frame.look);
    report.non_finite += skipped;
    report.truncated = too_many;

    for (from, to) in edges {
        // Depth runs linearly along the edge: clip by solving once.
        let (depth_from, depth_to) = (frame.depth(from), frame.depth(to));
        if !depth_from.is_finite() || !depth_to.is_finite() {
            report.non_finite += 1;
            continue;
        }
        let run = depth_to - depth_from;
        let (mut start, mut end) = (0.0_f64, 1.0_f64);
        if run.abs() <= f64::MIN_POSITIVE {
            if depth_from < 0.0 || limit.is_some_and(|limit| depth_from > limit) {
                continue;
            }
        } else {
            // Between the eye and the plane there is no line.
            let zero = -depth_from / run;
            if run > 0.0 {
                start = start.max(zero);
            } else {
                end = end.min(zero);
            }
            if let Some(limit) = limit {
                let reach = (limit - depth_from) / run;
                if run > 0.0 {
                    end = end.min(reach);
                } else {
                    start = start.max(reach);
                }
            }
        }
        if end - start <= 1e-9 {
            continue;
        }
        let a = frame.project(from.lerp(to, start));
        let b = frame.project(from.lerp(to, end));
        let depth_a = frame.depth(from.lerp(to, start));
        let depth_b = frame.depth(from.lerp(to, end));
        if !(a.is_finite() && b.is_finite() && depth_a.is_finite() && depth_b.is_finite()) {
            report.non_finite += 1;
            continue;
        }
        let length = a.distance(b);
        if length <= SEGMENT_EPSILON {
            continue;
        }

        let edge = Edge {
            a,
            b,
            depth_a,
            depth_b,
            deepest: depth_a.max(depth_b),
            low: a.min(b),
            high: a.max(b),
        };
        let Some(spans) = occluders.hidden_spans(&edge) else {
            report.truncated = true;
            break;
        };
        // Spans closer than MIN_HIDDEN_RUN are one hidden run, so many tiny neighbours are not
        // dropped one by one; then a run still shorter than that is a touch, not a cover.
        let near = MIN_HIDDEN_RUN / length;
        let mut runs: Vec<(f64, f64)> = Vec::with_capacity(spans.len());
        for (start, end) in spans {
            match runs.last_mut() {
                Some(last) if start - last.1 < near => last.1 = last.1.max(end),
                _ => runs.push((start, end)),
            }
        }
        let mut cursor = 0.0;
        for (start, end) in runs.into_iter().filter(|(start, end)| (end - start) * length >= MIN_HIDDEN_RUN) {
            push_run(a, b, cursor, start, true, visible, hidden);
            push_run(a, b, start, end, false, visible, hidden);
            cursor = end;
        }
        push_run(a, b, cursor, 1.0, true, visible, hidden);
    }
    report
}
fn push_run(
    a: DVec2,
    b: DVec2,
    start: f64,
    end: f64,
    visible: bool,
    visible_out: &mut Vec<Segment>,
    hidden_out: &mut Vec<Segment>,
) {
    if end - start <= 1e-9 {
        return;
    }
    let from = a.lerp(b, start);
    let to = a.lerp(b, end);
    if from.distance(to) <= SEGMENT_EPSILON {
        return;
    }
    let segment = Segment::new(from, to);
    if visible {
        visible_out.push(segment);
    } else {
        hidden_out.push(segment);
    }
}

/// Joins collinear segments that overlap, so a box's top and bottom rims do not draw the same
/// line twice. A visible run wins over a hidden one: what can be seen is not dashed.
pub(crate) fn merge_lines(visible: &mut Vec<Segment>, hidden: &mut Vec<Segment>) {
    struct Bucket {
        direction: DVec2,
        normal: DVec2,
        offset: f64,
        visible: Vec<(f64, f64)>,
        hidden: Vec<(f64, f64)>,
    }

    let mut buckets: BTreeMap<(i64, i64), Bucket> = BTreeMap::new();
    for (segment, is_visible) in visible
        .iter()
        .map(|segment| (segment, true))
        .chain(hidden.iter().map(|segment| (segment, false)))
    {
        let Some(mut direction) = (segment.b - segment.a).try_normalize() else {
            continue;
        };
        // One direction per line, so the two triangles of a quad agree.
        if direction.x < -1e-12 || (direction.x.abs() <= 1e-12 && direction.y < 0.0) {
            direction = -direction;
        }
        let normal = DVec2::new(-direction.y, direction.x);
        let offset = normal.dot(segment.a);
        let key = (
            (direction.y.atan2(direction.x) / 1e-6).round() as i64,
            (offset / 1e-6).round() as i64,
        );
        let bucket = buckets.entry(key).or_insert_with(|| Bucket {
            direction,
            normal,
            offset,
            visible: Vec::new(),
            hidden: Vec::new(),
        });
        let (from, to) = (direction.dot(segment.a), direction.dot(segment.b));
        let span = (from.min(to), from.max(to));
        if is_visible {
            bucket.visible.push(span);
        } else {
            bucket.hidden.push(span);
        }
    }

    let mut new_visible = Vec::new();
    let mut new_hidden = Vec::new();
    for (_, bucket) in buckets {
        let visible_spans = union(bucket.visible);
        let hidden_spans = subtract(bucket.hidden, &visible_spans);
        let place = |(from, to): (f64, f64)| {
            Segment::new(
                bucket.normal * bucket.offset + bucket.direction * from,
                bucket.normal * bucket.offset + bucket.direction * to,
            )
        };
        new_visible.extend(visible_spans.into_iter().map(place));
        new_hidden.extend(hidden_spans.into_iter().map(place));
    }
    *visible = new_visible;
    *hidden = new_hidden;
}

fn union(mut spans: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    spans.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (start, end) in spans {
        if end - start <= 1e-9 {
            continue;
        }
        match out.last_mut() {
            Some(last) if start <= last.1 + 1e-9 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out
}

fn subtract(spans: Vec<(f64, f64)>, cut: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for (start, end) in union(spans) {
        let mut cursor = start;
        for (cut_start, cut_end) in cut {
            if *cut_end <= cursor + 1e-9 {
                continue;
            }
            if *cut_start >= end - 1e-9 {
                break;
            }
            if *cut_start > cursor + 1e-9 {
                out.push((cursor, cut_start.min(end)));
            }
            cursor = cursor.max(*cut_end);
            if cursor >= end - 1e-9 {
                break;
            }
        }
        if end > cursor + 1e-9 {
            out.push((cursor, end));
        }
    }
    out
}
/// The edges worth drawing, welded so two triangles sharing an edge count once, the triangles
/// skipped, and whether the element had more edges than it may contribute.
fn feature_edges(mesh: &Mesh, look: DVec3) -> (Vec<(DVec3, DVec3)>, usize, bool) {
    let mut welded: BTreeMap<[u64; 3], u32> = BTreeMap::new();
    let mut points: Vec<DVec3> = Vec::new();
    let mut faces: BTreeMap<(u32, u32), EdgeFaces> = BTreeMap::new();
    let mut skipped = 0;

    for [a, b, c] in mesh.triangle_corners() {
        if !(a.is_finite() && b.is_finite() && c.is_finite()) {
            skipped += 1;
            continue;
        }
        let normal = (b - a).cross(c - a);
        if normal.length_squared() <= 1e-24 {
            continue;
        }
        let normal = normal.normalize();
        let mut id_of = |point: DVec3| -> u32 {
            let key = [point.x.to_bits(), point.y.to_bits(), point.z.to_bits()];
            let next = points.len() as u32;
            let id = *welded.entry(key).or_insert(next);
            if id as usize == points.len() {
                points.push(point);
            }
            id
        };
        let (ia, ib, ic) = (id_of(a), id_of(b), id_of(c));
        for (from, to) in [(ia, ib), (ib, ic), (ic, ia)] {
            if from == to {
                continue;
            }
            let key = (from.min(to), from.max(to));
            let edge = faces.entry(key).or_default();
            if edge.count < 2 {
                edge.normals[edge.count as usize] = normal;
            }
            edge.count = edge.count.saturating_add(1);
        }
    }

    let mut edges = Vec::new();
    let mut too_many = false;
    for ((from, to), edge) in faces {
        let draw = if edge.count < 2 {
            true
        } else {
            let first = edge.normals[0].dot(look);
            let second = edge.normals[1].dot(look);
            let crease = edge.normals[0].dot(edge.normals[1]) < CREASE_COSINE;
            // One face looks at the viewer and the other away: the surface turns here.
            let silhouette = (first < -1e-6 && second > 1e-6) || (second < -1e-6 && first > 1e-6);
            crease || silhouette
        };
        if !draw {
            continue;
        }
        let (a, b) = (points[from as usize], points[to as usize]);
        if a.distance(b) > SEGMENT_EPSILON {
            if edges.len() >= MAX_FEATURE_EDGES {
                too_many = true;
                break;
            }
            edges.push((a, b));
        }
    }
    (edges, skipped, too_many)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(z: f64) -> Mesh {
        Mesh {
            positions: vec![
                DVec3::new(0.0, 0.0, z),
                DVec3::new(4.0, 0.0, z),
                DVec3::new(4.0, 4.0, z),
                DVec3::new(0.0, 4.0, z),
            ],
            triangles: vec![[0, 1, 2], [0, 2, 3]],
        }
    }

    #[test]
    fn a_spent_budget_is_reported_and_draws_nothing_unchecked() {
        let frame = Frame::of(crate::cut::Cut::Plan { z: 10.0 }).unwrap();
        let (roof, floor) = (square(5.0), square(1.0));
        let mut grid = Occluders::new(4);
        add_occluders(&roof, &frame, None, &mut grid);
        grid.finish();

        let (mut visible, mut hidden) = (Vec::new(), Vec::new());
        grid.tests_left = 0;
        let report = project_mesh(&floor, &frame, None, &mut grid, &mut visible, &mut hidden);
        assert!(report.truncated);
        assert!(visible.is_empty(), "an unchecked edge would look visible: {visible:?}");

        grid.tests_left = 1000;
        let report = project_mesh(&floor, &frame, None, &mut grid, &mut visible, &mut hidden);
        assert!(!report.truncated);
        assert!(visible.is_empty());
        assert!(!hidden.is_empty());
    }

    /// A small deterministic generator, so a failure can be replayed.
    struct Lcg(u64);
    impl Lcg {
        fn unit(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    fn edge(a: DVec2, b: DVec2, depth_a: f64, depth_b: f64) -> Edge {
        Edge { a, b, depth_a, depth_b, deepest: depth_a.max(depth_b), low: a.min(b), high: a.max(b) }
    }

    /// Every triangle through `covered`, no hierarchy and no pruning: what the search must equal.
    fn oracle(occluders: &Occluders, edge: &Edge) -> Vec<(f64, f64)> {
        let join = JOIN_GAP / edge.a.distance(edge.b).max(JOIN_GAP);
        let mut spans: Vec<(f64, f64)> =
            occluders.triangles.iter().filter_map(|flat| Occluders::covered(flat, edge)).collect();
        merge_spans(&mut spans, join)
    }

    #[test]
    fn the_hierarchy_finds_what_covered_finds_on_every_triangle() {
        // Near the origin and at map coordinates (where a box computed from absolute values lost
        // its precision), with slivers and with edges laid exactly on triangles' sides, vertical
        // ones included: the cases the T-149 review found missed.
        let mut rng = Lcg(149);
        for base in [DVec2::ZERO, DVec2::new(538_471.0, 6_591_623.0)] {
            for trial in 0..400 {
                let mut occluders = Occluders::new(32);
                let mut sides = Vec::new();
                for _ in 0..24 {
                    let p = base + DVec2::new(rng.unit() * 4.0, rng.unit() * 4.0);
                    let q = p + DVec2::new(rng.unit() - 0.5, rng.unit() - 0.5) * 2.0;
                    let r = if rng.unit() < 0.3 {
                        // A sliver: the third corner a hair from the first side.
                        p.lerp(q, rng.unit()) + DVec2::new(1e-6, -1e-6) * (rng.unit() - 0.5)
                    } else if rng.unit() < 0.3 {
                        DVec2::new(p.x, p.y + rng.unit() * 2.0 - 1.0) // a vertical side p-r
                    } else {
                        p + DVec2::new(rng.unit() - 0.5, rng.unit() - 0.5) * 2.0
                    };
                    let depths = [rng.unit() * 3.0, rng.unit() * 3.0, rng.unit() * 3.0];
                    occluders.add([p, q, r], depths);
                    sides.extend([(p, q), (q, r), (r, p)]);
                }
                occluders.finish();
                for k in 0..60 {
                    let (a, b) = if k % 3 == 0 && !sides.is_empty() {
                        sides[(rng.unit() * sides.len() as f64) as usize % sides.len()]
                    } else {
                        let a = base + DVec2::new(rng.unit() * 5.0 - 0.5, rng.unit() * 5.0 - 0.5);
                        (a, a + DVec2::new(rng.unit() - 0.5, rng.unit() - 0.5) * 3.0)
                    };
                    let e = edge(a, b, rng.unit() * 4.0, rng.unit() * 4.0);
                    let found = occluders.hidden_spans(&e).unwrap();
                    assert_eq!(found, oracle(&occluders, &e), "trial {trial} edge {k} at {base:?}");
                }
            }
        }
    }

    #[test]
    fn a_sloped_slivers_slack_strip_neither_hides_nor_disagrees() {
        // The T-149 case: an edge 0.5 nm outside a sloped triangle, inside its slack strip, and
        // OCCLUSION_EPSILON behind its nearest corner. Extrapolated, the depth there fell below
        // the triangle's own and covered() hid the edge while the search did not.
        let mut occluders = Occluders::new(1);
        occluders.add([DVec2::new(0.0, 0.0), DVec2::new(1.0, 0.0), DVec2::new(0.0, 0.001)], [1.0, 1.0, 2.0]);
        occluders.finish();
        let e = edge(DVec2::new(0.1, -5e-10), DVec2::new(0.9, -5e-10), 1.0 + OCCLUSION_EPSILON, 1.0 + OCCLUSION_EPSILON);
        assert_eq!(occluders.hidden_spans(&e).unwrap(), oracle(&occluders, &e));
    }

    #[test]
    fn many_tiny_neighbouring_spans_are_one_hidden_run() {
        // 100 occluders each hiding 8 um of an edge, 0.2 um apart (more than JOIN_GAP and than the
        // slack's growth of tall occluders, less than
        // MIN_HIDDEN_RUN): dropped one by one, 0.82 mm of hidden line would draw as visible.
        let frame = Frame::of(crate::cut::Cut::Plan { z: 10.0 }).unwrap();
        let floor = square(1.0);
        let mut louvre = Mesh { positions: Vec::new(), triangles: Vec::new() };
        for i in 0..100u32 {
            let x = 1.0 + f64::from(i) * 8.2e-6;
            let at = louvre.positions.len() as u32;
            louvre.positions.extend([
                DVec3::new(x, -0.5, 5.0),
                DVec3::new(x + 8e-6, -0.5, 5.0),
                DVec3::new(x + 8e-6, 0.5, 5.0),
                DVec3::new(x, 0.5, 5.0),
            ]);
            louvre.triangles.extend([[at, at + 1, at + 2], [at, at + 2, at + 3]]);
        }
        let mut grid = Occluders::new(louvre.triangles.len());
        add_occluders(&louvre, &frame, None, &mut grid);
        grid.finish();
        let (mut visible, mut hidden) = (Vec::new(), Vec::new());
        project_mesh(&floor, &frame, None, &mut grid, &mut visible, &mut hidden);
        // The floor's edge along y = 0: hidden from x = 1 to the last louvre's end.
        let hidden_on_edge: f64 = hidden
            .iter()
            .filter(|s| s.a.y.abs() < 1e-9 && s.b.y.abs() < 1e-9)
            .map(|s| s.a.distance(s.b))
            .sum();
        let expected = 99.0 * 8.2e-6 + 8e-6;
        // One metre tall, so COVER_SLACK grows each by a nanometre and the gaps stay open.
        assert!((hidden_on_edge - expected).abs() < 1e-8, "hidden {hidden_on_edge} expected {expected}");
    }

    #[test]
    fn an_edge_on_the_border_of_the_computed_box_is_still_searched() {
        // The T-149 probe: a triangle with a vertical left side and its first corner on the
        // right, and a vertical edge one ulp left of the box as computed. Near the origin the
        // rounding of the corners is larger than an ulp there, so covered() can still reach the
        // edge; the pad keeps it searched.
        let mut rng = Lcg(271);
        let mut probed = 0;
        for base in [DVec2::ZERO, DVec2::new(500_000.0, 6_600_000.0)] {
            for _ in 0..10_000 {
                let (x0, y0) = (base.x + rng.unit() * 10.0, base.y + rng.unit() * 10.0);
                let (h, w) = (1.0 + rng.unit() * 5.0, 0.5 + rng.unit() * 5.0);
                let points = [DVec2::new(x0 + w, y0 + rng.unit() * h), DVec2::new(x0, y0 + h), DVec2::new(x0, y0)];
                let area = (points[1] - points[0]).perp_dot(points[2] - points[0]);
                let (low, _) = slack_corners(points, area);
                if !low.is_finite() {
                    continue;
                }
                let x = low.x.next_down();
                let mut occluders = Occluders::new(1);
                occluders.add(points, [1.0; 3]);
                occluders.finish();
                let e = edge(DVec2::new(x, y0 + 0.1 * h), DVec2::new(x, y0 + 0.9 * h), 2.0, 2.0);
                let expected = oracle(&occluders, &e);
                probed += usize::from(!expected.is_empty());
                assert_eq!(occluders.hidden_spans(&e).unwrap(), expected, "{points:?}");
            }
        }
        assert!(probed > 0, "no probe reached a covered edge outside the unpadded box");
    }

    #[test]
    fn an_exact_depth_tie_is_searched_as_covered_sees_it() {
        // Depths where nearest + OCCLUSION_EPSILON == deepest in floating point while covered()
        // still finds the edge behind by a margin of at least zero: the search must not skip it.
        let mut rng = Lcg(1);
        let mut found = None;
        for _ in 0..1_000_000 {
            let nearest = rng.unit() * 10.0;
            let deepest = nearest + OCCLUSION_EPSILON;
            if (deepest - nearest) - OCCLUSION_EPSILON >= 0.0 {
                found = Some((nearest, deepest));
                break;
            }
        }
        let (nearest, deepest) = found.expect("a tie");
        let mut occluders = Occluders::new(1);
        occluders.add([DVec2::new(0.0, 0.0), DVec2::new(2.0, 0.0), DVec2::new(0.0, 2.0)], [nearest; 3]);
        occluders.finish();
        let e = edge(DVec2::new(0.2, 0.5), DVec2::new(1.0, 0.5), deepest, deepest);
        let expected = oracle(&occluders, &e);
        assert!(!expected.is_empty(), "covered() should keep a zero margin");
        assert_eq!(occluders.hidden_spans(&e).unwrap(), expected);
    }

    #[test]
    fn a_long_edge_under_a_steep_sliver_is_hidden_where_it_passes() {
        // A sliver 1 mm wide whose depth climbs 1000 m per metre across it, and an edge 20 m long
        // crossing it well behind. Taken at the edge's ends, the plane is 1e4 m away on either
        // side, floored on one and far behind on the other, and the line between them crosses
        // zero metres from the sliver: the edge would show through it.
        let mut occluders = Occluders::new(1);
        occluders.add([DVec2::new(0.0, 0.0), DVec2::new(1.0, 0.0), DVec2::new(0.0, 0.001)], [1.0, 1.0, 2.0]);
        occluders.finish();
        let e = edge(DVec2::new(0.5, -10.0), DVec2::new(0.5, 10.0), 5.0, 5.0);
        let spans = occluders.hidden_spans(&e).unwrap();
        let hidden: f64 = spans.iter().map(|(start, end)| (end - start) * 20.0).sum();
        assert!((hidden - 0.0005).abs() < 1e-8, "hidden {hidden} m of the 0.5 mm under the sliver");
    }
}
