//! Closed meshes for revolved, swept and primitive solids. All in local coordinates.

use crate::mesh::Mesh;
use glam::{DVec2, DVec3};
use std::f64::consts::{PI, TAU};

/// Facets around a full circle.
pub(crate) const CIRCLE_SEGMENTS: usize = 32;
/// Facets around a pipe, which models repeat by the thousand.
const PIPE_SEGMENTS: usize = 12;
/// Latitude bands of a sphere.
const SPHERE_BANDS: usize = 16;
/// How far a chord of a circular arc may stray from it, in metres.
const ARC_TOLERANCE: f64 = 0.005;

/// A mesh built inside out is mirrored, not wrong: flip it so its volume is positive.
pub(crate) fn outward(mut mesh: Mesh) -> Mesh {
    if mesh.volume() < 0.0 {
        for triangle in &mut mesh.triangles {
            triangle.swap(1, 2);
        }
    }
    mesh
}

/// Evenly spaced points of a circular arc in the XY plane, both ends included.
pub(crate) fn arc(center: DVec2, radius: DVec2, start: f64, sweep: f64) -> Vec<DVec2> {
    arc_of(center, radius, start, sweep, radius.abs().max_element())
}

/// `arc` for a curve that is `size` metres across once it is placed. A count per turn alone
/// would let the chords of a wide curve leave it: on a 43 m wall, by more than the wall is thick.
fn arc_of(center: DVec2, radius: DVec2, start: f64, sweep: f64, size: f64) -> Vec<DVec2> {
    // The small margin stops rounding error adding a facet to an exact fraction of a turn.
    let turns = sweep.abs() / (TAU / CIRCLE_SEGMENTS as f64);
    let chords = sweep.abs() * (size / (8.0 * ARC_TOLERANCE)).sqrt();
    let steps = ((turns.max(chords) - 1e-9).ceil() as usize).clamp(1, 4096);
    (0..=steps)
        .map(|step| {
            let angle = start + sweep * step as f64 / steps as f64;
            center + DVec2::new(angle.cos(), angle.sin()) * radius
        })
        .collect()
}

/// The arc from `a` through `b` to `c`, or the straight run if they are collinear.
pub(crate) fn arc_through(a: DVec3, b: DVec3, c: DVec3) -> Vec<DVec3> {
    let (ab, ac) = (b - a, c - a);
    let normal = ab.cross(ac);
    let square = normal.length_squared();
    if square <= 1e-20 * ab.length_squared().max(1e-30) * ac.length_squared().max(1e-30) {
        return vec![a, b, c];
    }
    let center =
        a + (ab.length_squared() * ac.cross(normal) + ac.length_squared() * normal.cross(ab))
            / (2.0 * square);
    let x = a - center;
    let radius = x.length();
    let (x, y) = (x / radius, normal.normalize().cross(x / radius));
    let angle = |point: DVec3| {
        let to = point - center;
        to.dot(y).atan2(to.dot(x)).rem_euclid(TAU)
    };
    let sweep = angle(c);
    arc_of(DVec2::ZERO, DVec2::ONE, 0.0, sweep, radius)
        .into_iter()
        .map(|point| center + (x * point.x + y * point.y) * radius)
        .collect()
}

/// Spins an `(radius, z)` outline around Z. Points on the axis become single vertices.
fn lathe(outline: &[DVec2]) -> Mesh {
    let mut positions = Vec::new();
    let mut rings: Vec<Vec<u32>> = Vec::new();
    for point in outline {
        let start = positions.len() as u32;
        if point.x <= 0.0 {
            positions.push(DVec3::new(0.0, 0.0, point.y));
            rings.push(vec![start; CIRCLE_SEGMENTS]);
            continue;
        }
        let circle = arc_of(DVec2::ZERO, DVec2::splat(point.x), 0.0, TAU, 0.0);
        positions.extend(circle[..CIRCLE_SEGMENTS].iter().map(|ring| ring.extend(point.y)));
        rings.push((start..start + CIRCLE_SEGMENTS as u32).collect());
    }

    let mut triangles = Vec::new();
    for pair in rings.windows(2) {
        let (low, high) = (&pair[0], &pair[1]);
        for i in 0..CIRCLE_SEGMENTS {
            let next = (i + 1) % CIRCLE_SEGMENTS;
            if low[i] != low[next] {
                triangles.push([low[i], low[next], high[i]]);
            }
            if high[i] != high[next] {
                triangles.push([high[next], high[i], low[next]]);
            }
        }
    }
    outward(Mesh { positions, triangles })
}

pub(crate) fn cylinder(radius: f64, height: f64) -> Mesh {
    lathe(&[
        DVec2::new(0.0, 0.0),
        DVec2::new(radius, 0.0),
        DVec2::new(radius, height),
        DVec2::new(0.0, height),
    ])
}

