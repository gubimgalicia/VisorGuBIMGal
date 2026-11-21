//! B-spline curves and surfaces, rational or not, and meshing of trimmed surfaces.
//!
//! Evaluation is the Cox-de Boor recurrence. A trimmed face is meshed in parameter space:
//! its boundary is mapped onto the surface by Newton iteration and triangulated as a whole,
//! then the triangles are split along a grid that follows the knots, so the result keeps
//! both the exact trim and the curvature.

use crate::mesh::Mesh;
use earcut::Earcut;
use glam::{DMat4, DVec2, DVec3, DVec4};
use std::f64::consts::{FRAC_PI_2, TAU};

/// Hostile files can claim any size, and evaluation cost grows with the square of the degree.
const MAX_DEGREE: usize = 32;
const STEPS_PER_SPAN: usize = 8;
const MAX_CURVE_POINTS: usize = 4096;
const MAX_CELLS_PER_DIRECTION: usize = 64;
/// Triangle and cell pairs one face may test, so a hostile boundary cannot stall the Worker.
const MAX_CLIPS_PER_FACE: usize = 20_000_000;
const NEWTON_STEPS: usize = 12;
/// Grid resolution used to seed Newton iteration.
const SEED_GRID: usize = 16;
/// A gap this wide cannot come from sampling a full circle, so the face stops short of a turn.
const MIN_ANGULAR_GAP: f64 = FRAC_PI_2 / 4.0;
/// Radians beyond the boundary, so that no point of it sits on the end of a surface.
const ARC_MARGIN: f64 = 1e-6;

/// Expands `Knots` and `KnotMultiplicities`. `None` unless they suit `count` control points.
pub(crate) fn expand_knots(
    knots: &[f64],
    multiplicities: &[usize],
    degree: usize,
    count: usize,
) -> Option<Vec<f64>> {
    if knots.len() != multiplicities.len() || degree == 0 || degree > MAX_DEGREE || count <= degree {
        return None;
    }
    if multiplicities.iter().sum::<usize>() != count + degree + 1 {
        return None;
    }
    let expanded: Vec<f64> = knots
        .iter()
        .zip(multiplicities)
        .flat_map(|(knot, times)| std::iter::repeat_n(*knot, *times))
        .collect();
    let valid = expanded.iter().all(|knot| knot.is_finite())
        && expanded.windows(2).all(|pair| pair[0] <= pair[1])
        && expanded[degree] < expanded[count];
    valid.then_some(expanded)
}

/// The span holding `t` and its `degree + 1` non-zero basis functions.
fn basis(knots: &[f64], degree: usize, count: usize, t: f64) -> (usize, Vec<f64>) {
    let t = t.clamp(knots[degree], knots[count]);
    let mut span = degree;
    while span + 1 < count && t >= knots[span + 1] {
        span += 1;
    }
    let mut values = vec![0.0; degree + 1];
    values[0] = 1.0;
    let (mut left, mut right) = (vec![0.0; degree + 1], vec![0.0; degree + 1]);
    for j in 1..=degree {
        left[j] = t - knots[span + 1 - j];
        right[j] = knots[span + j] - t;
        let mut saved = 0.0;
        for r in 0..j {
            let denominator = right[r + 1] + left[j - r];
            let share = if denominator == 0.0 { 0.0 } else { values[r] / denominator };
            values[r] = saved + right[r + 1] * share;
            saved = left[j - r] * share;
        }
        values[j] = saved;
    }
    (span, values)
}

fn project(point: DVec4) -> Option<DVec3> {
    let result = point.truncate() / point.w;
    result.is_finite().then_some(result)
}

fn distinct_spans(knots: &[f64], degree: usize, count: usize) -> usize {
    knots[degree..=count].windows(2).filter(|pair| pair[0] < pair[1]).count()
}

pub(crate) struct Curve {
    pub degree: usize,
    pub points: Vec<DVec3>,
    pub weights: Vec<f64>,
    pub knots: Vec<f64>,
}

