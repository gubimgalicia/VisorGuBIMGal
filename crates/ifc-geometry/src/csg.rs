//! Boolean operations on closed meshes through binary space partitioning.
//!
//! Each operand becomes a BSP tree of its face planes. Clipping one tree against the other
//! keeps the fragments of the requested result, using the classical Naylor-Thibault
//! construction. Cutting leaves T-junctions, where one fragment's vertex sits on the middle
//! of its neighbour's edge, so [`assemble`] welds vertices and splits those edges before
//! triangulating. The result is watertight whenever the inputs are.

use crate::mesh::Mesh;
use glam::DVec3;
use crate::hash::KeyedMap;
use std::fmt;

/// A vertex this close to a plane lies on it. Metres.
const PLANE_TOLERANCE: f64 = 1e-7;
/// Vertices closer than this are one vertex. Metres.
const WELD_TOLERANCE: f64 = 1e-6;
/// Bounds recursion, so a pathological mesh gives an error rather than a stack overflow.
const MAX_TREE_DEPTH: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CsgError {
    /// The partition tree exceeded [`MAX_TREE_DEPTH`].
    TooComplex,
}

impl fmt::Display for CsgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CsgError::TooComplex => write!(f, "mesh too complex for boolean evaluation"),
        }
    }
}

impl std::error::Error for CsgError {}

/// `a` with the volume of `b` removed.
pub fn subtract(a: &Mesh, b: &Mesh) -> Result<Mesh, CsgError> {
    subtract_all(a, std::slice::from_ref(b))
}

/// `a` with the volume of every cut removed. Prefer this to repeated [`subtract`] calls.
///
/// Triangulating between cuts leaves long slivers that the next cut splits again, so
/// repeated calls grow quadratically. A single pass keeps faces as convex fragments and
/// stays linear. Cuts whose boxes overlap cannot share a pass, because each must also
/// remove the other's faces, so they run in successive passes.
pub fn subtract_all(a: &Mesh, cuts: &[Mesh]) -> Result<Mesh, CsgError> {
    let mut passes: Vec<(Vec<&Mesh>, Vec<Bounds>)> = Vec::new();
    for cut in cuts.iter().filter(|cut| !cut.is_empty()) {
        let reach = Bounds::of(cut.positions.iter().copied());
        match passes
            .iter_mut()
            .find(|(_, reaches)| !reaches.iter().any(|other| other.overlaps(&reach)))
        {
            Some((members, reaches)) => {
                members.push(cut);
                reaches.push(reach);
            }
            None => passes.push((vec![cut], vec![reach])),
        }
    }

    let mut result = a.clone();
    for (members, reaches) in &passes {
        // An empty tree clips nothing, so a further pass would keep the cut's walls.
        if result.is_empty() {
            break;
        }
        result = subtract_disjoint(&result, members, reaches)?;
    }
    Ok(result)
}

/// One pass of [`subtract_all`]. `a`'s tree only classifies: its faces are clipped directly,
/// and those clear of a cut's box stay whole.
fn subtract_disjoint(a: &Mesh, cuts: &[&Mesh], reaches: &[Bounds]) -> Result<Mesh, CsgError> {
    let mut a_tree = Node::from_mesh(a)?;
    a_tree.invert();

    let mut faces: Vec<Polygon> = polygons_of(a).into_iter().map(Polygon::flipped).collect();
    let mut cut_walls = Vec::new();
    for (cut, reach) in cuts.iter().zip(reaches) {
        let mut cut_tree = Node::from_mesh(cut)?;
        let (near, mut far): (Vec<_>, Vec<_>) = faces
            .into_iter()
            .partition(|face| reach.overlaps(&Bounds::of(face.vertices.iter().copied())));
        far.append(&mut cut_tree.clip_polygons(near));
        faces = far;

        cut_tree.clip_to(&a_tree);
        cut_tree.invert();
        cut_tree.clip_to(&a_tree);
        cut_tree.invert();
        cut_tree.collect(&mut cut_walls);
    }
    faces.append(&mut cut_walls);

    let result: Vec<Polygon> = faces.into_iter().map(Polygon::flipped).collect();
    Ok(assemble(&result))
}

