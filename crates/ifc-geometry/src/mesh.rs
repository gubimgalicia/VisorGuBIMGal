//! Indexed triangle meshes in `f64`, in metres.

use glam::DVec3;
use crate::hash::KeyedMap;

/// A triangle side that is open, or shared by three or more faces.
const NO_NEIGHBOUR: u32 = u32::MAX;

/// Shells with more closed parts than this have no cavities looked for, since every pair is
/// compared: 11 ms natively for 2,000 parts, 0.5 s for 20,000. Real shells have at most 25.
const MAX_NESTED_PARTS: usize = 2_000;

/// Sides leaving one corner beyond which `side_partners` sorts them rather than scanning.
const MAX_SCANNED_SIDES: u32 = 32;

/// Triangles wind counter-clockwise seen from outside the solid.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    pub positions: Vec<DVec3>,
    pub triangles: Vec<[u32; 3]>,
}

impl Mesh {
    /// An axis-aligned box.
    pub fn cuboid(min: DVec3, max: DVec3) -> Self {
        let corner = |x: bool, y: bool, z: bool| {
            DVec3::new(
                if x { max.x } else { min.x },
                if y { max.y } else { min.y },
                if z { max.z } else { min.z },
            )
        };
        let positions = vec![
            corner(false, false, false),
            corner(true, false, false),
            corner(true, true, false),
            corner(false, true, false),
            corner(false, false, true),
            corner(true, false, true),
            corner(true, true, true),
            corner(false, true, true),
        ];
        let triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        Self {
            positions,
            triangles,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.triangles.is_empty()
    }

    /// Applies `f` to every vertex. A mirroring `f` must also flip the winding.
    pub fn map_positions(&self, f: impl Fn(DVec3) -> DVec3) -> Self {
        Self {
            positions: self.positions.iter().map(|p| f(*p)).collect(),
            triangles: self.triangles.clone(),
        }
    }

    /// Yields each triangle's corners, skipping any with an out-of-range index.
    pub fn triangle_corners(&self) -> impl Iterator<Item = [DVec3; 3]> + '_ {
        self.triangles.iter().filter_map(|[a, b, c]| {
            Some([
                *self.positions.get(*a as usize)?,
                *self.positions.get(*b as usize)?,
                *self.positions.get(*c as usize)?,
            ])
        })
    }

    /// Enclosed volume. Meaningful for closed meshes only.
    pub fn volume(&self) -> f64 {
        // Measured from the first vertex, which keeps precision at large coordinates.
        let Some(pivot) = self.positions.first().copied() else {
            return 0.0;
        };
        let six_volume: f64 = self
            .triangle_corners()
            .map(|[a, b, c]| (a - pivot).dot((b - pivot).cross(c - pivot)))
            .sum();
        six_volume / 6.0
    }

    /// Directed edges with no opposite partner. Zero means watertight.
    pub fn open_edges(&self) -> usize {
        // Summed below, so the walk order of a keyed map does not matter.
        let mut balance: KeyedMap<(u32, u32), i32> = KeyedMap::default();
        for [a, b, c] in &self.triangles {
            for (from, to) in [(*a, *b), (*b, *c), (*c, *a)] {
                if from < to {
                    *balance.entry((from, to)).or_default() += 1;
                } else {
                    *balance.entry((to, from)).or_default() -= 1;
                }
            }
        }
        balance.values().map(|count| count.unsigned_abs() as usize).sum()
    }

    /// Whether no back face can show from outside: every side, with corners at one position
    /// counted as one, is shared by exactly two triangles running along it in opposite
    /// directions, and every part, its triangles joined across those sides, encloses a positive
    /// volume, so winds outward. A cavity winds inward, so a mesh with one is not closed here;
    /// nor is one whose faces meet only at T-junctions, nor one with a part of no volume, such
    /// as a triangle with a repeated corner or two faces back to back, which could otherwise join
    /// an inward part to an outward one.
    pub fn is_closed_outward(&self) -> bool {
        let count = self.positions.len();
        // Every side pairs with another, so there are an even number of them.
        if self.triangles.is_empty() || self.triangles.len() % 2 == 1 {
            return false;
        }
        if self.triangles.iter().flatten().any(|index| *index as usize >= count) {
            return false;
        }
        // Most meshes share their corners already; only those that do not are welded.
        let own: Vec<u32> = (0..count as u32).collect();
        let partners = if let Some(partners) = side_partners(&self.triangles, &own) {
            partners
        } else {
            let welded = welded_labels(&self.positions);
            let Some(partners) = side_partners(&self.triangles, &welded) else {
                return false;
            };
            partners
        };

        // Parts: triangles joined across their sides, without recursion: the WASM stack is 1 MB.
        let mut parent: Vec<u32> = (0..self.triangles.len() as u32).collect();
        let root = |parent: &mut [u32], mut at: u32| {
            while parent[at as usize] != at {
                let up = parent[parent[at as usize] as usize];
                parent[at as usize] = up;
                at = up;
            }
            at
        };
        for (triangle, across) in (0u32..).zip(&partners) {
            for other in across {
                let (one, two) = (root(&mut parent, triangle), root(&mut parent, *other));
                if one != two {
                    parent[two as usize] = one;
                }
            }
        }
        // Six times each part's volume, measured from a corner of the part for precision.
        let mut pivots: Vec<Option<DVec3>> = vec![None; self.triangles.len()];
        let mut six_volumes = vec![0.0f64; self.triangles.len()];
        for (index, triangle) in (0u32..).zip(&self.triangles) {
            let [a, b, c] = triangle.map(|id| self.positions[id as usize]);
            let part = root(&mut parent, index) as usize;
            let pivot = *pivots[part].get_or_insert(a);
            six_volumes[part] += (a - pivot).dot((b - pivot).cross(c - pivot));
        }
        pivots.iter().zip(&six_volumes).all(|(pivot, six_volume)| pivot.is_none() || *six_volume > 0.0)
    }