/// Rational quadratic arcs of the unit circle, at most a quarter turn each: their control
/// points, weights and knots.
fn unit_arc(start: f64, sweep: f64) -> (Vec<DVec2>, Vec<f64>, Vec<f64>) {
    let arcs = ((sweep.abs() / FRAC_PI_2 - 1e-9).ceil() as usize).max(1);
    let half = sweep / arcs as f64 / 2.0;
    let on_circle = |angle: f64| DVec2::new(angle.cos(), angle.sin());
    let (mut points, mut weights) = (vec![on_circle(start)], vec![1.0]);
    let mut knots = vec![0.0; 3];
    for arc in 0..arcs {
        let angle = start + half * (2 * arc + 1) as f64;
        points.push(on_circle(angle) / half.cos());
        points.push(on_circle(angle + half));
        weights.extend([half.cos(), 1.0]);
        let knot = (arc + 1) as f64 / arcs as f64;
        knots.extend([knot, knot]);
    }
    knots.push(1.0);
    (points, weights, knots)
}

/// The part of a turn that `angles` cover, as a start and a sweep with a little to spare.
/// A cover with no wide gap is the whole turn. Starting in the gap keeps the seam of a
/// surface built from it out of the face.
pub(crate) fn covered_arc(angles: impl Iterator<Item = f64>) -> (f64, f64) {
    let mut angles: Vec<f64> = angles.map(|angle| angle.rem_euclid(TAU)).collect();
    angles.sort_by(f64::total_cmp);
    let widest = (0..angles.len())
        .map(|i| match angles.get(i + 1) {
            Some(next) => (next - angles[i], *next),
            None => (angles[0] + TAU - angles[i], angles[0]),
        })
        .max_by(|a, b| a.0.total_cmp(&b.0));
    match widest {
        Some((gap, end)) if gap >= MIN_ANGULAR_GAP => (end - ARC_MARGIN, TAU - gap + 2.0 * ARC_MARGIN),
        _ => (0.0, TAU),
    }
}

impl Curve {
    /// Straight segments through `points`.
    pub fn polyline(points: Vec<DVec3>) -> Option<Self> {
        let count = points.len();
        if count < 2 {
            return None;
        }
        let spans = (count - 1) as f64;
        let mut knots = vec![0.0];
        knots.extend((0..count).map(|i| i as f64 / spans));
        knots.push(1.0);
        Some(Self { degree: 1, weights: vec![1.0; count], points, knots })
    }

    /// An arc of the circle of `radius` around `(center_x, 0, 0)` in the XZ plane.
    pub fn arc_in_xz(center_x: f64, radius: f64, start: f64, sweep: f64) -> Self {
        let (points, weights, knots) = unit_arc(start, sweep);
        let points = points
            .iter()
            .map(|point| DVec3::new(center_x + point.x * radius, 0.0, point.y * radius))
            .collect();
        Self { degree: 2, points, weights, knots }
    }

    fn at(&self, t: f64) -> Option<DVec3> {
        let (span, values) = basis(&self.knots, self.degree, self.points.len(), t);
        let mut sum = DVec4::ZERO;
        for (offset, value) in values.iter().enumerate() {
            let index = span - self.degree + offset;
            let weight = self.weights[index] * value;
            sum += (self.points[index] * weight).extend(weight);
        }
        project(sum)
    }

    /// A polyline through the curve, with more points on higher degrees and more spans.
    pub fn sample(&self) -> Option<Vec<DVec3>> {
        let count = self.points.len();
        let (start, end) = (self.knots[self.degree], self.knots[count]);
        let spans = distinct_spans(&self.knots, self.degree, count);
        let steps = (spans * self.degree * STEPS_PER_SPAN / 2).clamp(1, MAX_CURVE_POINTS);
        (0..=steps)
            .map(|step| self.at(start + (end - start) * step as f64 / steps as f64))
            .collect()
    }
}

pub(crate) struct Surface {
    pub u_degree: usize,
    pub v_degree: usize,
    /// One row per U index.
    pub points: Vec<Vec<DVec3>>,
    pub weights: Vec<Vec<f64>>,
    pub u_knots: Vec<f64>,
    pub v_knots: Vec<f64>,
}

