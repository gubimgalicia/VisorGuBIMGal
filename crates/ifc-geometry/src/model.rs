//! Turns IFC products into world-space meshes, in metres.
//!
//! Every failure is local to its element (R8): what cannot be evaluated becomes a
//! [`Diagnostic`], and the rest of the model carries on.

use crate::csg::{intersect, seal, subtract, subtract_all, union};
use crate::curves::{self, Heading, Parent, Stationed};
use crate::hash::KeyedMap;
use crate::mesh::Mesh;
use crate::nurbs;
use crate::solids;
use earcut::Earcut;
use glam::{DMat4, DVec2, DVec3, DVec4};
use ifc_schema::units::{ProjectUnits, project_units};
use ifc_schema::{EntityDef, Schema, SchemaId, schema};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use step_parser::{Entity, StepIndex, Value};

/// Bounds placement chains and nested mapped items, which a hostile file could make cyclic.
const MAX_DEPTH: usize = 64;
/// Items one element may expand to. Maps sharing maps can multiply at every level, so the
/// depth limit alone leaves exponentially many expansions.
const MAX_ITEMS_PER_ELEMENT: usize = 100_000;
/// Booleans one element may evaluate. Each costs far more than a plain item.
const MAX_BOOLEANS_PER_ELEMENT: usize = 4096;
/// A target reaching less than this into a half space loses nothing to it. Metres: the
/// boolean welds vertices this close anyway.
const CLEAR_OF_HALF_SPACE: f64 = 1e-6;
/// Segments of a half space's boundary that end further apart than this leave it unusable,
/// and the clip is skipped. In the local files they meet within a micrometre, except where
/// Revit centred the arcs kilometres away and the ends lie 311 m to 15 km apart. Metres.
const BOUNDARY_GAP: f64 = 0.01;
/// Open meshes larger than this stay open. Sealing scans each edge against the vertices
/// beside it, which on a flat mesh grows with the square of its size: about 0.4 s natively
/// here, and 26 s at 80,000 triangles. Shells that nearly close in real files have hundreds.
const MAX_SEALED_TRIANGLES: usize = 10_000;
const DEFAULT_RGBA: u32 = 0xB8B8_B8FF;
/// Triangles kept for repeated instances, so a model of unique shapes cannot fill memory twice.
const MAX_INSTANCE_TRIANGLES: usize = 1_000_000;
/// Consecutive curve points closer than this are one point. Metres.
const POINT_TOLERANCE: f64 = 1e-9;
/// The same for the rings of a profile. Exporters round the ends of arcs and lines apart by
/// microns, and triangulation loses such a sliver, which leaves the solid open. Metres.
const RING_TOLERANCE: f64 = 1e-5;
/// Points one alignment curve may reach: far beyond a real one, and hostile files can ask
/// for thousands of segments of thousands of points.
const MAX_CURVE_POINTS: usize = 200_000;
/// Pairs of legs compared to find where two grid axes cross. Real axes have a few legs, and a
/// tessellated arc a few hundred, each met by a straight axis.
const MAX_CROSSING_PAIRS: usize = 100_000;
/// Slack at the ends of a leg, as a share of its length, and the sine below which two legs
/// count as parallel.
const CROSSING_TOLERANCE: f64 = 1e-9;
/// Face surfaces built as an exact B-spline for each face.
const ANALYTIC_SURFACES: [&str; 5] = [
    "IfcCylindricalSurface",
    "IfcSphericalSurface",
    "IfcToroidalSurface",
    "IfcSurfaceOfRevolution",
    "IfcSurfaceOfLinearExtrusion",
];
/// Steps along a ruled wall that twists, where two triangles would not follow it.
const RULED_STEPS: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub express_id: Option<u32>,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ElementMesh {
    pub mesh: Mesh,
    /// `0xRRGGBBAA`.
    pub rgba: u32,
    /// `Some(true)` when the mesh is known to pass [`Mesh::is_closed_outward`]: a shape repeated
    /// under a mapped representation is checked once, before any placement. A placement keeps
    /// it closed and outward, as `transformed` turns the winding of a mirroring one, and can only
    /// merge corners, never part them. `None` when not yet checked.
    pub closed: Option<bool>,
    /// Set when `mesh` is a placed copy of a shape the evaluator keeps (`docs/09` §2, A13), so
    /// the stream may send the shape once and this mesh as an instance of it. `None` for
    /// everything else, and once a void has been cut from the element.
    pub instance: Option<InstanceOf>,
}

/// A mesh as a placed copy of a shared shape: `mesh = transformed(shape, transform)`.
#[derive(Debug, Clone)]
pub struct InstanceOf {
    /// The leaf representation item the shape comes from: the same key `instance_uses` counts.
    pub key: u32,
    /// The shape in its own coordinates, shared by every copy.
    pub shape: Rc<Mesh>,
    /// From the shape's coordinates to model coordinates.
    pub transform: DMat4,
}

#[derive(Debug, Clone)]
pub struct ElementGeometry {
    pub express_id: u32,
    pub type_name: String,
    pub meshes: Vec<ElementMesh>,
    /// Something was skipped: a void left uncut, say. A diagnostic names it.
    pub degraded: bool,
    pub hidden_by_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnsupportedSchema;

/// Where a cross-section stands along a curve.
struct SectionMark {
    station: f64,
    /// To the left, up and along.
    offsets: DVec3,
    /// The profile's X and Y axes, relative to the curve: along, left and up.
    x: DVec3,
    y: DVec3,
}

#[derive(Clone)]
struct Profile {
    outer: Vec<DVec2>,
    holes: Vec<Vec<DVec2>>,
}

pub struct ModelEvaluator<'a> {
    file: &'a StepIndex<'a>,
    schema: &'static Schema,
    /// Schema definition of each type in `file.type_names()`, by position.
    defs: Vec<Option<EntityDef>>,
    /// Types read without building an entity.
    plain: PlainTypes,
    units: ProjectUnits,
    placements: HashMap<u32, DMat4>,
    curves: HashMap<u32, Rc<Stationed>>,
    /// Each repeated shape's mesh, and whether it is closed and winds outward, once asked.
    instances: HashMap<u32, (Rc<Mesh>, Option<bool>)>,
    instance_triangles: usize,
    openings: HashMap<u32, Vec<u32>>,
    item_colors: HashMap<u32, u32>,
    /// The placement of the grid each grid axis belongs to.
    grid_axes: HashMap<u32, u32>,
    diagnostics: Vec<Diagnostic>,
    current: Option<u32>,
    degraded: bool,
    items_used: usize,
    booleans_used: usize,
}

/// Positions in `file.type_names()` of the types whose usual records are read without
/// building an entity. Each is a type whose attributes are the same in every schema.
struct PlainTypes {
    point: Option<u32>,
    face: Option<u32>,
    outer_bound: Option<u32>,
    bound: Option<u32>,
    poly_loop: Option<u32>,
}

impl PlainTypes {
    fn new(file: &StepIndex<'_>) -> Self {
        let position = |wanted: &str| {
            file.type_names()
                .position(|name| name == wanted)
                .and_then(|at| u32::try_from(at).ok())
        };
        Self {
            point: position("IFCCARTESIANPOINT"),
            face: position("IFCFACE"),
            outer_bound: position("IFCFACEOUTERBOUND"),
            bound: position("IFCFACEBOUND"),
            poly_loop: position("IFCPOLYLOOP"),
        }
    }
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Real(number) => Some(*number),
        Value::Integer(number) => Some(*number as f64),
        Value::Typed { value, .. } => number(value),
        _ => None,
    }
}

fn reference(value: &Value) -> Option<u32> {
    match value {
        Value::Ref(id) => Some(*id),
        _ => None,
    }
}

fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::List(items)) => items,
        _ => &[],
    }
}

fn ring_area(ring: &[DVec2]) -> f64 {
    let count = ring.len();
    (0..count)
        .map(|i| ring[i].perp_dot(ring[(i + 1) % count]))
        .sum::<f64>()
        / 2.0
}

/// Drops repeated points, including a closing point equal to the first.
fn clean_ring(mut ring: Vec<DVec2>) -> Vec<DVec2> {
    ring.dedup_by(|a, b| a.distance_squared(*b) <= RING_TOLERANCE * RING_TOLERANCE);
    while ring.len() > 1
        && ring[0].distance_squared(ring[ring.len() - 1]) <= RING_TOLERANCE * RING_TOLERANCE
    {
        ring.pop();
    }
    ring
}

/// Earcut and its inputs, kept between faces: making them anew for each face was a fifth of
/// the time spent allocating on a large faceted model.
#[derive(Default)]
struct Triangulator {
    earcut: Earcut<f64>,
    points: Vec<[f64; 2]>,
    hole_starts: Vec<u32>,
    indices: Vec<u32>,
}

/// A polygon this many corners or more gives its buffers back afterwards, so one huge face
/// does not keep them for the rest of the model.
const KEPT_TRIANGULATOR_CORNERS: usize = 4096;

thread_local! {
    static TRIANGULATOR: std::cell::RefCell<Triangulator> = std::cell::RefCell::default();
}

/// Triangulates the polygon `fill` writes, its corners and then where each hole starts among
/// them, and hands `emit` each triangle, counter-clockwise, as indices into those corners.
fn triangulate_with(fill: impl FnOnce(&mut Vec<[f64; 2]>, &mut Vec<u32>), mut emit: impl FnMut([u32; 3])) {
    TRIANGULATOR.with_borrow_mut(|kept| {
        let Triangulator { earcut, points, hole_starts, indices } = kept;
        points.clear();
        hole_starts.clear();
        fill(points, hole_starts);
        earcut.earcut(points.iter().copied(), hole_starts, indices);
        for &[a, b, c] in indices.as_chunks::<3>().0 {
            let corner = |id: u32| {
                let [x, y] = points[id as usize];
                DVec2::new(x, y)
            };
            emit(if (corner(b) - corner(a)).perp_dot(corner(c) - corner(a)) < 0.0 { [a, c, b] } else { [a, b, c] });
        }
        if points.len() >= KEPT_TRIANGULATOR_CORNERS {
            *kept = Triangulator::default();
        }
    });
}

/// Triangulates a polygon with holes. Rings need at least three points each.
fn triangulate_rings(rings: &[&[DVec2]]) -> Vec<[u32; 3]> {
    let mut triangles = Vec::new();
    triangulate_with(
        |points, hole_starts| {
            for (index, ring) in rings.iter().enumerate() {
                if index > 0 {
                    hole_starts.push(points.len() as u32);
                }
                points.extend(ring.iter().map(|point| [point.x, point.y]));
            }
        },
        |triangle| triangles.push(triangle),
    );
    triangles
}

/// Flips edges so each starts where the last one ended. A loop has to connect, and real
/// files carry orientation flags that say otherwise, which would fold the whole boundary.
fn chain_edges(edges: &mut [Vec<DVec3>]) {
    let ends = |edge: &[DVec3]| (edge[0], edge[edge.len() - 1]);
    let meets = |a: DVec3, b: DVec3| a.distance_squared(b) <= 1e-12;
    if edges.len() < 2 || edges.iter().any(Vec::is_empty) {
        return;
    }
    let (second_start, second_end) = ends(&edges[1]);
    let (_, first_end) = ends(&edges[0]);
    if !meets(first_end, second_start) && !meets(first_end, second_end) {
        edges[0].reverse();
    }
    for index in 1..edges.len() {
        let (_, reached) = ends(&edges[index - 1]);
        let (start, end) = ends(&edges[index]);
        if !meets(start, reached) && meets(end, reached) {
            edges[index].reverse();
        }
    }
}

/// An edge may use only part of its curve: keeps the run between its two vertices.
fn between_vertices(points: Vec<DVec3>, start: DVec3, end: DVec3) -> Vec<DVec3> {
    if start.distance_squared(end) <= POINT_TOLERANCE * POINT_TOLERANCE {
        return points;
    }
    let nearest = |to: DVec3| {
        (0..points.len()).min_by(|a, b| {
            points[*a].distance_squared(to).total_cmp(&points[*b].distance_squared(to))
        })
    };
    match (nearest(start), nearest(end)) {
        (Some(first), Some(last)) if first < last => points[first..=last].to_vec(),
        _ => points,
    }
}

fn numbers(value: Option<&Value>) -> Vec<f64> {
    list(value).iter().filter_map(number).collect()
}

fn knot_vector(
    entity: &Entity,
    def: &EntityDef,
    knots: &str,
    multiplicities: &str,
    degree: usize,
    count: usize,
) -> Option<Vec<f64>> {
    let knots = numbers(attribute(entity, def, knots));
    let times: Vec<usize> = numbers(attribute(entity, def, multiplicities))
        .into_iter()
        .map(|times| times as usize)
        .collect();
    nurbs::expand_knots(&knots, &times, degree, count)
}

/// Separate solids sharing one mesh.
fn merged(parts: impl Iterator<Item = Mesh>) -> Mesh {
    let mut all = Mesh::default();
    for mesh in parts {
        let first = all.positions.len() as u32;
        all.positions.extend(mesh.positions);
        all.triangles.extend(mesh.triangles.iter().map(|triangle| triangle.map(|id| id + first)));
    }
    all
}

/// Whether a logical is `.T.` or `.F.`. Absent or unknown gives `None`.
fn flag(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Enum(flag)) if flag == "T" => Some(true),
        Some(Value::Enum(flag)) if flag == "F" => Some(false),
        _ => None,
    }
}

/// Where two lines cross, as shares of each run; `None` when they are parallel.
fn line_crossing(start_a: DVec2, run_a: DVec2, start_b: DVec2, run_b: DVec2) -> Option<(f64, f64)> {
    let turn = run_a.perp_dot(run_b);
    if turn.abs() <= CROSSING_TOLERANCE * run_a.length() * run_b.length() {
        return None;
    }
    let gap = start_b - start_a;
    Some((gap.perp_dot(run_b) / turn, gap.perp_dot(run_a) / turn))
}

/// A polyline moved sideways by `offset`, positive to its left, as legs of start and run.
/// Each leg is moved on its own, then cut or lengthened to meet the next at a mitre, so a bend
/// leaves neither a gap nor an overlap.
fn offset_legs(points: &[DVec2], offset: f64) -> Vec<(DVec2, DVec2)> {
    let moved = |pair: &[DVec2]| {
        let side = (pair[1] - pair[0]).try_normalize()?.perp() * offset;
        Some([pair[0] + side, pair[1] + side])
    };
    let mut legs: Vec<[DVec2; 2]> = points.windows(2).filter_map(moved).collect();
    for index in 1..legs.len() {
        let ([start, end], [next_start, next_end]) = (legs[index - 1], legs[index]);
        if let Some((at, _)) = line_crossing(start, end - start, next_start, next_end - next_start) {
            let corner = start + (end - start) * at;
            legs[index - 1][1] = corner;
            legs[index][0] = corner;
        }
    }
    legs.into_iter().map(|[start, end]| (start, end - start)).collect()
}

/// Where two polylines cross once each is moved sideways by its offset, positive to its left:
/// the first crossing along `a`, and the heading of `a` there. The end legs run on past the
/// ends, since grid axes are drawn to a length of their own choosing.
fn offset_crossing(a: &[DVec2], offset_a: f64, b: &[DVec2], offset_b: f64) -> Option<(DVec2, DVec2)> {
    let (a, b) = (offset_legs(a, offset_a), offset_legs(b, offset_b));
    if a.len().saturating_mul(b.len()) > MAX_CROSSING_PAIRS {
        return None;
    }
    let within = |at: f64, index: usize, count: usize| {
        (index == 0 || at >= -CROSSING_TOLERANCE) && (index + 1 == count || at <= 1.0 + CROSSING_TOLERANCE)
    };
    for (i, &(start_a, run_a)) in a.iter().enumerate() {
        for (j, &(start_b, run_b)) in b.iter().enumerate() {
            let Some((at_a, at_b)) = line_crossing(start_a, run_a, start_b, run_b) else { continue };
            if within(at_a, i, a.len()) && within(at_b, j, b.len()) {
                return Some((start_a + run_a * at_a, run_a.normalize()));
            }
        }
    }
    None
}

/// Appends a curve segment, dropping the joint it shares with what came before.
fn join(path: &mut Vec<DVec3>, part: Vec<DVec3>) {
    let shared = match (path.last(), part.first()) {
        (Some(last), Some(first)) => last.distance_squared(*first) <= POINT_TOLERANCE * POINT_TOLERANCE,
        _ => false,
    };
    path.extend(part.into_iter().skip(shared as usize));
}

