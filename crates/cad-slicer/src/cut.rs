//! Plan and section cuts: intersects the meshes with a plane and chains the pieces into
//! closed loops.
//!
//! Only the material behind the plane survives, the side the viewer looks away from, so a
//! plan at a storey level keeps the storey and drops everything above it. A plane that only
//! touches the near face of a solid therefore yields nothing, while one that touches the far
//! face yields that face.
//!
//! Loops come out counter-clockwise when they bound material, clockwise when they bound a
//! hole. Each cut segment is ordered by the triangle's outward normal, so the rule holds
//! without looking for containment.

use crate::geom::{Loop, NodeIndex, SEGMENT_EPSILON};
use glam::{DVec2, DVec3};
use ifc_geometry::Mesh;
use std::collections::{BTreeMap, BTreeSet};

/// Segments one element may contribute. Beyond this the cut is truncated and reported.
pub(crate) const MAX_CUT_SEGMENTS: usize = 200_000;
/// Points one loop may reach, which bounds a walk through a hostile fan of segments.
const MAX_LOOP_POINTS: usize = 65_536;

/// The axis a section stands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
    Z,
}

impl Axis {
    pub fn unit(self) -> DVec3 {
        match self {
            Axis::X => DVec3::X,
            Axis::Y => DVec3::Y,
            Axis::Z => DVec3::Z,
        }
    }
}

/// Which way the viewer looks along the cut axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    Positive,
    Negative,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cut {
    /// The horizontal plan of docs/05: it always looks towards -Z.
    Plan { z: f64 },
    Section {
        axis: Axis,
        position: f64,
        look: Look,
    },
    /// An arbitrary cut plane through `origin`, looking in the direction of `normal`.
    Plane {
        origin: DVec3,
        normal: DVec3,
    },
}

/// The drawing plane: where the cut stands, where the viewer looks, and how world coordinates
/// map to the sheet.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub origin: DVec3,
    /// The direction the viewer looks in, from the eye into the model.
    pub look: DVec3,
    /// The sheet's X axis.
    pub right: DVec3,
    /// The sheet's Y axis.
    pub up: DVec3,
}

impl Frame {
    /// `None` when the cut's position or normal is not a finite usable vector.
    pub fn of(cut: Cut) -> Option<Self> {
        let (origin, look) = match cut {
            Cut::Plan { z } => (DVec3::new(0.0, 0.0, z), -DVec3::Z),
            Cut::Section {
                axis,
                position,
                look,
            } => {
                let sign = if look == Look::Positive { 1.0 } else { -1.0 };
                (axis.unit() * position, axis.unit() * sign)
            }
            Cut::Plane { origin, normal } => {
                if !normal.is_finite() || normal.length_squared() <= 1e-24 {
                    return None;
                }
                (origin, normal.try_normalize()?)
            }
        };
        if !origin.is_finite() || !look.is_finite() {
            return None;
        }
        // Project world +Z onto the sheet; for a horizontal plane keep world +Y up.
        let vertical = DVec3::Z - look * DVec3::Z.dot(look);
        let up = if vertical.length_squared() > 1e-12 {
            vertical.normalize()
        } else {
            (DVec3::Y - look * DVec3::Y.dot(look)).normalize()
        };
        // right × up = -look: the sheet is right handed seen from the eye.
        let right = up.cross(-look);
        Some(Self {
            origin,
            look,
            right,
            up,
        })
    }

    pub fn project(&self, point: DVec3) -> DVec2 {
        DVec2::new(point.dot(self.right), point.dot(self.up))
    }

    pub fn unproject(&self, point: DVec2) -> DVec3 {
        self.look * self.origin.dot(self.look) + self.right * point.x + self.up * point.y
    }