impl Surface {
    /// `curve` turned about Z, from `start` by `sweep`. Exact, and U runs by the right-hand
    /// rule, so a curve rising along V at positive X faces away from the axis.
    pub fn revolved(curve: &Curve, start: f64, sweep: f64) -> Self {
        let (turns, turn_weights, u_knots) = unit_arc(start, sweep);
        let points = turns
            .iter()
            .map(|turn| {
                curve
                    .points
                    .iter()
                    .map(|point| {
                        let radial = DVec2::new(point.x * turn.x - point.y * turn.y, point.x * turn.y + point.y * turn.x);
                        radial.extend(point.z)
                    })
                    .collect()
            })
            .collect();
        let weights = turn_weights
            .iter()
            .map(|turn| curve.weights.iter().map(|weight| turn * weight).collect())
            .collect();
        Self { u_degree: 2, v_degree: curve.degree, points, weights, u_knots, v_knots: curve.knots.clone() }
    }

    /// `curve` moved between two offsets, with U along it and V across.
    pub fn extruded(curve: &Curve, low: DVec3, high: DVec3) -> Self {
        Self {
            u_degree: curve.degree,
            v_degree: 1,
            points: curve.points.iter().map(|point| vec![*point + low, *point + high]).collect(),
            weights: curve.weights.iter().map(|weight| vec![*weight; 2]).collect(),
            u_knots: curve.knots.clone(),
            v_knots: vec![0.0, 0.0, 1.0, 1.0],
        }
    }

    pub fn transformed(mut self, frame: DMat4) -> Self {
        for point in self.points.iter_mut().flatten() {
            *point = frame.transform_point3(*point);
        }
        self
    }

    fn u_count(&self) -> usize {
        self.points.len()
    }

    fn v_count(&self) -> usize {
        self.points[0].len()
    }

    fn u_domain(&self) -> (f64, f64) {
        (self.u_knots[self.u_degree], self.u_knots[self.u_count()])
    }

    fn v_domain(&self) -> (f64, f64) {
        (self.v_knots[self.v_degree], self.v_knots[self.v_count()])
    }

    fn at(&self, u: f64, v: f64) -> Option<DVec3> {
        let (u_span, u_values) = basis(&self.u_knots, self.u_degree, self.u_count(), u);
        let (v_span, v_values) = basis(&self.v_knots, self.v_degree, self.v_count(), v);
        let mut sum = DVec4::ZERO;
        for (i, u_value) in u_values.iter().enumerate() {
            let row = u_span - self.u_degree + i;
            for (j, v_value) in v_values.iter().enumerate() {
                let column = v_span - self.v_degree + j;
                let weight = self.weights[row][column] * u_value * v_value;
                sum += (self.points[row][column] * weight).extend(weight);
            }
        }
        project(sum)
    }

    /// Newton iteration towards the point nearest `target`. Gives the parameters and the miss.
    fn refine(&self, target: DVec3, start: DVec2) -> Option<(DVec2, f64)> {
        let (u_start, u_end) = self.u_domain();
        let (v_start, v_end) = self.v_domain();
        let (du, dv) = ((u_end - u_start) * 1e-5, (v_end - v_start) * 1e-5);
        let mut at = start;
        for _ in 0..NEWTON_STEPS {
            let here = self.at(at.x, at.y)?;
            let along_u = (self.at(at.x + du, at.y)? - self.at(at.x - du, at.y)?) / (2.0 * du);
            let along_v = (self.at(at.x, at.y + dv)? - self.at(at.x, at.y - dv)?) / (2.0 * dv);
            let miss = target - here;
            let (uu, uv, vv) = (along_u.dot(along_u), along_u.dot(along_v), along_v.dot(along_v));
            let determinant = uu * vv - uv * uv;
            if determinant.abs() < 1e-24 {
                break;
            }
            let (a, b) = (miss.dot(along_u), miss.dot(along_v));
            let step = DVec2::new(vv * a - uv * b, uu * b - uv * a) / determinant;
            at = DVec2::new(
                (at.x + step.x).clamp(u_start, u_end),
                (at.y + step.y).clamp(v_start, v_end),
            );
            if step.length_squared() < 1e-20 {
                break;
            }
        }
        Some((at, self.at(at.x, at.y)?.distance_squared(target)))
    }

