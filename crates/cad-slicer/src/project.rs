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
/// A projected triangle's hot box data for BVH leaf scanning: its nearest depth and the box of
/// the region `covered` treats as inside (the triangle grown by `COVER_SLACK` on each side,
/// corners included; unbounded for a sliver whose grown sides are nearly parallel).
#[derive(Debug, Clone, Copy)]
struct TriBox {
    low: DVec2,
    high: DVec2,
    nearest: f64,
}

/// A projected triangle: two sheet coordinates and the depth at each corner, plus its signed
/// double area and nearest depth. Its 2D slack box lives side-by-side in `Occluders::boxes` so
/// leaf scans only touch 40 bytes per triangle until a box hit needs the corners.
#[derive(Debug, Clone, Copy)]
struct Flat {
    points: [DVec2; 3],
    depths: [f64; 3],
    area: f64,
    nearest: f64,
}

#[derive(Default)]
struct FeatureScratch {
    pos_to_welded: Vec<u32>,
    table_slots: Vec<u32>,
    point_keys: Vec<[u64; 3]>,
    points: Vec<DVec3>,
    tri_normals: Vec<DVec3>,
    raw_edges: Vec<(u64, u32)>,
    edges: Vec<(DVec3, DVec3)>,
    proj_edges: Vec<Edge>,
    runs: Vec<(f64, f64)>,
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
    boxes: Vec<TriBox>,
    nodes: Vec<Node>,
    stack: Vec<u32>,
    spans_buf: Vec<(f64, f64)>,
    last_covers: [u32; 8],
    last_covers_len: usize,
    bloated_root: u32,
    scratch: FeatureScratch,
    tests_left: usize,
}

impl Occluders {
    /// `triangles` is an upper bound on what will be added: reserving it up front avoids the
    /// moment when a growing list and its copy are both alive, twice the memory at the peak.
    pub(crate) fn new(triangles: usize) -> Self {
        let cap = triangles.min(MAX_OCCLUDERS);
        Self {
            triangles: Vec::with_capacity(cap),
            boxes: Vec::with_capacity(cap),
            nodes: Vec::new(),
            stack: Vec::with_capacity(64),
            spans_buf: Vec::with_capacity(32),
            last_covers: [0; 8],
            last_covers_len: 0,
            bloated_root: u32::MAX,
            scratch: FeatureScratch::default(),
            tests_left: MAX_OCCLUSION_TESTS,
        }
    }