fn on_conic(frame: DMat4, radii: DVec2, start: f64, sweep: f64) -> Vec<DVec3> {
    solids::arc(DVec2::ZERO, radii, start, sweep)
        .into_iter()
        .map(|point| frame.transform_point3(point.extend(0.0)))
        .collect()
}

/// Outer ring counter-clockwise, holes clockwise.
fn wound(mut profile: Profile) -> Profile {
    if ring_area(&profile.outer) < 0.0 {
        profile.outer.reverse();
    }
    for hole in &mut profile.holes {
        if ring_area(hole) > 0.0 {
            hole.reverse();
        }
    }
    profile
}

/// Extrudes a profile along `offset`, which must not lie in the profile's plane.
fn prism(profile: Profile, offset: DVec3) -> Mesh {
    let Profile { outer, holes } = wound(profile);
    let mut rings: Vec<&[DVec2]> = vec![&outer];
    rings.extend(holes.iter().map(Vec::as_slice));
    let caps = triangulate_rings(&rings);

    let count = rings.iter().map(|ring| ring.len()).sum::<usize>() as u32;
    let mut positions = Vec::with_capacity(count as usize * 2);
    for shift in [DVec3::ZERO, offset] {
        for ring in &rings {
            positions.extend(ring.iter().map(|point| point.extend(0.0) + shift));
        }
    }

    let mut triangles = Vec::with_capacity(caps.len() * 2 + count as usize * 2);
    for [a, b, c] in caps {
        triangles.push([a, c, b]);
        triangles.push([a + count, b + count, c + count]);
    }
    let mut start = 0u32;
    for ring in &rings {
        let length = ring.len() as u32;
        for i in 0..length {
            let (a, b) = (start + i, start + (i + 1) % length);
            triangles.push([a, b, b + count]);
            triangles.push([a, b + count, a + count]);
        }
        start += length;
    }

    // Extruding downwards turns the solid inside out.
    if offset.z < 0.0 {
        for triangle in &mut triangles {
            triangle.swap(1, 2);
        }
    }
    Mesh { positions, triangles }
}

/// One cross-section of a loft: its outer ring, then its holes, placed in space.
type Section = Vec<Vec<DVec3>>;

/// Triangulates a section on its own plane.
fn section_cap(section: &Section) -> Option<Vec<[u32; 3]>> {
    let outer = section.first()?;
    let normal = (0..outer.len())
        .fold(DVec3::ZERO, |sum, i| sum + outer[i].cross(outer[(i + 1) % outer.len()]))
        .try_normalize()?;
    let u = normal.any_orthonormal_vector();
    let v = normal.cross(u);
    let flat: Vec<Vec<DVec2>> = section
        .iter()
        .map(|ring| ring.iter().map(|point| DVec2::new(point.dot(u), point.dot(v))).collect())
        .collect();
    let rings: Vec<&[DVec2]> = flat.iter().map(Vec::as_slice).collect();
    Some(triangulate_rings(&rings))
}

/// Joins corresponding rings of successive sections and caps both ends. Every section needs
/// the same ring sizes, wound as `wound` leaves them.
fn loft(sections: &[Section]) -> Option<Mesh> {
    let (first, last) = (sections.first()?, sections.last()?);
    let sizes: Vec<u32> = first.iter().map(|ring| ring.len() as u32).collect();
    let matching = sections.iter().all(|section| {
        section.iter().map(|ring| ring.len() as u32).eq(sizes.iter().copied())
    });
    if sections.len() < 2 || !matching || sizes.iter().any(|size| *size < 3) {
        return None;
    }
    let count: u32 = sizes.iter().sum();
    let positions: Vec<DVec3> = sections.iter().flatten().flatten().copied().collect();

    let mut triangles = Vec::new();
    for step in 0..sections.len() as u32 - 1 {
        let mut start = step * count;
        for size in &sizes {
            for i in 0..*size {
                let (a, b) = (start + i, start + (i + 1) % size);
                triangles.push([a, b, b + count]);
                triangles.push([a, b + count, a + count]);
            }
            start += size;
        }
    }
    for [a, b, c] in section_cap(first)? {
        triangles.push([a, c, b]);
    }
    let end = (sections.len() as u32 - 1) * count;
    for [a, b, c] in section_cap(last)? {
        triangles.push([a + end, b + end, c + end]);
    }
    Some(solids::outward(Mesh { positions, triangles }))
}

/// Gives two rings the same number of points, matched by their share of the perimeter.
fn matched_rings(a: &[DVec2], b: &[DVec2]) -> (Vec<DVec2>, Vec<DVec2>) {
    if a.len() == b.len() {
        return (a.to_vec(), b.to_vec());
    }
    // Outlines of different kinds can start anywhere: begin them near each other.
    let nearest = (0..b.len()).min_by(|i, j| {
        b[*i].distance_squared(a[0]).total_cmp(&b[*j].distance_squared(a[0]))
    });
    let mut b = b.to_vec();
    b.rotate_left(nearest.unwrap_or(0));

    let shares = |ring: &[DVec2]| {
        let mut walked = 0.0;
        let mut result = Vec::with_capacity(ring.len());
        for i in 0..ring.len() {
            result.push(walked);
            walked += ring[i].distance(ring[(i + 1) % ring.len()]);
        }
        result.iter_mut().for_each(|share| *share /= walked);
        result
    };
    let (of_a, of_b) = (shares(a), shares(&b));
    let mut all: Vec<f64> = of_a.iter().chain(&of_b).copied().collect();
    all.sort_by(f64::total_cmp);
    all.dedup_by(|x, y| (*x - *y).abs() < 1e-9);

    let at = |ring: &[DVec2], of: &[f64], share: f64| {
        let index = of.partition_point(|value| *value <= share).saturating_sub(1);
        let next = of.get(index + 1).copied().unwrap_or(1.0);
        ring[index].lerp(ring[(index + 1) % ring.len()], (share - of[index]) / (next - of[index]))
    };
    (
        all.iter().map(|share| at(a, &of_a, *share)).collect(),
        all.iter().map(|share| at(&b, &of_b, *share)).collect(),
    )
}

/// Pairs start and end sections point for point, unless a part or a hole has no partner.
fn section_pairs(start: &[Profile], end: &[Profile]) -> Option<Vec<(Profile, Profile)>> {
    if start.len() != end.len() {
        return None;
    }
    let pair = |(a, b): (&Profile, &Profile)| {
        let (a, b) = (wound(a.clone()), wound(b.clone()));
        if a.holes.len() != b.holes.len() {
            return None;
        }
        let (first_outer, second_outer) = matched_rings(&a.outer, &b.outer);
        let (first_holes, second_holes) =
            a.holes.iter().zip(&b.holes).map(|(x, y)| matched_rings(x, y)).unzip();
        Some((
            Profile { outer: first_outer, holes: first_holes },
            Profile { outer: second_outer, holes: second_holes },
        ))
    };
    start.iter().zip(end).map(pair).collect()
}

/// The section `share` of the way from `a` to `b`, which `section_pairs` matched.
fn blended(a: &Profile, b: &Profile, share: f64, place: impl Fn(DVec2) -> DVec3) -> Section {
    let starts = std::iter::once(&a.outer).chain(&a.holes);
    let ends = std::iter::once(&b.outer).chain(&b.holes);
    starts
        .zip(ends)
        .map(|(start, end)| start.iter().zip(end).map(|(p, q)| place(p.lerp(*q, share))).collect())
        .collect()
}

/// Whether every wall from `a` to `b`, moved along `offset`, is flat.
fn flat_walls(a: &Profile, b: &Profile, offset: DVec3) -> bool {
    let starts = std::iter::once(&a.outer).chain(&a.holes);
    let ends = std::iter::once(&b.outer).chain(&b.holes);
    starts.zip(ends).all(|(start, end)| {
        (0..start.len()).all(|i| {
            let next = (i + 1) % start.len();
            let across = (end[i].extend(0.0) + offset) - start[i].extend(0.0);
            let (along_start, along_end) = (start[next] - start[i], end[next] - end[i]);
            let (first, second) = (along_start.extend(0.0), along_end.extend(0.0));
            let scale = first.length() * second.length() * across.length();
            first.cross(across).dot(second).abs() <= scale * 1e-9
        })
    })
}

/// The sections of a profile along `path`. Its X axis takes the direction of `hints`, one
/// for each point, across the path. Joints are mitred at half the angle of the turn.
fn swept_sections(profile: &Profile, path: &[DVec3], hints: &[DVec3]) -> Option<Vec<Section>> {
    let runs: Vec<DVec3> = path
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).try_normalize())
        .collect::<Option<_>>()?;
    let (first, last) = (*runs.first()?, *runs.last()?);
    let mut across = None;
    let mut sections: Vec<Section> = Vec::with_capacity(path.len());
    for (index, at) in path.iter().enumerate() {
        let arriving = if index == 0 { first } else { runs[index - 1] };
        let leaving = runs.get(index).copied().unwrap_or(last);
        let mitre = (arriving + leaving).try_normalize().filter(|plane| plane.dot(arriving) > 0.25);
        let mitre = mitre.unwrap_or(arriving);
        let hint = hints[index];
        // Each leg keeps its own frame up to the mitre, or it twists from one to the other.
        let mut section_along = |run: DVec3| -> Option<Section> {
            // A reference along the path gives no direction: keep the last one that did.
            let x = (hint - run * hint.dot(run)).try_normalize().or(across)?;
            across = Some(x);
            let y = run.cross(x);
            let place = |point: &DVec2| {
                let flat = *at + x * point.x + y * point.y;
                flat + run * (*at - flat).dot(mitre) / run.dot(mitre)
            };
            let rings = std::iter::once(&profile.outer).chain(&profile.holes);
            Some(rings.map(|ring| ring.iter().map(place).collect()).collect())
        };
        let arrived = section_along(arriving)?;
        let left = section_along(leaving)?;
        let apart = arrived.iter().flatten().zip(left.iter().flatten()).any(|(a, b)| a.distance_squared(*b) > 1e-18);
        sections.push(arrived);
        if apart {
            sections.push(left);
        }
    }
    Some(sections)
}

/// The run of a polyline between two distances along it.
fn path_between_lengths(path: &[DVec3], start: f64, end: f64) -> Vec<DVec3> {
    let mut run = Vec::new();
    let mut walked = 0.0;
    for pair in path.windows(2) {
        let length = pair[0].distance(pair[1]);
        let reach = walked + length;
        let at = |distance: f64| pair[0].lerp(pair[1], ((distance - walked) / length).clamp(0.0, 1.0));
        if reach > start && walked < end {
            if run.is_empty() {
                run.push(at(start));
            }
            run.push(at(end));
        }
        walked = reach;
    }
    run
}

/// The run of a polyline between two parameters, which count its segments from zero.
fn polyline_between(path: &[DVec3], start: f64, end: f64) -> Vec<DVec3> {
    let at = |t: f64| {
        let index = (t.floor() as usize).min(path.len() - 2);
        path[index].lerp(path[index + 1], t - index as f64)
    };
    let inner = (start.floor() as usize + 1)..(end.ceil() as usize);
    let mut run = vec![at(start)];
    run.extend_from_slice(&path[inner]);
    run.push(at(end));
    run
}

fn transformed(mesh: Mesh, transform: DMat4) -> Mesh {
    let mut result = mesh.map_positions(|point| transform.transform_point3(point));
    if transform.determinant() < 0.0 {
        for triangle in &mut result.triangles {
            triangle.swap(1, 2);
        }
    }
    result
}

/// Whether the mesh, once coincident vertices are merged, encloses a volume.
fn is_closed(mesh: &Mesh) -> bool {
    let mut ids: KeyedMap<(u64, u64, u64), u32> = KeyedMap::default();
    let mut remap = Vec::with_capacity(mesh.positions.len());
    for position in &mesh.positions {
        let key = (position.x.to_bits(), position.y.to_bits(), position.z.to_bits());
        let next = ids.len() as u32;
        remap.push(*ids.entry(key).or_insert(next));
    }
    let merged = Mesh {
        positions: mesh.positions.clone(),
        triangles: mesh
            .triangles
            .iter()
            .map(|triangle| triangle.map(|id| remap[id as usize]))
            .collect(),
    };
    !merged.is_empty() && merged.open_edges() == 0
}

/// The mesh a boolean can use: as it is when closed, else sealed when that closes it. Only
/// open meshes are sealed, so closed ones keep their exact triangles.
fn closed_shape(mesh: &Mesh) -> Option<Cow<'_, Mesh>> {
    if is_closed(mesh) {
        return Some(Cow::Borrowed(mesh));
    }
    if mesh.triangles.len() > MAX_SEALED_TRIANGLES {
        return None;
    }
    let sealed = seal(mesh);
    is_closed(&sealed).then_some(Cow::Owned(sealed))
}

