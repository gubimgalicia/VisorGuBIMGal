//! Curves of alignments: transition spirals, defined by how they turn, segments that cut
//! a part of such a curve and place it, and paths that know their distance along.

use crate::solids::CIRCLE_SEGMENTS;
use glam::{DMat4, DVec2, DVec3};
use std::f64::consts::{PI, TAU};
use std::rc::Rc;

const MAX_SEGMENT_POINTS: usize = 4096;
/// How far a chord of an alignment curve may stray from it, in metres.
const CHORD_TOLERANCE: f64 = 0.02;
/// Polynomial segments have no turn to measure before sampling them.
const POLYNOMIAL_STEPS: usize = 32;
/// Simpson intervals from a spiral's origin to the start of a segment.
const SPIRAL_INTERVALS: usize = 512;
/// Simpson intervals between two samples of a spiral, which turn little by construction.
const STEP_INTERVALS: usize = 4;
/// Samples used to measure how far a spiral turns over a segment.
const TURN_SAMPLES: usize = 32;
/// Halvings that find where a vertical profile reaches a distance: 2⁻⁶⁰ of a segment.
const PROFILE_HALVINGS: usize = 60;

/// How a transition spiral turns with arc length.
pub(crate) enum Heading {
    /// `(power, coefficient)` terms of a polynomial.
    Polynomial(Vec<(i32, f64)>),
    Cosine { constant: Option<f64>, cosine: f64, length: f64 },
    Sine { constant: Option<f64>, linear: Option<f64>, sine: f64, length: f64 },
}

impl Heading {
    /// A polynomial spiral from its terms `A0, A1, ...`. Absent or zero terms drop out.
    pub fn polynomial(terms: &[Option<f64>]) -> Self {
        let term = |(index, value): (usize, &Option<f64>)| {
            let value = (*value).filter(|value| *value != 0.0)?;
            let power = index as i32 + 1;
            let coefficient = if index % 2 == 1 {
                value / (power as f64 * value.abs().powi(power + 1))
            } else {
                1.0 / (power as f64 * value.powi(power))
            };
            Some((power, coefficient))
        };
        Self::Polynomial(terms.iter().enumerate().filter_map(term).collect())
    }

    fn at(&self, s: f64) -> f64 {
        let linear = |constant: Option<f64>| constant.map_or(0.0, |constant| s / constant);
        match self {
            Self::Polynomial(terms) => terms.iter().map(|(power, value)| value * s.powi(*power)).sum(),
            Self::Cosine { constant, cosine, length } => {
                linear(*constant) + length / (PI * cosine) * (PI / length * s).sin()
            }
            Self::Sine { constant, linear: quadratic, sine, length } => {
                let spiral = quadratic.map_or(0.0, |term| 0.5 * term.signum() * (s / term) * (s / term));
                linear(*constant) + spiral - length / (TAU * sine) * ((TAU / length * s).cos() - 1.0)
            }
        }
    }

    /// The local movement between two arc lengths, by Simpson's rule.
    fn step(&self, from: f64, to: f64, intervals: usize) -> DVec2 {
        let width = (to - from) / intervals as f64;
        let along = |s: f64| {
            let angle = self.at(s);
            DVec2::new(angle.cos(), angle.sin())
        };
        let mut sum = along(from) + along(to);
        for interval in 1..intervals {
            sum += along(from + width * interval as f64) * if interval % 2 == 1 { 4.0 } else { 2.0 };
        }
        sum * width / 3.0
    }
}

/// A curve that a segment cuts a part from, measured by arc length, or by its own parameter
/// for polynomials.
pub(crate) enum Parent {
    Line { origin: DVec3, direction: DVec3 },
    Circle { frame: DMat4, radius: f64 },
    Spiral { frame: DMat4, heading: Heading },
    Polynomial { frame: DMat4, x: Vec<f64>, y: Vec<f64>, z: Vec<f64>, unit: f64 },
}

/// A polynomial and its derivative, with coefficients lowest power first.
fn polynomial(coefficients: &[f64], t: f64) -> (f64, f64) {
    coefficients.iter().rev().fold((0.0, 0.0), |(value, slope), coefficient| {
        (value * t + coefficient, slope * t + value)
    })
}