/// The volume common to `a` and `b`.
pub fn intersect(a: &Mesh, b: &Mesh) -> Result<Mesh, CsgError> {
    if a.is_empty() || b.is_empty() {
        return Ok(Mesh::default());
    }
    let mut a_tree = Node::from_mesh(a)?;
    let mut b_tree = Node::from_mesh(b)?;
    a_tree.invert();
    b_tree.clip_to(&a_tree);
    b_tree.invert();
    a_tree.clip_to(&b_tree);
    b_tree.clip_to(&a_tree);
    let mut fragments = Vec::new();
    b_tree.collect(&mut fragments);
    a_tree.build(fragments, 0)?;
    a_tree.invert();
    Ok(a_tree.into_mesh())
}

/// The volume of `a` and `b` together.
pub fn union(a: &Mesh, b: &Mesh) -> Result<Mesh, CsgError> {
    if a.is_empty() {
        return Ok(b.clone());
    }
    if b.is_empty() {
        return Ok(a.clone());
    }
    let mut a_tree = Node::from_mesh(a)?;
    let mut b_tree = Node::from_mesh(b)?;
    a_tree.clip_to(&b_tree);
    b_tree.clip_to(&a_tree);
    b_tree.invert();
    b_tree.clip_to(&a_tree);
    b_tree.invert();
    let mut fragments = Vec::new();
    b_tree.collect(&mut fragments);
    a_tree.build(fragments, 0)?;
    Ok(a_tree.into_mesh())
}

/// `mesh` with vertices closer than [`WELD_TOLERANCE`] merged and every edge split at the
/// vertices on it, as [`assemble`] does to fragments. Exporters write closed shells whose
/// faces meet at a corner on a neighbour's edge, or at one corner written twice a rounding
/// apart; those then share their edges and close. Zero-area triangles are dropped.
pub fn seal(mesh: &Mesh) -> Mesh {
    assemble(&polygons_of(mesh))
}