    /// Makes a shell agree with itself: faces across a shared edge wind the same way, a closed
    /// part winds outward unless it is a cavity in another, and an open part keeps the way most
    /// of its area faces. Real files write faces of one shell in both directions. An edge of
    /// three or more faces joins nothing. Corners at one position count as one, because a face
    /// set need not share its indices.
    pub fn orient_shell(&mut self) {
        self.orient_shells(&[]);
    }

    /// [`Mesh::orient_shell`] for the faces of several shells or face sets at once, each starting
    /// at a triangle index in `starts`, in order; the first may be left out. Faces of different
    /// shells still join across shared edges, but a part is only a cavity in a part of its own
    /// shell.
    pub fn orient_shells(&mut self, starts: &[usize]) {
        let welded = welded_labels(&self.positions);
        let corners = |triangle: [u32; 3]| triangle.map(|id| welded[id as usize]);
        // Edges grouped by their lower corner, by counting, then by their upper one, with no
        // allocation per edge, which a map of lists cost on every shell; sorting them all took
        // longer. Only an edge of exactly two faces joins them.
        let count = self.positions.len();
        let mut start = vec![0u32; count + 1];
        for triangle in &self.triangles {
            let [a, b, c] = corners(*triangle);
            for (from, to) in [(a, b), (b, c), (c, a)] {
                start[from.min(to) as usize + 1] += 1;
            }
        }
        for at in 1..=count {
            start[at] += start[at - 1];
        }
        let mut fill = start.clone();
        // Each edge as its upper corner, its triangle and which side of it.
        let mut edges = vec![(0u32, 0u32, 0u8); self.triangles.len() * 3];
        for (index, triangle) in (0u32..).zip(&self.triangles) {
            let [a, b, c] = corners(*triangle);
            for (side, (from, to)) in (0u8..).zip([(a, b), (b, c), (c, a)]) {
                let low = from.min(to) as usize;
                edges[fill[low] as usize] = (from.max(to), index, side);
                fill[low] += 1;
            }
        }
        let mut neighbours = vec![[NO_NEIGHBOUR; 3]; self.triangles.len()];
        for low in 0..count {
            let group = &mut edges[start[low] as usize..start[low + 1] as usize];
            if group.len() > MAX_SCANNED_SIDES as usize {
                group.sort_unstable();
                for same in group.chunk_by(|one, two| one.0 == two.0) {
                    if let [(_, one, one_side), (_, two, two_side)] = same {
                        neighbours[*one as usize][*one_side as usize] = *two;
                        neighbours[*two as usize][*two_side as usize] = *one;
                    }
                }
                continue;
            }
            // Few edges leave most corners: scanning them beats sorting them.
            for (at, (high, one, one_side)) in group.iter().enumerate() {
                let mut others = group.iter().enumerate().filter(|(other, edge)| *other != at && edge.0 == *high);
                if let (Some((_, (_, two, _))), None) = (others.next(), others.next()) {
                    neighbours[*one as usize][*one_side as usize] = *two;
                }
            }
        }
        let mut flip = vec![false; self.triangles.len()];
        let mut seen = vec![false; self.triangles.len()];
        let mut closed_parts = Vec::new();
        for start in 0..self.triangles.len() {
            if seen[start] {
                continue;
            }
            seen[start] = true;
            let mut part = vec![start];
            let mut closed = true;
            // Grows while it is walked: an explicit list, because recursion would grow with the
            // file and the WASM stack is 1 MB.
            let mut next = 0;
            while next < part.len() {
                let current = part[next];
                next += 1;
                let [a, b, c] = corners(self.triangles[current]);
                for (side, (from, to)) in [(a, b), (b, c), (c, a)].into_iter().enumerate() {
                    let other = neighbours[current][side];
                    if other == NO_NEIGHBOUR {
                        closed = false;
                        continue;
                    }
                    let other = other as usize;
                    if seen[other] {
                        continue;
                    }
                    seen[other] = true;
                    // Neighbours that agree run along their shared edge in opposite directions.
                    let [d, e, f] = corners(self.triangles[other]);
                    let same_way = [(d, e), (e, f), (f, d)].contains(&(from, to));
                    flip[other] = same_way != flip[current];
                    part.push(other);
                }
            }
            self.settle(&part, closed, &mut flip);
            if closed {
                closed_parts.push(part);
            }
        }
        self.hollow(&closed_parts, starts, &mut flip);
        for (triangle, flip) in self.triangles.iter_mut().zip(flip) {
            if flip {
                triangle.swap(1, 2);
            }
        }
    }