    /// The parameters of the surface point nearest `target`. Starts from the previous point
    /// along the boundary and from the nearest of a coarse grid, and keeps the better.
    fn invert(&self, target: DVec3, grid: &[(DVec2, DVec3)], previous: Option<DVec2>) -> Option<DVec2> {
        let seed = grid
            .iter()
            .min_by(|a, b| a.1.distance_squared(target).total_cmp(&b.1.distance_squared(target)))?
            .0;
        let from_seed = self.refine(target, seed)?;
        let best = match previous.and_then(|start| self.refine(target, start)) {
            Some(result) if result.1 <= from_seed.1 => result,
            _ => from_seed,
        };
        Some(best.0)
    }

    /// The unit normal, along U cross V, at the surface point nearest each of `points`.
    pub fn normals_at(&self, points: &[DVec3]) -> Option<Vec<DVec3>> {
        let seeds = self.seed_grid();
        let (u_start, u_end) = self.u_domain();
        let (v_start, v_end) = self.v_domain();
        let (du, dv) = ((u_end - u_start) * 1e-5, (v_end - v_start) * 1e-5);
        let mut previous = None;
        points
            .iter()
            .map(|point| {
                let uv = self.invert(*point, &seeds, previous)?;
                previous = Some(uv);
                let along_u = self.at(uv.x + du, uv.y)? - self.at(uv.x - du, uv.y)?;
                let along_v = self.at(uv.x, uv.y + dv)? - self.at(uv.x, uv.y - dv)?;
                along_u.cross(along_v).try_normalize()
            })
            .collect()
    }

    /// Whether the two ends of a parameter direction are the same place.
    fn closes(&self, along_u: bool) -> bool {
        let (u_start, u_end) = self.u_domain();
        let (v_start, v_end) = self.v_domain();
        (0..=8).all(|step| {
            let share = step as f64 / 8.0;
            let ends = if along_u {
                let v = v_start + (v_end - v_start) * share;
                (self.at(u_start, v), self.at(u_end, v))
            } else {
                let u = u_start + (u_end - u_start) * share;
                (self.at(u, v_start), self.at(u, v_end))
            };
            matches!(ends, (Some(a), Some(b)) if a.distance_squared(b) < 1e-12)
        })
    }

    fn seed_grid(&self) -> Vec<(DVec2, DVec3)> {
        let (u_start, u_end) = self.u_domain();
        let (v_start, v_end) = self.v_domain();
        let mut grid = Vec::with_capacity((SEED_GRID + 1) * (SEED_GRID + 1));
        for i in 0..=SEED_GRID {
            for j in 0..=SEED_GRID {
                let uv = DVec2::new(
                    u_start + (u_end - u_start) * i as f64 / SEED_GRID as f64,
                    v_start + (v_end - v_start) * j as f64 / SEED_GRID as f64,
                );
                if let Some(point) = self.at(uv.x, uv.y) {
                    grid.push((uv, point));
                }
            }
        }
        grid
    }
}

/// Keeps the part of a closed ring on one side of an axis-aligned line.
fn clip_ring(ring: &[DVec2], axis: usize, limit: f64, keep_above: bool) -> Vec<DVec2> {
    let inside = |point: DVec2| {
        let value = point[axis];
        if keep_above { value >= limit } else { value <= limit }
    };
    let mut result = Vec::with_capacity(ring.len());
    for (index, current) in ring.iter().enumerate() {
        let next = ring[(index + 1) % ring.len()];
        if inside(*current) {
            result.push(*current);
        }
        if inside(*current) != inside(next) {
            let share = (limit - current[axis]) / (next[axis] - current[axis]);
            result.push(current.lerp(next, share));
        }
    }
    result
}

fn clip_to_cell(ring: &[DVec2], min: DVec2, max: DVec2) -> Vec<DVec2> {
    let ring = clip_ring(ring, 0, min.x, true);
    let ring = clip_ring(&ring, 0, max.x, false);
    let ring = clip_ring(&ring, 1, min.y, true);
    clip_ring(&ring, 1, max.y, false)
}