impl Parent {
    /// The point and unit tangent at `s`.
    fn at(&self, s: f64) -> (DVec3, DVec3) {
        match self {
            Self::Line { origin, direction } => (*origin + *direction * s, *direction),
            Self::Circle { frame, radius } => {
                let (sin, cos) = (s / radius).sin_cos();
                let point = DVec3::new(cos, sin, 0.0) * *radius;
                (frame.transform_point3(point), frame.transform_vector3(DVec3::new(-sin, cos, 0.0)))
            }
            Self::Spiral { frame, heading } => {
                let (sin, cos) = heading.at(s).sin_cos();
                let point = heading.step(0.0, s, SPIRAL_INTERVALS).extend(0.0);
                (frame.transform_point3(point), frame.transform_vector3(DVec3::new(cos, sin, 0.0)))
            }
            Self::Polynomial { frame, x, y, z, unit } => {
                let t = s / unit;
                let (px, dx) = polynomial(x, t);
                let (py, dy) = polynomial(y, t);
                let (pz, dz) = polynomial(z, t);
                let point = DVec3::new(px, py, pz) * *unit;
                (frame.transform_point3(point), frame.transform_vector3(DVec3::new(dx, dy, dz)).normalize_or_zero())
            }
        }
    }

    /// The normal of the plane the curve lies in.
    fn plane(&self) -> DVec3 {
        match self {
            Self::Line { direction, .. } => {
                if direction.z.abs() < 0.9 { DVec3::Z } else { DVec3::X }
            }
            Self::Circle { frame, .. } | Self::Spiral { frame, .. } | Self::Polynomial { frame, .. } => {
                frame.z_axis.truncate()
            }
        }
    }

    /// Enough steps for the angle turned, and for chords to stay close to wide curves, where
    /// a count per turn alone would leave chords tens of metres long.
    fn steps(&self, start: f64, length: f64) -> usize {
        let per_turn = CIRCLE_SEGMENTS as f64 / TAU;
        let steps_for = |turn: f64, curvature: f64| {
            let chords = length.abs() * (curvature / (8.0 * CHORD_TOLERANCE)).sqrt();
            (turn * per_turn).max(chords)
        };
        let steps = match self {
            Self::Line { .. } => 1.0,
            Self::Circle { radius, .. } => steps_for((length / radius).abs(), 1.0 / radius),
            Self::Polynomial { .. } => POLYNOMIAL_STEPS as f64,
            Self::Spiral { heading, .. } => {
                let angle = |sample: usize| heading.at(start + length * sample as f64 / TURN_SAMPLES as f64);
                let turns = (1..=TURN_SAMPLES).map(|i| (angle(i) - angle(i - 1)).abs());
                let (total, sharpest) = turns.fold((0.0, 0.0_f64), |(total, sharpest), turn| (total + turn, sharpest.max(turn)));
                steps_for(total, sharpest * TURN_SAMPLES as f64 / length.abs())
            }
        };
        (steps.ceil() as usize).clamp(1, MAX_SEGMENT_POINTS)
    }

    /// Points from `start` by `length`, in `steps` equal parts.
    fn samples(&self, start: f64, length: f64, steps: usize) -> Vec<DVec3> {
        let along = |step: usize| start + length * step as f64 / steps as f64;
        match self {
            Self::Spiral { frame, heading } => {
                // Walking saves integrating from the origin for each of thousands of samples.
                let mut reached = heading.step(0.0, start, SPIRAL_INTERVALS);
                let mut points = vec![frame.transform_point3(reached.extend(0.0))];
                for step in 1..=steps {
                    reached += heading.step(along(step - 1), along(step), STEP_INTERVALS);
                    points.push(frame.transform_point3(reached.extend(0.0)));
                }
                points
            }
            _ => (0..=steps).map(|step| self.at(along(step)).0).collect(),
        }
    }
}

/// The part of a parent curve that one segment places, kept to find points between samples.
#[derive(Clone)]
struct Piece {
    /// Where the piece starts along the whole curve, and how long it is.
    from: f64,
    length: f64,
    parent: Rc<Parent>,
    moved: DMat4,
    /// The parent's own measure at the piece's start, and +1 or -1 for the way it runs.
    start: f64,
    sense: f64,
}

impl Piece {
    fn covers(&self, station: f64) -> bool {
        station >= self.from && station <= self.from + self.length
    }

    /// The point and unit tangent `station` along the whole curve, on the parent itself.
    fn at(&self, station: f64) -> (DVec3, DVec3) {
        let (point, tangent) = self.parent.at(self.start + self.sense * (station - self.from));
        let tangent = self.moved.transform_vector3(tangent * self.sense).normalize_or_zero();
        (self.moved.transform_point3(point), tangent)
    }
}

/// A polyline, with how far along the true curve each of its points is.
#[derive(Clone, Default)]
pub(crate) struct Stationed {
    pub points: Vec<DVec3>,
    pub stations: Vec<f64>,
    /// The segments the points were sampled from, in order, where they are known.
    pieces: Vec<Piece>,
    /// For a curve raised by a gradient: the vertical profile, as distance along and height.
    profile: Option<Rc<Stationed>>,
}

