//! Iterative 3D axis-aligned bounding box hierarchy (`f64`, metres).
//!
//! Built and queried without recursion so it stays safe within the 1 MB WASM stack.

use glam::DVec3;

const LEAF_SIZE: usize = 8;

/// Axis-aligned 3D bounding box in absolute model metres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aabb3 {
    pub min: DVec3,
    pub max: DVec3,
}

impl Aabb3 {
    pub const EMPTY: Self = Self {
        min: DVec3::INFINITY,
        max: DVec3::NEG_INFINITY,
    };

    #[inline]
    pub fn from_min_max(min: DVec3, max: DVec3) -> Self {
        Self { min, max }
    }

    pub fn from_points(points: impl IntoIterator<Item = DVec3>) -> Option<Self> {
        let mut min = DVec3::INFINITY;
        let mut max = DVec3::NEG_INFINITY;
        let mut any = false;
        for p in points {
            if !p.is_finite() {
                continue;
            }
            min = min.min(p);
            max = max.max(p);
            any = true;
        }
        any.then_some(Self { min, max })
    }

    #[inline]
    pub fn from_triangle(tri: [DVec3; 3]) -> Self {
        Self {
            min: tri[0].min(tri[1]).min(tri[2]),
            max: tri[0].max(tri[1]).max(tri[2]),
        }
    }

    #[inline]
    pub fn is_valid(&self) -> bool {
        self.min.is_finite()
            && self.max.is_finite()
            && self.min.x <= self.max.x
            && self.min.y <= self.max.y
            && self.min.z <= self.max.z
    }

    #[inline]
    pub fn union(&self, other: &Self) -> Self {
        Self {
            min: self.min.min(other.min),
            max: self.max.max(other.max),
        }
    }

    #[inline]
    pub fn expand(&self, margin: f64) -> Self {
        let m = DVec3::splat(margin);
        Self {
            min: self.min - m,
            max: self.max + m,
        }
    }

    #[inline]
    pub fn center(&self) -> DVec3 {
        (self.min + self.max) * 0.5
    }

    #[inline]
    pub fn extent(&self) -> DVec3 {
        self.max - self.min
    }

    /// Inclusive overlap with tolerance `tol` (e.g. `clearance`).
    #[inline]
    pub fn overlaps(&self, other: &Self, tol: f64) -> bool {
        self.min.x <= other.max.x + tol
            && self.max.x + tol >= other.min.x
            && self.min.y <= other.max.y + tol
            && self.max.y + tol >= other.min.y
            && self.min.z <= other.max.z + tol
            && self.max.z + tol >= other.min.z
    }

    /// Strictly positive overlap on all three axes (> `eps`).
    #[inline]
    pub fn strict_overlaps(&self, other: &Self, eps: f64) -> bool {
        let overlap_min = self.min.max(other.min);
        let overlap_max = self.max.min(other.max);
        let d = overlap_max - overlap_min;
        d.x > eps && d.y > eps && d.z > eps
    }

    /// Minimum squared Euclidean distance between two AABBs (0 when overlapping or touching).
    #[inline]
    pub fn min_dist_sq(&self, other: &Self) -> f64 {
        let dx = (self.min.x - other.max.x).max(other.min.x - self.max.x).max(0.0);
        let dy = (self.min.y - other.max.y).max(other.min.y - self.max.y).max(0.0);
        let dz = (self.min.z - other.max.z).max(other.min.z - self.max.z).max(0.0);
        dx * dx + dy * dy + dz * dz
    }

    /// Minimum squared distance from a point to this AABB.
    #[inline]
    pub fn point_dist_sq(&self, p: DVec3) -> f64 {
        let clamped = p.clamp(self.min, self.max);
        clamped.distance_squared(p)
    }

