//! WASM-side clash detection helpers and bounded-LRU narrow-phase session (`docs/11_clash.md`).

use clash_detector::{Aabb3, BroadItem, ClashMesh, ClashOutcome, broad_phase_pairs, test_pair};
use glam::DVec3;
use ifc_geometry::{ElementGeometry, Mesh, ModelEvaluator};
use std::collections::HashMap;

/// Default LRU mesh cache cap in the ClashWorker (16 MiB).
pub const DEFAULT_CLASH_CACHE_BYTES: usize = 16 * 1024 * 1024;

/// Raw `f64` triangle mesh of one element for narrow-phase clash detection (no feature edges).
#[derive(Debug, Clone, Default)]
pub struct RawElementMesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

/// Evaluates compact `f64` AABBs `[express_id, minX, minY, minZ, maxX, maxY, maxZ]` for each
/// requested drawable element id. Elements with no geometry are skipped.
pub fn element_bounds_flat(
    evaluator: &mut ModelEvaluator<'_>,
    drawn: &[u32],
    express_ids: &[u32],
) -> Vec<f64> {
    let mut out = Vec::with_capacity(express_ids.len() * 7);
    for &id in express_ids {
        if drawn.binary_search(&id).is_err() {
            continue;
        }
        let Some(geom) = evaluator.evaluate(id) else {
            continue;
        };
        let Some(bounds) = geometry_bounds(&geom) else {
            continue;
        };
        out.push(id as f64);
        out.push(bounds.min.x);
        out.push(bounds.min.y);
        out.push(bounds.min.z);
        out.push(bounds.max.x);
        out.push(bounds.max.y);
        out.push(bounds.max.z);
    }
    out
}

fn geometry_bounds(geom: &ElementGeometry) -> Option<Aabb3> {
    let mut bounds = Aabb3::EMPTY;
    let mut any = false;
    for part in &geom.meshes {
        if part.mesh.triangles.is_empty() {
            continue;
        }
        for &p in &part.mesh.positions {
            if p.is_finite() {
                bounds.min = bounds.min.min(p);
                bounds.max = bounds.max.max(p);
                any = true;
            }
        }
    }
    (any && bounds.is_valid()).then_some(bounds)
}

/// Flattens an element's meshes into one raw `f64` position + `u32` index buffer without computing
/// measuring feature edges.
pub fn raw_element_mesh(geom: &ElementGeometry) -> Option<RawElementMesh> {
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for part in &geom.meshes {
        let mesh = &part.mesh;
        if mesh.triangles.is_empty() || mesh.positions.is_empty() {
            continue;
        }
        let base = (positions.len() / 3) as u32;
        for &p in &mesh.positions {
            positions.extend_from_slice(&p.to_array());
        }
        let vcount = mesh.positions.len() as u32;
        for &[a, b, c] in &mesh.triangles {
            if a < vcount && b < vcount && c < vcount {
                indices.push(base + a);
                indices.push(base + b);
                indices.push(base + c);
            }
        }
    }
    (!indices.is_empty()).then_some(RawElementMesh { positions, indices })
}

fn build_clash_mesh(positions: &[f64], indices: &[u32]) -> Option<ClashMesh> {
    if !positions.len().is_multiple_of(3) || !indices.len().is_multiple_of(3) || indices.is_empty() {
        return None;
    }
    let vert_count = positions.len() / 3;
    let mut pts = Vec::with_capacity(vert_count);
    for chunk in positions.as_chunks::<3>().0 {
        pts.push(DVec3::new(chunk[0], chunk[1], chunk[2]));
    }
    let mut tris = Vec::with_capacity(indices.len() / 3);
    for chunk in indices.as_chunks::<3>().0 {
        let a = chunk[0];
        let b = chunk[1];
        let c = chunk[2];
        if (a as usize) < vert_count && (b as usize) < vert_count && (c as usize) < vert_count {
            tris.push([a, b, c]);
        }
    }
    ClashMesh::new(Mesh {
        positions: pts,
        triangles: tris,
    })
}

fn parse_broad_items(flat: &[f64]) -> Vec<BroadItem> {
    let mut items = Vec::with_capacity(flat.len() / 8);
    for chunk in flat.as_chunks::<8>().0 {
        let model_index = chunk[0] as u32;
        let express_id = chunk[1] as u32;
        let min = DVec3::new(chunk[2], chunk[3], chunk[4]);
        let max = DVec3::new(chunk[5], chunk[6], chunk[7]);
        items.push(BroadItem {
            model_index,
            express_id,
            bounds: Aabb3::from_min_max(min, max),
        });
    }
    items
}