impl Stationed {
    /// A polyline with nothing better to measure by than its own length.
    pub fn from_path(points: Vec<DVec3>) -> Self {
        let mut stations = Vec::with_capacity(points.len());
        let mut walked = 0.0;
        for (index, point) in points.iter().enumerate() {
            if index > 0 {
                walked += points[index - 1].distance(*point);
            }
            stations.push(walked);
        }
        Self { points, stations, ..Self::default() }
    }

    /// Appends a run, measured from its own start, and drops a joint they share.
    pub fn extend(&mut self, run: Stationed) {
        let offset = self.stations.last().copied().unwrap_or(0.0);
        let shared = match (self.points.last(), run.points.first()) {
            (Some(last), Some(first)) => last.distance_squared(*first) <= 1e-18,
            _ => false,
        };
        let skip = shared as usize;
        self.points.extend(run.points.into_iter().skip(skip));
        self.stations.extend(run.stations.into_iter().skip(skip).map(|station| station + offset));
        self.pieces.extend(run.pieces.into_iter().map(|piece| Piece { from: piece.from + offset, ..piece }));
    }

    fn piece(&self, station: f64) -> Option<&Piece> {
        let after = self.pieces.partition_point(|piece| piece.from <= station);
        self.pieces[..after].last().filter(|piece| piece.covers(station))
    }

    /// The point and unit tangent at `station` on the curve itself, not on its chords, where
    /// the segments it was sampled from are known. Elsewhere, as [`Self::at`].
    pub fn exact(&self, station: f64) -> Option<(DVec3, DVec3)> {
        let Some((point, tangent)) = self.on_pieces(station) else {
            return self.at(station);
        };
        let Some(profile) = &self.profile else {
            return Some((point, tangent));
        };
        let (height, gradient) = match profile.height(station) {
            Some(found) => found,
            None => {
                let (point, tangent) = self.at(station)?;
                (point.z, tangent.z / tangent.truncate().length().max(1e-12))
            }
        };
        let run = tangent.truncate().normalize_or_zero();
        Some((point.truncate().extend(height), run.extend(gradient).normalize_or_zero()))
    }

    /// On the segment at `station`, or past either end of the curve, straight on along its
    /// tangent there. `None` where no segment is known.
    fn on_pieces(&self, station: f64) -> Option<(DVec3, DVec3)> {
        if let Some(piece) = self.piece(station) {
            return Some(piece.at(station));
        }
        let (first, last) = (self.pieces.first()?, self.pieces.last()?);
        let (start, end) = (*self.stations.first()?, *self.stations.last()?);
        let (edge, piece) = if station < first.from && first.from <= start {
            (first.from, first)
        } else if station > last.from + last.length && last.from + last.length >= end {
            (last.from + last.length, last)
        } else {
            return None;
        };
        let (point, tangent) = piece.at(edge);
        Some((point + tangent * (station - edge), tangent))
    }

    /// Height and gradient where this vertical profile is `distance` along, on its segments,
    /// and past either end straight on. A segment that runs back against the distance is left
    /// to the polyline.
    fn height(&self, distance: f64) -> Option<(f64, f64)> {
        // Where segments overlap, the later holds: each starts where its own placement says.
        let found = self.pieces.iter().rev().find_map(|piece| {
            let along = |station: f64| piece.at(station).0.x;
            let (mut low, mut high) = (piece.from, piece.from + piece.length);
            if !(along(low) <= distance && distance <= along(high)) {
                return None;
            }
            for _ in 0..PROFILE_HALVINGS {
                let middle = 0.5 * (low + high);
                if along(middle) < distance {
                    low = middle;
                } else {
                    high = middle;
                }
            }
            let (point, tangent) = piece.at(0.5 * (low + high));
            (tangent.x.abs() > 1e-12).then(|| (point.y, tangent.y / tangent.x))
        });
        found.or_else(|| self.height_beyond(distance))
    }

    /// Past either end of this profile, straight on along its gradient there.
    fn height_beyond(&self, distance: f64) -> Option<(f64, f64)> {
        let (first, last) = (self.pieces.first()?, self.pieces.last()?);
        let (start, end) = (*self.stations.first()?, *self.stations.last()?);
        let (begins, ends) = (first.at(first.from), last.at(last.from + last.length));
        // A profile that runs back against the distance has no before and after.
        if begins.0.x >= ends.0.x {
            return None;
        }
        let (point, tangent) = if first.from <= start && distance < begins.0.x {
            begins
        } else if last.from + last.length >= end && distance > ends.0.x {
            ends
        } else {
            return None;
        };
        (tangent.x.abs() > 1e-12).then(|| {
            let gradient = tangent.y / tangent.x;
            (point.y + gradient * (distance - point.x), gradient)
        })
    }

