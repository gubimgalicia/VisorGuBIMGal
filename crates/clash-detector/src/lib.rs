//! Sovereign 3D clash detection (C22, `docs/11_clash.md`):
//! - Broad phase: iterative 3D AABB BVH (`Bvh3`)
//! - Narrow phase: exact `f64` triangle-triangle intersection, containment, CSG volume/depth,
//!   and BVH-accelerated minimum distance for soft clashes.

pub mod bvh;
pub mod narrow;

pub use bvh::{Aabb3, Bvh3};
pub use narrow::{ClashMesh, ClashOutcome, MAX_CSG_TRIANGLES, test_pair};

use std::collections::HashSet;

/// An element identity + AABB for broad-phase pair discovery across one or more models.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BroadItem {
    pub model_index: u32,
    pub express_id: u32,
    pub bounds: Aabb3,
}

/// Runs 3D BVH broad-phase overlap detection between `set_a` and `set_b` with clearance `clearance_m`.
///
/// Self-pairs `(m, id) == (m, id)` are excluded, and symmetric duplicates are canonicalised so
/// each unordered pair is returned at most once, as `(idx_in_a, idx_in_b)`.
pub fn broad_phase_pairs(
    set_a: &[BroadItem],
    set_b: &[BroadItem],
    clearance_m: f64,
) -> Vec<(u32, u32)> {
    if set_a.is_empty() || set_b.is_empty() {
        return Vec::new();
    }
    let tol = if clearance_m.is_finite() && clearance_m > 0.0 {
        clearance_m
    } else {
        0.0
    };
    let boxes_b: Vec<Aabb3> = set_b.iter().map(|item| item.bounds).collect();
    let bvh_b = Bvh3::build(&boxes_b);
    if bvh_b.is_empty() {
        return Vec::new();
    }

    let mut pairs = Vec::new();
    let mut seen: HashSet<((u32, u32), (u32, u32))> = HashSet::new();
    let mut hits = Vec::new();

    for (ia, item_a) in set_a.iter().enumerate() {
        if !item_a.bounds.is_valid() {
            continue;
        }
        hits.clear();
        bvh_b.query_aabb(&item_a.bounds, tol, &mut hits);
        let key_a = (item_a.model_index, item_a.express_id);
        for &ib in &hits {
            let item_b = &set_b[ib as usize];
            let key_b = (item_b.model_index, item_b.express_id);
            if key_a == key_b {
                continue;
            }
            if !item_a.bounds.overlaps(&item_b.bounds, tol) {
                continue;
            }
            let canonical = if key_a < key_b {
                (key_a, key_b)
            } else {
                (key_b, key_a)
            };
            if seen.insert(canonical) {
                pairs.push((ia as u32, ib));
            }
        }
    }

    pairs
}