/// Grid lines across `[start, end]`, on every knot and between them, so that features
/// squeezed between close knots still get cells of their own.
fn grid_lines(knots: &[f64], degree: usize, start: f64, end: f64) -> Vec<f64> {
    let mut stops = vec![start];
    stops.extend(knots.iter().copied().filter(|knot| *knot > start && *knot < end));
    stops.push(end);
    stops.dedup();

    let spans = stops.len() - 1;
    let stride = spans.div_ceil(MAX_CELLS_PER_DIRECTION).max(1);
    // Curved directions are as fine as the boundaries, which are sampled at the same rate.
    let wanted = if degree > 1 { (degree * 2).max(STEPS_PER_SPAN) } else { 2 };
    let per_span = (MAX_CELLS_PER_DIRECTION / spans).clamp(1, wanted);
    let mut lines = Vec::new();
    for pair in stops.windows(2).step_by(stride) {
        lines.extend((0..per_span).map(|step| pair[0] + (pair[1] - pair[0]) * step as f64 / per_span as f64));
    }
    lines.push(end);
    lines
}

/// The cells of `lines` that `low..high` reaches.
fn cell_range(lines: &[f64], low: f64, high: f64) -> std::ops::Range<usize> {
    let first = lines.partition_point(|line| *line <= low).saturating_sub(1);
    let last = lines.partition_point(|line| *line < high).min(lines.len() - 1);
    first..last.max(first + 1)
}

/// Whether a ring steps across more than half of a direction: on a closed surface, that is
/// the seam, not a long edge.
fn crosses_seam(rings: &[Vec<DVec2>], axis: usize, span: f64) -> bool {
    rings.iter().any(|ring| {
        (0..ring.len()).any(|i| (ring[(i + 1) % ring.len()][axis] - ring[i][axis]).abs() > span * 0.5)
    })
}

/// How many times a ring goes around a closed direction of `span`, with sign.
fn winding(ring: &[DVec2], axis: usize, span: f64) -> f64 {
    let travelled: f64 = (0..ring.len())
        .map(|i| {
            let step = ring[(i + 1) % ring.len()][axis] - ring[i][axis];
            step - span * (step / span).round()
        })
        .sum();
    travelled / span
}