    fn chord(&self, index: usize) -> DVec3 {
        (self.points[index + 1] - self.points[index]).normalize_or_zero()
    }

    /// The point at `station`, carrying on straight past either end, and the unit tangent,
    /// averaged at a vertex so that sections there stand square to the curve.
    pub fn at(&self, station: f64) -> Option<(DVec3, DVec3)> {
        let last = self.points.len().checked_sub(2)?;
        let index = self.stations.partition_point(|value| *value <= station).saturating_sub(1).min(last);
        let (start, end) = (self.stations[index], self.stations[index + 1]);
        let share = if end > start { (station - start) / (end - start) } else { 0.0 };
        let point = self.points[index].lerp(self.points[index + 1], share);
        let tangent = if share.abs() < 1e-9 && index > 0 {
            (self.chord(index - 1) + self.chord(index)).normalize_or_zero()
        } else if (share - 1.0).abs() < 1e-9 && index < last {
            (self.chord(index) + self.chord(index + 1)).normalize_or_zero()
        } else {
            self.chord(index)
        };
        Some((point, tangent))
    }

    /// The point and the axes at `station` on the polyline, as meshes follow it: along the
    /// curve, to its left and up.
    pub fn frame(&self, station: f64) -> Option<(DVec3, [DVec3; 3])> {
        self.at(station).map(axes)
    }

    /// The point and the axes at `station` on the curve itself, for placing things on it.
    pub fn exact_frame(&self, station: f64) -> Option<(DVec3, [DVec3; 3])> {
        self.exact(station).map(axes)
    }

    /// The vertical `profile`, whose points are distance along and height, raised onto this base.
    pub fn lifted(&self, profile: Stationed) -> Self {
        let profile = Rc::new(profile);
        let mut points: Vec<DVec2> = profile.points.iter().map(|point| point.truncate()).collect();
        let lifted = self.lifted_points(&mut points);
        Self { pieces: self.pieces.clone(), profile: Some(profile), ..lifted }
    }

    fn lifted_points(&self, profile: &mut [DVec2]) -> Self {
        profile.sort_by(|a, b| a.x.total_cmp(&b.x));
        let height = |station: f64| {
            let after = profile.partition_point(|point| point.x <= station);
            match (after.checked_sub(1).and_then(|index| profile.get(index)), profile.get(after)) {
                (Some(low), Some(high)) if high.x > low.x => {
                    low.y + (high.y - low.y) * (station - low.x) / (high.x - low.x)
                }
                (Some(point), _) | (None, Some(point)) => point.y,
                (None, None) => 0.0,
            }
        };
        let (first, end) = match (self.stations.first(), self.stations.last()) {
            (Some(first), Some(end)) => (*first, *end),
            _ => return Self::default(),
        };
        let inner = profile.iter().map(|point| point.x).filter(|station| *station > first && *station < end);
        let mut stations: Vec<f64> = self.stations.iter().copied().chain(inner).collect();
        stations.sort_by(f64::total_cmp);
        stations.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        let points = stations
            .iter()
            .filter_map(|station| {
                let (point, _) = self.at(*station)?;
                Some(DVec3::new(point.x, point.y, height(*station)))
            })
            .collect();
        Self { points, stations, ..Self::default() }
    }
}

fn axes((point, tangent): (DVec3, DVec3)) -> (DVec3, [DVec3; 3]) {
    let left = DVec3::Z.cross(tangent).try_normalize().unwrap_or(DVec3::Y);
    (point, [tangent, left, tangent.cross(left)])
}

/// A part of `parent`, from `start` by `length`, moved so that it sets off from `placement`
/// along its X axis. The sign of `length` is the sense.
pub(crate) fn segment(parent: Parent, placement: DMat4, start: f64, length: f64) -> Option<Stationed> {
    let (origin, tangent) = parent.at(start);
    let x = (tangent * length.signum()).try_normalize()?;
    let z = parent.plane();
    let y = z.cross(x);
    let entry = DMat4::from_cols(x.extend(0.0), y.extend(0.0), z.extend(0.0), origin.extend(1.0));
    let moved = placement * entry.inverse();

    let steps = parent.steps(start, length);
    let points: Vec<DVec3> = parent
        .samples(start, length, steps)
        .into_iter()
        .map(|point| moved.transform_point3(point))
        .collect();
    let stations = (0..=steps).map(|step| length.abs() * step as f64 / steps as f64).collect();
    let piece = Piece { from: 0.0, length: length.abs(), parent: Rc::new(parent), moved, start, sense: length.signum() };
    points.iter().all(|point| point.is_finite()).then(|| Stationed { points, stations, pieces: vec![piece], profile: None })
}