    /// Chooses the direction of one connected part, whose flips so far agree with its first.
    fn settle(&self, part: &[usize], closed: bool, flip: &mut [bool]) {
        let corners = |index: usize| {
            let [a, b, c] = self.triangles[index].map(|id| self.positions[id as usize]);
            if flip[index] { [a, c, b] } else { [a, b, c] }
        };
        let turn = if closed {
            let pivot = corners(part[0])[0];
            let six_volume: f64 = part
                .iter()
                .map(|index| {
                    let [a, b, c] = corners(*index);
                    (a - pivot).dot((b - pivot).cross(c - pivot))
                })
                .sum();
            six_volume < 0.0
        } else {
            let area = |turned: bool| -> f64 {
                part.iter()
                    .filter(|index| flip[**index] == turned)
                    .map(|index| {
                        let [a, b, c] = corners(*index);
                        (b - a).cross(c - a).length()
                    })
                    .sum()
            };
            area(true) > area(false)
        };
        if turn {
            for index in part {
                flip[*index] = !flip[*index];
            }
        }
    }

    /// Turns inward each closed part that lies inside an odd number of others of its shell: a
    /// cavity, or an island in one. Tekla writes the cores of a hollow slab as closed parts of
    /// the slab's one shell, sharing no edge with it, and each would otherwise wind outward and
    /// add its volume. Revit writes a part buried in another as a face set of its own, which is
    /// joined to the other, not cut from it.
    fn hollow(&self, parts: &[Vec<usize>], starts: &[usize], flip: &mut [bool]) {
        if !(2..=MAX_NESTED_PARTS).contains(&parts.len()) {
            return;
        }
        // The shells each part has faces in, sorted.
        let shells: Vec<Vec<usize>> = parts
            .iter()
            .map(|part| {
                let mut shells: Vec<usize> =
                    part.iter().map(|index| starts.partition_point(|start| start <= index)).collect();
                shells.sort_unstable();
                shells.dedup();
                shells
            })
            .collect();
        let share = |one: &[usize], two: &[usize]| one.iter().any(|shell| two.binary_search(shell).is_ok());
        let bounds: Vec<(DVec3, DVec3)> = parts
            .iter()
            .map(|part| {
                part.iter()
                    .flat_map(|index| self.triangles[*index])
                    .map(|id| self.positions[id as usize])
                    .fold((DVec3::INFINITY, DVec3::NEG_INFINITY), |(low, high), point| {
                        (low.min(point), high.max(point))
                    })
            })
            .collect();
        let mut turned = vec![false; parts.len()];
        for (inner, part) in parts.iter().enumerate() {
            let (low, high) = bounds[inner];
            // A point inside one of the part's own faces, clear of its edges.
            let Some(probe) = part
                .iter()
                .map(|index| self.triangles[*index].map(|id| self.positions[id as usize]))
                .max_by(|one, two| doubled_area(one).total_cmp(&doubled_area(two)))
                .map(|[a, b, c]| (a + b + c) / 3.0)
            else {
                continue;
            };
            let depth = parts
                .iter()
                .enumerate()
                .filter(|(outer, _)| {
                    let (outer_low, outer_high) = bounds[*outer];
                    // Strictly inside the box: a part that touches or coincides with another's
                    // bounds is beside it, not in it.
                    *outer != inner
                        && outer_low.cmplt(low).all()
                        && high.cmplt(outer_high).all()
                        && share(&shells[inner], &shells[*outer])
                })
                .filter(|(_, outer)| self.winding(outer, flip, probe).abs() > 0.5)
                .count();
            turned[inner] = depth % 2 == 1;
        }
        for (part, turned) in parts.iter().zip(turned) {
            if turned {
                for index in part {
                    flip[*index] = !flip[*index];
                }
            }
        }
    }