/// Meshes a surface inside trimming loops, given as points in space, the outer one first.
///
/// Triangles wind by parameter direction. A loop that wraps around a closed surface has no
/// interior in parameter space, so such faces keep the whole band that their loops span,
/// less any loop wound the other way that stays clear of the seam: those are real holes.
/// A lone loop around the surface caps it, reaching from the loop to the end of the surface
/// on its left, seen from outside the face: `same_sense` says which side of the surface that is.
pub(crate) fn mesh_surface(surface: &Surface, loops: &[Vec<DVec3>], same_sense: bool) -> Option<Mesh> {
    let seeds = surface.seed_grid();
    let (u_start, u_end) = surface.u_domain();
    let (v_start, v_end) = surface.v_domain();

    let mut rings: Vec<Vec<DVec2>> = Vec::with_capacity(loops.len());
    for boundary in loops {
        let mut ring = Vec::with_capacity(boundary.len());
        for point in boundary {
            ring.push(surface.invert(*point, &seeds, ring.last().copied())?);
        }
        rings.push(ring);
    }

    let u_wraps = surface.closes(true) && crosses_seam(&rings, 0, u_end - u_start);
    let v_wraps = surface.closes(false) && crosses_seam(&rings, 1, v_end - v_start);

    let extent = |axis: usize| {
        rings.iter().flatten().fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), uv| {
            (low.min(uv[axis]), high.max(uv[axis]))
        })
    };
    let (mut u_low, mut u_high) = if u_wraps { (u_start, u_end) } else { extent(0) };
    let (mut v_low, mut v_high) = if v_wraps { (v_start, v_end) } else { extent(1) };
    if let [ring] = rings.as_slice() {
        let side = if same_sense { 1.0 } else { -1.0 };
        let around_u = winding(ring, 0, u_end - u_start) * side;
        if u_wraps && !v_wraps && around_u.abs() > 0.9 {
            // Left of rising U is rising V.
            if around_u > 0.0 { v_high = v_end } else { v_low = v_start }
        }
        let around_v = winding(ring, 1, v_end - v_start) * side;
        if v_wraps && !u_wraps && around_v.abs() > 0.9 {
            if around_v > 0.0 { u_low = u_start } else { u_high = u_end }
        }
    }
    if !(u_high > u_low && v_high > v_low) {
        return None;
    }
    let us = grid_lines(&surface.u_knots, surface.u_degree, u_low, u_high);
    let vs = grid_lines(&surface.v_knots, surface.v_degree, v_low, v_high);

    let signed_area = |ring: &[DVec2]| {
        (0..ring.len()).map(|i| ring[i].perp_dot(ring[(i + 1) % ring.len()])).sum::<f64>() / 2.0
    };
    // A single loop around its whole extent trims nothing, and a plain grid is far lighter.
    let extent_area = (u_high - u_low) * (v_high - v_low);
    let untrimmed = rings.len() == 1 && signed_area(&rings[0]).abs() >= extent_area * 0.9999;

    let mut mesh = Mesh::default();
    let wraps = u_wraps || v_wraps;
    let band_holes: Vec<&Vec<DVec2>> = if wraps {
        let largest = rings.iter().map(|ring| signed_area(ring)).max_by(|a, b| a.abs().total_cmp(&b.abs()));
        let sign = largest.unwrap_or(1.0).signum();
        let spans = [u_end - u_start, v_end - v_start];
        rings
            .iter()
            .filter(|ring| signed_area(ring) * sign < 0.0)
            .filter(|ring| !(0..2).any(|axis| crosses_seam(std::slice::from_ref(*ring), axis, spans[axis])))
            .collect()
    } else {
        Vec::new()
    };

    if untrimmed || (wraps && band_holes.is_empty()) {
        for u in us.windows(2) {
            for v in vs.windows(2) {
                let square = [
                    DVec2::new(u[0], v[0]),
                    DVec2::new(u[1], v[0]),
                    DVec2::new(u[1], v[1]),
                    DVec2::new(u[0], v[1]),
                ];
                emit_fan(surface, &square, &mut mesh)?;
            }
        }
        return (!mesh.is_empty()).then_some(mesh);
    }

    let band;
    let parts: Vec<&Vec<DVec2>> = if wraps {
        band = vec![
            DVec2::new(u_low, v_low),
            DVec2::new(u_high, v_low),
            DVec2::new(u_high, v_high),
            DVec2::new(u_low, v_high),
        ];
        std::iter::once(&band).chain(band_holes).collect()
    } else {
        rings.iter().collect()
    };
    let mut points: Vec<DVec2> = Vec::new();
    let mut hole_starts = Vec::new();
    for (index, ring) in parts.iter().enumerate() {
        if index > 0 {
            hole_starts.push(points.len() as u32);
        }
        points.extend_from_slice(ring);
    }
    let mut indices: Vec<u32> = Vec::new();
    Earcut::new().earcut(points.iter().map(|point| [point.x, point.y]), &hole_starts, &mut indices);

    let mut clips = 0;
    for triangle in indices.as_chunks::<3>().0 {
        let [a, b, c] = [0, 1, 2].map(|corner| points[triangle[corner] as usize]);
        let area = (b - a).perp_dot(c - a);
        if area == 0.0 {
            continue;
        }
        let corners = if area > 0.0 { [a, b, c] } else { [a, c, b] };
        let (low, high) = (a.min(b).min(c), a.max(b).max(c));
        for i in cell_range(&us, low.x, high.x) {
            for j in cell_range(&vs, low.y, high.y) {
                clips += 1;
                if clips > MAX_CLIPS_PER_FACE {
                    return None;
                }
                let min = DVec2::new(us[i], vs[j]);
                let max = DVec2::new(us[i + 1], vs[j + 1]);
                emit_fan(surface, &clip_to_cell(&corners, min, max), &mut mesh)?;
            }
        }
    }
    (!mesh.is_empty()).then_some(mesh)
}

/// Adds a convex polygon of parameters to the mesh as a triangle fan.
fn emit_fan(surface: &Surface, polygon: &[DVec2], mesh: &mut Mesh) -> Option<()> {
    if polygon.len() < 3 {
        return Some(());
    }
    let first = mesh.positions.len() as u32;
    for corner in polygon {
        mesh.positions.push(surface.at(corner.x, corner.y)?);
    }
    for step in 1..polygon.len() as u32 - 1 {
        mesh.triangles.push([first, first + step, first + step + 1]);
    }
    Some(())
}