    /// Call once everything is in: builds the hierarchy, splitting each node at the median of
    /// its triangles' centres along its longer side. Leaves list their triangles nearest first.
    /// Real triangles are split into small and large branches (searched nearest-first) while
    /// slivers whose slack box bloats beyond their vertices are placed in a separate branch
    /// searched only when real triangles did not already hide the edge.
    pub(crate) fn finish(&mut self) {
        self.nodes.clear();
        self.last_covers_len = 0;
        self.bloated_root = u32::MAX;
        let len = self.triangles.len();
        if len == 0 {
            return;
        }
        #[derive(Clone, Copy)]
        struct BuildItem {
            centre: DVec2,
            id: u32,
        }

        let mut tier0 = Vec::with_capacity(len);
        let mut tier1 = Vec::new();
        let mut tier2 = Vec::new();
        for (idx, (flat, tbox)) in self.triangles.iter().zip(self.boxes.iter()).enumerate() {
            let id = idx as u32;
            let p_low = flat.points[0].min(flat.points[1]).min(flat.points[2]);
            let p_high = flat.points[0].max(flat.points[1]).max(flat.points[2]);
            let bloat = ((tbox.high - tbox.low) - (p_high - p_low)).max_element();
            if !bloat.is_finite() || bloat > 0.1 {
                let centre = if tbox.low.is_finite() && tbox.high.is_finite() {
                    (tbox.low + tbox.high) * 0.5
                } else {
                    (flat.points[0] + flat.points[1] + flat.points[2]) / 3.0
                };
                tier2.push(BuildItem { centre, id });
            } else if bloat > 0.002 {
                let centre = (tbox.low + tbox.high) * 0.5;
                tier1.push(BuildItem { centre, id });
            } else {
                let centre = (flat.points[0] + flat.points[1] + flat.points[2]) / 3.0;
                tier0.push(BuildItem { centre, id });
            }
        }

        let mut perm: Vec<u32> = Vec::with_capacity(len);

        let build_subtree = |items: &mut [BuildItem],
                             nodes: &mut Vec<Node>,
                             root_slot: usize,
                             boxes: &[TriBox],
                             perm: &mut Vec<u32>| {
            let mut pending = vec![(root_slot, 0usize, items.len())];
            while let Some((node, start, end)) = pending.pop() {
                let slice = &mut items[start..end];
                if slice.len() <= LEAF_SIZE {
                    slice.sort_by(|a, b| {
                        boxes[a.id as usize]
                            .nearest
                            .total_cmp(&boxes[b.id as usize].nearest)
                            .then(a.id.cmp(&b.id))
                    });
                    let leaf_start = perm.len() as u32;
                    let count = slice.len() as u32;
                    let mut low = DVec2::splat(f64::INFINITY);
                    let mut high = DVec2::splat(f64::NEG_INFINITY);
                    let mut nearest = f64::INFINITY;
                    for item in slice.iter() {
                        let tb = boxes[item.id as usize];
                        low = low.min(tb.low);
                        high = high.max(tb.high);
                        nearest = nearest.min(tb.nearest);
                        perm.push(item.id);
                    }
                    nodes[node] = Node { low, high, nearest, start: leaf_start, count };
                    continue;
                }
                let mut centre_low = DVec2::splat(f64::INFINITY);
                let mut centre_high = DVec2::splat(f64::NEG_INFINITY);
                for item in slice.iter() {
                    centre_low = centre_low.min(item.centre);
                    centre_high = centre_high.max(item.centre);
                }
                let extent = centre_high - centre_low;
                let axis = usize::from(extent.y > extent.x);
                let middle = slice.len() / 2;
                slice.select_nth_unstable_by(middle, |a, b| {
                    a.centre[axis].total_cmp(&b.centre[axis]).then(a.id.cmp(&b.id))
                });
                let left = nodes.len();
                let placeholder = Node { low: DVec2::ZERO, high: DVec2::ZERO, nearest: 0.0, start: 0, count: 0 };
                nodes.push(placeholder);
                nodes.push(placeholder);
                nodes[node] = Node { low: DVec2::ZERO, high: DVec2::ZERO, nearest: 0.0, start: left as u32, count: 0 };
                pending.push((left, start, start + middle));
                pending.push((left + 1, start + middle, end));
            }
        };

        let placeholder = Node { low: DVec2::ZERO, high: DVec2::ZERO, nearest: 0.0, start: 0, count: 0 };
        let mut active_tiers: Vec<Vec<BuildItem>> = [tier0, tier1, tier2]
            .into_iter()
            .filter(|t| !t.is_empty())
            .collect();
        match active_tiers.len() {
            1 => {
                self.nodes.push(placeholder);
                build_subtree(&mut active_tiers[0], &mut self.nodes, 0, &self.boxes, &mut perm);
            }
            2 => {
                self.nodes.push(Node { low: DVec2::ZERO, high: DVec2::ZERO, nearest: 0.0, start: 1, count: 0 });
                self.nodes.push(placeholder);
                self.nodes.push(placeholder);
                self.bloated_root = 2;
                build_subtree(&mut active_tiers[0], &mut self.nodes, 1, &self.boxes, &mut perm);
                build_subtree(&mut active_tiers[1], &mut self.nodes, 2, &self.boxes, &mut perm);
            }
            _ => {
                // Node 0 -> children 1 (tier 0) and 2 (inner parent of tiers 1 and 2 at 3 and 4).
                self.nodes.push(Node { low: DVec2::ZERO, high: DVec2::ZERO, nearest: 0.0, start: 1, count: 0 });
                self.nodes.push(placeholder);
                self.nodes.push(Node { low: DVec2::ZERO, high: DVec2::ZERO, nearest: 0.0, start: 3, count: 0 });
                self.nodes.push(placeholder);
                self.nodes.push(placeholder);
                self.bloated_root = 2;
                build_subtree(&mut active_tiers[0], &mut self.nodes, 1, &self.boxes, &mut perm);
                build_subtree(&mut active_tiers[1], &mut self.nodes, 3, &self.boxes, &mut perm);
                build_subtree(&mut active_tiers[2], &mut self.nodes, 4, &self.boxes, &mut perm);
            }
        }
        drop(active_tiers);

        for i in (0..self.nodes.len()).rev() {
            let node = self.nodes[i];
            if node.count == 0 {
                let a = self.nodes[node.start as usize];
                let b = self.nodes[(node.start + 1) as usize];
                self.nodes[i].low = a.low.min(b.low);
                self.nodes[i].high = a.high.max(b.high);
                self.nodes[i].nearest = a.nearest.min(b.nearest);
            }
        }
        for i in 0..len {
            if (perm[i] as usize) == i {
                continue;
            }
            let saved_tri = self.triangles[i];
            let saved_box = self.boxes[i];
            let mut current = i;
            loop {
                let next = perm[current] as usize;
                perm[current] = current as u32;
                if next == i {
                    self.triangles[current] = saved_tri;
                    self.boxes[current] = saved_box;
                    break;
                }
                self.triangles[current] = self.triangles[next];
                self.boxes[current] = self.boxes[next];
                current = next;
            }
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
        let nearest = depths[0].min(depths[1]).min(depths[2]);
        self.triangles.push(Flat {
            points,
            depths,
            area,
            nearest,
        });
        self.boxes.push(TriBox {
            low,
            high,
            nearest,
        });
        true
    }

    /// Clips the edge against one triangle: the span of it that lies under the triangle and
    /// behind it. Everything here is linear along the edge, so each test is one clip.
    fn covered(flat: &Flat, edge: &Edge) -> Option<(f64, f64)> {
        let sign = flat.area.signum();
        let [p, q, r] = flat.points;
        let s0 = q - p;
        let a0 = sign * s0.perp_dot(edge.a - p) + COVER_SLACK;
        let b0 = sign * s0.perp_dot(edge.b - p) + COVER_SLACK;
        if a0 < 0.0 && b0 < 0.0 {
            return None;
        }
        let s1 = r - q;
        let a1 = sign * s1.perp_dot(edge.a - q) + COVER_SLACK;
        let b1 = sign * s1.perp_dot(edge.b - q) + COVER_SLACK;
        if a1 < 0.0 && b1 < 0.0 {
            return None;
        }
        let s2 = p - r;
        let a2 = sign * s2.perp_dot(edge.a - r) + COVER_SLACK;
        let b2 = sign * s2.perp_dot(edge.b - r) + COVER_SLACK;
        if a2 < 0.0 && b2 < 0.0 {
            return None;
        }
        let (mut start, mut end) = (0.0_f64, 1.0_f64);
        for (at_start, at_end) in [(a0, b0), (a1, b1), (a2, b2)] {
            if at_start < 0.0 {
                start = start.max(at_start / (at_start - at_end));
            } else if at_end < 0.0 {
                end = end.min(at_start / (at_start - at_end));
            }
            if start >= end {
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
        let behind_start = depth_at(start) - under_start.max(flat.nearest) - OCCLUSION_EPSILON;
        let behind_end = depth_at(end) - under_end.max(flat.nearest) - OCCLUSION_EPSILON;
        if !behind_start.is_finite() || !behind_end.is_finite() {
            return None;
        }
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

    #[inline]
    fn record_cover(&mut self, id: u32) {
        if let Some(pos) = self.last_covers[..self.last_covers_len].iter().position(|&x| x == id) {
            if pos > 0 {
                self.last_covers.copy_within(0..pos, 1);
                self.last_covers[0] = id;
            }
        } else if self.last_covers_len < 8 {
            self.last_covers.copy_within(0..self.last_covers_len, 1);
            self.last_covers[0] = id;
            self.last_covers_len += 1;
        } else {
            self.last_covers.copy_within(0..7, 1);
            self.last_covers[0] = id;
        }
    }

    /// The hidden spans of an edge, as sorted parameters along it. `None` when the budget ran
    /// out, because a partial answer would draw hidden lines as visible. The nearer child is
    /// searched first, so a fully covered edge stops early.
    fn hidden_spans_slice(&mut self, edge: &Edge) -> Option<&[(f64, f64)]> {
        let join = JOIN_GAP / edge.a.distance(edge.b).max(JOIN_GAP);
        self.spans_buf.clear();
        if self.nodes.is_empty() {
            return Some(&self.spans_buf);
        }
        let mut active_low = edge.low;
        let mut active_high = edge.high;
        let mut active_deepest = edge.deepest;

        // 2D separating-axis line parameters for the segment a -> b: a box [low, high] whose 4
        // corners all lie strictly on one side of the infinite line through a -> b cannot contain
        // any point of the segment.
        let two_a = edge.a * 2.0;
        let line_n = DVec2::new(edge.a.y - edge.b.y, edge.b.x - edge.a.x);
        let abs_n = line_n.abs();
        let coord_scale = edge.a.abs().max(edge.b.abs()).max_element();
        let line_pad = (abs_n.x + abs_n.y) * (coord_scale * 1e-13 + 1e-11);

        let reaches = |low: DVec2, high: DVec2, nearest: f64, a_low: DVec2, a_high: DVec2, a_deep: f64| {
            nearest + OCCLUSION_EPSILON <= a_deep
                && a_high.x >= low.x
                && a_low.x <= high.x
                && a_high.y >= low.y
                && a_low.y <= high.y
                && (!low.is_finite()
                    || !high.is_finite()
                    || ((low + high) - two_a).dot(line_n).abs() <= (high - low).dot(abs_n) + line_pad)
        };
        let root = &self.nodes[0];
        if !reaches(root.low, root.high, root.nearest, active_low, active_high, active_deepest) {
            return Some(&self.spans_buf);
        }

        // Fast path: test the individual triangles that covered recent edges first.
        let mut cache_hit = false;
        for k in 0..self.last_covers_len {
            let idx = self.last_covers[k] as usize;
            let tbox = &self.boxes[idx];
            if !reaches(tbox.low, tbox.high, tbox.nearest, active_low, active_high, active_deepest) {
                continue;
            }
            if self.tests_left == 0 {
                return None;
            }
            self.tests_left -= 1;
            if let Some(span) = Self::covered(&self.triangles[idx], edge) {
                if span.0 <= join && span.1 >= 1.0 - join {
                    let id = idx as u32;
                    self.record_cover(id);
                    self.spans_buf.clear();
                    self.spans_buf.push((0.0, 1.0));
                    return Some(&self.spans_buf);
                }
                self.spans_buf.push(span);
                cache_hit = true;
            }
        }
        if cache_hit {
            merge_spans_in_place(&mut self.spans_buf, join);
            if self.spans_buf.len() == 1 && self.spans_buf[0].0 <= 0.0 && self.spans_buf[0].1 >= 1.0 {
                return Some(&self.spans_buf);
            }
            let u_min = if self.spans_buf.first().is_some_and(|s| s.0 <= 0.0) {
                self.spans_buf[0].1
            } else {
                0.0
            };
            let u_max = if self.spans_buf.last().is_some_and(|s| s.1 >= 1.0) {
                self.spans_buf.last().unwrap().0
            } else {
                1.0
            };
            if u_min > 0.0 || u_max < 1.0 {
                let pa = edge.a + (edge.b - edge.a) * u_min;
                let pb = edge.a + (edge.b - edge.a) * u_max;
                let pad = pa.abs().max(pb.abs()).max_element() * 1e-14 + 1e-12;
                active_low = (pa.min(pb) - DVec2::splat(pad)).max(edge.low);
                active_high = (pa.max(pb) + DVec2::splat(pad)).min(edge.high);
                let da = edge.depth_a + (edge.depth_b - edge.depth_a) * u_min;
                let db = edge.depth_a + (edge.depth_b - edge.depth_a) * u_max;
                let dpad = da.abs().max(db.abs()) * 1e-14 + 1e-12;
                active_deepest = (da.max(db) + dpad).min(edge.deepest);
            }
        }

        self.stack.clear();
        let mut current = 0u32;
        loop {
            let node = self.nodes[current as usize];
            if node.count == 0 {
                let (a, b) = (node.start, node.start + 1);
                let na = &self.nodes[a as usize];
                let nb = &self.nodes[b as usize];
                let ra = reaches(na.low, na.high, na.nearest, active_low, active_high, active_deepest);
                let rb = reaches(nb.low, nb.high, nb.nearest, active_low, active_high, active_deepest);
                if ra && rb {
                    // Always search real triangles before the bloated sliver subtree, and moderate
                    // slivers before huge/unbounded slivers; within real triangles, order by
                    // nearest depth.
                    if b == self.bloated_root || current == self.bloated_root || na.nearest <= nb.nearest {
                        self.stack.push(b);
                        current = a;
                    } else {
                        self.stack.push(a);
                        current = b;
                    }
                    continue;
                } else if ra {
                    current = a;
                    continue;
                } else if rb {
                    current = b;
                    continue;
                }
            } else {
                let before = self.spans_buf.len();
                let start = node.start as usize;
                let end = start + node.count as usize;
                let mut leaf_full = false;
                for tri_idx in start..end {
                    let tbox = self.boxes[tri_idx];
                    if tbox.nearest + OCCLUSION_EPSILON > active_deepest {
                        break;
                    }
                    if active_high.x < tbox.low.x
                        || active_low.x > tbox.high.x
                        || active_high.y < tbox.low.y
                        || active_low.y > tbox.high.y
                    {
                        continue;
                    }
                    if self.tests_left == 0 {
                        return None;
                    }
                    self.tests_left -= 1;
                    if let Some(span) = Self::covered(&self.triangles[tri_idx], edge) {
                        self.record_cover(tri_idx as u32);
                        if span.0 <= join && span.1 >= 1.0 - join {
                            self.spans_buf.clear();
                            self.spans_buf.push((0.0, 1.0));
                            leaf_full = true;
                            break;
                        }
                        self.spans_buf.push(span);
                    }
                }
                if leaf_full {
                    break;
                }
                if self.spans_buf.len() != before {
                    merge_spans_in_place(&mut self.spans_buf, join);
                    if self.spans_buf.len() == 1 && self.spans_buf[0].0 <= 0.0 && self.spans_buf[0].1 >= 1.0 {
                        break;
                    }
                    let u_min = if self.spans_buf.first().is_some_and(|s| s.0 <= 0.0) {
                        self.spans_buf[0].1
                    } else {
                        0.0
                    };
                    let u_max = if self.spans_buf.last().is_some_and(|s| s.1 >= 1.0) {
                        self.spans_buf.last().unwrap().0
                    } else {
                        1.0
                    };
                    if u_min > 0.0 || u_max < 1.0 {
                        let pa = edge.a + (edge.b - edge.a) * u_min;
                        let pb = edge.a + (edge.b - edge.a) * u_max;
                        let pad = pa.abs().max(pb.abs()).max_element() * 1e-14 + 1e-12;
                        active_low = (pa.min(pb) - DVec2::splat(pad)).max(edge.low);
                        active_high = (pa.max(pb) + DVec2::splat(pad)).min(edge.high);
                        let da = edge.depth_a + (edge.depth_b - edge.depth_a) * u_min;
                        let db = edge.depth_a + (edge.depth_b - edge.depth_a) * u_max;
                        let dpad = da.abs().max(db.abs()) * 1e-14 + 1e-12;
                        active_deepest = (da.max(db) + dpad).min(edge.deepest);
                    }
                }
            }
            loop {
                let Some(next) = self.stack.pop() else {
                    return Some(&self.spans_buf);
                };
                let n = &self.nodes[next as usize];
                if reaches(n.low, n.high, n.nearest, active_low, active_high, active_deepest) {
                    current = next;
                    break;
                }
            }
        }
        Some(&self.spans_buf)
    }

    #[cfg(test)]
    fn hidden_spans(&mut self, edge: &Edge) -> Option<Vec<(f64, f64)>> {
        self.hidden_spans_slice(edge).map(|s| s.to_vec())
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

/// Sorts and joins spans in place, snapping to the ends of the edge.
fn merge_spans_in_place(spans: &mut Vec<(f64, f64)>, join: f64) {
    spans.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut write = 0usize;
    for read in 0..spans.len() {
        let (start, end) = spans[read];
        if write > 0 && start <= spans[write - 1].1 + join {
            spans[write - 1].1 = spans[write - 1].1.max(end);
        } else {
            spans[write] = (start, end);
            write += 1;
        }
    }
    spans.truncate(write);
    if let Some(first) = spans.first_mut().filter(|first| first.0 <= join) {
        first.0 = 0.0;
    }
    if let Some(last) = spans.last_mut().filter(|last| last.1 >= 1.0 - join) {
        last.1 = 1.0;
    }
}

#[cfg(test)]
fn merge_spans(spans: &mut Vec<(f64, f64)>, join: f64) -> Vec<(f64, f64)> {
    merge_spans_in_place(spans, join);
    spans.clone()
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
    let mut scratch = std::mem::take(&mut occluders.scratch);
    let (skipped, too_many) = feature_edges_into(mesh, frame.look, &mut scratch);
    report.non_finite += skipped;
    report.truncated = too_many;

    scratch.proj_edges.clear();
    for &(from, to) in &scratch.edges {
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

        scratch.proj_edges.push(Edge {
            a,
            b,
            depth_a,
            depth_b,
            deepest: depth_a.max(depth_b),
            low: a.min(b),
            high: a.max(b),
        });
    }

    for edge in &scratch.proj_edges {
        let length = edge.a.distance(edge.b);
        let Some(spans) = occluders.hidden_spans_slice(edge) else {
            report.truncated = true;
            break;
        };
        // Spans closer than MIN_HIDDEN_RUN are one hidden run, so many tiny neighbours are not
        // dropped one by one; then a run still shorter than that is a touch, not a cover.
        let near = MIN_HIDDEN_RUN / length;
        scratch.runs.clear();
        for &(start, end) in spans {
            match scratch.runs.last_mut() {
                Some(last) if start - last.1 < near => last.1 = last.1.max(end),
                _ => scratch.runs.push((start, end)),
            }
        }
        let mut cursor = 0.0;
        for &(start, end) in &scratch.runs {
            if (end - start) * length >= MIN_HIDDEN_RUN {
                push_run(edge.a, edge.b, cursor, start, true, visible, hidden);
                push_run(edge.a, edge.b, start, end, false, visible, hidden);
                cursor = end;
            }
        }
        push_run(edge.a, edge.b, cursor, 1.0, true, visible, hidden);
    }
    occluders.scratch = scratch;
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
    struct Entry {
        key: (i64, i64),
        span: (f64, f64),
        idx_and_vis: u32,
    }

    let total = visible.len() + hidden.len();
    let mut entries: Vec<Entry> = Vec::with_capacity(total);
    for (idx, (segment, is_visible)) in visible
        .iter()
        .map(|segment| (segment, true))
        .chain(hidden.iter().map(|segment| (segment, false)))
        .enumerate()
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
        let (from, to) = (direction.dot(segment.a), direction.dot(segment.b));
        let span = (from.min(to), from.max(to));
        entries.push(Entry {
            key,
            span,
            idx_and_vis: ((idx as u32) << 1) | u32::from(is_visible),
        });
    }

    entries.sort_unstable_by(|a, b| a.key.cmp(&b.key).then(a.idx_and_vis.cmp(&b.idx_and_vis)));

    let vis_len = visible.len();
    let mut new_visible = Vec::with_capacity(vis_len);
    let mut new_hidden = Vec::with_capacity(hidden.len());
    let mut vis_buf: Vec<(f64, f64)> = Vec::new();
    let mut hid_buf: Vec<(f64, f64)> = Vec::new();
    let mut vis_out: Vec<(f64, f64)> = Vec::new();
    let mut hid_union: Vec<(f64, f64)> = Vec::new();
    let mut hid_out: Vec<(f64, f64)> = Vec::new();
    let mut i = 0;
    while i < entries.len() {
        let key = entries[i].key;
        let first_idx = (entries[i].idx_and_vis >> 1) as usize;
        let first_seg = if first_idx < vis_len {
            &visible[first_idx]
        } else {
            &hidden[first_idx - vis_len]
        };
        let mut first_dir = (first_seg.b - first_seg.a).try_normalize().unwrap();
        if first_dir.x < -1e-12 || (first_dir.x.abs() <= 1e-12 && first_dir.y < 0.0) {
            first_dir = -first_dir;
        }
        let first_norm = DVec2::new(-first_dir.y, first_dir.x);
        let first_off = first_norm.dot(first_seg.a);
        let base = first_norm * first_off;
        vis_buf.clear();
        hid_buf.clear();
        while i < entries.len() && entries[i].key == key {
            if (entries[i].idx_and_vis & 1) != 0 {
                vis_buf.push(entries[i].span);
            } else {
                hid_buf.push(entries[i].span);
            }
            i += 1;
        }
        union_into(&mut vis_buf, &mut vis_out);
        for &(from, to) in &vis_out {
            new_visible.push(Segment::new(base + first_dir * from, base + first_dir * to));
        }
        if !hid_buf.is_empty() {
            subtract_into(&mut hid_buf, &vis_out, &mut hid_union, &mut hid_out);
            for &(from, to) in &hid_out {
                new_hidden.push(Segment::new(base + first_dir * from, base + first_dir * to));
            }
        }
    }
    *visible = new_visible;
    *hidden = new_hidden;
}

fn union_into(spans: &mut [(f64, f64)], out: &mut Vec<(f64, f64)>) {
    out.clear();
    if spans.is_empty() {
        return;
    }
    if spans.len() > 1 {
        spans.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    }
    for &(start, end) in spans.iter() {
        if end - start <= 1e-9 {
            continue;
        }
        match out.last_mut() {
            Some(last) if start <= last.1 + 1e-9 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
}

fn subtract_into(
    spans: &mut [(f64, f64)],
    cut: &[(f64, f64)],
    union_buf: &mut Vec<(f64, f64)>,
    out: &mut Vec<(f64, f64)>,
) {
    union_into(spans, union_buf);
    out.clear();
    for &(start, end) in union_buf.iter() {
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
}

/// The edges worth drawing, welded so two triangles sharing an edge count once, the triangles
/// skipped, and whether the element had more edges than it may contribute.
fn feature_edges_into(mesh: &Mesh, look: DVec3, scratch: &mut FeatureScratch) -> (usize, bool) {
    let n_pos = mesh.positions.len();
    scratch.pos_to_welded.clear();
    scratch.pos_to_welded.resize(n_pos, u32::MAX);
    let table_cap = (n_pos * 2).next_power_of_two().max(16);
    let mask = table_cap - 1;
    scratch.table_slots.clear();
    scratch.table_slots.resize(table_cap, u32::MAX);
    scratch.point_keys.clear();
    scratch.points.clear();
    scratch.tri_normals.clear();
    scratch.raw_edges.clear();
    scratch.edges.clear();
    let mut skipped = 0;

    for &[i0, i1, i2] in &mesh.triangles {
        let (Some(&a), Some(&b), Some(&c)) = (
            mesh.positions.get(i0 as usize),
            mesh.positions.get(i1 as usize),
            mesh.positions.get(i2 as usize),
        ) else {
            continue;
        };
        if !(a.is_finite() && b.is_finite() && c.is_finite()) {
            skipped += 1;
            continue;
        }
        let normal = (b - a).cross(c - a);
        if normal.length_squared() <= 1e-24 {
            continue;
        }
        let normal = normal.normalize();
        let tri_idx = scratch.tri_normals.len() as u32;
        scratch.tri_normals.push(normal);

        let mut id_of = |idx: u32, point: DVec3| -> u32 {
            let cached = scratch.pos_to_welded[idx as usize];
            if cached != u32::MAX {
                return cached;
            }
            let key = [point.x.to_bits(), point.y.to_bits(), point.z.to_bits()];
            let mut h = key[0]
                .wrapping_mul(0x9e3779b97f4a7c15)
                .wrapping_add(key[1].wrapping_mul(0xbf58476d1ce4e5b9))
                .wrapping_add(key[2].wrapping_mul(0x94d049bb133111eb));
            h ^= h >> 30;
            let mut slot = (h as usize) & mask;
            let id = loop {
                let entry = scratch.table_slots[slot];
                if entry == u32::MAX {
                    let next = scratch.points.len() as u32;
                    scratch.table_slots[slot] = next;
                    scratch.point_keys.push(key);
                    scratch.points.push(point);
                    break next;
                }
                if scratch.point_keys[entry as usize] == key {
                    break entry;
                }
                slot = (slot + 1) & mask;
            };
            scratch.pos_to_welded[idx as usize] = id;
            id
        };
        let (ia, ib, ic) = (id_of(i0, a), id_of(i1, b), id_of(i2, c));
        for (from, to) in [(ia, ib), (ib, ic), (ic, ia)] {
            if from == to {
                continue;
            }
            let key = ((from.min(to) as u64) << 32) | (from.max(to) as u64);
            scratch.raw_edges.push((key, tri_idx));
        }
    }

    scratch.raw_edges.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut too_many = false;
    let mut i = 0;
    while i < scratch.raw_edges.len() {
        let key = scratch.raw_edges[i].0;
        let n0 = scratch.tri_normals[scratch.raw_edges[i].1 as usize];
        let mut count = 1u32;
        let mut n1 = DVec3::ZERO;
        i += 1;
        while i < scratch.raw_edges.len() && scratch.raw_edges[i].0 == key {
            if count == 1 {
                n1 = scratch.tri_normals[scratch.raw_edges[i].1 as usize];
            }
            count = count.saturating_add(1);
            i += 1;
        }
        let draw = if count < 2 {
            true
        } else {
            let first = n0.dot(look);
            let second = n1.dot(look);
            let crease = n0.dot(n1) < CREASE_COSINE;
            // One face looks at the viewer and the other away: the surface turns here.
            let silhouette = (first < -1e-6 && second > 1e-6) || (second < -1e-6 && first > 1e-6);
            crease || silhouette
        };
        if !draw {
            continue;
        }
        let from = (key >> 32) as usize;
        let to = (key as u32) as usize;
        let (a, b) = (scratch.points[from], scratch.points[to]);
        if a.distance(b) > SEGMENT_EPSILON {
            if scratch.edges.len() >= MAX_FEATURE_EDGES {
                too_many = true;
                break;
            }
            scratch.edges.push((a, b));
        }
    }
    (skipped, too_many)
}

#[cfg(test)]
fn feature_edges(mesh: &Mesh, look: DVec3) -> (Vec<(DVec3, DVec3)>, usize, bool) {
    let mut scratch = FeatureScratch::default();
    let (skipped, too_many) = feature_edges_into(mesh, look, &mut scratch);
    (scratch.edges, skipped, too_many)
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

    // External models in `test/models` (or `GUBIM_MODELS_DIR`) are fetched by `node scripts/fetch-models.mjs`.
    #[test]
    #[ignore]
    fn review_t149_real_models_bvh_vs_oracle() {
        use std::fs;
        use std::path::{Path, PathBuf};

        fn collect_ifc(dir: &Path, out: &mut Vec<PathBuf>) {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        collect_ifc(&path, out);
                    } else if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("ifc")) {
                        out.push(path);
                    }
                }
            }
        }

        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let models_dir =
            std::env::var_os("GUBIM_MODELS_DIR").map_or_else(|| root.join("test/models"), PathBuf::from);
        let mut files = Vec::new();
        for dir in [root.join("test/fixtures"), root.join("public/samples"), models_dir] {
            collect_ifc(&dir, &mut files);
        }
        files.sort();

        let mut checked_files = 0usize;
        let mut total_edges = 0usize;
        for path in &files {
            if fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX) > 3_000_000 {
                continue;
            }
            let Ok(bytes) = fs::read(path) else { continue };
            let Ok(index) = step_parser::index(&bytes) else { continue };
            let Ok(mut eval) = ifc_geometry::ModelEvaluator::new(&index) else { continue };
            let mut meshes = Vec::new();
            let (mut low, mut high) = (DVec3::INFINITY, DVec3::NEG_INFINITY);
            for id in eval.element_ids() {
                if let Some(el) = eval.evaluate(id) {
                    for item in el.meshes {
                        for &pt in &item.mesh.positions {
                            if pt.is_finite() {
                                low = low.min(pt);
                                high = high.max(pt);
                            }
                        }
                        meshes.push(item.mesh);
                    }
                }
            }
            if meshes.is_empty() || !low.is_finite() {
                continue;
            }
            let total_tris: usize = meshes.iter().map(|m| m.triangles.len()).sum();
            if total_tris > 40_000 {
                continue;
            }
            let mid_z = (low.z + high.z) * 0.5 + (high.z - low.z) * 0.0137;
            let frame = Frame::of(crate::cut::Cut::Plan { z: mid_z }).unwrap();
            let mut occluders = Occluders::new(total_tris);
            for mesh in &meshes {
                add_occluders(mesh, &frame, None, &mut occluders);
            }
            occluders.finish();
            checked_files += 1;

            for mesh in &meshes {
                let (edges, _, _) = feature_edges(mesh, frame.look);
                for (from, to) in edges {
                    let (depth_from, depth_to) = (frame.depth(from), frame.depth(to));
                    if !depth_from.is_finite() || !depth_to.is_finite() {
                        continue;
                    }
                    let run = depth_to - depth_from;
                    let (mut start, mut end) = (0.0_f64, 1.0_f64);
                    if run.abs() <= f64::MIN_POSITIVE {
                        if depth_from < 0.0 {
                            continue;
                        }
                    } else {
                        let zero = -depth_from / run;
                        if run > 0.0 {
                            start = start.max(zero);
                        } else {
                            end = end.min(zero);
                        }
                    }
                    if end - start <= 1e-9 {
                        continue;
                    }
                    let a = from.lerp(to, start);
                    let b = from.lerp(to, end);
                    let (pa, pb) = (frame.project(a), frame.project(b));
                    if pa.distance(pb) <= SEGMENT_EPSILON {
                        continue;
                    }
                    let e = edge(pa, pb, frame.depth(a), frame.depth(b));
                    occluders.tests_left = MAX_OCCLUSION_TESTS;
                    let bvh = occluders.hidden_spans(&e).unwrap();
                    let expected = oracle(&occluders, &e);
                    assert_eq!(bvh, expected, "BVH disagrees with brute-force oracle in {}", path.display());
                    total_edges += 1;
                }
            }
        }
        assert!(checked_files > 0 && total_edges > 0);
    }
}