fn polygons_of(mesh: &Mesh) -> Vec<Polygon> {
    mesh.triangle_corners()
        .filter_map(|[a, b, c]| {
            Some(Polygon {
                plane: Plane::from_points(a, b, c)?,
                vertices: vec![a, b, c],
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    min: DVec3,
    max: DVec3,
}

impl Bounds {
    fn of(points: impl Iterator<Item = DVec3>) -> Self {
        points.fold(
            Self {
                min: DVec3::INFINITY,
                max: DVec3::NEG_INFINITY,
            },
            |bounds, point| Self {
                min: bounds.min.min(point),
                max: bounds.max.max(point),
            },
        )
    }

    fn overlaps(&self, other: &Self) -> bool {
        (self.min - WELD_TOLERANCE).cmple(other.max).all()
            && (other.min - WELD_TOLERANCE).cmple(self.max).all()
    }
}

#[derive(Debug, Clone, Copy)]
struct Plane {
    normal: DVec3,
    offset: f64,
}

impl Plane {
    fn from_points(a: DVec3, b: DVec3, c: DVec3) -> Option<Self> {
        let normal = (b - a).cross(c - a).try_normalize()?;
        Some(Self {
            normal,
            offset: normal.dot(a),
        })
    }

    fn flipped(self) -> Self {
        Self {
            normal: -self.normal,
            offset: -self.offset,
        }
    }

    fn distance(self, point: DVec3) -> f64 {
        self.normal.dot(point) - self.offset
    }
}

/// A convex fragment. Its plane comes from the source face and never from fragment
/// vertices, so repeated splitting cannot make it drift.
#[derive(Debug, Clone)]
struct Polygon {
    vertices: Vec<DVec3>,
    plane: Plane,
}

impl Polygon {
    fn flipped(mut self) -> Self {
        self.vertices.reverse();
        self.plane = self.plane.flipped();
        self
    }
}

const COPLANAR: u8 = 0;
const FRONT: u8 = 1;
const BACK: u8 = 2;
const SPANNING: u8 = 3;

struct Split {
    coplanar_front: Vec<Polygon>,
    coplanar_back: Vec<Polygon>,
    front: Vec<Polygon>,
    back: Vec<Polygon>,
}

fn split_polygon(plane: Plane, polygon: Polygon, out: &mut Split) {
    let sides: Vec<(f64, u8)> = polygon
        .vertices
        .iter()
        .map(|vertex| {
            let distance = plane.distance(*vertex);
            let side = if distance > PLANE_TOLERANCE {
                FRONT
            } else if distance < -PLANE_TOLERANCE {
                BACK
            } else {
                COPLANAR
            };
            (distance, side)
        })
        .collect();

    match sides.iter().fold(COPLANAR, |all, (_, side)| all | side) {
        COPLANAR => {
            if plane.normal.dot(polygon.plane.normal) > 0.0 {
                out.coplanar_front.push(polygon);
            } else {
                out.coplanar_back.push(polygon);
            }
        }
        FRONT => out.front.push(polygon),
        BACK => out.back.push(polygon),
        SPANNING => {
            let mut front = Vec::with_capacity(polygon.vertices.len() + 1);
            let mut back = Vec::with_capacity(polygon.vertices.len() + 1);
            let count = polygon.vertices.len();
            for here in 0..count {
                let next = (here + 1) % count;
                let (from, to) = (polygon.vertices[here], polygon.vertices[next]);
                let (from_distance, from_side) = sides[here];
                let (to_distance, to_side) = sides[next];
                if from_side != BACK {
                    front.push(from);
                }
                if from_side != FRONT {
                    back.push(from);
                }
                if from_side | to_side == SPANNING {
                    let along = from_distance / (from_distance - to_distance);
                    let crossing = from + (to - from) * along;
                    front.push(crossing);
                    back.push(crossing);
                }
            }
            if front.len() >= 3 {
                out.front.push(Polygon {
                    vertices: front,
                    plane: polygon.plane,
                });
            }
            if back.len() >= 3 {
                out.back.push(Polygon {
                    vertices: back,
                    plane: polygon.plane,
                });
            }
        }
        _ => {}
    }
}

#[derive(Debug, Default)]
struct Node {
    plane: Option<Plane>,
    polygons: Vec<Polygon>,
    front: Option<Box<Node>>,
    back: Option<Box<Node>>,
}

impl Node {
    fn from_mesh(mesh: &Mesh) -> Result<Self, CsgError> {
        let mut node = Self::default();
        node.build(polygons_of(mesh), 0)?;
        Ok(node)
    }

    fn build(&mut self, polygons: Vec<Polygon>, depth: usize) -> Result<(), CsgError> {
        if polygons.is_empty() {
            return Ok(());
        }
        if depth >= MAX_TREE_DEPTH {
            return Err(CsgError::TooComplex);
        }
        let plane = *self.plane.get_or_insert(polygons[0].plane);
        let mut split = Split {
            coplanar_front: Vec::new(),
            coplanar_back: Vec::new(),
            front: Vec::new(),
            back: Vec::new(),
        };
        for polygon in polygons {
            split_polygon(plane, polygon, &mut split);
        }
        self.polygons.append(&mut split.coplanar_front);
        self.polygons.append(&mut split.coplanar_back);
        if !split.front.is_empty() {
            self.front
                .get_or_insert_default()
                .build(split.front, depth + 1)?;
        }
        if !split.back.is_empty() {
            self.back
                .get_or_insert_default()
                .build(split.back, depth + 1)?;
        }
        Ok(())
    }

    /// Swaps solid and empty space.
    fn invert(&mut self) {
        self.polygons = std::mem::take(&mut self.polygons)
            .into_iter()
            .map(Polygon::flipped)
            .collect();
        self.plane = self.plane.map(Plane::flipped);
        if let Some(front) = &mut self.front {
            front.invert();
        }
        if let Some(back) = &mut self.back {
            back.invert();
        }
        std::mem::swap(&mut self.front, &mut self.back);
    }

    /// Removes the parts of `polygons` inside this tree's solid.
    fn clip_polygons(&self, polygons: Vec<Polygon>) -> Vec<Polygon> {
        let Some(plane) = self.plane else {
            return polygons;
        };
        let mut split = Split {
            coplanar_front: Vec::new(),
            coplanar_back: Vec::new(),
            front: Vec::new(),
            back: Vec::new(),
        };
        for polygon in polygons {
            split_polygon(plane, polygon, &mut split);
        }
        split.front.append(&mut split.coplanar_front);
        split.back.append(&mut split.coplanar_back);
        let mut kept = match &self.front {
            Some(front) => front.clip_polygons(split.front),
            None => split.front,
        };
        if let Some(back) = &self.back {
            kept.append(&mut back.clip_polygons(split.back));
        }
        kept
    }

    fn clip_to(&mut self, other: &Node) {
        self.polygons = other.clip_polygons(std::mem::take(&mut self.polygons));
        if let Some(front) = &mut self.front {
            front.clip_to(other);
        }
        if let Some(back) = &mut self.back {
            back.clip_to(other);
        }
    }

    fn collect(&self, out: &mut Vec<Polygon>) {
        out.extend_from_slice(&self.polygons);
        if let Some(front) = &self.front {
            front.collect(out);
        }
        if let Some(back) = &self.back {
            back.collect(out);
        }
    }

    fn into_mesh(self) -> Mesh {
        let mut polygons = Vec::new();
        self.collect(&mut polygons);
        assemble(&polygons)
    }
}

/// Merges vertices closer than [`WELD_TOLERANCE`].
#[derive(Default)]
struct Welder {
    positions: Vec<DVec3>,
    cells: KeyedMap<(i64, i64, i64), Vec<u32>>,
}

impl Welder {
    fn cell(point: DVec3) -> (i64, i64, i64) {
        let scaled = (point / WELD_TOLERANCE).floor();
        (scaled.x as i64, scaled.y as i64, scaled.z as i64)
    }

    fn insert(&mut self, point: DVec3) -> u32 {
        let (x, y, z) = Self::cell(point);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(ids) = self.cells.get(&(x + dx, y + dy, z + dz)) else {
                        continue;
                    };
                    for id in ids {
                        if self.positions[*id as usize].distance_squared(point)
                            <= WELD_TOLERANCE * WELD_TOLERANCE
                        {
                            return *id;
                        }
                    }
                }
            }
        }
        let id = self.positions.len() as u32;
        self.positions.push(point);
        self.cells.entry((x, y, z)).or_default().push(id);
        id
    }
}

/// Vertex ids sorted along each axis, for finding the vertices that lie on an edge.
struct EdgeScanner<'a> {
    positions: &'a [DVec3],
    sorted: [Vec<u32>; 3],
}