    /// Slab intersection test for ray `origin + t * dir` with `t >= 0.0`.
    #[inline]
    pub fn ray_intersects(&self, origin: DVec3, inv_dir: DVec3) -> bool {
        let t1 = (self.min - origin) * inv_dir;
        let t2 = (self.max - origin) * inv_dir;
        let tmin = t1.min(t2).max_element();
        let tmax = t1.max(t2).min_element();
        tmax >= 0.0 && tmax >= tmin
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Node {
    pub bounds: Aabb3,
    /// For leaves (`count > 0`): start index in `items`.
    /// For inner nodes (`count == 0`): index of left child (`right = start + 1`).
    pub start: u32,
    pub count: u32,
}

/// Compact 3D BVH over indexed AABBs.
#[derive(Debug, Clone)]
pub struct Bvh3 {
    pub(crate) nodes: Vec<Node>,
    pub(crate) items: Vec<u32>,
}

impl Bvh3 {
    pub fn build(boxes: &[Aabb3]) -> Self {
        let len = boxes.len();
        if len == 0 {
            return Self {
                nodes: Vec::new(),
                items: Vec::new(),
            };
        }

        #[derive(Clone, Copy)]
        struct Entry {
            center: DVec3,
            id: u32,
        }

        let mut entries: Vec<Entry> = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.is_valid())
            .map(|(i, b)| Entry {
                center: b.center(),
                id: i as u32,
            })
            .collect();

        if entries.is_empty() {
            return Self {
                nodes: Vec::new(),
                items: Vec::new(),
            };
        }

        let placeholder = Node {
            bounds: Aabb3::EMPTY,
            start: 0,
            count: 0,
        };
        let mut nodes = Vec::with_capacity(entries.len() * 2 / LEAF_SIZE + 8);
        nodes.push(placeholder);
        let mut items = Vec::with_capacity(entries.len());
        let mut pending = vec![(0usize, 0usize, entries.len())];

        while let Some((node_idx, start, end)) = pending.pop() {
            let slice = &mut entries[start..end];
            if slice.len() <= LEAF_SIZE {
                let leaf_start = items.len() as u32;
                let mut bounds = Aabb3::EMPTY;
                for entry in slice.iter() {
                    bounds = bounds.union(&boxes[entry.id as usize]);
                    items.push(entry.id);
                }
                nodes[node_idx] = Node {
                    bounds,
                    start: leaf_start,
                    count: slice.len() as u32,
                };
                continue;
            }

            let mut c_min = DVec3::INFINITY;
            let mut c_max = DVec3::NEG_INFINITY;
            for entry in slice.iter() {
                c_min = c_min.min(entry.center);
                c_max = c_max.max(entry.center);
            }
            let ext = c_max - c_min;
            let axis = if ext.x >= ext.y && ext.x >= ext.z {
                0
            } else if ext.y >= ext.z {
                1
            } else {
                2
            };
            let mid = slice.len() / 2;
            slice.select_nth_unstable_by(mid, |a, b| {
                a.center[axis]
                    .total_cmp(&b.center[axis])
                    .then(a.id.cmp(&b.id))
            });

            let left = nodes.len();
            nodes.push(placeholder);
            nodes.push(placeholder);
            nodes[node_idx] = Node {
                bounds: Aabb3::EMPTY,
                start: left as u32,
                count: 0,
            };
            pending.push((left, start, start + mid));
            pending.push((left + 1, start + mid, end));
        }

        // Bottom-up bounds fill: children always have a larger index than their parent.
        for idx in (0..nodes.len()).rev() {
            if nodes[idx].count == 0 {
                let left = nodes[idx].start as usize;
                nodes[idx].bounds = nodes[left].bounds.union(&nodes[left + 1].bounds);
            }
        }

        Self { nodes, items }
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn root_bounds(&self) -> Option<Aabb3> {
        self.nodes.first().map(|n| n.bounds)
    }

    /// Collects all item indices whose AABB overlaps `query` within `tol`.
    pub fn query_aabb(&self, query: &Aabb3, tol: f64, out: &mut Vec<u32>) {
        if self.nodes.is_empty() || !query.is_valid() {
            return;
        }
        let mut stack = Vec::with_capacity(64);
        stack.push(0usize);
        while let Some(idx) = stack.pop() {
            let node = self.nodes[idx];
            if !node.bounds.overlaps(query, tol) {
                continue;
            }
            if node.count > 0 {
                let start = node.start as usize;
                let end = start + node.count as usize;
                out.extend_from_slice(&self.items[start..end]);
            } else {
                let left = node.start as usize;
                stack.push(left);
                stack.push(left + 1);
            }
        }
    }

    /// Calls `visitor(item_a, item_b)` for every leaf pair whose AABBs overlap within `tol`.
    /// Stops early if `visitor` returns `true`.
    pub fn visit_overlapping_pairs(
        &self,
        other: &Self,
        tol: f64,
        mut visitor: impl FnMut(u32, u32) -> bool,
    ) -> bool {
        if self.nodes.is_empty() || other.nodes.is_empty() {
            return false;
        }
        let mut stack = Vec::with_capacity(128);
        stack.push((0usize, 0usize));
        while let Some((ia, ib)) = stack.pop() {
            let na = self.nodes[ia];
            let nb = other.nodes[ib];
            if !na.bounds.overlaps(&nb.bounds, tol) {
                continue;
            }
            match (na.count > 0, nb.count > 0) {
                (true, true) => {
                    let sa = na.start as usize;
                    let sb = nb.start as usize;
                    for &item_a in &self.items[sa..sa + na.count as usize] {
                        for &item_b in &other.items[sb..sb + nb.count as usize] {
                            if visitor(item_a, item_b) {
                                return true;
                            }
                        }
                    }
                }
                (true, false) => {
                    let left = nb.start as usize;
                    stack.push((ia, left));
                    stack.push((ia, left + 1));
                }
                (false, true) => {
                    let left = na.start as usize;
                    stack.push((left, ib));
                    stack.push((left + 1, ib));
                }
                (false, false) => {
                    // Split the node with the larger bounding box extent.
                    let ext_a = na.bounds.extent().length_squared();
                    let ext_b = nb.bounds.extent().length_squared();
                    if ext_a >= ext_b {
                        let left = na.start as usize;
                        stack.push((left, ib));
                        stack.push((left + 1, ib));
                    } else {
                        let left = nb.start as usize;
                        stack.push((ia, left));
                        stack.push((ia, left + 1));
                    }
                }
            }
        }
        false
    }

    /// Dual-BVH branch-and-bound traversal for minimum squared distance `< max_dist_sq`.
    /// Calls `leaf_dist_sq(item_a, item_b, best_sq)` which may tighten `best_sq`.
    pub fn visit_closest_pairs(
        &self,
        other: &Self,
        max_dist_sq: f64,
        mut leaf_dist_sq: impl FnMut(u32, u32, &mut f64),
    ) -> f64 {
        if self.nodes.is_empty() || other.nodes.is_empty() {
            return max_dist_sq;
        }
        let mut best_sq = max_dist_sq;
        let mut stack = Vec::with_capacity(128);
        let root_d = self.nodes[0].bounds.min_dist_sq(&other.nodes[0].bounds);
        if root_d >= best_sq {
            return best_sq;
        }
        stack.push((0usize, 0usize, root_d));

        while let Some((ia, ib, lower_bound)) = stack.pop() {
            if lower_bound >= best_sq {
                continue;
            }
            let na = self.nodes[ia];
            let nb = other.nodes[ib];
            match (na.count > 0, nb.count > 0) {
                (true, true) => {
                    let sa = na.start as usize;
                    let sb = nb.start as usize;
                    for &item_a in &self.items[sa..sa + na.count as usize] {
                        for &item_b in &other.items[sb..sb + nb.count as usize] {
                            leaf_dist_sq(item_a, item_b, &mut best_sq);
                            if best_sq == 0.0 {
                                return 0.0;
                            }
                        }
                    }
                }
                (true, false) => {
                    let l = nb.start as usize;
                    let r = l + 1;
                    let dl = na.bounds.min_dist_sq(&other.nodes[l].bounds);
                    let dr = na.bounds.min_dist_sq(&other.nodes[r].bounds);
                    // Push farther child first so nearer child is popped first.
                    if dl <= dr {
                        if dr < best_sq {
                            stack.push((ia, r, dr));
                        }
                        if dl < best_sq {
                            stack.push((ia, l, dl));
                        }
                    } else {
                        if dl < best_sq {
                            stack.push((ia, l, dl));
                        }
                        if dr < best_sq {
                            stack.push((ia, r, dr));
                        }
                    }
                }
                (false, true) => {
                    let l = na.start as usize;
                    let r = l + 1;
                    let dl = self.nodes[l].bounds.min_dist_sq(&nb.bounds);
                    let dr = self.nodes[r].bounds.min_dist_sq(&nb.bounds);
                    if dl <= dr {
                        if dr < best_sq {
                            stack.push((r, ib, dr));
                        }
                        if dl < best_sq {
                            stack.push((l, ib, dl));
                        }
                    } else {
                        if dl < best_sq {
                            stack.push((l, ib, dl));
                        }
                        if dr < best_sq {
                            stack.push((r, ib, dr));
                        }
                    }
                }
                (false, false) => {
                    let ext_a = na.bounds.extent().length_squared();
                    let ext_b = nb.bounds.extent().length_squared();
                    if ext_a >= ext_b {
                        let l = na.start as usize;
                        let r = l + 1;
                        let dl = self.nodes[l].bounds.min_dist_sq(&nb.bounds);
                        let dr = self.nodes[r].bounds.min_dist_sq(&nb.bounds);
                        if dl <= dr {
                            if dr < best_sq {
                                stack.push((r, ib, dr));
                            }
                            if dl < best_sq {
                                stack.push((l, ib, dl));
                            }
                        } else {
                            if dl < best_sq {
                                stack.push((l, ib, dl));
                            }
                            if dr < best_sq {
                                stack.push((r, ib, dr));
                            }
                        }
                    } else {
                        let l = nb.start as usize;
                        let r = l + 1;
                        let dl = na.bounds.min_dist_sq(&other.nodes[l].bounds);
                        let dr = na.bounds.min_dist_sq(&other.nodes[r].bounds);
                        if dl <= dr {
                            if dr < best_sq {
                                stack.push((ia, r, dr));
                            }
                            if dl < best_sq {
                                stack.push((ia, l, dl));
                            }
                        } else {
                            if dl < best_sq {
                                stack.push((ia, l, dl));
                            }
                            if dr < best_sq {
                                stack.push((ia, r, dr));
                            }
                        }
                    }
                }
            }
        }
        best_sq
    }

    /// Visits all leaf items whose AABB intersects ray `origin + t * dir` (`t >= 0`).
    pub fn visit_ray(&self, origin: DVec3, dir: DVec3, mut visitor: impl FnMut(u32)) {
        if self.nodes.is_empty() {
            return;
        }
        let inv_dir = DVec3::new(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
        let mut stack = Vec::with_capacity(64);
        stack.push(0usize);
        while let Some(idx) = stack.pop() {
            let node = self.nodes[idx];
            if !node.bounds.ray_intersects(origin, inv_dir) {
                continue;
            }
            if node.count > 0 {
                let start = node.start as usize;
                let end = start + node.count as usize;
                for &item in &self.items[start..end] {
                    visitor(item);
                }
            } else {
                let left = node.start as usize;
                stack.push(left);
                stack.push(left + 1);
            }
        }
    }
}