    /// Distance behind the plane along the look direction. Negative is between eye and plane.
    pub fn depth(&self, point: DVec3) -> f64 {
        (point - self.origin).dot(self.look)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CutReport {
    /// Triangles with a coordinate that is not finite.
    pub non_finite: usize,
    /// Segments dropped because the element hit the work limit.
    pub truncated: bool,
    /// Loops that did not close, usually a mesh that is not watertight.
    pub open_loops: usize,
}

/// Cuts one mesh and appends its loops. Never fails: a hostile mesh loses its bad triangles.
pub(crate) fn cut_mesh(mesh: &Mesh, frame: &Frame, out: &mut Vec<Loop>) -> CutReport {
    let mut report = CutReport::default();
    let mut index = NodeIndex::new();
    let mut edges: Vec<(u32, u32)> = Vec::new();

    for [a, b, c] in mesh.triangle_corners() {
        if !(a.is_finite() && b.is_finite() && c.is_finite()) {
            report.non_finite += 1;
            continue;
        }
        let corners = [a, b, c];
        let depth = [frame.depth(a), frame.depth(b), frame.depth(c)];
        if depth.iter().any(|value| !value.is_finite()) {
            report.non_finite += 1;
            continue;
        }
        let normal = (b - a).cross(c - a);
        if normal.length_squared() <= 1e-24 {
            continue;
        }
        // Material lies on the -normal side of the face; the in-plane part of that direction
        // says which way the boundary runs.
        let inward = -normal;
        let flat = inward - frame.look * inward.dot(frame.look);
        let along = DVec2::new(flat.dot(frame.right), flat.dot(frame.up));
        if along.length_squared() <= 1e-24 {
            continue;
        }
        // Walking this way keeps the material, which lies `along`, on the left.
        let direction = DVec2::new(along.y, -along.x);

        let mut hits: [DVec2; 2] = [DVec2::ZERO; 2];
        let mut count = 0;
        for i in 0..3 {
            let j = (i + 1) % 3;
            if (depth[i] > 0.0) == (depth[j] > 0.0) {
                continue;
            }
            let t = depth[i] / (depth[i] - depth[j]);
            let point = frame.project(corners[i] + (corners[j] - corners[i]) * t);
            if !point.is_finite() {
                count = 0;
                break;
            }
            if count < 2 {
                hits[count] = point;
            }
            count += 1;
        }
        if count != 2 {
            continue;
        }
        // Order the piece so the material stays on its left.
        if (hits[1] - hits[0]).dot(direction) < 0.0 {
            hits.swap(0, 1);
        }
        if hits[0].distance(hits[1]) <= SEGMENT_EPSILON {
            continue;
        }
        if edges.len() >= MAX_CUT_SEGMENTS {
            report.truncated = true;
            break;
        }
        let (Some(from), Some(to)) = (index.node(hits[0]), index.node(hits[1])) else {
            continue;
        };
        if from == to {
            continue;
        }
        edges.push((from, to));
    }

    let edges = merge_edges(&edges);
    let chain_report = chain(&index, &edges, out);
    report.open_loops = chain_report.open;
    report.truncated |= chain_report.capped;
    report
}

/// Pairs the directed edges that join the same two nodes.
///
/// Two solids touching inside one mesh both cut their shared face, each with the material on
/// its own side, so the two edges run in opposite directions and bound nothing between them:
/// the pair cancels and the joint outline closes. Only an edge repeated in the same direction
/// is the same boundary drawn twice, and one copy survives. The walk keeps the input order so
/// the result does not depend on any hashing.
fn merge_edges(edges: &[(u32, u32)]) -> Vec<(u32, u32)> {
    // Which directions each unordered node pair was seen in.
    let mut directions: BTreeMap<(u32, u32), [bool; 2]> = BTreeMap::new();
    for (from, to) in edges {
        let forward = (*from < *to) as usize;
        directions
            .entry((*from.min(to), *from.max(to)))
            .or_default()[forward] = true;
    }
    // Which directions have already given their one surviving edge.
    let mut emitted: BTreeSet<(u32, u32, bool)> = BTreeSet::new();
    let mut kept = Vec::with_capacity(edges.len());
    for (from, to) in edges {
        let pair = (*from.min(to), *from.max(to));
        let forward = *from < *to;
        if directions[&pair][1 - (forward as usize)] {
            continue;
        }
        // A repeat in the same direction is the same boundary: keep its first copy.
        if !emitted.insert((pair.0, pair.1, forward)) {
            continue;
        }
        kept.push((*from, *to));
    }
    kept
}

/// What the chaining pass found.
struct ChainReport {
    /// Chains that stopped without closing on a mesh that should have been watertight.
    open: usize,
    /// A loop hit the point limit, so the rest of its edges were left for another chain.
    capped: bool,
}

/// Follows the directed edges into loops and returns how many chains stayed open.
fn chain(index: &NodeIndex, edges: &[(u32, u32)], out: &mut Vec<Loop>) -> ChainReport {
    let mut outgoing: Vec<Vec<u32>> = vec![Vec::new(); index.len()];
    for (id, (from, _)) in edges.iter().enumerate() {
        outgoing[*from as usize].push(id as u32);
    }
    let mut used = vec![false; edges.len()];
    let mut open = 0;
    let mut capped = false;

    for start in 0..edges.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let (first, mut current) = edges[start];
        let mut points = vec![index.point(first), index.point(current)];
        let mut closed = false;
        let mut previous = first;

        while points.len() < MAX_LOOP_POINTS {
            if current == first {
                closed = true;
                break;
            }
            let Some(next) =
                next_edge(index, edges, &outgoing[current as usize], &used, current, previous)
            else {
                break;
            };
            used[next as usize] = true;
            let (from, to) = edges[next as usize];
            let onward = if from == current { to } else { from };
            points.push(index.point(onward));
            previous = current;
            current = onward;
        }

        if closed && points.len() > 1 {
            points.pop();
        }
        if !closed {
            // A ring longer than the cap is not an open mesh; the pass simply stopped.
            if points.len() >= MAX_LOOP_POINTS {
                capped = true;
            } else {
                open += 1;
            }
        }
        let shape = Loop {
            points,
            closed,
        };
        if !shape.is_empty() {
            out.push(shape);
        }
        // Past the cap there is no useful remainder: stop instead of reporting the fragments
        // as open loops.
        if capped {
            break;
        }
    }
    ChainReport { open, capped }
}

/// The straightest unused edge leaving a node, then the lowest number. Fixed rules keep the
/// output independent of any hashing.
fn next_edge(
    index: &NodeIndex,
    edges: &[(u32, u32)],
    candidates: &[u32],
    used: &[bool],
    current: u32,
    previous: u32,
) -> Option<u32> {
    let incoming = (index.point(current) - index.point(previous)).try_normalize()?;
    let mut best: Option<(f64, u32)> = None;
    for id in candidates {
        if used[*id as usize] {
            continue;
        }
        let (from, to) = edges[*id as usize];
        let onward = if from == current { to } else { from };
        let Some(outgoing) = (index.point(onward) - index.point(current)).try_normalize() else {
            continue;
        };
        let straightness = incoming.dot(outgoing);
        if best.is_none_or(|(best_score, best_id)| {
            straightness.total_cmp(&best_score) == std::cmp::Ordering::Greater
                || (straightness == best_score && *id < best_id)
        }) {
            best = Some((straightness, *id));
        }
    }
    best.map(|(_, id)| id)
}