    /// How many times the triangles of `part`, as flipped so far, wind around `point`: ±1 inside
    /// a closed part and 0 outside, whichever way the part faces. Each triangle's solid angle,
    /// summed.
    fn winding(&self, part: &[usize], flip: &[bool], point: DVec3) -> f64 {
        let solid_angle: f64 = part
            .iter()
            .map(|index| {
                let [a, mut b, mut c] = self.triangles[*index].map(|id| self.positions[id as usize] - point);
                if flip[*index] {
                    std::mem::swap(&mut b, &mut c);
                }
                let (la, lb, lc) = (a.length(), b.length(), c.length());
                let numerator = a.dot(b.cross(c));
                let denominator = la * lb * lc + a.dot(b) * lc + a.dot(c) * lb + b.dot(c) * la;
                2.0 * numerator.atan2(denominator)
            })
            .sum();
        solid_angle / (4.0 * std::f64::consts::PI)
    }
}

/// A label for each corner, shared by corners at one position. Any labels work, as long as
/// equal positions share one. The keys are made once and sorted, not made per comparison.
fn welded_labels(positions: &[DVec3]) -> Vec<u32> {
    // Adding zero turns -0.0 into 0.0, which has other bits.
    let mut keyed: Vec<([u64; 3], u32)> = positions
        .iter()
        .zip(0u32..)
        .map(|(position, index)| ((*position + DVec3::ZERO).to_array().map(f64::to_bits), index))
        .collect();
    keyed.sort_unstable();
    let mut welded = vec![0u32; positions.len()];
    for (at, (key, index)) in keyed.iter().enumerate() {
        welded[*index as usize] = match at.checked_sub(1).map(|before| &keyed[before]) {
            Some((before, earlier)) if before == key => welded[*earlier as usize],
            _ => *index,
        };
    }
    welded
}

/// For each triangle, with corners renamed by `label`, the triangles running back along its
/// three sides; `None` unless each directed side appears once and its reverse too. A side whose
/// ends are one corner is its own reverse. The sides are grouped by the corner they leave, by
/// counting: sorting them all took a third longer.
fn side_partners(triangles: &[[u32; 3]], label: &[u32]) -> Option<Vec<[u32; 3]>> {
    let count = label.len();
    let mut start = vec![0u32; count + 1];
    for triangle in triangles {
        for id in triangle {
            start[label[*id as usize] as usize + 1] += 1;
        }
    }
    for at in 1..=count {
        start[at] += start[at - 1];
    }
    let mut fill = start.clone();
    // Each side as the corner it reaches and its triangle.
    let mut ends = vec![(0u32, 0u32); triangles.len() * 3];
    for (index, triangle) in (0u32..).zip(triangles) {
        let [a, b, c] = triangle.map(|id| label[id as usize]);
        for (from, to) in [(a, b), (b, c), (c, a)] {
            ends[fill[from as usize] as usize] = (to, index);
            fill[from as usize] += 1;
        }
    }
    let range = |corner: u32| start[corner as usize] as usize..start[corner as usize + 1] as usize;
    // A few sides leave most corners, and scanning them beats sorting them. A corner with many,
    // the tip of a fine cone say, would make scanning quadratic, so then they are sorted.
    let scanned = start.windows(2).all(|pair| pair[1] - pair[0] <= MAX_SCANNED_SIDES);
    if !scanned {
        for corner in 0..count as u32 {
            ends[range(corner)].sort_unstable();
        }
    }
    let repeated = (0..count as u32).any(|corner| {
        let leaving = &ends[range(corner)];
        if scanned {
            leaving.iter().enumerate().any(|(at, (to, _))| leaving[..at].iter().any(|(other, _)| other == to))
        } else {
            leaving.windows(2).any(|pair| pair[0].0 == pair[1].0)
        }
    });
    if repeated {
        return None;
    }
    let back = |from: u32, to: u32| -> Option<u32> {
        let arriving = &ends[range(to)];
        if scanned {
            arriving.iter().find(|(end, _)| *end == from).map(|(_, triangle)| *triangle)
        } else {
            arriving.binary_search_by_key(&from, |(end, _)| *end).ok().map(|at| arriving[at].1)
        }
    };
    triangles
        .iter()
        .map(|triangle| {
            let [a, b, c] = triangle.map(|id| label[id as usize]);
            Some([back(a, b)?, back(b, c)?, back(c, a)?])
        })
        .collect()
}

fn doubled_area([a, b, c]: &[DVec3; 3]) -> f64 {
    (*b - *a).cross(*c - *a).length()
}