impl<'a> ModelEvaluator<'a> {
    pub fn new(file: &'a StepIndex<'a>) -> Result<Self, UnsupportedSchema> {
        let id = SchemaId::from_identifiers(file.schema_identifiers()).ok_or(UnsupportedSchema)?;
        let tables = schema(id);
        let mut evaluator = Self {
            file,
            schema: tables,
            defs: file.type_names().map(|name| tables.entity(name)).collect(),
            plain: PlainTypes::new(file),
            units: project_units(file, tables),
            placements: HashMap::new(),
            curves: HashMap::new(),
            instances: HashMap::new(),
            instance_triangles: 0,
            openings: HashMap::new(),
            item_colors: HashMap::new(),
            grid_axes: HashMap::new(),
            diagnostics: Vec::new(),
            current: None,
            degraded: false,
            items_used: 0,
            booleans_used: 0,
        };
        evaluator.index_openings();
        evaluator.index_colors();
        evaluator.index_grids();
        Ok(evaluator)
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn units(&self) -> ProjectUnits {
        self.units
    }

    fn warn(&mut self, code: &'static str, message: String) {
        self.degraded = true;
        self.diagnostics.push(Diagnostic {
            express_id: self.current,
            code,
            message,
        });
    }

    fn lookup(&self, id: u32) -> Option<(Entity, EntityDef)> {
        let found = self.file.get(id)?;
        let def = (*self.defs.get(found.type_index as usize)?)?;
        let entity = self.file.decode_ref(found).ok()?;
        Some((entity, def))
    }

    fn index_openings(&mut self) {
        let ids: Vec<u32> = self.file.ids_by_type("IFCRELVOIDSELEMENT").collect();
        for id in ids {
            let Some((entity, def)) = self.lookup(id) else { continue };
            let host = attribute(&entity, &def, "RelatingBuildingElement").and_then(reference);
            let opening = attribute(&entity, &def, "RelatedOpeningElement").and_then(reference);
            if let (Some(host), Some(opening)) = (host, opening) {
                self.openings.entry(host).or_default().push(opening);
            }
        }
    }

    fn index_colors(&mut self) {
        let ids: Vec<u32> = self.file.ids_by_type("IFCSTYLEDITEM").collect();
        for id in ids {
            let Some((entity, def)) = self.lookup(id) else { continue };
            let Some(item) = attribute(&entity, &def, "Item").and_then(reference) else {
                continue;
            };
            let color = list(attribute(&entity, &def, "Styles"))
                .iter()
                .filter_map(reference)
                .find_map(|style| self.style_color(style, 0, &mut HashSet::new()));
            if let Some(color) = color {
                self.item_colors.insert(item, color);
            }
        }
    }

    /// Grid placements before IFC 4.3 have no parent of their own: their grid places them.
    fn index_grids(&mut self) {
        let ids: Vec<u32> = self.file.ids_by_type("IFCGRID").collect();
        for id in ids {
            let Some((entity, def)) = self.lookup(id) else { continue };
            let Some(placement) = attribute(&entity, &def, "ObjectPlacement").and_then(reference) else {
                continue;
            };
            for axes in ["UAxes", "VAxes", "WAxes"] {
                for axis in list(attribute(&entity, &def, axes)).iter().filter_map(reference) {
                    self.grid_axes.insert(axis, placement);
                }
            }
        }
    }

    fn style_color(&self, id: u32, depth: usize, visited: &mut HashSet<u32>) -> Option<u32> {
        if depth >= MAX_DEPTH || !visited.insert(id) {
            return None;
        }
        let (entity, def) = self.lookup(id)?;
        if def.is_a("IfcSurfaceStyleShading") {
            let colour = attribute(&entity, &def, "SurfaceColour").and_then(reference)?;
            let (rgb, rgb_def) = self.lookup(colour)?;
            let channel = |name: &str| {
                let value = attribute(&rgb, &rgb_def, name).and_then(number)?;
                Some((value.clamp(0.0, 1.0) * 255.0).round() as u32)
            };
            let transparency = attribute(&entity, &def, "Transparency")
                .and_then(number)
                .unwrap_or(0.0);
            let alpha = ((1.0 - transparency).clamp(0.0, 1.0) * 255.0).round() as u32;
            return Some(
                channel("Red")? << 24 | channel("Green")? << 16 | channel("Blue")? << 8 | alpha,
            );
        }
        if def.is_a("IfcSurfaceStyle") || def.name() == "IfcPresentationStyleAssignment" {
            return list(attribute(&entity, &def, "Styles"))
                .iter()
                .filter_map(reference)
                .find_map(|style| self.style_color(style, depth + 1, visited));
        }
        None
    }

    /// Products with a representation, ascending. Openings only exist to cut their hosts.
    pub fn element_ids(&self) -> Vec<u32> {
        let mut ids = Vec::new();
        for type_name in self.schema.subtypes_of("IfcProduct") {
            let upper = type_name.to_ascii_uppercase();
            for id in self.file.ids_by_type(&upper) {
                let Some((entity, def)) = self.lookup(id) else { continue };
                let shown = !def.is_a("IfcFeatureElementSubtraction")
                    && attribute(&entity, &def, "Representation")
                        .and_then(reference)
                        .is_some();
                if shown {
                    ids.push(id);
                }
            }
        }
        ids.sort_unstable();
        ids
    }

    pub fn evaluate(&mut self, id: u32) -> Option<ElementGeometry> {
        self.current = Some(id);
        self.degraded = false;
        self.items_used = 0;
        self.booleans_used = 0;
        let (entity, def) = self.lookup(id)?;
        let mut meshes = self.product_meshes(&entity, &def);

        if let Some(openings) = self.openings.get(&id).cloned() {
            let cuts: Vec<Mesh> = openings
                .iter()
                .flat_map(|opening| {
                    let Some((entity, def)) = self.lookup(*opening) else {
                        return Vec::new();
                    };
                    self.product_meshes(&entity, &def)
                })
                .map(|element| element.mesh)
                .collect();
            if !cuts.is_empty() {
                for element in &mut meshes {
                    // Cut or not, the element no longer is a plain copy of a shape.
                    element.instance = None;
                    let Some(shape) = closed_shape(&element.mesh) else {
                        self.warn("void-on-open-mesh", "void not cut: mesh is not closed".into());
                        continue;
                    };
                    match subtract_all(&shape, &cuts) {
                        Ok(result) => element.mesh = result,
                        Err(error) => self.warn("void-failed", error.to_string()),
                    }
                }
            }
        }

        let geometry = ElementGeometry {
            express_id: id,
            type_name: def.name().to_string(),
            meshes,
            degraded: self.degraded,
            hidden_by_default: def.is_a("IfcSpace"),
        };
        self.current = None;
        Some(geometry)
    }

    /// Where a product's own origin lies in model coordinates, metres: its `ObjectPlacement`
    /// resolved as its geometry's is. `None` without a placement or with one not finite.
    pub fn placement_origin(&mut self, id: u32) -> Option<DVec3> {
        let (entity, def) = self.lookup(id)?;
        let placement = attribute(&entity, &def, "ObjectPlacement").and_then(reference)?;
        let origin = self.placement(placement, 0).transform_point3(DVec3::ZERO);
        origin.is_finite().then_some(origin)
    }

    fn product_meshes(&mut self, entity: &Entity, def: &EntityDef) -> Vec<ElementMesh> {
        let placement = match attribute(entity, def, "ObjectPlacement").and_then(reference) {
            Some(id) => self.placement(id, 0),
            None => DMat4::IDENTITY,
        };
        let chosen = self.chosen_representation(entity, def);

        let mut meshes = Vec::new();
        if let Some(representation) = chosen {
            self.representation(representation, placement, DEFAULT_RGBA, 0, &mut meshes);
        }
        meshes
    }

    fn representation(
        &mut self,
        id: u32,
        transform: DMat4,
        color: u32,
        depth: usize,
        out: &mut Vec<ElementMesh>,
    ) {
        let Some((entity, def)) = self.lookup(id) else { return };
        let items: Vec<u32> = list(attribute(&entity, &def, "Items"))
            .iter()
            .filter_map(reference)
            .collect();
        for item in items {
            self.item(item, transform, color, depth, out);
        }
    }

    fn item(
        &mut self,
        id: u32,
        transform: DMat4,
        inherited: u32,
        depth: usize,
        out: &mut Vec<ElementMesh>,
    ) {
        if depth >= MAX_DEPTH {
            self.warn("nesting-too-deep", format!("#{id} is nested too deeply"));
            return;
        }
        self.items_used += 1;
        if self.items_used > MAX_ITEMS_PER_ELEMENT {
            if self.items_used == MAX_ITEMS_PER_ELEMENT + 1 {
                self.warn("too-many-items", "representation expands too far".into());
            }
            return;
        }
        let Some((entity, def)) = self.lookup(id) else {
            self.warn("missing-item", format!("#{id} cannot be read"));
            return;
        };
        let color = self.item_color(id).unwrap_or(inherited);

        if def.is_a("IfcMappedItem") {
            self.mapped_item(&entity, &def, transform, color, depth, out);
            return;
        }
        let local = self.instance_of(id, &entity, &def, depth);

        if let Some((mesh, closed, shared)) = local {
            // A placement that flattens the shape leaves it no volume, so it is checked again.
            let keeps_volume = transform.determinant().is_normal();
            out.push(ElementMesh {
                mesh: transformed(mesh, transform),
                rgba: color,
                closed: closed.filter(|_| keeps_volume),
                instance: shared.map(|shape| InstanceOf { key: id, shape, transform }),
            });
        }
    }

    /// `solid`, remembered for items under a mapped representation, which models repeat by the
    /// thousand, with whether it is closed, so that is checked once too. An item that raised a
    /// diagnostic is not kept, so each element reports it. The third value is the kept shape,
    /// shared, when there is one.
    fn instance_of(
        &mut self,
        id: u32,
        entity: &Entity,
        def: &EntityDef,
        depth: usize,
    ) -> Option<(Mesh, Option<bool>, Option<Rc<Mesh>>)> {
        if depth == 0 {
            return Some((self.solid(id, entity, def, depth)?, None, None));
        }
        // Checked when the shape comes back, so one used once is not checked twice. Only a
        // closed shape's answer is passed on: one that is not may become closed once placed,
        // when rounding merges corners a hair apart, so each placed copy is checked.
        if let Some((mesh, closed)) = self.instances.get_mut(&id) {
            let closed = *closed.get_or_insert_with(|| mesh.is_closed_outward());
            return Some(((**mesh).clone(), closed.then_some(true), Some(Rc::clone(mesh))));
        }
        let reported = self.diagnostics.len();
        let mesh = self.solid(id, entity, def, depth)?;
        let kept = self.instance_triangles + mesh.triangles.len();
        if self.diagnostics.len() == reported && kept <= MAX_INSTANCE_TRIANGLES {
            self.instance_triangles = kept;
            let shared = Rc::new(mesh.clone());
            self.instances.insert(id, (Rc::clone(&shared), None));
            return Some((mesh, None, Some(shared)));
        }
        Some((mesh, None, None))
    }

    /// Whether a kept shape is closed and winds outward, checked once (`docs/09` §2: `Closed`
    /// comes from the shape). `None` for a key the evaluator does not keep.
    pub fn shape_closed(&mut self, key: u32) -> Option<bool> {
        let (mesh, closed) = self.instances.get_mut(&key)?;
        Some(*closed.get_or_insert_with(|| mesh.is_closed_outward()))
    }

    /// How many times the stream will meet each leaf item under a mapped representation
    /// (`docs/09` §2, rule 5), counted before streaming by walking what `evaluate` walks: the
    /// products of `element_ids` without voids, the first of their `Body`, `Facetation` and
    /// `Mesh` representations, and each `IfcMappedItem` down to its map's items, through nested
    /// mappings, which multiply. Bounded like the evaluator: `MAX_DEPTH` levels, a path set
    /// against cycles, and each map's leaves counted once and remembered.
    pub fn instance_uses(&self) -> HashMap<u32, u32> {
        let mut uses: HashMap<u32, u32> = HashMap::new();
        let mut memo: HashMap<u32, Rc<Vec<(u32, u32)>>> = HashMap::new();
        for id in self.element_ids() {
            if self.openings.contains_key(&id) {
                continue;
            }
            let Some((entity, def)) = self.lookup(id) else { continue };
            let Some(representation) = self.chosen_representation(&entity, &def) else { continue };
            for item in self.representation_items(representation) {
                let Some((item_entity, item_def)) = self.lookup(item) else { continue };
                if !item_def.is_a("IfcMappedItem") {
                    continue;
                }
                let mut path = Vec::new();
                for (leaf, count) in self.mapped_leaves(&item_entity, &item_def, &mut memo, &mut path).iter() {
                    let entry = uses.entry(*leaf).or_insert(0);
                    *entry = entry.saturating_add(*count);
                }
            }
        }
        uses
    }

    /// The leaf items under one mapped item, with how many times each is reached.
    fn mapped_leaves(
        &self,
        entity: &Entity,
        def: &EntityDef,
        memo: &mut HashMap<u32, Rc<Vec<(u32, u32)>>>,
        path: &mut Vec<u32>,
    ) -> Rc<Vec<(u32, u32)>> {
        let Some(map) = attribute(entity, def, "MappingSource").and_then(reference) else {
            return Rc::new(Vec::new());
        };
        if let Some(known) = memo.get(&map) {
            return Rc::clone(known);
        }
        if path.len() >= MAX_DEPTH || path.contains(&map) {
            return Rc::new(Vec::new());
        }
        let Some((map_entity, map_def)) = self.lookup(map) else { return Rc::new(Vec::new()) };
        let Some(representation) = attribute(&map_entity, &map_def, "MappedRepresentation").and_then(reference) else {
            return Rc::new(Vec::new());
        };
        path.push(map);
        let mut counts: HashMap<u32, u32> = HashMap::new();
        for item in self.representation_items(representation) {
            let Some((item_entity, item_def)) = self.lookup(item) else { continue };
            if item_def.is_a("IfcMappedItem") {
                for (leaf, count) in self.mapped_leaves(&item_entity, &item_def, memo, path).iter() {
                    let entry = counts.entry(*leaf).or_insert(0);
                    *entry = entry.saturating_add(*count);
                }
            } else {
                *counts.entry(item).or_insert(0) += 1;
            }
        }
        path.pop();
        let mut leaves: Vec<(u32, u32)> = counts.into_iter().collect();
        leaves.sort_unstable();
        let leaves = Rc::new(leaves);
        memo.insert(map, Rc::clone(&leaves));
        leaves
    }

    /// The items of a representation, in order.
    fn representation_items(&self, id: u32) -> Vec<u32> {
        let Some((entity, def)) = self.lookup(id) else { return Vec::new() };
        list(attribute(&entity, &def, "Items")).iter().filter_map(reference).collect()
    }

    /// The representation a product is drawn from: the first of `Body`, `Facetation` and `Mesh`.
    fn chosen_representation(&self, entity: &Entity, def: &EntityDef) -> Option<u32> {
        let shape = attribute(entity, def, "Representation").and_then(reference)?;
        let (shape, shape_def) = self.lookup(shape)?;
        let representations: Vec<u32> = list(attribute(&shape, &shape_def, "Representations"))
            .iter()
            .filter_map(reference)
            .collect();
        let identifier = |id: u32| -> Option<String> {
            let (entity, def) = self.lookup(id)?;
            match attribute(&entity, &def, "RepresentationIdentifier")? {
                Value::String(text) => Some(text.clone()),
                _ => None,
            }
        };
        ["Body", "Facetation", "Mesh"]
            .iter()
            .find_map(|wanted| representations.iter().copied().find(|id| identifier(*id).as_deref() == Some(*wanted)))
    }

    /// Exporters may style a boolean result or only the solid it started from.
    fn item_color(&self, id: u32) -> Option<u32> {
        let mut current = id;
        for _ in 0..MAX_DEPTH {
            if let Some(color) = self.item_colors.get(&current) {
                return Some(*color);
            }
            let (entity, def) = self.lookup(current)?;
            let next = attribute(&entity, &def, "FirstOperand")
                .or_else(|| attribute(&entity, &def, "TreeRootExpression"));
            current = next.and_then(reference)?;
        }
        None
    }

    /// Local geometry of a representation item, before any placement.
    fn solid(&mut self, id: u32, entity: &Entity, def: &EntityDef, depth: usize) -> Option<Mesh> {
        if def.is_a("IfcExtrudedAreaSolidTapered") {
            self.tapered_extrusion(entity, def)
        } else if def.is_a("IfcRevolvedAreaSolidTapered") {
            self.tapered_revolution(entity, def)
        } else if def.is_a("IfcExtrudedAreaSolid") {
            self.extrusion(entity, def)
        } else if def.is_a("IfcBooleanResult") {
            self.boolean(entity, def, depth)
        } else if def.is_a("IfcCsgSolid") {
            let root = attribute(entity, def, "TreeRootExpression").and_then(reference)?;
            self.operand(root, depth + 1)
        } else if def.is_a("IfcRevolvedAreaSolid") {
            self.revolved(entity, def)
        } else if def.is_a("IfcSweptDiskSolid") {
            self.swept_disk(entity, def)
        } else if def.is_a("IfcFixedReferenceSweptAreaSolid") || def.is_a("IfcSurfaceCurveSweptAreaSolid") {
            self.area_sweep(entity, def)
        } else if def.is_a("IfcSectionedSolidHorizontal") {
            self.sectioned_solid(entity, def)
        } else if def.is_a("IfcCsgPrimitive3D") {
            self.primitive(id, entity, def)
        } else if def.is_a("IfcManifoldSolidBrep") {
            self.brep(entity, def)
        } else if def.is_a("IfcShellBasedSurfaceModel") {
            let shells: Vec<u32> = list(attribute(entity, def, "SbsmBoundary"))
                .iter()
                .filter_map(reference)
                .collect();
            self.shell(&shells)
        } else if def.is_a("IfcFaceBasedSurfaceModel") {
            let sets: Vec<u32> = list(attribute(entity, def, "FbsmFaces"))
                .iter()
                .filter_map(reference)
                .collect();
            self.shell(&sets)
        } else if def.is_a("IfcTriangulatedFaceSet") {
            self.triangulated_face_set(entity, def)
        } else if def.is_a("IfcPolygonalFaceSet") {
            self.polygonal_face_set(entity, def)
        } else {
            self.warn("unsupported-geometry", format!("#{id} {}", def.name()));
            None
        }
    }

    fn operand(&mut self, id: u32, depth: usize) -> Option<Mesh> {
        if depth >= MAX_DEPTH {
            self.warn("nesting-too-deep", format!("#{id} is nested too deeply"));
            return None;
        }
        let (entity, def) = self.lookup(id)?;
        self.solid(id, &entity, &def, depth)
    }

    /// A failed boolean leaves the first operand: too much material beats a missing wall.
    fn boolean(&mut self, entity: &Entity, def: &EntityDef, depth: usize) -> Option<Mesh> {
        let first = attribute(entity, def, "FirstOperand").and_then(reference)?;
        let second = attribute(entity, def, "SecondOperand").and_then(reference)?;
        let first = self.operand(first, depth + 1)?;

        self.booleans_used += 1;
        if self.booleans_used > MAX_BOOLEANS_PER_ELEMENT {
            if self.booleans_used == MAX_BOOLEANS_PER_ELEMENT + 1 {
                self.warn("too-many-booleans", "boolean expression expands too far".into());
            }
            return Some(first);
        }

        let second = match self.lookup(second) {
            Some((half, half_def)) if half_def.is_a("IfcHalfSpaceSolid") => {
                self.half_space(&half, &half_def, &first)
            }
            _ => self.operand(second, depth + 1),
        };
        let Some(second) = second else {
            self.warn("boolean-failed", "second operand cannot be evaluated".into());
            return Some(first);
        };
        let operator = match attribute(entity, def, "Operator") {
            Some(Value::Enum(operator)) => operator.as_str(),
            _ => "DIFFERENCE",
        };
        // Nothing to remove, add, or have in common, as with a half space clear of `first`.
        if second.is_empty() {
            return (operator != "INTERSECTION").then_some(first);
        }
        let (Some(one), Some(two)) = (closed_shape(&first), closed_shape(&second)) else {
            self.warn("boolean-on-open-mesh", "boolean skipped: an operand is not closed".into());
            return Some(first);
        };

        let result = match operator {
            "UNION" => union(&one, &two),
            "INTERSECTION" => intersect(&one, &two),
            _ => subtract(&one, &two),
        };
        match result {
            Ok(mesh) => (!mesh.is_empty()).then_some(mesh),
            Err(error) => {
                self.warn("boolean-failed", error.to_string());
                Some(first)
            }
        }
    }

    /// Half spaces are unbounded, so they become a block reaching past everything in `target`.
    fn half_space(&mut self, entity: &Entity, def: &EntityDef, target: &Mesh) -> Option<Mesh> {
        let surface = attribute(entity, def, "BaseSurface").and_then(reference)?;
        let (plane, plane_def) = self.lookup(surface)?;
        if !plane_def.is_a("IfcPlane") {
            self.warn("unsupported-surface", format!("#{surface} {}", plane_def.name()));
            return None;
        }
        let frame = attribute(&plane, &plane_def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        let origin = frame.w_axis.truncate();
        let normal = frame.z_axis.truncate();
        // AgreementFlag is true when the normal points away from the material.
        let agrees = matches!(attribute(entity, def, "AgreementFlag"), Some(Value::Enum(flag)) if flag == "T");
        let into = if agrees { -normal } else { normal };
        // A target wholly outside the half space shares nothing with it, however it is bounded.
        // Revit clips walls at their own top this way, and some of its boundaries are broken.
        if target.positions.iter().all(|point| (*point - origin).dot(into) <= CLEAR_OF_HALF_SPACE) {
            return Some(Mesh::default());
        }
        if let Some(notch) = self.enclosed_notch(entity, def, frame, into) {
            return Some(notch);
        }

        let reach = |from: DVec3| {
            let furthest = target.positions.iter().fold(0.0_f64, |most, point| most.max(point.distance(from)));
            furthest * 2.0 + 1.0
        };
        let size = reach(origin);
        let (x, y) = solids::perpendiculars(into);
        let placement = DMat4::from_cols(x.extend(0.0), y.extend(0.0), into.extend(0.0), origin.extend(1.0));
        let block = Mesh::cuboid(DVec3::new(-size, -size, 0.0), DVec3::splat(size));
        let block = transformed(block, placement);
        if !def.is_a("IfcPolygonalBoundedHalfSpace") {
            return Some(block);
        }

        let position = attribute(entity, def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        let boundary = attribute(entity, def, "PolygonalBoundary").and_then(reference)?;
        let (curve, curve_def) = self.lookup(boundary)?;
        let ring = if curve_def.is_a("IfcCompositeCurve") && !self.is_segmented(&curve, &curve_def) {
            let parts = self.composite_parts(&curve, &curve_def, 0)?;
            let widest = parts
                .windows(2)
                .filter_map(|pair| Some(pair[0].last()?.distance(*pair[1].first()?)))
                .fold(0.0, f64::max);
            if widest > BOUNDARY_GAP {
                self.warn("broken-boundary", format!("#{boundary}: segments end {widest:.3} m apart"));
                return None;
            }
            let mut path = Vec::new();
            for part in parts {
                join(&mut path, part);
            }
            path.into_iter().map(DVec3::truncate).collect()
        } else {
            self.curve_points(boundary)?
        };
        let outer = clean_ring(ring);
        if outer.len() < 3 {
            return None;
        }
        // The plane may tilt, so the prism must also reach the far side of the block.
        let length = reach(position.w_axis.truncate()) + size * 2.0;
        let prism_mesh = prism(Profile { outer, holes: Vec::new() }, DVec3::new(0.0, 0.0, length * 2.0));
        let start = DMat4::from_translation(DVec3::new(0.0, 0.0, -length));
        let prism_mesh = transformed(prism_mesh, position * start);
        match intersect(&block, &prism_mesh) {
            Ok(mesh) => Some(mesh),
            Err(error) => {
                self.warn("boolean-failed", error.to_string());
                None
            }
        }
    }

    /// The schema says an enclosure only helps searching and leaves the result alone, but Revit
    /// writes it as the cut itself: a box centred on the plane in X and Y, starting at the plane,
    /// one wall thick. In the Revit files tried, the `Volume` each element declares matches that
    /// reading, and the whole half space removes most of the wall. This goes by the shape of the
    /// box alone and reads no quantity. Any other box follows the schema.
    fn enclosed_notch(&mut self, entity: &Entity, def: &EntityDef, frame: DMat4, into: DVec3) -> Option<Mesh> {
        if !def.is_a("IfcBoxedHalfSpace") {
            return None;
        }
        let enclosure = attribute(entity, def, "Enclosure").and_then(reference)?;
        let (enclosure, enclosure_def) = self.lookup(enclosure)?;
        let corner = attribute(&enclosure, &enclosure_def, "Corner")
            .and_then(reference)
            .and_then(|id| self.point(id))?;
        let scale = self.units.length;
        let size = |name: &str| attribute(&enclosure, &enclosure_def, name).and_then(number).map(|value| value * scale);
        let size = DVec3::new(size("XDim")?, size("YDim")?, size("ZDim")?);
        let centred = |offset: f64, side: f64| (offset.abs() * 2.0 - side).abs() <= 1e-6;
        let shaped = size.min_element() > 0.0
            && centred(corner.x, size.x)
            && centred(corner.y, size.y)
            && corner.z.abs() <= 1e-6;
        if !shaped {
            return None;
        }
        let x = frame.x_axis.truncate().try_normalize()?;
        let y = into.cross(x);
        let placement = DMat4::from_cols(x.extend(0.0), y.extend(0.0), into.extend(0.0), frame.w_axis);
        let half = (size / 2.0).truncate();
        Some(transformed(Mesh::cuboid(-half.extend(0.0), half.extend(size.z)), placement))
    }

    /// The placement of a revolution, a point on its axis, the axis, and how far it turns.
    fn revolution(&mut self, entity: &Entity, def: &EntityDef) -> Option<(DMat4, DVec3, DVec3, f64)> {
        let position = attribute(entity, def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        let axis = attribute(entity, def, "Axis").and_then(reference)?;
        let (axis, axis_def) = self.lookup(axis)?;
        let axis_point = attribute(&axis, &axis_def, "Location")
            .and_then(reference)
            .and_then(|id| self.point(id))?;
        let direction = attribute(&axis, &axis_def, "Axis")
            .and_then(reference)
            .and_then(|id| self.direction(id))
            .unwrap_or(DVec3::Z)
            .try_normalize()?;
        let angle = attribute(entity, def, "Angle").and_then(number)? * self.units.plane_angle;
        (angle > 0.0).then_some((position, axis_point, direction, angle.min(std::f64::consts::TAU)))
    }

    fn revolved(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let profile = attribute(entity, def, "SweptArea").and_then(reference)?;
        let profiles = self.profiles(profile, 0)?;
        let (position, axis_point, direction, angle) = self.revolution(entity, def)?;
        let parts = profiles.into_iter().map(|profile| {
            let profile = wound(profile);
            let mut rings: Vec<&[DVec2]> = vec![&profile.outer];
            rings.extend(profile.holes.iter().map(Vec::as_slice));
            let caps = triangulate_rings(&rings);
            solids::revolve(&rings, &caps, axis_point, direction, angle)
        });
        Some(transformed(merged(parts), position))
    }

    /// Start and end sections of a tapered sweep. Unmatched ones sweep the start unchanged.
    fn taper(&mut self, entity: &Entity, def: &EntityDef) -> Option<Vec<(Profile, Profile)>> {
        let start = attribute(entity, def, "SweptArea").and_then(reference)?;
        let start = self.profiles(start, 0)?;
        let end = attribute(entity, def, "EndSweptArea").and_then(reference);
        let end = end.and_then(|id| self.profiles(id, 0));
        let pairs = end.and_then(|end| section_pairs(&start, &end));
        if pairs.is_none() {
            self.warn("taper-ignored", "end section does not match the start".into());
        }
        pairs.or_else(|| section_pairs(&start, &start))
    }

    fn tapered_extrusion(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let (offset, position) = self.extrusion_path(entity, def)?;
        let pairs = self.taper(entity, def)?;
        let mut parts = Vec::with_capacity(pairs.len());
        for (start, end) in &pairs {
            // Flat walls are exact. Twisted ones are ruled surfaces, so follow them in steps.
            let steps = if flat_walls(start, end, offset) { 1 } else { RULED_STEPS };
            let sections: Vec<Section> = (0..=steps)
                .map(|step| {
                    let share = step as f64 / steps as f64;
                    blended(start, end, share, |point| point.extend(0.0) + offset * share)
                })
                .collect();
            parts.push(loft(&sections)?);
        }
        Some(transformed(merged(parts.into_iter()), position))
    }

    fn tapered_revolution(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let (position, axis_point, axis, angle) = self.revolution(entity, def)?;
        let pairs = self.taper(entity, def)?;
        let step_angle = std::f64::consts::TAU / solids::CIRCLE_SEGMENTS as f64;
        let steps = ((angle / step_angle).ceil() as usize).max(1);
        let mut parts = Vec::with_capacity(pairs.len());
        for (start, end) in &pairs {
            let sections: Vec<Section> = (0..=steps)
                .map(|step| {
                    let share = step as f64 / steps as f64;
                    blended(start, end, share, |point| {
                        solids::turned(point.extend(0.0), axis_point, axis, angle * share)
                    })
                })
                .collect();
            parts.push(loft(&sections)?);
        }
        Some(transformed(merged(parts.into_iter()), position))
    }

    /// The part of a directrix that a sweep's `StartParam` and `EndParam` select.
    fn directrix_path(&mut self, entity: &Entity, def: &EntityDef) -> Option<Vec<DVec3>> {
        let directrix = attribute(entity, def, "Directrix").and_then(reference)?;
        let start = attribute(entity, def, "StartParam");
        let end = attribute(entity, def, "EndParam");
        let by_length = |value: Option<&Value>| {
            matches!(value, Some(Value::Typed { name, .. }) if name.contains("LENGTHMEASURE"))
        };
        let (from, to) = (start.and_then(number), end.and_then(number));

        if (from.is_some() || to.is_some())
            && let Some((curve, curve_def)) = self.lookup(directrix)
                && !by_length(start) && !by_length(end) && (curve_def.is_a("IfcCircle") || curve_def.is_a("IfcEllipse")) {
                    let (frame, radii) = self.conic(&curve, &curve_def)?;
                    let angle = self.units.plane_angle;
                    let begin = from.unwrap_or(0.0) * angle;
                    let finish = to.map_or(std::f64::consts::TAU, |to| to * angle);
                    return (finish > begin).then(|| on_conic(frame, radii, begin, finish - begin));
                }

        let mut path = self.curve_path(directrix, 0)?;
        if from.is_some() || to.is_some() {
            let last = path.len().saturating_sub(1) as f64;
            if by_length(start) || by_length(end) {
                let scale = self.units.length;
                let begin = from.unwrap_or(0.0) * scale;
                let finish = to.map_or(f64::INFINITY, |to| to * scale);
                path = path_between_lengths(&path, begin, finish);
            } else if self.is_polyline(directrix) {
                let (begin, finish) = (from.unwrap_or(0.0).clamp(0.0, last), to.unwrap_or(last).clamp(0.0, last));
                if finish > begin {
                    path = polyline_between(&path, begin, finish);
                }
            } else {
                self.warn("sweep-trim-ignored", "swept along the whole directrix".into());
            }
        }
        path.dedup_by(|a, b| a.distance_squared(*b) <= POINT_TOLERANCE * POINT_TOLERANCE);
        (path.len() >= 2).then_some(path)
    }

    /// The direction of the profile's X axis at each point of a sweep's path.
    fn sweep_hints(&mut self, entity: &Entity, def: &EntityDef, path: &[DVec3]) -> Option<Vec<DVec3>> {
        if let Some(fixed) = attribute(entity, def, "FixedReference").and_then(reference) {
            return Some(vec![self.direction(fixed)?; path.len()]);
        }
        let surface = attribute(entity, def, "ReferenceSurface").and_then(reference)?;
        let (surface, surface_def) = self.lookup(surface)?;
        if surface_def.is_a("IfcPlane") {
            let frame = attribute(&surface, &surface_def, "Position")
                .and_then(reference)
                .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
            return Some(vec![frame.z_axis.truncate(); path.len()]);
        }
        let loops = [path.to_vec()];
        let curved = if surface_def.is_a("IfcBSplineSurfaceWithKnots") {
            self.bspline_surface(&surface, &surface_def)
        } else if ANALYTIC_SURFACES.iter().any(|name| surface_def.is_a(name)) {
            self.analytic_surface(&surface, &surface_def, &loops)
        } else {
            self.warn("unsupported-surface", surface_def.name().to_string());
            return None;
        };
        let normals = curved.and_then(|curved| curved.normals_at(path));
        if normals.is_none() {
            self.warn("bad-surface", "reference surface gives no normal along the directrix".into());
        }
        normals
    }

    fn area_sweep(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let profile = attribute(entity, def, "SweptArea").and_then(reference)?;
        let profiles = self.profiles(profile, 0)?;
        let position = attribute(entity, def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        let path = self.directrix_path(entity, def)?;
        let hints = self.sweep_hints(entity, def, &path)?;
        let mut parts = Vec::with_capacity(profiles.len());
        for profile in profiles {
            let sections = swept_sections(&wound(profile), &path, &hints)?;
            parts.push(loft(&sections)?);
        }
        Some(transformed(merged(parts.into_iter()), position))
    }

    /// Voids are shells too. Their normals should point into the void, but files differ.
    fn brep(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let outer = attribute(entity, def, "Outer").and_then(reference)?;
        let outer = self.shell(&[outer])?;
        let voids: Vec<u32> = list(attribute(entity, def, "Voids")).iter().filter_map(reference).collect();
        if voids.is_empty() {
            return Some(outer);
        }
        let mut parts = vec![solids::outward(outer)];
        for void in voids {
            if let Some(mut mesh) = self.shell(&[void]) {
                if mesh.volume() > 0.0 {
                    mesh.triangles.iter_mut().for_each(|triangle| triangle.swap(1, 2));
                }
                parts.push(mesh);
            }
        }
        Some(merged(parts.into_iter()))
    }

    /// Whether a directrix is a polyline, the one curve whose parameters are simple to apply.
    fn is_polyline(&self, id: u32) -> bool {
        self.lookup(id).is_some_and(|(curve, def)| {
            def.is_a("IfcPolyline")
                || (def.is_a("IfcIndexedPolyCurve") && attribute(&curve, &def, "Segments").is_none())
        })
    }

    fn swept_disk(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let directrix = attribute(entity, def, "Directrix").and_then(reference)?;
        let scale = self.units.length;
        let radius = attribute(entity, def, "Radius")
            .and_then(number)
            .map(|radius| radius * scale)
            .filter(|radius| *radius > 0.0)?;
        let inner = attribute(entity, def, "InnerRadius")
            .and_then(number)
            .map(|inner| inner * scale)
            .filter(|inner| *inner > 0.0 && *inner < radius);
        let mut path = self.curve_path(directrix, 0)?;
        let bound = |name: &str| attribute(entity, def, name).and_then(number);
        let (start, end) = (bound("StartParam"), bound("EndParam"));
        if start.is_some() || end.is_some() {
            let last = path.len().saturating_sub(1) as f64;
            let (from, to) = (start.unwrap_or(0.0).clamp(0.0, last), end.unwrap_or(last).clamp(0.0, last));
            // Exactly 0 to 1 over many segments may mean the whole curve. Too much bar beats
            // a missing one, as with booleans.
            let ambiguous = last > 1.0 && from == 0.0 && to == 1.0;
            if self.is_polyline(directrix) && to > from && !ambiguous {
                path = polyline_between(&path, from, to);
            } else {
                self.warn("sweep-trim-ignored", "swept along the whole directrix".into());
            }
        }
        path.dedup_by(|a, b| a.distance_squared(*b) <= POINT_TOLERANCE * POINT_TOLERANCE);
        if let Some(fillet) = attribute(entity, def, "FilletRadius").and_then(number) {
            path = solids::filleted(&path, fillet * scale);
        }
        (path.len() >= 2).then(|| solids::pipe(&path, radius, inner))
    }

    fn primitive(&mut self, id: u32, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let scale = self.units.length;
        let size = |name: &str| Some(attribute(entity, def, name).and_then(number)? * scale);
        let mesh = match def.name() {
            "IfcBlock" => {
                Mesh::cuboid(DVec3::ZERO, DVec3::new(size("XLength")?, size("YLength")?, size("ZLength")?))
            }
            "IfcRectangularPyramid" => {
                solids::pyramid(size("XLength")?, size("YLength")?, size("Height")?)
            }
            "IfcRightCircularCone" => solids::cone(size("BottomRadius")?, size("Height")?),
            "IfcRightCircularCylinder" => solids::cylinder(size("Radius")?, size("Height")?),
            "IfcSphere" => solids::sphere(size("Radius")?),
            other => {
                self.warn("unsupported-geometry", format!("#{id} {other}"));
                return None;
            }
        };
        let position = attribute(entity, def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        Some(transformed(mesh, position))
    }

    /// ISO 10303-43 semantics: moves the mapping origin onto the mapping target.
    fn mapped_item(
        &mut self,
        entity: &Entity,
        def: &EntityDef,
        transform: DMat4,
        color: u32,
        depth: usize,
        out: &mut Vec<ElementMesh>,
    ) {
        let source = attribute(entity, def, "MappingSource").and_then(reference);
        let Some((map, map_def)) = source.and_then(|id| self.lookup(id)) else {
            self.warn("bad-mapped-item", "unreadable mapping source".into());
            return;
        };
        let target = attribute(entity, def, "MappingTarget")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.transformation_operator(id));
        let origin = attribute(&map, &map_def, "MappingOrigin")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        let Some(representation) =
            attribute(&map, &map_def, "MappedRepresentation").and_then(reference)
        else {
            return;
        };
        let mapped = transform * target * origin.inverse();
        self.representation(representation, mapped, color, depth + 1, out);
    }

    fn transformation_operator(&mut self, id: u32) -> DMat4 {
        let Some((entity, def)) = self.lookup(id) else {
            return DMat4::IDENTITY;
        };
        let direction = |evaluator: &Self, name: &str| {
            attribute(&entity, &def, name)
                .and_then(reference)
                .and_then(|id| evaluator.direction(id))
        };
        let x_hint = direction(self, "Axis1").unwrap_or(DVec3::X);
        let y_hint = direction(self, "Axis2").unwrap_or(DVec3::Y);
        let z_hint = direction(self, "Axis3").unwrap_or(DVec3::Z);
        let origin = attribute(&entity, &def, "LocalOrigin")
            .and_then(reference)
            .and_then(|id| self.point(id))
            .unwrap_or(DVec3::ZERO);
        let scale = attribute(&entity, &def, "Scale").and_then(number).unwrap_or(1.0);
        let scale_y = attribute(&entity, &def, "Scale2").and_then(number).unwrap_or(scale);
        let scale_z = attribute(&entity, &def, "Scale3").and_then(number).unwrap_or(scale);

        let z = z_hint.try_normalize().unwrap_or(DVec3::Z);
        let x = (x_hint - z * x_hint.dot(z)).try_normalize().unwrap_or(DVec3::X);
        let mut y = z.cross(x);
        if y.dot(y_hint) < 0.0 {
            y = -y;
        }
        DMat4::from_cols(
            (x * scale).extend(0.0),
            (y * scale_y).extend(0.0),
            (z * scale_z).extend(0.0),
            DVec4::new(origin.x, origin.y, origin.z, 1.0),
        )
    }

    fn point(&self, id: u32) -> Option<DVec3> {
        let found = self.file.get(id)?;
        // Most points are plain numbers, read without building an entity. Anything else, or
        // another type, takes the full path, which gives the same answer for those.
        if Some(found.type_index) == self.plain.point
            && let Some(([x, y, z], count)) = self.file.decode_coordinates(found)
        {
            let z = if count == 3 { z } else { 0.0 };
            return Some(DVec3::new(x, y, z) * self.units.length);
        }
        let (entity, def) = self.lookup(id)?;
        let coordinates = list(attribute(&entity, &def, "Coordinates"));
        let value = |index: usize| coordinates.get(index).and_then(number);
        Some(DVec3::new(value(0)?, value(1)?, value(2).unwrap_or(0.0)) * self.units.length)
    }

    fn direction(&self, id: u32) -> Option<DVec3> {
        let (entity, def) = self.lookup(id)?;
        let ratios = list(attribute(&entity, &def, "DirectionRatios"));
        let value = |index: usize| ratios.get(index).and_then(number);
        Some(DVec3::new(value(0)?, value(1)?, value(2).unwrap_or(0.0)))
    }

    /// An `IfcAxis2Placement2D` or `IfcAxis2Placement3D`.
    fn placement_matrix(&mut self, id: u32) -> DMat4 {
        let Some((entity, def)) = self.lookup(id) else {
            self.warn("bad-placement", format!("#{id} cannot be read"));
            return DMat4::IDENTITY;
        };
        let location = attribute(&entity, &def, "Location")
            .and_then(reference)
            .and_then(|id| self.point(id))
            .unwrap_or(DVec3::ZERO);
        let axis = attribute(&entity, &def, "Axis")
            .and_then(reference)
            .and_then(|id| self.direction(id));
        let x_hint = attribute(&entity, &def, "RefDirection")
            .and_then(reference)
            .and_then(|id| self.direction(id))
            .unwrap_or(DVec3::X);

        let z = axis.and_then(DVec3::try_normalize).unwrap_or(DVec3::Z);
        let x = (x_hint - z * x_hint.dot(z))
            .try_normalize()
            .unwrap_or_else(|| z.any_orthonormal_vector());
        let y = z.cross(x);
        DMat4::from_cols(
            x.extend(0.0),
            y.extend(0.0),
            z.extend(0.0),
            location.extend(1.0),
        )
    }

    fn placement(&mut self, id: u32, depth: usize) -> DMat4 {
        if let Some(cached) = self.placements.get(&id) {
            return *cached;
        }
        if depth >= MAX_DEPTH {
            self.warn("bad-placement", "placement chain is too deep or cyclic".into());
            return DMat4::IDENTITY;
        }
        let Some((entity, def)) = self.lookup(id) else {
            return DMat4::IDENTITY;
        };
        let along_curve = def.is_a("IfcLinearPlacement");
        let on_grid = def.is_a("IfcGridPlacement");
        if !def.is_a("IfcLocalPlacement") && !along_curve && !on_grid {
            self.warn("unsupported-placement", format!("#{id} {}", def.name()));
            return DMat4::IDENTITY;
        }
        let mut parent = attribute(&entity, &def, "PlacementRelTo").and_then(reference);
        if on_grid && parent.is_none() {
            parent = self.grid_of(&entity, &def);
        }
        let parent = match parent {
            Some(parent) => self.placement(parent, depth + 1),
            None => DMat4::IDENTITY,
        };
        let relative = attribute(&entity, &def, "RelativePlacement").and_then(reference);
        let relative = if on_grid {
            let on_axes = self.grid_matrix(&entity, &def);
            if on_axes.is_none() {
                self.warn("bad-placement", format!("#{id} names grid axes that do not cross"));
            }
            on_axes
        } else if along_curve {
            relative.and_then(|id| self.linear_matrix(id, depth + 1)).or_else(|| {
                let fallback = attribute(&entity, &def, "CartesianPosition").and_then(reference);
                fallback.map(|id| self.placement_matrix(id))
            })
        } else {
            relative.map(|id| self.placement_matrix(id))
        };
        let world = parent * relative.unwrap_or(DMat4::IDENTITY);
        self.placements.insert(id, world);
        world
    }

    /// The placement of the grid an `IfcGridPlacement`'s first axis belongs to.
    fn grid_of(&self, entity: &Entity, def: &EntityDef) -> Option<u32> {
        let location = attribute(entity, def, "PlacementLocation").and_then(reference)?;
        let (crossing, crossing_def) = self.lookup(location)?;
        let first = list(attribute(&crossing, &crossing_def, "IntersectingAxes")).first().and_then(reference)?;
        self.grid_axes.get(&first).copied()
    }

    /// An `IfcGridPlacement` in its grid's coordinates. Its x runs toward the explicit direction,
    /// else toward the second crossing, else along the first axis; its z is the grid's.
    fn grid_matrix(&mut self, entity: &Entity, def: &EntityDef) -> Option<DMat4> {
        let location = attribute(entity, def, "PlacementLocation").and_then(reference)?;
        let (origin, along) = self.grid_crossing(location)?;
        let toward = attribute(entity, def, "PlacementRefDirection").and_then(reference);
        let x = match toward.and_then(|id| Some((id, self.lookup(id)?.1))) {
            Some((id, toward_def)) if toward_def.is_a("IfcDirection") => self.direction(id).map(DVec3::truncate),
            Some((id, _)) => self.grid_crossing(id).map(|(other, _)| (other - origin).truncate()),
            None => None,
        };
        let x = x.and_then(DVec2::try_normalize).unwrap_or(along);
        Some(DMat4::from_cols(
            x.extend(0.0).extend(0.0),
            x.perp().extend(0.0).extend(0.0),
            DVec4::Z,
            origin.extend(1.0),
        ))
    }

    /// An `IfcVirtualGridIntersection`: where its two axes cross once offset, raised by its
    /// third offset, and the heading of the first axis there.
    fn grid_crossing(&mut self, id: u32) -> Option<(DVec3, DVec2)> {
        let (entity, def) = self.lookup(id)?;
        let axes: Vec<u32> = list(attribute(&entity, &def, "IntersectingAxes")).iter().filter_map(reference).collect();
        let offsets = numbers(attribute(&entity, &def, "OffsetDistances"));
        let scale = self.units.length;
        let offset = |index: usize| offsets.get(index).copied().unwrap_or(0.0) * scale;
        let [first, second] = axes[..] else { return None };
        let (first, second) = (self.grid_axis(first)?, self.grid_axis(second)?);
        let (point, along) = offset_crossing(&first, offset(0), &second, offset(1))?;
        Some((point.extend(offset(2)), along))
    }

    /// An `IfcGridAxis` as a polyline in its grid's coordinates, running the axis's own way. An
    /// unbounded line is two of its points, which is enough since axes run on past their ends.
    fn grid_axis(&mut self, id: u32) -> Option<Vec<DVec2>> {
        let (entity, def) = self.lookup(id)?;
        let curve = attribute(&entity, &def, "AxisCurve").and_then(reference)?;
        let (line, line_def) = self.lookup(curve)?;
        let mut points = if line_def.is_a("IfcLine") {
            let start = attribute(&line, &line_def, "Pnt").and_then(reference).and_then(|id| self.point(id))?;
            let (vector, vector_def) = attribute(&line, &line_def, "Dir").and_then(reference).and_then(|id| self.lookup(id))?;
            let heading = attribute(&vector, &vector_def, "Orientation").and_then(reference).and_then(|id| self.direction(id))?;
            vec![start.truncate(), start.truncate() + heading.truncate()]
        } else {
            self.curve_points(curve)?
        };
        if flag(attribute(&entity, &def, "SameSense")) == Some(false) {
            points.reverse();
        }
        Some(points)
    }

    fn curve_points(&mut self, id: u32) -> Option<Vec<DVec2>> {
        let path = self.curve_path(id, 0)?;
        Some(path.into_iter().map(DVec3::truncate).collect())
    }

    /// A curve as a polyline. Arcs are tessellated, not replaced by their chords.
    fn curve_path(&mut self, id: u32, depth: usize) -> Option<Vec<DVec3>> {
        // Composite curves can share segments, so depth alone leaves exponentially many.
        self.items_used += 1;
        if depth >= MAX_DEPTH || self.items_used > MAX_ITEMS_PER_ELEMENT {
            self.warn("nesting-too-deep", format!("#{id} is nested too deeply"));
            return None;
        }
        let (entity, def) = self.lookup(id)?;
        if self.is_segmented(&entity, &def) {
            return self.stationed(id, depth).map(|curve| curve.points.clone());
        }
        if def.is_a("IfcOffsetCurve2D") || def.is_a("IfcOffsetCurve3D") || def.is_a("IfcOffsetCurveByDistances") {
            return self.offset_curve(&entity, &def, depth);
        }
        if def.is_a("IfcPolyline") {
            list(attribute(&entity, &def, "Points"))
                .iter()
                .map(|point| self.point(reference(point)?))
                .collect()
        } else if def.is_a("IfcIndexedPolyCurve") {
            self.indexed_curve(&entity, &def)
        } else if def.is_a("IfcCompositeCurve") {
            let mut path = Vec::new();
            for part in self.composite_parts(&entity, &def, depth)? {
                join(&mut path, part);
            }
            Some(path)
        } else if def.is_a("IfcTrimmedCurve") {
            self.trimmed_curve(&entity, &def)
        } else if def.is_a("IfcBSplineCurveWithKnots") {
            self.bspline_curve(&entity, &def)
        } else if def.is_a("IfcSurfaceCurve") {
            let curve = attribute(&entity, &def, "Curve3D").and_then(reference)?;
            self.curve_path(curve, depth + 1)
        } else if def.is_a("IfcCircle") || def.is_a("IfcEllipse") {
            let (frame, radii) = self.conic(&entity, &def)?;
            Some(on_conic(frame, radii, 0.0, std::f64::consts::TAU))
        } else {
            self.warn("unsupported-curve", format!("#{id} {}", def.name()));
            None
        }
    }

    /// Each segment of a composite curve as a polyline, running the way the curve does.
    fn composite_parts(&mut self, entity: &Entity, def: &EntityDef, depth: usize) -> Option<Vec<Vec<DVec3>>> {
        let mut parts = Vec::new();
        for segment in list(attribute(entity, def, "Segments")).iter().filter_map(reference) {
            let (segment, segment_def) = self.lookup(segment)?;
            let parent = attribute(&segment, &segment_def, "ParentCurve").and_then(reference)?;
            let mut part = self.curve_path(parent, depth + 1)?;
            if flag(attribute(&segment, &segment_def, "SameSense")) == Some(false) {
                part.reverse();
            }
            parts.push(part);
        }
        Some(parts)
    }

    /// Whether a curve is made of `IfcCurveSegment`s, as alignment curves are.
    fn is_segmented(&self, entity: &Entity, def: &EntityDef) -> bool {
        def.is_a("IfcGradientCurve")
            || def.is_a("IfcSegmentedReferenceCurve")
            || (def.is_a("IfcCompositeCurve")
                && list(attribute(entity, def, "Segments"))
                    .iter()
                    .filter_map(reference)
                    .any(|id| self.lookup(id).is_some_and(|(_, segment)| segment.is_a("IfcCurveSegment"))))
    }

    /// A curve with the true distance along it, which composites of segments know exactly.
    fn stationed(&mut self, id: u32, depth: usize) -> Option<Rc<Stationed>> {
        if let Some(curve) = self.curves.get(&id) {
            return Some(curve.clone());
        }
        self.items_used += 1;
        if depth >= MAX_DEPTH || self.items_used > MAX_ITEMS_PER_ELEMENT {
            self.warn("nesting-too-deep", format!("#{id} is nested too deeply"));
            return None;
        }
        let (entity, def) = self.lookup(id)?;
        let base = attribute(&entity, &def, "BaseCurve").and_then(reference);
        let curve = if def.is_a("IfcSegmentedReferenceCurve") {
            self.warn("cant-ignored", format!("#{id} follows its base curve without its cant"));
            (*self.stationed(base?, depth + 1)?).clone()
        } else if def.is_a("IfcGradientCurve") {
            let base = self.stationed(base?, depth + 1)?;
            base.lifted(self.curve_segments(&entity, &def, depth)?)
        } else if self.is_segmented(&entity, &def) {
            self.curve_segments(&entity, &def, depth)?
        } else {
            Stationed::from_path(self.curve_path(id, depth)?)
        };
        let curve = Rc::new(curve);
        self.curves.insert(id, curve.clone());
        Some(curve)
    }

    fn curve_segments(&mut self, entity: &Entity, def: &EntityDef, depth: usize) -> Option<Stationed> {
        let scale = self.units.length;
        let mut whole = Stationed::default();
        for id in list(attribute(entity, def, "Segments")).iter().filter_map(reference) {
            let (segment, segment_def) = self.lookup(id)?;
            let parent = attribute(&segment, &segment_def, "ParentCurve").and_then(reference)?;
            let run = if segment_def.is_a("IfcCurveSegment") {
                let per_parameter = self.parameter_length(parent);
                let measure = |name: &str| {
                    let value = attribute(&segment, &segment_def, name)?;
                    let by_parameter = matches!(value, Value::Typed { name, .. } if name == "IFCPARAMETERVALUE");
                    Some(number(value)? * if by_parameter { per_parameter } else { scale })
                };
                let (start, length) = (measure("SegmentStart")?, measure("SegmentLength")?);
                if length == 0.0 {
                    continue;
                }
                let placement = attribute(&segment, &segment_def, "Placement").and_then(reference)?;
                let placement = self.any_placement(placement, depth + 1)?;
                let parent = self.parent_curve(parent, length.abs())?;
                let run = curves::segment(parent, placement, start, length);
                if run.is_none() {
                    self.warn("bad-curve", format!("#{id} has no usable points"));
                }
                run?
            } else {
                Stationed::from_path(self.curve_path(parent, depth + 1)?)
            };
            if whole.points.len() + run.points.len() > MAX_CURVE_POINTS {
                self.warn("curve-too-long", format!("#{id} goes past {MAX_CURVE_POINTS} points"));
                return None;
            }
            whole.extend(run);
        }
        (whole.points.len() >= 2).then_some(whole)
    }

    /// The length along curve `id` per unit of its own parameter, for a segment measured by
    /// parameter value: the direction vector on a line, the radius per plane angle unit on a
    /// circle. Segments on other curves count it as a length: no parameter space for them is
    /// agreed yet, and the exporters seen measure spirals by length.
    fn parameter_length(&self, id: u32) -> f64 {
        let scale = self.units.length;
        let Some((entity, def)) = self.lookup(id) else {
            return scale;
        };
        if def.is_a("IfcLine") {
            let vector = attribute(&entity, &def, "Dir").and_then(reference).and_then(|id| self.lookup(id));
            let magnitude = vector.and_then(|(vector, vector_def)| attribute(&vector, &vector_def, "Magnitude").and_then(number));
            magnitude.map_or(scale, |magnitude| magnitude * scale)
        } else if def.is_a("IfcCircle") {
            let radius = attribute(&entity, &def, "Radius").and_then(number);
            radius.map_or(scale, |radius| radius * scale * self.units.plane_angle)
        } else {
            scale
        }
    }

    /// The curve a segment cuts from. `length` is the length of that segment.
    fn parent_curve(&mut self, id: u32, length: f64) -> Option<Parent> {
        let (entity, def) = self.lookup(id)?;
        let scale = self.units.length;
        let term = |name: &str| attribute(&entity, &def, name).and_then(number).map(|value| value * scale);
        let frame = attribute(&entity, &def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        let spiral = |heading: Heading| Some(Parent::Spiral { frame, heading });

        if def.is_a("IfcLine") {
            let origin = attribute(&entity, &def, "Pnt").and_then(reference).and_then(|id| self.point(id))?;
            let vector = attribute(&entity, &def, "Dir").and_then(reference)?;
            let (vector, vector_def) = self.lookup(vector)?;
            let direction = attribute(&vector, &vector_def, "Orientation")
                .and_then(reference)
                .and_then(|id| self.direction(id))?
                .try_normalize()?;
            Some(Parent::Line { origin, direction })
        } else if def.is_a("IfcCircle") {
            let radius = term("Radius").filter(|radius| *radius > 0.0)?;
            Some(Parent::Circle { frame, radius })
        } else if def.is_a("IfcClothoid") {
            spiral(Heading::polynomial(&[None, term("ClothoidConstant")]))
        } else if def.is_a("IfcSecondOrderPolynomialSpiral") {
            spiral(Heading::polynomial(&["ConstantTerm", "LinearTerm", "QuadraticTerm"].map(term)))
        } else if def.is_a("IfcThirdOrderPolynomialSpiral") {
            spiral(Heading::polynomial(&["ConstantTerm", "LinearTerm", "QuadraticTerm", "CubicTerm"].map(term)))
        } else if def.is_a("IfcSeventhOrderPolynomialSpiral") {
            spiral(Heading::polynomial(
                &[
                    "ConstantTerm",
                    "LinearTerm",
                    "QuadraticTerm",
                    "CubicTerm",
                    "QuarticTerm",
                    "QuinticTerm",
                    "SexticTerm",
                    "SepticTerm",
                ]
                .map(term),
            ))
        } else if def.is_a("IfcCosineSpiral") {
            let cosine = term("CosineTerm")?;
            spiral(Heading::Cosine { constant: term("ConstantTerm"), cosine, length })
        } else if def.is_a("IfcSineSpiral") {
            let sine = term("SineTerm")?;
            spiral(Heading::Sine { constant: term("ConstantTerm"), linear: term("LinearTerm"), sine, length })
        } else if def.is_a("IfcPolynomialCurve") {
            let coefficients = |name: &str| numbers(attribute(&entity, &def, name));
            let (x, y, z) = (coefficients("CoefficientsX"), coefficients("CoefficientsY"), coefficients("CoefficientsZ"));
            Some(Parent::Polynomial { frame, x, y, z, unit: scale })
        } else {
            self.warn("unsupported-curve", format!("#{id} {}", def.name()));
            None
        }
    }

    /// A placement of any kind, including one along a curve.
    fn any_placement(&mut self, id: u32, depth: usize) -> Option<DMat4> {
        let (_, def) = self.lookup(id)?;
        if def.is_a("IfcAxis2PlacementLinear") {
            self.linear_matrix(id, depth)
        } else {
            Some(self.placement_matrix(id))
        }
    }

    /// An `IfcPointByDistanceExpression`: its curve's id, the distance along, and the offsets
    /// to the left, up and along.
    fn distance_along(&self, id: u32) -> Option<(Option<u32>, f64, DVec3)> {
        let (entity, def) = self.lookup(id)?;
        let scale = self.units.length;
        let measure = |name: &str| attribute(&entity, &def, name).and_then(number).unwrap_or(0.0) * scale;
        let station = attribute(&entity, &def, "DistanceAlong").and_then(number)? * scale;
        let offsets = DVec3::new(measure("OffsetLateral"), measure("OffsetVertical"), measure("OffsetLongitudinal"));
        Some((attribute(&entity, &def, "BasisCurve").and_then(reference), station, offsets))
    }

    /// Where an `IfcAxis2PlacementLinear` lands, its axes taken relative to the curve there.
    fn linear_matrix(&mut self, id: u32, depth: usize) -> Option<DMat4> {
        let (entity, def) = self.lookup(id)?;
        let location = attribute(&entity, &def, "Location").and_then(reference)?;
        let (basis, station, offsets) = self.distance_along(location)?;
        // A segment can be placed along the curve it belongs to, so depth carries through.
        let curve = self.stationed(basis?, depth + 1)?;
        // On the curve itself: its chords stray by up to their tolerance between samples.
        let (point, [along, left, up]) = curve.exact_frame(station)?;
        let origin = point + left * offsets.x + up * offsets.y + along * offsets.z;
        let on_curve = DMat4::from_cols(along.extend(0.0), left.extend(0.0), up.extend(0.0), origin.extend(1.0));
        Some(on_curve * self.placement_matrix(id))
    }

    fn offset_curve(&mut self, entity: &Entity, def: &EntityDef, depth: usize) -> Option<Vec<DVec3>> {
        let basis = attribute(entity, def, "BasisCurve").and_then(reference)?;
        let curve = self.stationed(basis, depth + 1)?;
        let offsets: Vec<(f64, DVec3)> = list(attribute(entity, def, "OffsetValues"))
            .iter()
            .filter_map(reference)
            .filter_map(|id| self.distance_along(id).map(|(_, station, offsets)| (station, offsets)))
            .collect();
        let distance = attribute(entity, def, "Distance").and_then(number).unwrap_or(0.0) * self.units.length;
        let reference_direction = attribute(entity, def, "RefDirection")
            .and_then(reference)
            .and_then(|id| self.direction(id))
            .and_then(DVec3::try_normalize);

        let mut sorted = offsets;
        sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
        let offset_at = |station: f64| {
            let after = sorted.partition_point(|(at, _)| *at <= station);
            match (after.checked_sub(1).and_then(|index| sorted.get(index)), sorted.get(after)) {
                (Some(low), Some(high)) if high.0 > low.0 => {
                    low.1.lerp(high.1, (station - low.0) / (high.0 - low.0))
                }
                (Some(point), _) | (None, Some(point)) => point.1,
                (None, None) => DVec3::ZERO,
            }
        };
        // Offsets can change between the vertices of the base, so the path bends there too.
        let (first, last) = (*curve.stations.first()?, *curve.stations.last()?);
        let marks = sorted.iter().map(|(at, _)| *at).filter(|at| *at > first && *at < last);
        let mut stations: Vec<f64> = curve.stations.iter().copied().chain(marks).collect();
        stations.sort_by(f64::total_cmp);
        stations.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        stations
            .iter()
            .map(|station| {
                let (point, [along, left, up]) = curve.frame(*station)?;
                Some(if def.is_a("IfcOffsetCurveByDistances") {
                    let offsets = offset_at(*station);
                    point + left * offsets.x + up * offsets.y + along * offsets.z
                } else if def.is_a("IfcOffsetCurve3D") {
                    point + along.cross(reference_direction?) * distance
                } else {
                    point + left * distance
                })
            })
            .collect()
    }

    /// One cross-section position: the distance along, the offsets, and the profile's axes
    /// relative to the curve. X defaults to the axis across the curve, to its left.
    fn section_mark(&mut self, id: u32) -> Option<SectionMark> {
        let (entity, def) = self.lookup(id)?;
        let location = attribute(&entity, &def, "Location").and_then(reference)?;
        let (_, station, offsets) = self.distance_along(location)?;
        let vector = |name: &str| {
            attribute(&entity, &def, name)
                .and_then(reference)
                .and_then(|id| self.direction(id))
                .and_then(DVec3::try_normalize)
        };
        let y = vector("Axis").unwrap_or(DVec3::Z);
        let across = y.cross(DVec3::X).try_normalize().unwrap_or(DVec3::Y);
        let x = vector("RefDirection")
            .filter(|hint| hint.x.abs() < 0.999)
            .and_then(|hint| (hint - y * hint.dot(y)).try_normalize())
            .unwrap_or(across);
        Some(SectionMark { station, offsets, x, y })
    }

    fn sectioned_solid(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let ids = |name: &str| -> Vec<u32> { list(attribute(entity, def, name)).iter().filter_map(reference).collect() };
        let (sections, positions) = (ids("CrossSections"), ids("CrossSectionPositions"));
        if sections.len() != positions.len() || sections.len() < 2 {
            self.warn("bad-sections", "cross sections and positions do not pair up".into());
            return None;
        }
        let directrix = attribute(entity, def, "Directrix").and_then(reference)?;
        let curve = self.stationed(directrix, 0)?;
        let marks: Vec<SectionMark> = positions.iter().map(|id| self.section_mark(*id)).collect::<Option<_>>()?;
        let profiles: Vec<Vec<Profile>> = sections.iter().map(|id| self.profiles(*id, 0)).collect::<Option<_>>()?;

        let mut parts = Vec::new();
        for span in 0..marks.len() - 1 {
            let (first, second) = (&marks[span], &marks[span + 1]);
            let pairs = section_pairs(&profiles[span], &profiles[span + 1]).filter(|_| second.station > first.station);
            let Some(pairs) = pairs else {
                self.warn("bad-sections", "consecutive sections do not match or do not advance".into());
                return None;
            };
            let inner = curve.stations.iter().copied().filter(|at| *at > first.station && *at < second.station);
            let stations: Vec<f64> = std::iter::once(first.station).chain(inner).chain([second.station]).collect();
            for (start, end) in &pairs {
                let sections: Vec<Section> = stations
                    .iter()
                    .map(|station| {
                        let share = (station - first.station) / (second.station - first.station);
                        let (point, [along, left, up]) = curve.frame(*station)?;
                        let world = |local: DVec3| along * local.x + left * local.y + up * local.z;
                        let offsets = first.offsets.lerp(second.offsets, share);
                        let origin = point + left * offsets.x + up * offsets.y + along * offsets.z;
                        let x = world(first.x.lerp(second.x, share)).try_normalize()?;
                        let y = world(first.y.lerp(second.y, share)).try_normalize()?;
                        Some(blended(start, end, share, |flat| origin + x * flat.x + y * flat.y))
                    })
                    .collect::<Option<_>>()?;
                parts.push(loft(&sections)?);
            }
        }
        Some(merged(parts.into_iter()))
    }

    fn bspline_curve(&mut self, entity: &Entity, def: &EntityDef) -> Option<Vec<DVec3>> {
        let degree = attribute(entity, def, "Degree").and_then(number)? as usize;
        let points: Vec<DVec3> = list(attribute(entity, def, "ControlPointsList"))
            .iter()
            .map(|point| self.point(reference(point)?))
            .collect::<Option<_>>()?;
        let knots = knot_vector(entity, def, "Knots", "KnotMultiplicities", degree, points.len())?;
        let weights = numbers(attribute(entity, def, "WeightsData"));
        let weights = if weights.is_empty() { vec![1.0; points.len()] } else { weights };
        if weights.len() != points.len() {
            return None;
        }
        nurbs::Curve { degree, points, weights, knots }.sample()
    }

    fn bspline_surface(&mut self, entity: &Entity, def: &EntityDef) -> Option<nurbs::Surface> {
        let u_degree = attribute(entity, def, "UDegree").and_then(number)? as usize;
        let v_degree = attribute(entity, def, "VDegree").and_then(number)? as usize;
        let points: Vec<Vec<DVec3>> = list(attribute(entity, def, "ControlPointsList"))
            .iter()
            .map(|row| {
                list(Some(row))
                    .iter()
                    .map(|point| self.point(reference(point)?))
                    .collect::<Option<Vec<_>>>()
            })
            .collect::<Option<_>>()?;
        let (rows, columns) = (points.len(), points.first()?.len());
        if points.iter().any(|row| row.len() != columns) {
            return None;
        }
        let u_knots = knot_vector(entity, def, "UKnots", "UMultiplicities", u_degree, rows)?;
        let v_knots = knot_vector(entity, def, "VKnots", "VMultiplicities", v_degree, columns)?;
        let weights: Vec<Vec<f64>> = list(attribute(entity, def, "WeightsData"))
            .iter()
            .map(|row| numbers(Some(row)))
            .collect();
        let weights = if weights.is_empty() { vec![vec![1.0; columns]; rows] } else { weights };
        if weights.len() != rows || weights.iter().any(|row| row.len() != columns) {
            return None;
        }
        Some(nurbs::Surface { u_degree, v_degree, points, weights, u_knots, v_knots })
    }

    fn vertex_point(&self, id: u32) -> Option<DVec3> {
        let (vertex, def) = self.lookup(id)?;
        self.point(attribute(&vertex, &def, "VertexGeometry").and_then(reference)?)
    }

    /// An edge from its start vertex to its end vertex. The vertices are authoritative, so
    /// faces sharing an edge share its end points exactly.
    fn edge_points(&mut self, edge: &Entity, def: &EntityDef) -> Option<Vec<DVec3>> {
        let start = self.vertex_point(attribute(edge, def, "EdgeStart").and_then(reference)?)?;
        let end = self.vertex_point(attribute(edge, def, "EdgeEnd").and_then(reference)?)?;
        let geometry = attribute(edge, def, "EdgeGeometry").and_then(reference)?;
        let same_sense = flag(attribute(edge, def, "SameSense")).unwrap_or(true);
        let (curve, curve_def) = self.lookup(geometry)?;

        let mut points = if curve_def.is_a("IfcLine") {
            vec![start, end]
        } else if curve_def.is_a("IfcCircle") || curve_def.is_a("IfcEllipse") {
            let (frame, radii) = self.conic(&curve, &curve_def)?;
            let inverse = frame.inverse();
            let angle = |point: DVec3| {
                let local = inverse.transform_point3(point);
                (local.y / radii.y).atan2(local.x / radii.x)
            };
            let tau = std::f64::consts::TAU;
            let turn = |amount: f64| match amount.rem_euclid(tau) {
                amount if amount < 1e-9 => tau,
                amount => amount,
            };
            let sweep = if same_sense { turn(angle(end) - angle(start)) } else { -turn(angle(start) - angle(end)) };
            on_conic(frame, radii, angle(start), sweep)
        } else {
            let mut points = self.curve_path(geometry, 0)?;
            if !same_sense {
                points.reverse();
            }
            between_vertices(points, start, end)
        };
        *points.first_mut()? = start;
        *points.last_mut()? = end;
        Some(points)
    }

    fn edge_loop(&mut self, entity: &Entity, def: &EntityDef) -> Option<Vec<DVec3>> {
        let mut edges = Vec::new();
        for oriented in list(attribute(entity, def, "EdgeList")).iter().filter_map(reference) {
            let (oriented, oriented_def) = self.lookup(oriented)?;
            let element = attribute(&oriented, &oriented_def, "EdgeElement").and_then(reference)?;
            let (edge, edge_def) = self.lookup(element)?;
            let mut points = self.edge_points(&edge, &edge_def)?;
            if flag(attribute(&oriented, &oriented_def, "Orientation")) == Some(false) {
                points.reverse();
            }
            edges.push(points);
        }
        chain_edges(&mut edges);

        let mut path = Vec::new();
        for points in edges {
            join(&mut path, points);
        }
        // The loop closes on its first vertex, which should not appear twice.
        if path.len() > 1 && path[0].distance_squared(path[path.len() - 1]) <= POINT_TOLERANCE * POINT_TOLERANCE {
            path.pop();
        }
        (path.len() >= 3).then_some(path)
    }

    /// The profile curve of a swept surface, in the XY plane.
    fn swept_curve(&mut self, entity: &Entity, def: &EntityDef) -> Option<Vec<DVec3>> {
        let profile = attribute(entity, def, "SweptCurve").and_then(reference)?;
        let (profile, profile_def) = self.lookup(profile)?;
        let curve = attribute(&profile, &profile_def, "Curve")
            .or_else(|| attribute(&profile, &profile_def, "OuterCurve"))
            .and_then(reference)?;
        self.curve_path(curve, 0)
    }

    /// An analytic surface as an exact B-spline, built for one face: it covers the angles the
    /// face's loops reach, so its seam stays out of the face, and the extent they reach on
    /// directions the surface leaves unbounded.
    fn analytic_surface(
        &mut self,
        entity: &Entity,
        def: &EntityDef,
        loops: &[Vec<DVec3>],
    ) -> Option<nurbs::Surface> {
        use std::f64::consts::{FRAC_PI_2, PI};
        let scale = self.units.length;
        let size = |name: &str| attribute(entity, def, name).and_then(number).map(|size| size * scale);
        let position = attribute(entity, def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        let around_z = |points: &[DVec3]| {
            nurbs::covered_arc(points.iter().filter(|point| point.truncate().length() > 1e-9).map(|point| point.y.atan2(point.x)))
        };
        let localized = |frame: DMat4| -> Vec<DVec3> {
            let inverse = frame.inverse();
            loops.iter().flatten().map(|point| inverse.transform_point3(*point)).collect()
        };
        let spread = |values: &[f64]| {
            values.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), value| {
                (low.min(*value), high.max(*value))
            })
        };

        if def.is_a("IfcCylindricalSurface") {
            let radius = size("Radius").filter(|radius| *radius > 0.0)?;
            let local = localized(position);
            let heights: Vec<f64> = local.iter().map(|point| point.z).collect();
            let (low, high) = spread(&heights);
            // A curve at one height still needs a surface with some height, to have a normal.
            let (low, high) = if high - low < 1e-6 { (low - 1.0, high + 1.0) } else { (low, high) };
            let edge = nurbs::Curve::polyline(vec![DVec3::new(radius, 0.0, low), DVec3::new(radius, 0.0, high)])?;
            let (start, sweep) = around_z(&local);
            Some(nurbs::Surface::revolved(&edge, start, sweep).transformed(position))
        } else if def.is_a("IfcSphericalSurface") {
            let radius = size("Radius").filter(|radius| *radius > 0.0)?;
            let meridian = nurbs::Curve::arc_in_xz(0.0, radius, -FRAC_PI_2, PI);
            let (start, sweep) = around_z(&localized(position));
            Some(nurbs::Surface::revolved(&meridian, start, sweep).transformed(position))
        } else if def.is_a("IfcToroidalSurface") {
            let major = size("MajorRadius").filter(|radius| *radius > 0.0)?;
            let minor = size("MinorRadius").filter(|radius| *radius > 0.0)?;
            let local = localized(position);
            let tube = |point: &DVec3| point.z.atan2(point.truncate().length() - major);
            let (tube_start, tube_sweep) = nurbs::covered_arc(local.iter().map(tube));
            let section = nurbs::Curve::arc_in_xz(major, minor, tube_start, tube_sweep);
            let (start, sweep) = around_z(&local);
            Some(nurbs::Surface::revolved(&section, start, sweep).transformed(position))
        } else if def.is_a("IfcSurfaceOfRevolution") {
            let curve = self.swept_curve(entity, def)?;
            let axis = attribute(entity, def, "AxisPosition").and_then(reference)?;
            let (axis, axis_def) = self.lookup(axis)?;
            let origin = attribute(&axis, &axis_def, "Location")
                .and_then(reference)
                .and_then(|id| self.point(id))?;
            let z = attribute(&axis, &axis_def, "Axis")
                .and_then(reference)
                .and_then(|id| self.direction(id))
                .unwrap_or(DVec3::Z)
                .try_normalize()?;
            let (x, y) = solids::perpendiculars(z);
            let axis_frame = DMat4::from_cols(x.extend(0.0), y.extend(0.0), z.extend(0.0), origin.extend(1.0));
            let frame = position * axis_frame;
            let to_axis = axis_frame.inverse();
            let curve = curve.iter().map(|point| to_axis.transform_point3(*point)).collect();
            let (start, sweep) = around_z(&localized(frame));
            let revolved = nurbs::Surface::revolved(&nurbs::Curve::polyline(curve)?, start, sweep);
            Some(revolved.transformed(frame))
        } else {
            let direction = attribute(entity, def, "ExtrudedDirection")
                .and_then(reference)
                .and_then(|id| self.direction(id))?
                .try_normalize()?;
            let depth = size("Depth")?;
            let curve = nurbs::Curve::polyline(self.swept_curve(entity, def)?)?;
            // The profile lies in the XY plane, so height tells how far along a point has gone.
            let climb = direction.z;
            let travel = |point: &DVec3| if climb.abs() > 1e-9 { point.z / climb } else { point.dot(direction) };
            let reached: Vec<f64> = localized(position).iter().map(travel).collect();
            let (low, high) = spread(&reached);
            let (low, high) = (low.min(0.0), high.max(depth));
            Some(nurbs::Surface::extruded(&curve, direction * low, direction * high).transformed(position))
        }
    }

    /// A face on a curved surface, meshed in that surface's parameter space.
    fn curved_face(
        &mut self,
        surface: &nurbs::Surface,
        loops: &[Vec<DVec3>],
        same_sense: bool,
        builder: &mut FaceBuilder,
    ) {
        let Some(mesh) = nurbs::mesh_surface(surface, loops, same_sense) else {
            self.warn("bad-trim", "face boundary does not lie on its surface".into());
            return;
        };
        for triangle in mesh.triangles {
            let [a, b, c] = triangle.map(|id| builder.vertex(mesh.positions[id as usize]));
            builder.mesh.triangles.push(if same_sense { [a, b, c] } else { [a, c, b] });
        }
    }

    fn indexed_curve(&mut self, entity: &Entity, def: &EntityDef) -> Option<Vec<DVec3>> {
        let points = attribute(entity, def, "Points").and_then(reference)?;
        let (points, points_def) = self.lookup(points)?;
        let scale = self.units.length;
        let coordinates: Vec<DVec3> = list(attribute(&points, &points_def, "CoordList"))
            .iter()
            .map(|point| {
                let point = list(Some(point));
                let value = |index: usize| point.get(index).and_then(number);
                Some(DVec3::new(value(0)?, value(1)?, value(2).unwrap_or(0.0)) * scale)
            })
            .collect::<Option<_>>()?;

        let segments = list(attribute(entity, def, "Segments"));
        if segments.is_empty() {
            return Some(coordinates);
        }
        let mut path = Vec::new();
        for segment in segments {
            let Value::Typed { name, value } = segment else { return None };
            let corners: Vec<DVec3> = list(Some(value))
                .iter()
                .map(|index| coordinates.get((number(index)? as usize).checked_sub(1)?).copied())
                .collect::<Option<_>>()?;
            match (name.as_str(), corners.as_slice()) {
                ("IFCARCINDEX", [a, b, c]) => join(&mut path, solids::arc_through(*a, *b, *c)),
                _ => join(&mut path, corners),
            }
        }
        Some(path)
    }

    /// The placement of a circle or ellipse, and its semi-axes.
    fn conic(&mut self, entity: &Entity, def: &EntityDef) -> Option<(DMat4, DVec2)> {
        let frame = attribute(entity, def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        let scale = self.units.length;
        let size = |name: &str| Some(attribute(entity, def, name).and_then(number)? * scale);
        let radii = if def.is_a("IfcEllipse") {
            DVec2::new(size("SemiAxis1")?, size("SemiAxis2")?)
        } else {
            DVec2::splat(size("Radius")?)
        };
        Some((frame, radii))
    }

    fn trimmed_curve(&mut self, entity: &Entity, def: &EntityDef) -> Option<Vec<DVec3>> {
        let basis = attribute(entity, def, "BasisCurve").and_then(reference)?;
        let (basis, basis_def) = self.lookup(basis)?;
        let forward = flag(attribute(entity, def, "SenseAgreement")).unwrap_or(true);
        let by_parameter = !matches!(
            attribute(entity, def, "MasterRepresentation"),
            Some(Value::Enum(master)) if master == "CARTESIAN"
        );
        let trim1 = list(attribute(entity, def, "Trim1"));
        let trim2 = list(attribute(entity, def, "Trim2"));
        let parameter = |trim: &[Value]| {
            trim.iter().find_map(|value| match value {
                Value::Typed { name, value } if name == "IFCPARAMETERVALUE" => number(value),
                _ => None,
            })
        };
        let cartesian = |evaluator: &Self, trim: &[Value]| {
            trim.iter().filter_map(reference).find_map(|point| evaluator.point(point))
        };

        if basis_def.is_a("IfcLine") {
            let start = attribute(&basis, &basis_def, "Pnt").and_then(reference).and_then(|id| self.point(id))?;
            let vector = attribute(&basis, &basis_def, "Dir").and_then(reference)?;
            let (vector, vector_def) = self.lookup(vector)?;
            let orientation = attribute(&vector, &vector_def, "Orientation")
                .and_then(reference)
                .and_then(|id| self.direction(id))?
                .try_normalize()?;
            let magnitude = attribute(&vector, &vector_def, "Magnitude").and_then(number)?;
            let step = orientation * magnitude * self.units.length;
            let end = |evaluator: &Self, trim: &[Value]| {
                let from_parameter = parameter(trim).map(|value| start + step * value);
                let from_point = cartesian(evaluator, trim);
                if by_parameter { from_parameter.or(from_point) } else { from_point.or(from_parameter) }
            };
            return Some(vec![end(self, trim1)?, end(self, trim2)?]);
        }

        if !basis_def.is_a("IfcCircle") && !basis_def.is_a("IfcEllipse") {
            self.warn("unsupported-curve", format!("trimmed {}", basis_def.name()));
            return None;
        }
        let (frame, radii) = self.conic(&basis, &basis_def)?;
        let inverse = frame.inverse();
        let angle_scale = self.units.plane_angle;
        let angle = |evaluator: &Self, trim: &[Value]| {
            let from_parameter = parameter(trim).map(|value| value * angle_scale);
            let from_point = cartesian(evaluator, trim).map(|point| {
                let local = inverse.transform_point3(point);
                (local.y / radii.y).atan2(local.x / radii.x)
            });
            if by_parameter { from_parameter.or(from_point) } else { from_point.or(from_parameter) }
        };
        let (start, end) = (angle(self, trim1)?, angle(self, trim2)?);
        let tau = std::f64::consts::TAU;
        let turn = |amount: f64| match amount.rem_euclid(tau) {
            0.0 => tau,
            amount => amount,
        };
        let sweep = if forward { turn(end - start) } else { -turn(start - end) };
        Some(on_conic(frame, radii, start, sweep))
    }

    fn profile(&mut self, id: u32) -> Option<Profile> {
        let (entity, def) = self.lookup(id)?;
        let scale = self.units.length;
        let curve = |name: &str| attribute(&entity, &def, name).and_then(reference);

        let (outer, holes) = if def.is_a("IfcArbitraryClosedProfileDef") {
            let outer = self.curve_points(curve("OuterCurve")?)?;
            let mut holes = Vec::new();
            if def.is_a("IfcArbitraryProfileDefWithVoids") {
                for inner in list(attribute(&entity, &def, "InnerCurves")) {
                    let hole = self.curve_points(reference(inner)?)?;
                    holes.push(hole);
                }
            }
            (outer, holes)
        } else if def.name() == "IfcEllipseProfileDef" {
            let size = |name: &str| Some(attribute(&entity, &def, name).and_then(number)? * scale);
            let radii = DVec2::new(size("SemiAxis1")?, size("SemiAxis2")?);
            let ring = solids::arc(DVec2::ZERO, radii, 0.0, std::f64::consts::TAU);
            (self.placed_profile(&entity, &def, ring), Vec::new())
        } else if def.name() == "IfcCircleProfileDef" || def.is_a("IfcCircleHollowProfileDef") {
            let radius = attribute(&entity, &def, "Radius").and_then(number)? * scale;
            let circle = |radius: f64| solids::arc(DVec2::ZERO, DVec2::splat(radius), 0.0, std::f64::consts::TAU);
            let wall = attribute(&entity, &def, "WallThickness").and_then(number).map(|wall| wall * scale);
            let holes = match wall.filter(|wall| *wall > 0.0 && *wall < radius) {
                Some(wall) => vec![self.placed_profile(&entity, &def, circle(radius - wall))],
                None => Vec::new(),
            };
            (self.placed_profile(&entity, &def, circle(radius)), holes)
        } else if def.is_a("IfcRectangleProfileDef") {
            let size = |name: &str| attribute(&entity, &def, name).and_then(number).map(|value| value * scale);
            let (x, y) = (size("XDim")? / 2.0, size("YDim")? / 2.0);
            let box_of = |x: f64, y: f64, radius: f64| {
                solids::rounded(&[(-x, -y, radius), (x, -y, radius), (x, y, radius), (-x, y, radius)])
            };
            let radius = size("RoundingRadius").or_else(|| size("OuterFilletRadius")).unwrap_or(0.0);
            let wall = size("WallThickness").filter(|wall| *wall > 0.0 && *wall < x.min(y));
            let holes = match wall {
                Some(wall) => {
                    let inner = box_of(x - wall, y - wall, size("InnerFilletRadius").unwrap_or(0.0));
                    vec![self.placed_profile(&entity, &def, inner)]
                }
                None => Vec::new(),
            };
            (self.placed_profile(&entity, &def, box_of(x, y, radius)), holes)
        } else if let Some(corners) = self.section(&entity, &def) {
            let ring = solids::rounded(&corners);
            (self.placed_profile(&entity, &def, ring), Vec::new())
        } else {
            self.warn("unsupported-profile", format!("#{id} {}", def.name()));
            return None;
        };

        let outer = clean_ring(outer);
        let given = holes.len();
        let holes: Vec<Vec<DVec2>> = holes
            .into_iter()
            .map(clean_ring)
            .filter(|hole| hole.len() >= 3)
            .collect();
        if holes.len() != given {
            self.warn("bad-profile-hole", format!("#{id} has a hole too small to keep"));
        }
        (outer.len() >= 3).then_some(Profile { outer, holes })
    }

    /// The outline of a steel section, in its own centred coordinates.
    fn section(&mut self, entity: &Entity, def: &EntityDef) -> Option<Vec<solids::Corner>> {
        let scale = self.units.length;
        let size = |name: &str| Some(attribute(entity, def, name).and_then(number)? * scale);
        let radius = |name: &str| size(name).unwrap_or(0.0);
        let sloped = ["FlangeSlope", "WebSlope", "LegSlope"]
            .iter()
            .any(|name| attribute(entity, def, name).and_then(number).is_some_and(|slope| slope != 0.0));

        let corners = match def.name() {
            "IfcIShapeProfileDef" => solids::i_section(
                size("OverallWidth")?,
                size("OverallDepth")?,
                size("WebThickness")?,
                size("FlangeThickness")?,
                radius("FilletRadius"),
                radius("FlangeEdgeRadius"),
            ),
            "IfcLShapeProfileDef" => {
                let depth = size("Depth")?;
                solids::l_section(
                    depth,
                    size("Width").unwrap_or(depth),
                    size("Thickness")?,
                    radius("FilletRadius"),
                    radius("EdgeRadius"),
                )
            }
            "IfcTShapeProfileDef" => solids::t_section(
                size("Depth")?,
                size("FlangeWidth")?,
                size("WebThickness")?,
                size("FlangeThickness")?,
                [radius("FilletRadius"), radius("FlangeEdgeRadius"), radius("WebEdgeRadius")],
            ),
            "IfcUShapeProfileDef" => solids::u_section(
                size("Depth")?,
                size("FlangeWidth")?,
                size("WebThickness")?,
                size("FlangeThickness")?,
                radius("FilletRadius"),
                radius("EdgeRadius"),
            ),
            "IfcCShapeProfileDef" => solids::c_section(
                size("Depth")?,
                size("Width")?,
                size("WallThickness")?,
                size("Girth")?,
                radius("InternalFilletRadius"),
            ),
            "IfcZShapeProfileDef" => solids::z_section(
                size("Depth")?,
                size("FlangeWidth")?,
                size("WebThickness")?,
                size("FlangeThickness")?,
                radius("FilletRadius"),
                radius("EdgeRadius"),
            ),
            _ => return None,
        };
        if sloped {
            self.warn("profile-slope-ignored", format!("{} drawn with parallel faces", def.name()));
        }
        Some(corners)
    }

    /// Every closed area of a profile. Composite profiles have several.
    fn profiles(&mut self, id: u32, depth: usize) -> Option<Vec<Profile>> {
        self.items_used += 1;
        if depth >= MAX_DEPTH || self.items_used > MAX_ITEMS_PER_ELEMENT {
            self.warn("nesting-too-deep", format!("#{id} is nested too deeply"));
            return None;
        }
        let (entity, def) = self.lookup(id)?;
        if def.is_a("IfcCompositeProfileDef") {
            let mut all = Vec::new();
            for part in list(attribute(&entity, &def, "Profiles")).iter().filter_map(reference) {
                all.extend(self.profiles(part, depth + 1)?);
            }
            return Some(all);
        }
        if def.is_a("IfcDerivedProfileDef") {
            let parent = attribute(&entity, &def, "ParentProfile").and_then(reference)?;
            let parents = self.profiles(parent, depth + 1)?;
            // A mirrored profile flips across the Y axis, whatever its derived operator says.
            let matrix = if def.is_a("IfcMirroredProfileDef") {
                DMat4::from_scale(DVec3::new(-1.0, 1.0, 1.0))
            } else {
                attribute(&entity, &def, "Operator")
                    .and_then(reference)
                    .map_or(DMat4::IDENTITY, |id| self.transformation_operator(id))
            };
            let apply = |ring: Vec<DVec2>| -> Vec<DVec2> {
                ring.into_iter()
                    .map(|point| matrix.transform_point3(point.extend(0.0)).truncate())
                    .collect()
            };
            return Some(
                parents
                    .into_iter()
                    .map(|Profile { outer, holes }| Profile {
                        outer: apply(outer),
                        holes: holes.into_iter().map(apply).collect(),
                    })
                    .collect(),
            );
        }
        self.profile(id).map(|profile| vec![profile])
    }

    fn placed_profile(&mut self, entity: &Entity, def: &EntityDef, ring: Vec<DVec2>) -> Vec<DVec2> {
        let Some(position) = attribute(entity, def, "Position").and_then(reference) else {
            return ring;
        };
        let matrix = self.placement_matrix(position);
        ring.into_iter()
            .map(|point| matrix.transform_point3(point.extend(0.0)).truncate())
            .collect()
    }

    /// What an extrusion moves its section by, and where it stands.
    fn extrusion_path(&mut self, entity: &Entity, def: &EntityDef) -> Option<(DVec3, DMat4)> {
        let depth = attribute(entity, def, "Depth").and_then(number)? * self.units.length;
        let direction = attribute(entity, def, "ExtrudedDirection")
            .and_then(reference)
            .and_then(|id| self.direction(id))?
            .try_normalize()?;
        let position = attribute(entity, def, "Position")
            .and_then(reference)
            .map_or(DMat4::IDENTITY, |id| self.placement_matrix(id));
        Some((direction * depth, position))
    }

    fn extrusion(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let profile = attribute(entity, def, "SweptArea").and_then(reference)?;
        let profiles = self.profiles(profile, 0)?;
        let (offset, position) = self.extrusion_path(entity, def)?;
        let parts = profiles.into_iter().map(|profile| prism(profile, offset));
        Some(transformed(merged(parts), position))
    }

    /// Faces from closed shells, open shells or connected face sets.
    fn shell(&mut self, shells: &[u32]) -> Option<Mesh> {
        let mut builder = FaceBuilder::default();
        let mut starts = Vec::new();
        for shell in shells {
            let (entity, def) = self.lookup(*shell)?;
            starts.push(builder.mesh.triangles.len());
            for face in list(attribute(&entity, &def, "CfsFaces")) {
                if let Some(face) = reference(face) {
                    self.face(face, &mut builder);
                }
            }
        }
        builder.mesh.orient_shells(&starts);
        (!builder.mesh.is_empty()).then_some(builder.mesh)
    }

    fn face(&mut self, id: u32, builder: &mut FaceBuilder) {
        let Some(found) = self.file.get(id) else { return };
        // Most faces of a faceted solid are plain `IfcFace`s, read without building entities,
        // and have no surface. Anything else takes the full path, which agrees for those.
        let mut bounds = Vec::new();
        let full = if Some(found.type_index) == self.plain.face
            && self.file.decode_references(found, &mut bounds)
        {
            None
        } else {
            let Some((entity, def)) = self.lookup(id) else { return };
            bounds = list(attribute(&entity, &def, "Bounds")).iter().filter_map(reference).collect();
            Some((entity, def))
        };
        let mut outer: Option<Vec<DVec3>> = None;
        let mut holes: Vec<Vec<DVec3>> = Vec::new();
        for bound in bounds {
            let Some((poly, forward, is_outer)) = self.face_bound(bound) else { continue };
            let Some(mut ring) = self.face_ring(id, poly, builder) else { continue };
            if !forward {
                ring.reverse();
            }
            if is_outer && outer.is_none() {
                outer = Some(ring);
            } else {
                holes.push(ring);
            }
        }
        if outer.is_none() && !holes.is_empty() {
            outer = Some(holes.remove(0));
        }
        let Some(outer) = outer else { return };
        if outer.len() < 3 {
            self.warn("bad-face", format!("#{id} has fewer than three corners"));
            return;
        }

        let Some((entity, def)) = &full else {
            builder.flat_face(outer, holes, true);
            return;
        };
        let same_sense = flag(attribute(entity, def, "SameSense")).unwrap_or(true);
        let surface = attribute(entity, def, "FaceSurface")
            .and_then(reference)
            .and_then(|id| self.lookup(id));
        if let Some((surface, surface_def)) = &surface {
            let spline = surface_def.is_a("IfcBSplineSurfaceWithKnots");
            let analytic = ANALYTIC_SURFACES.iter().any(|name| surface_def.is_a(name));
            if spline || analytic {
                let mut loops = vec![outer.clone()];
                loops.extend(holes.iter().cloned());
                let curved = if spline {
                    self.bspline_surface(surface, surface_def)
                } else {
                    self.analytic_surface(surface, surface_def, &loops)
                };
                if let Some(curved) = curved {
                    self.curved_face(&curved, &loops, same_sense, builder);
                    return;
                }
                self.warn("bad-surface", format!("#{id} has an unusable surface"));
            } else if !surface_def.is_a("IfcPlane") {
                self.warn("unsupported-surface", format!("#{id} {}", surface_def.name()));
            }
        }

        // Planar, or the nearest we can do: a flat face across the boundary.
        builder.flat_face(outer, holes, same_sense);
    }

    /// The loop of a face bound, whether it keeps its direction, and whether it is the
    /// outer bound.
    fn face_bound(&self, id: u32) -> Option<(u32, bool, bool)> {
        let found = self.file.get(id)?;
        let is_outer = Some(found.type_index) == self.plain.outer_bound;
        if (is_outer || Some(found.type_index) == self.plain.bound)
            && let Some((poly, forward)) = self.file.decode_reference_and_boolean(found)
        {
            return Some((poly, forward, is_outer));
        }
        let (bound, def) = self.lookup(id)?;
        let poly = attribute(&bound, &def, "Bound").and_then(reference)?;
        let forward = flag(attribute(&bound, &def, "Orientation")) != Some(false);
        Some((poly, forward, def.is_a("IfcFaceOuterBound")))
    }

    /// The corners of a face's loop, `None` if it has none we can read.
    fn face_ring(&mut self, face: u32, poly: u32, builder: &mut FaceBuilder) -> Option<Vec<DVec3>> {
        let found = self.file.get(poly)?;
        let mut corners = Vec::new();
        let expected = if Some(found.type_index) == self.plain.poly_loop
            && self.file.decode_references(found, &mut corners)
        {
            corners.len()
        } else {
            let (poly, def) = self.lookup(poly)?;
            if def.is_a("IfcPolyLoop") {
                let values = list(attribute(&poly, &def, "Polygon"));
                corners = values.iter().filter_map(reference).collect();
                values.len()
            } else if def.is_a("IfcEdgeLoop") {
                return self.edge_loop(&poly, &def);
            } else {
                self.warn("unsupported-face-bound", def.name().to_string());
                return None;
            }
        };
        let points: Vec<DVec3> = corners
            .into_iter()
            .filter_map(|point| builder.point(point, |id| self.point(id)))
            .collect();
        if points.len() != expected {
            self.warn("bad-face", format!("#{face} has a corner that cannot be read"));
        }
        Some(points)
    }

    fn coordinate_list(&self, entity: &Entity, def: &EntityDef) -> Option<Vec<DVec3>> {
        let id = attribute(entity, def, "Coordinates").and_then(reference)?;
        let (points, points_def) = self.lookup(id)?;
        list(attribute(&points, &points_def, "CoordList"))
            .iter()
            .map(|triple| {
                let triple = list(Some(triple));
                let value = |index: usize| triple.get(index).and_then(number);
                Some(DVec3::new(value(0)?, value(1)?, value(2)?) * self.units.length)
            })
            .collect()
    }

    fn triangulated_face_set(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let positions = self.coordinate_list(entity, def)?;
        let lookup = pn_index(entity, def);
        let triangles: Vec<[u32; 3]> = list(attribute(entity, def, "CoordIndex"))
            .iter()
            .filter_map(|triangle| {
                let triangle = list(Some(triangle));
                let corner = |index: usize| {
                    resolve_index(number(triangle.get(index)?)?, &lookup, positions.len())
                };
                Some([corner(0)?, corner(1)?, corner(2)?])
            })
            .collect();
        let mut mesh = Mesh { positions, triangles };
        mesh.orient_shell();
        (!mesh.is_empty()).then_some(mesh)
    }

    fn polygonal_face_set(&mut self, entity: &Entity, def: &EntityDef) -> Option<Mesh> {
        let positions = self.coordinate_list(entity, def)?;
        let lookup = pn_index(entity, def);
        let ring = |values: &[Value]| -> Vec<u32> {
            values
                .iter()
                .filter_map(|value| resolve_index(number(value)?, &lookup, positions.len()))
                .collect()
        };

        let mut builder = FaceBuilder {
            mesh: Mesh {
                positions: positions.clone(),
                triangles: Vec::new(),
            },
            ..FaceBuilder::default()
        };
        for face in list(attribute(entity, def, "Faces")).iter().filter_map(reference) {
            let Some((face, face_def)) = self.lookup(face) else { continue };
            let outer = ring(list(attribute(&face, &face_def, "CoordIndex")));
            let holes: Vec<Vec<u32>> = list(attribute(&face, &face_def, "InnerCoordIndices"))
                .iter()
                .map(|hole| ring(list(Some(hole))))
                .collect();
            builder.face(&outer, &holes);
        }
        builder.mesh.orient_shell();
        (!builder.mesh.is_empty()).then_some(builder.mesh)
    }
}

fn attribute<'e>(entity: &'e Entity, def: &EntityDef, name: &str) -> Option<&'e Value> {
    entity
        .params
        .get(def.attribute_index(name)?)
        .filter(|value| !matches!(value, Value::Null | Value::Derived))
}

fn pn_index(entity: &Entity, def: &EntityDef) -> Vec<u32> {
    list(attribute(entity, def, "PnIndex"))
        .iter()
        .filter_map(|value| Some(number(value)? as u32))
        .collect()
}

/// Converts a one-based index, through `PnIndex` if present, to a checked position.
fn resolve_index(value: f64, lookup: &[u32], count: usize) -> Option<u32> {
    let one_based = value as u32;
    let index = if lookup.is_empty() {
        one_based
    } else {
        *lookup.get(one_based.checked_sub(1)? as usize)?
    };
    let index = index.checked_sub(1)?;
    ((index as usize) < count).then_some(index)
}

/// Assembles planar faces, sharing coincident vertices.
#[derive(Default)]
struct FaceBuilder {
    mesh: Mesh,
    ids: KeyedMap<(u64, u64, u64), u32>,
    /// Faces share their corners, so each is decoded from the file once per shell.
    points: KeyedMap<u32, DVec3>,
    /// Corner ids of the face at hand, and of all its rings in turn, kept to save allocations
    /// per face.
    corners: Vec<u32>,
    ring_corners: Vec<u32>,
}

impl FaceBuilder {
    fn point(&mut self, id: u32, decode: impl FnOnce(u32) -> Option<DVec3>) -> Option<DVec3> {
        if let Some(point) = self.points.get(&id) {
            return Some(*point);
        }
        let point = decode(id)?;
        self.points.insert(id, point);
        Some(point)
    }

    fn vertex(&mut self, position: DVec3) -> u32 {
        let key = (position.x.to_bits(), position.y.to_bits(), position.z.to_bits());
        *self.ids.entry(key).or_insert_with(|| {
            self.mesh.positions.push(position);
            (self.mesh.positions.len() - 1) as u32
        })
    }

    /// A face across its corners, sharing them with the faces before it.
    fn flat_face(&mut self, outer: Vec<DVec3>, holes: Vec<Vec<DVec3>>, same_sense: bool) {
        // Most faces have no hole: their corners go in the kept list.
        if holes.is_empty() {
            let mut corners = std::mem::take(&mut self.corners);
            corners.clear();
            corners.extend(outer.into_iter().map(|point| self.vertex(point)));
            if !same_sense {
                corners.reverse();
            }
            self.face(&corners, &[]);
            self.corners = corners;
            return;
        }
        let mut rings = std::iter::once(outer).chain(holes).map(|ring| {
            let mut ids: Vec<u32> = ring.into_iter().map(|point| self.vertex(point)).collect();
            if !same_sense {
                ids.reverse();
            }
            ids
        });
        let first = rings.next().unwrap_or_default();
        let others: Vec<Vec<u32>> = rings.collect();
        self.face(&first, &others);
    }

    fn face(&mut self, outer: &[u32], holes: &[Vec<u32>]) {
        if outer.len() < 3 {
            return;
        }
        let corner = |id: u32| self.mesh.positions[id as usize];
        // Most faces of a faceted solid are triangles, which need no triangulating.
        if let ([a, b, c], []) = (outer, holes) {
            if (corner(*b) - corner(*a)).cross(corner(*c) - corner(*a)) != DVec3::ZERO {
                self.mesh.triangles.push([*a, *b, *c]);
            }
            return;
        }
        // Newell's method, which tolerates collinear and slightly non-planar corners.
        let normal = outer.iter().enumerate().fold(DVec3::ZERO, |sum, (i, id)| {
            sum + corner(*id).cross(corner(outer[(i + 1) % outer.len()]))
        });
        let Some(normal) = normal.try_normalize() else {
            return;
        };
        let u = normal.any_orthonormal_vector();
        let v = normal.cross(u);
        let positions = &self.mesh.positions;
        let flatten = |id: &u32| {
            let corner = positions[*id as usize];
            [corner.dot(u), corner.dot(v)]
        };
        let holes = || holes.iter().filter(|hole| hole.len() >= 3);
        // The outer ring's corners and then each hole's, as the triangulation numbers them.
        let ids = &mut self.ring_corners;
        ids.clear();
        ids.extend_from_slice(outer);
        holes().for_each(|hole| ids.extend_from_slice(hole));
        let (ids, triangles) = (&*ids, &mut self.mesh.triangles);
        triangulate_with(
            |points, hole_starts| {
                points.extend(outer.iter().map(flatten));
                for hole in holes() {
                    hole_starts.push(points.len() as u32);
                    points.extend(hole.iter().map(flatten));
                }
            },
            |[a, b, c]| triangles.push([a, b, c].map(|at| ids[at as usize])),
        );
    }
}