impl<'a> EdgeScanner<'a> {
    fn new(positions: &'a [DVec3]) -> Self {
        let sorted = [0, 1, 2].map(|axis| {
            let mut ids: Vec<u32> = (0..positions.len() as u32).collect();
            ids.sort_by(|a, b| positions[*a as usize][axis].total_cmp(&positions[*b as usize][axis]));
            ids
        });
        Self { positions, sorted }
    }

    /// Ids strictly between `from` and `to` on that edge, ordered from `from`.
    fn between(&self, from: u32, to: u32) -> Vec<u32> {
        let (start, end) = (self.positions[from as usize], self.positions[to as usize]);
        let span = end - start;
        let length_squared = span.length_squared();
        if length_squared <= WELD_TOLERANCE * WELD_TOLERANCE {
            return Vec::new();
        }
        // The axis the edge spans least rules out the most vertices.
        let extent = span.abs();
        let axis = if extent.x <= extent.y && extent.x <= extent.z {
            0
        } else if extent.y <= extent.z {
            1
        } else {
            2
        };
        let low = start[axis].min(end[axis]) - WELD_TOLERANCE;
        let high = start[axis].max(end[axis]) + WELD_TOLERANCE;
        let sorted = &self.sorted[axis];
        let first = sorted.partition_point(|id| self.positions[*id as usize][axis] < low);

        let mut found: Vec<(f64, u32)> = Vec::new();
        for id in &sorted[first..] {
            let point = self.positions[*id as usize];
            if point[axis] > high {
                break;
            }
            if *id == from || *id == to {
                continue;
            }
            let along = (point - start).dot(span) / length_squared;
            if along <= 0.0 || along >= 1.0 {
                continue;
            }
            if (start + span * along).distance_squared(point) <= WELD_TOLERANCE * WELD_TOLERANCE {
                found.push((along, *id));
            }
        }
        found.sort_by(|a, b| a.0.total_cmp(&b.0));
        found.into_iter().map(|(_, id)| id).collect()
    }
}