struct CacheEntry {
    mesh: ClashMesh,
    bytes: usize,
    last_used: u64,
}

/// Stateful narrow-phase clash session running inside a dedicated short-lived ClashWorker.
pub struct ClashSessionStore {
    cache: HashMap<(u32, u32), CacheEntry>,
    cache_bytes: usize,
    max_cache_bytes: usize,
    tick: u64,
    active: Option<((u32, u32), ClashMesh)>,
}

impl ClashSessionStore {
    pub fn new(max_cache_bytes: usize) -> Self {
        Self {
            cache: HashMap::new(),
            cache_bytes: 0,
            max_cache_bytes: if max_cache_bytes == 0 {
                DEFAULT_CLASH_CACHE_BYTES
            } else {
                max_cache_bytes
            },
            tick: 0,
            active: None,
        }
    }

    pub fn broad_phase(a_flat: &[f64], b_flat: &[f64], clearance_m: f64) -> Vec<u32> {
        let set_a = parse_broad_items(a_flat);
        let set_b = parse_broad_items(b_flat);
        let pairs = broad_phase_pairs(&set_a, &set_b, clearance_m);
        let mut out = Vec::with_capacity(pairs.len() * 2);
        for (ia, ib) in pairs {
            out.push(ia);
            out.push(ib);
        }
        out
    }

    pub fn has_cached(&self, model_index: u32, express_id: u32) -> bool {
        self.cache.contains_key(&(model_index, express_id))
    }

    pub fn cache_bytes(&self) -> usize {
        self.cache_bytes
    }

    pub fn cache_mesh(
        &mut self,
        model_index: u32,
        express_id: u32,
        positions: &[f64],
        indices: &[u32],
    ) -> bool {
        let key = (model_index, express_id);
        if let Some(entry) = self.cache.get_mut(&key) {
            self.tick += 1;
            entry.last_used = self.tick;
            return true;
        }
        let Some(mesh) = build_clash_mesh(positions, indices) else {
            return false;
        };
        let bytes = mesh.memory_bytes();
        while !self.cache.is_empty() && self.cache_bytes + bytes > self.max_cache_bytes {
            let Some(&victim) = self
                .cache
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(k, _)| k)
            else {
                break;
            };
            if let Some(removed) = self.cache.remove(&victim) {
                self.cache_bytes = self.cache_bytes.saturating_sub(removed.bytes);
            }
        }
        self.tick += 1;
        self.cache_bytes += bytes;
        self.cache.insert(
            key,
            CacheEntry {
                mesh,
                bytes,
                last_used: self.tick,
            },
        );
        true
    }

    pub fn set_active_mesh(
        &mut self,
        model_index: u32,
        express_id: u32,
        positions: &[f64],
        indices: &[u32],
    ) -> bool {
        let Some(mesh) = build_clash_mesh(positions, indices) else {
            self.active = None;
            return false;
        };
        self.active = Some(((model_index, express_id), mesh));
        true
    }

    /// Tests the current active mesh against a cached mesh `(cached_model, cached_id)`.
    ///
    /// Returns `[kind (1=hard, 2=soft), penetration_m, gap_m, volume_m3_or_nan, px, py, pz,
    /// minX, minY, minZ, maxX, maxY, maxZ]` when a clash is found.
    pub fn test_active_against_cached(
        &mut self,
        cached_model: u32,
        cached_id: u32,
        clearance_m: f64,
    ) -> Option<Vec<f64>> {
        let (_, active_mesh) = self.active.as_ref()?;
        self.tick += 1;
        let tick = self.tick;
        let cached = self.cache.get_mut(&(cached_model, cached_id))?;
        cached.last_used = tick;

        let outcome = test_pair(active_mesh, &cached.mesh, clearance_m)?;
        let union = active_mesh.bounds.union(&cached.mesh.bounds);
        let (kind, penetration_m, gap_m, volume, point) = match outcome {
            ClashOutcome::Hard {
                penetration_m,
                volume_m3,
                point,
            } => (1.0, penetration_m, 0.0, volume_m3.unwrap_or(f64::NAN), point),
            ClashOutcome::Soft { gap_m, point } => (2.0, 0.0, gap_m, f64::NAN, point),
        };
        Some(vec![
            kind,
            penetration_m,
            gap_m,
            volume,
            point.x,
            point.y,
            point.z,
            union.min.x,
            union.min.y,
            union.min.z,
            union.max.x,
            union.max.y,
            union.max.z,
        ])
    }
}