pub(crate) fn cone(radius: f64, height: f64) -> Mesh {
    lathe(&[DVec2::new(0.0, 0.0), DVec2::new(radius, 0.0), DVec2::new(0.0, height)])
}

pub(crate) fn sphere(radius: f64) -> Mesh {
    let outline: Vec<DVec2> = (0..=SPHERE_BANDS)
        .map(|band| {
            let angle = PI * band as f64 / SPHERE_BANDS as f64 - PI / 2.0;
            DVec2::new(angle.cos(), angle.sin()) * radius
        })
        .map(|point| if point.x < radius * 1e-9 { DVec2::new(0.0, point.y) } else { point })
        .collect();
    lathe(&outline)
}

/// Base corner at the origin, apex over the middle of the base.
pub(crate) fn pyramid(x: f64, y: f64, height: f64) -> Mesh {
    let positions = vec![
        DVec3::ZERO,
        DVec3::new(x, 0.0, 0.0),
        DVec3::new(x, y, 0.0),
        DVec3::new(0.0, y, 0.0),
        DVec3::new(x / 2.0, y / 2.0, height),
    ];
    let triangles = vec![[0, 2, 1], [0, 3, 2], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];
    outward(Mesh { positions, triangles })
}

/// `point` turned about an axis of unit length, positive by the right-hand rule.
pub(crate) fn turned(point: DVec3, axis_point: DVec3, axis: DVec3, turn: f64) -> DVec3 {
    let offset = point - axis_point;
    let along = axis * offset.dot(axis);
    let radial = offset - along;
    let (sin, cos) = turn.sin_cos();
    axis_point + along + radial * cos + axis.cross(radial) * sin
}

/// Sweeps closed rings around an axis lying in their plane, by `angle` radians.
///
/// `caps` triangulates the rings, indexing them as if laid end to end. A full turn needs none.
pub(crate) fn revolve(
    rings: &[&[DVec2]],
    caps: &[[u32; 3]],
    axis_point: DVec3,
    axis: DVec3,
    angle: f64,
) -> Mesh {
    let full = angle >= TAU - 1e-9;
    let steps = ((angle / (TAU / CIRCLE_SEGMENTS as f64)).ceil() as usize).max(1);
    let sections = if full { steps } else { steps + 1 };
    let count = rings.iter().map(|ring| ring.len()).sum::<usize>() as u32;

    let mut positions = Vec::with_capacity(sections * count as usize);
    for section in 0..sections {
        let turn = angle * section as f64 / steps as f64;
        for point in rings.iter().flat_map(|ring| ring.iter()) {
            positions.push(turned(point.extend(0.0), axis_point, axis, turn));
        }
    }

    let vertex = |section: usize, index: u32| (section % sections) as u32 * count + index;
    let mut triangles = Vec::new();
    for step in 0..steps {
        let mut start = 0;
        for ring in rings {
            let length = ring.len() as u32;
            for i in 0..length {
                let (a, b) = (start + i, start + (i + 1) % length);
                let (a0, b0) = (vertex(step, a), vertex(step, b));
                let (a1, b1) = (vertex(step + 1, a), vertex(step + 1, b));
                triangles.push([a0, b0, b1]);
                triangles.push([a0, b1, a1]);
            }
            start += length;
        }
    }
    if !full {
        let last = steps as u32 * count;
        for [a, b, c] in caps {
            triangles.push([*a, *c, *b]);
            triangles.push([a + last, b + last, c + last]);
        }
    }
    outward(Mesh { positions, triangles })
}

/// Unit vectors perpendicular to `direction` and to each other.
pub(crate) fn perpendiculars(direction: DVec3) -> (DVec3, DVec3) {
    let helper = if direction.x.abs() < 0.9 { DVec3::X } else { DVec3::Y };
    let first = direction.cross(helper).normalize();
    (first, direction.cross(first))
}

/// Each section of `path`, as the cross-section's offsets carried along by mitred joints.
fn sections(path: &[DVec3], radius: f64) -> Vec<Vec<DVec3>> {
    let first = (path[1] - path[0]).normalize();
    let (x, y) = perpendiculars(first);
    let start: Vec<DVec3> = (0..PIPE_SEGMENTS)
        .map(|segment| {
            let (sin, cos) = (TAU * segment as f64 / PIPE_SEGMENTS as f64).sin_cos();
            path[0] + (x * cos + y * sin) * radius
        })
        .collect();

    let mut sections = vec![start];
    for at in 1..path.len() {
        let incoming = (path[at] - path[at - 1]).normalize();
        let outgoing = path.get(at + 1).map(|next| (*next - path[at]).normalize());
        let bisector = outgoing
            .map(|outgoing| incoming + outgoing)
            .and_then(DVec3::try_normalize)
            // A hairpin has no usable mitre, and neither does a very sharp turn.
            .filter(|plane| plane.dot(incoming) > 0.25)
            .unwrap_or(incoming);
        let section = sections[at - 1]
            .iter()
            .map(|point| {
                *point + incoming * (path[at] - *point).dot(bisector) / incoming.dot(bisector)
            })
            .collect();
        sections.push(section);
    }
    sections
}