/// Whether `point` lies on the line through `a` and `c`. A distance test, since an area
/// threshold misreads collinear points on long edges as corners.
fn on_line(a: DVec3, c: DVec3, point: DVec3) -> bool {
    let span = c - a;
    let cross = span.cross(point - a);
    cross.length_squared() <= WELD_TOLERANCE * WELD_TOLERANCE * span.length_squared()
}

/// Ear-clips a convex ring whose edges may carry collinear vertices.
///
/// Always consumes the whole ring. Topology needs every ring edge used exactly once, so a
/// sliver with no clean ear still closes, and a zero-area triangle is better than a hole.
fn triangulate(ring: &mut Vec<u32>, positions: &[DVec3], out: &mut Vec<[u32; 3]>) {
    while ring.len() >= 3 {
        let count = ring.len();
        let corners = |i: usize| {
            let (prev, here, next) = (
                ring[(i + count - 1) % count],
                ring[i],
                ring[(i + 1) % count],
            );
            (
                [prev, here, next],
                positions[prev as usize],
                positions[here as usize],
                positions[next as usize],
            )
        };
        let is_corner = |i: usize| {
            let (_, a, b, c) = corners(i);
            !on_line(a, c, b)
        };
        // A vertex on the diagonal would be left in a zero-area triangle.
        let clear_diagonal = |i: usize| {
            let (ids, a, _, c) = corners(i);
            ring.iter()
                .filter(|id| !ids.contains(id))
                .all(|id| !on_line(a, c, positions[*id as usize]))
        };
        let ear = (0..count)
            .find(|&i| is_corner(i) && clear_diagonal(i))
            .or_else(|| (0..count).find(|&i| is_corner(i)))
            .unwrap_or(0);

        let (ids, ..) = corners(ear);
        // Repeated ids come from welding, and their edges cancel out.
        if ids[0] != ids[1] && ids[1] != ids[2] && ids[0] != ids[2] {
            out.push(ids);
        }
        ring.remove(ear);
    }
}
/// Welds fragments into one mesh, removing T-junctions.
fn assemble(polygons: &[Polygon]) -> Mesh {
    let mut welder = Welder::default();
    let rings: Vec<Vec<u32>> = polygons
        .iter()
        .map(|polygon| {
            let mut ring: Vec<u32> = polygon
                .vertices
                .iter()
                .map(|vertex| welder.insert(*vertex))
                .collect();
            ring.dedup();
            if ring.len() > 1 && ring.first() == ring.last() {
                ring.pop();
            }
            ring
        })
        .collect();

    let positions = welder.positions;
    let scanner = EdgeScanner::new(&positions);
    let mut on_edge: KeyedMap<(u32, u32), Vec<u32>> = KeyedMap::default();
    let mut triangles = Vec::new();
    for ring in &rings {
        let mut full = Vec::with_capacity(ring.len());
        for (i, from) in ring.iter().enumerate() {
            let to = ring[(i + 1) % ring.len()];
            full.push(*from);
            let inner = on_edge
                .entry((*from, to))
                .or_insert_with(|| scanner.between(*from, to));
            full.extend_from_slice(inner);
        }
        triangulate(&mut full, &positions, &mut triangles);
    }

    Mesh {
        positions,
        triangles,
    }
}