fn tube_walls(sections: &[Vec<DVec3>], first: u32, flip: bool, triangles: &mut Vec<[u32; 3]>) {
    let around = sections[0].len() as u32;
    for along in 0..sections.len() as u32 - 1 {
        for i in 0..around {
            let next = (i + 1) % around;
            let a = first + along * around + i;
            let b = first + along * around + next;
            let (c, d) = (a + around, b + around);
            if flip {
                triangles.extend([[a, d, b], [a, c, d]]);
            } else {
                triangles.extend([[a, b, d], [a, d, c]]);
            }
        }
    }
}

/// A round bar along `path`, hollow if `inner` is given. `path` needs two distinct points.
pub(crate) fn pipe(path: &[DVec3], radius: f64, inner: Option<f64>) -> Mesh {
    let outer = sections(path, radius);
    let around = outer[0].len() as u32;
    let rings = outer.len() as u32;
    let mut positions: Vec<DVec3> = outer.iter().flatten().copied().collect();
    let mut triangles = Vec::new();
    tube_walls(&outer, 0, false, &mut triangles);
    let last = (rings - 1) * around;

    match inner {
        Some(inner) => {
            let hollow = sections(path, inner);
            let start = positions.len() as u32;
            positions.extend(hollow.iter().flatten());
            tube_walls(&hollow, start, true, &mut triangles);
            for i in 0..around {
                let next = (i + 1) % around;
                triangles.extend([
                    [i, start + i, start + next],
                    [i, start + next, next],
                    [last + i, last + next, start + last + next],
                    [last + i, start + last + next, start + last + i],
                ]);
            }
        }
        None => {
            let (start_center, end_center) = (positions.len() as u32, positions.len() as u32 + 1);
            positions.push(path[0]);
            positions.push(path[path.len() - 1]);
            for i in 0..around {
                let next = (i + 1) % around;
                triangles.push([start_center, next, i]);
                triangles.push([end_center, last + i, last + next]);
            }
        }
    }
    outward(Mesh { positions, triangles })
}

/// Rounds the joints of a polyline with arcs of `radius`. A joint with no room for its arc,
/// or that doubles straight back, stays sharp.
pub(crate) fn filleted(path: &[DVec3], radius: f64) -> Vec<DVec3> {
    let Some(last) = path.last() else { return Vec::new() };
    let mut result = vec![path[0]];
    for (index, joint) in path.windows(3).enumerate() {
        let (before, at, after) = (joint[0], joint[1], joint[2]);
        let (into, out) = (at - before, after - at);
        // Segments between two joints share their length with the arc at the other end.
        let room_in = into.length() / if index == 0 { 1.0 } else { 2.0 };
        let room_out = out.length() / if index + 3 == path.len() { 1.0 } else { 2.0 };
        let (Some(incoming), Some(outgoing)) = (into.try_normalize(), out.try_normalize()) else {
            result.push(at);
            continue;
        };
        let turn = incoming.angle_between(outgoing);
        let reach = radius * (turn / 2.0).tan();
        let bisector = (outgoing - incoming).try_normalize();
        match bisector.filter(|_| turn > 1e-6 && reach <= room_in.min(room_out)) {
            Some(bisector) => {
                let center = at + bisector * radius / (turn / 2.0).cos();
                let bend = center - bisector * radius;
                result.extend(arc_through(at - incoming * reach, bend, at + outgoing * reach));
            }
            None => result.push(at),
        }
    }
    result.push(*last);
    result
}

/// A corner of a section outline, and how much to round it.
pub(crate) type Corner = (f64, f64, f64);

/// A closed polygon with rounded corners. A radius too large for its edges is left square.
pub(crate) fn rounded(corners: &[Corner]) -> Vec<DVec2> {
    let count = corners.len();
    let point = |index: usize| {
        let (x, y, _) = corners[index % count];
        DVec2::new(x, y)
    };
    let mut ring = Vec::with_capacity(count);
    for (index, (_, _, radius)) in corners.iter().enumerate() {
        let (at, radius) = (point(index), *radius);
        let (before, after) = (point(index + count - 1), point(index + 1));
        let (to_before, to_after) = (before - at, after - at);
        let (Some(u), Some(v)) = (to_before.try_normalize(), to_after.try_normalize()) else {
            ring.push(at);
            continue;
        };
        let half = u.dot(v).clamp(-1.0, 1.0).acos() / 2.0;
        let cut = radius / half.tan();
        if radius <= 0.0 || !cut.is_finite() || cut > to_before.length() || cut > to_after.length() {
            ring.push(at);
            continue;
        }
        let center = at + (u + v).normalize() * (radius / half.sin());
        let angle = |point: DVec2| (point.y - center.y).atan2(point.x - center.x);
        let start = angle(at + u * cut);
        let mut sweep = angle(at + v * cut) - start;
        if sweep > PI {
            sweep -= TAU;
        } else if sweep < -PI {
            sweep += TAU;
        }
        ring.extend(arc(center, DVec2::splat(radius), start, sweep));
    }
    ring
}

/// `(width, depth, web, flange, fillet, edge)` of an I section, centred.
pub(crate) fn i_section(w: f64, d: f64, web: f64, flange: f64, fillet: f64, edge: f64) -> Vec<Corner> {
    let (x, y, t) = (w / 2.0, d / 2.0, web / 2.0);
    let inner = y - flange;
    vec![
        (-x, -y, 0.0),
        (x, -y, 0.0),
        (x, -inner, edge),
        (t, -inner, fillet),
        (t, inner, fillet),
        (x, inner, edge),
        (x, y, 0.0),
        (-x, y, 0.0),
        (-x, inner, edge),
        (-t, inner, fillet),
        (-t, -inner, fillet),
        (-x, -inner, edge),
    ]
}

/// An angle with its legs along the bottom and the left of its bounding box, centred.
pub(crate) fn l_section(depth: f64, width: f64, thickness: f64, fillet: f64, edge: f64) -> Vec<Corner> {
    let (x, y) = (width / 2.0, depth / 2.0);
    vec![
        (-x, -y, 0.0),
        (x, -y, 0.0),
        (x, -y + thickness, edge),
        (-x + thickness, -y + thickness, fillet),
        (-x + thickness, y, edge),
        (-x, y, 0.0),
    ]
}

/// A tee with its flange at the top of its bounding box, centred.
pub(crate) fn t_section(
    depth: f64,
    width: f64,
    web: f64,
    flange: f64,
    [fillet, flange_edge, web_edge]: [f64; 3],
) -> Vec<Corner> {
    let (x, y, t) = (width / 2.0, depth / 2.0, web / 2.0);
    vec![
        (-t, -y, web_edge),
        (t, -y, web_edge),
        (t, y - flange, fillet),
        (x, y - flange, flange_edge),
        (x, y, 0.0),
        (-x, y, 0.0),
        (-x, y - flange, flange_edge),
        (-t, y - flange, fillet),
    ]
}

/// A channel with its web on the left of its bounding box, centred.
pub(crate) fn u_section(depth: f64, width: f64, web: f64, flange: f64, fillet: f64, edge: f64) -> Vec<Corner> {
    let (x, y) = (width / 2.0, depth / 2.0);
    vec![
        (-x, -y, 0.0),
        (x, -y, 0.0),
        (x, -y + flange, edge),
        (-x + web, -y + flange, fillet),
        (-x + web, y - flange, fillet),
        (x, y - flange, edge),
        (x, y, 0.0),
        (-x, y, 0.0),
    ]
}

/// A cold-formed channel with lips, open on the right, centred.
pub(crate) fn c_section(depth: f64, width: f64, wall: f64, girth: f64, fillet: f64) -> Vec<Corner> {
    let (x, y) = (width / 2.0, depth / 2.0);
    let outer = if fillet > 0.0 { fillet + wall } else { 0.0 };
    vec![
        (-x, -y, outer),
        (x, -y, outer),
        (x, -y + girth, 0.0),
        (x - wall, -y + girth, 0.0),
        (x - wall, -y + wall, fillet),
        (-x + wall, -y + wall, fillet),
        (-x + wall, y - wall, fillet),
        (x - wall, y - wall, fillet),
        (x - wall, y - girth, 0.0),
        (x, y - girth, 0.0),
        (x, y, outer),
        (-x, y, outer),
    ]
}

/// A zed with its web on the Y axis, top flange to the right, bottom flange to the left.
pub(crate) fn z_section(depth: f64, width: f64, web: f64, flange: f64, fillet: f64, edge: f64) -> Vec<Corner> {
    let (y, t, x) = (depth / 2.0, web / 2.0, width - web / 2.0);
    vec![
        (-x, -y, 0.0),
        (t, -y, 0.0),
        (t, y - flange, fillet),
        (x, y - flange, edge),
        (x, y, 0.0),
        (-t, y, 0.0),
        (-t, -y + flange, fillet),
        (-x, -y + flange, edge),
    ]
}
