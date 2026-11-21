//! Exact `f64` narrow-phase clash detection: triangle-triangle intersection, containment,
//! CSG intersection volume/depth (D-009), and BVH-accelerated minimum distance for soft clashes.

use crate::bvh::{Aabb3, Bvh3};
use glam::DVec3;
use ifc_geometry::{Mesh, csg};

/// Geometric tolerance for strict crossing and grazing rejection (metres = 0.001 mm).
const EPS: f64 = 1e-6;
/// Boundary band around a mesh surface for strict point-in-solid checks (metres = 0.01 mm).
const SURFACE_EPS: f64 = 1e-5;
/// Minimum enclosed intersection volume (m³) for a confirmed closed-solid hard clash (0.001 mm³).
const MIN_CLASH_VOLUME: f64 = 1e-12;
/// Triangle budget above which BSP CSG is skipped to prevent stalls on dense valves/fittings.
pub const MAX_CSG_TRIANGLES: usize = 2_000;

/// Three deterministic, skewed ray directions for majority-vote point-in-solid parity tests.
const RAY_DIRS: [DVec3; 3] = [
    DVec3::new(0.916_515_138_991_168, 0.340_406_115_617_287, 0.209_963_918_174_938),
    DVec3::new(0.242_535_625_036_333, 0.921_635_375_138_065, 0.303_169_531_295_416),
    DVec3::new(-0.311_400_512_934_142, 0.259_500_427_445_118, 0.914_044_503_852_946),
];

/// Result of narrow-phase testing between two element meshes.
#[derive(Debug, Clone, PartialEq)]
pub enum ClashOutcome {
    Hard {
        penetration_m: f64,
        volume_m3: Option<f64>,
        point: DVec3,
    },
    Soft {
        gap_m: f64,
        point: DVec3,
    },
}

/// Pre-indexed `f64` mesh prepared for narrow-phase clash tests.
#[derive(Debug, Clone)]
pub struct ClashMesh {
    pub mesh: Mesh,
    pub bounds: Aabb3,
    pub tri_boxes: Vec<Aabb3>,
    pub bvh: Bvh3,
    pub closed: bool,
}

impl ClashMesh {
    pub fn new(mesh: Mesh) -> Option<Self> {
        if mesh.triangles.is_empty() || mesh.positions.is_empty() {
            return None;
        }
        let mut tri_boxes = Vec::with_capacity(mesh.triangles.len());
        let mut bounds = Aabb3::EMPTY;
        for tri in &mesh.triangles {
            let Some(corners) = triangle_corners(&mesh, *tri) else {
                tri_boxes.push(Aabb3::EMPTY);
                continue;
            };
            let tb = Aabb3::from_triangle(corners);
            if tb.is_valid() {
                bounds = bounds.union(&tb);
                tri_boxes.push(tb);
            } else {
                tri_boxes.push(Aabb3::EMPTY);
            }
        }
        if !bounds.is_valid() {
            return None;
        }
        let bvh = Bvh3::build(&tri_boxes);
        if bvh.is_empty() {
            return None;
        }
        // Only pay for the manifold closure check when CSG could actually run on this mesh.
        let closed = mesh.triangles.len() <= MAX_CSG_TRIANGLES && mesh.is_closed_outward();
        Some(Self {
            mesh,
            bounds,
            tri_boxes,
            bvh,
            closed,
        })
    }

    /// Approximate heap memory consumed by this cached mesh and its triangle BVH, in bytes.
    pub fn memory_bytes(&self) -> usize {
        self.mesh.positions.len() * std::mem::size_of::<DVec3>()
            + self.mesh.triangles.len() * std::mem::size_of::<[u32; 3]>()
            + self.tri_boxes.len() * std::mem::size_of::<Aabb3>()
            + self.bvh.nodes.len() * std::mem::size_of::<crate::bvh::Node>()
            + self.bvh.items.len() * std::mem::size_of::<u32>()
    }

    #[inline]
    fn tri_corners(&self, tri_idx: u32) -> Option<[DVec3; 3]> {
        triangle_corners(&self.mesh, *self.mesh.triangles.get(tri_idx as usize)?)
    }
}

#[inline]
fn triangle_corners(mesh: &Mesh, tri: [u32; 3]) -> Option<[DVec3; 3]> {
    let a = *mesh.positions.get(tri[0] as usize)?;
    let b = *mesh.positions.get(tri[1] as usize)?;
    let c = *mesh.positions.get(tri[2] as usize)?;
    if a.is_finite() && b.is_finite() && c.is_finite() {
        Some([a, b, c])
    } else {
        None
    }
}

/// Tests two prepared meshes for a hard clash and, when `clearance_m > 0`, a soft clash.
///
/// Guarantees:
/// - Touching faces with zero penetration are NOT a hard clash.
/// - Any real interior penetration returns `Some(ClashOutcome::Hard { .. })`.
/// - When `clearance_m > 0.0` and no hard clash occurs, returns `Some(ClashOutcome::Soft { .. })`
///   if and only if `min_surface_distance < clearance_m`.
pub fn test_pair(a: &ClashMesh, b: &ClashMesh, clearance_m: f64) -> Option<ClashOutcome> {
    let clearance = if clearance_m.is_finite() && clearance_m > 0.0 {
        clearance_m
    } else {
        0.0
    };

    // Quick AABB rejection.
    if !a.bounds.overlaps(&b.bounds, clearance) {
        return None;
    }

    // 1. Hard clash test: requires strictly positive AABB overlap (> EPS on all 3 axes).
    if a.bounds.strict_overlaps(&b.bounds, EPS)
        && let Some(hard) = detect_hard_clash(a, b)
    {
        return Some(hard);
    }

    // 2. Soft clash test (only when clearance > 0).
    if clearance > 0.0 {
        let max_sq = clearance * clearance;
        let mut best_p_a = DVec3::ZERO;
        let mut best_p_b = DVec3::ZERO;
        let mut found = false;

        let best_sq = a.bvh.visit_closest_pairs(&b.bvh, max_sq, |ta_idx, tb_idx, best| {
            let (Some(ta), Some(tb)) = (a.tri_corners(ta_idx), b.tri_corners(tb_idx)) else {
                return;
            };
            if a.tri_boxes[ta_idx as usize].min_dist_sq(&b.tri_boxes[tb_idx as usize]) >= *best {
                return;
            }
            let (d2, pa, pb) = tri_tri_closest_points(ta, tb);
            if d2 < *best {
                *best = d2;
                best_p_a = pa;
                best_p_b = pb;
                found = true;
            }
        });

        if found {
            let gap = best_sq.sqrt();
            if gap < clearance - 1e-9 {
                return Some(ClashOutcome::Soft {
                    gap_m: gap,
                    point: (best_p_a + best_p_b) * 0.5,
                });
            }
        }
    }

    None
}

#[derive(Debug, Clone, Copy)]
enum TriCross {
    /// Both triangles strictly straddle each other's plane and cross on an interior segment.
    Proper { p0: DVec3, p1: DVec3 },
    /// One triangle strictly straddles the other's plane while touching/crossing along an edge.
    /// Occurs in both aligned overlapping boxes and rotated T-junction touching, so it needs
    /// solid-overlap confirmation.
    OneSided {
        p0: DVec3,
        p1: DVec3,
        /// Whether triangle A (true) or triangle B (false) straddled the other's plane.
        a_straddles: bool,
    },
}

fn detect_hard_clash(a: &ClashMesh, b: &ClashMesh) -> Option<ClashOutcome> {
    let mut proper_count = 0usize;
    let mut one_sided_count = 0usize;
    let mut cross_min = DVec3::INFINITY;
    let mut cross_max = DVec3::NEG_INFINITY;
    let mut cross_sum = DVec3::ZERO;
    let mut cross_pts = 0usize;
    let mut probe_points_in_b: Vec<DVec3> = Vec::new();
    let mut probe_points_in_a: Vec<DVec3> = Vec::new();

    const MAX_COLLECTED_CROSSINGS: usize = 64;

    a.bvh.visit_overlapping_pairs(&b.bvh, 0.0, |ta_idx, tb_idx| {
        if !a.tri_boxes[ta_idx as usize].overlaps(&b.tri_boxes[tb_idx as usize], EPS) {
            return false;
        }
        let (Some(ta), Some(tb)) = (a.tri_corners(ta_idx), b.tri_corners(tb_idx)) else {
            return false;
        };
        let Some(cross) = tri_tri_cross(ta, tb) else {
            return false;
        };
        match cross {
            TriCross::Proper { p0, p1 } => {
                proper_count += 1;
                cross_min = cross_min.min(p0).min(p1);
                cross_max = cross_max.max(p0).max(p1);
                cross_sum += (p0 + p1) * 0.5;
                cross_pts += 1;
            }
            TriCross::OneSided {
                p0,
                p1,
                a_straddles,
            } => {
                one_sided_count += 1;
                cross_min = cross_min.min(p0).min(p1);
                cross_max = cross_max.max(p0).max(p1);
                cross_sum += (p0 + p1) * 0.5;
                cross_pts += 1;
                if a_straddles && probe_points_in_b.len() < 16 {
                    let mid = (p0 + p1) * 0.5;
                    for &v in &ta {
                        if b.bounds.overlaps(&Aabb3::from_min_max(v, v), 0.0) {
                            probe_points_in_b.push((mid + v) * 0.5);
                        }
                    }
                } else if !a_straddles && probe_points_in_a.len() < 16 {
                    let mid = (p0 + p1) * 0.5;
                    for &v in &tb {
                        if a.bounds.overlaps(&Aabb3::from_min_max(v, v), 0.0) {
                            probe_points_in_a.push((mid + v) * 0.5);
                        }
                    }
                }
            }
        }
        proper_count + one_sided_count >= MAX_COLLECTED_CROSSINGS
    });

    // Check full containment if no triangle crossings were found.
    let contained_point = if proper_count == 0 && one_sided_count == 0 {
        find_contained_point(a, b)
    } else {
        None
    };

    if proper_count == 0 && one_sided_count == 0 && contained_point.is_none() {
        return None;
    }

    // Use sovereign CSG (D-009) when both meshes are closed and within the BSP triangle budget.
    // This gives exact intersection volume and penetration depth AND cleanly rejects zero-volume
    // grazing / T-junction touches between closed solids.
    if a.closed
        && b.closed
        && a.mesh.triangles.len() + b.mesh.triangles.len() <= MAX_CSG_TRIANGLES
        && let Ok(inter) = csg::intersect(&a.mesh, &b.mesh)
    {
        let vol = inter.volume();
        if vol > MIN_CLASH_VOLUME {
            let ib = Aabb3::from_points(inter.positions.iter().copied())
                .unwrap_or_else(|| a.bounds.union(&b.bounds));
            let penetration = ib.extent().min_element().max(EPS);
            return Some(ClashOutcome::Hard {
                penetration_m: penetration,
                volume_m3: Some(vol),
                point: ib.center(),
            });
        }
        // Two closed solids whose CSG intersection has zero volume only graze/touch.
        return None;
    }

    // Fallback (open meshes, large meshes > MAX_CSG_TRIANGLES, or CSG TooComplex):
    // Proper crossings and confirmed containment are always real hard clashes.
    // One-sided crossings must show an actual interior point (to reject rotated T-junctions).
    let confirmed = proper_count > 0
        || contained_point.is_some()
        || probe_points_in_b.iter().any(|&p| point_strictly_inside(b, p))
        || probe_points_in_a.iter().any(|&p| point_strictly_inside(a, p))
        || find_contained_point(a, b).is_some();

    if !confirmed {
        return None;
    }

    let (point, penetration_m) = if cross_pts > 0 {
        let overlap_min = a.bounds.min.max(b.bounds.min);
        let overlap_max = a.bounds.max.min(b.bounds.max);
        let aabb_depth = (overlap_max - overlap_min).min_element().max(0.0);
        let cross_ext = (cross_max - cross_min).max(DVec3::ZERO);
        // Use the smaller of crossing extent (if 3D) or AABB overlap minimum axis.
        let est = if cross_ext.min_element() > EPS {
            cross_ext.min_element().min(aabb_depth)
        } else {
            aabb_depth
        };
        (cross_sum / cross_pts as f64, est.max(EPS))
    } else {
        let p = contained_point.unwrap_or_else(|| {
            let overlap_min = a.bounds.min.max(b.bounds.min);
            let overlap_max = a.bounds.max.min(b.bounds.max);
            (overlap_min + overlap_max) * 0.5
        });
        let overlap_min = a.bounds.min.max(b.bounds.min);
        let overlap_max = a.bounds.max.min(b.bounds.max);
        let depth = (overlap_max - overlap_min).min_element().max(EPS);
        (p, depth)
    };

    Some(ClashOutcome::Hard {
        penetration_m,
        volume_m3: None,
        point,
    })
}

/// Classifies the plane-intersection overlap between two non-coplanar triangles in relative `f64`.
fn tri_tri_cross(a_world: [DVec3; 3], b_world: [DVec3; 3]) -> Option<TriCross> {
    let origin = a_world[0];
    let a = a_world.map(|p| p - origin);
    let b = b_world.map(|p| p - origin);

    let na = (a[1] - a[0]).cross(a[2] - a[0]);
    let na_len = na.length();
    if na_len <= 1e-12 {
        return None;
    }
    let na = na / na_len;

    let nb = (b[1] - b[0]).cross(b[2] - b[0]);
    let nb_len = nb.length();
    if nb_len <= 1e-12 {
        return None;
    }
    let nb = nb / nb_len;

    let da = [
        nb.dot(a[0] - b[0]),
        nb.dot(a[1] - b[0]),
        nb.dot(a[2] - b[0]),
    ];
    let da_min = da[0].min(da[1]).min(da[2]);
    let da_max = da[0].max(da[1]).max(da[2]);
    if da_max < -EPS || da_min > EPS {
        return None;
    }
    if da_min >= -EPS && da_max <= EPS {
        // Coplanar: touching faces on the same plane have zero penetration.
        return None;
    }

    let db = [
        na.dot(b[0] - a[0]),
        na.dot(b[1] - a[0]),
        na.dot(b[2] - a[0]),
    ];
    let db_min = db[0].min(db[1]).min(db[2]);
    let db_max = db[0].max(db[1]).max(db[2]);
    if db_max < -EPS || db_min > EPS {
        return None;
    }
    if db_min >= -EPS && db_max <= EPS {
        return None;
    }

    let strict_a = da_min < -EPS && da_max > EPS;
    let strict_b = db_min < -EPS && db_max > EPS;
    if !strict_a && !strict_b {
        // Neither triangle straddles the other's plane: edge/vertex touch only.
        return None;
    }

    let line_dir = na.cross(nb);
    let dir_len = line_dir.length();
    if dir_len <= 1e-12 {
        return None;
    }
    let line_dir = line_dir / dir_len;

    let (ta0, ta1, pa0, pa1) = plane_clip_interval(a, da, line_dir)?;
    let (tb0, tb1, pb0, pb1) = plane_clip_interval(b, db, line_dir)?;

    let lo = ta0.max(tb0);
    let hi = ta1.min(tb1);
    if hi - lo <= EPS {
        return None;
    }

    let p0 = if ta0 >= tb0 { pa0 } else { pb0 } + origin;
    let p1 = if ta1 <= tb1 { pa1 } else { pb1 } + origin;

    if strict_a && strict_b {
        Some(TriCross::Proper { p0, p1 })
    } else {
        Some(TriCross::OneSided {
            p0,
            p1,
            a_straddles: strict_a,
        })
    }
}

/// Computes the 1D interval `[t_min, t_max]` and corresponding 3D endpoints where `tri`
/// meets a plane given signed vertex distances `d`, projected onto unit direction `line_dir`.
fn plane_clip_interval(
    tri: [DVec3; 3],
    d: [f64; 3],
    line_dir: DVec3,
) -> Option<(f64, f64, DVec3, DVec3)> {
    let mut pts = [DVec3::ZERO; 6];
    let mut count = 0usize;

    for i in 0..3 {
        let j = (i + 1) % 3;
        let di = d[i];
        let dj = d[j];
        if di.abs() <= EPS {
            pts[count] = tri[i];
            count += 1;
        }
        if (di > EPS && dj < -EPS) || (di < -EPS && dj > EPS) {
            let t = di / (di - dj);
            pts[count] = tri[i] + (tri[j] - tri[i]) * t;
            count += 1;
        }
    }
    if count < 2 {
        return None;
    }

    let mut t_min = f64::INFINITY;
    let mut t_max = f64::NEG_INFINITY;
    let mut p_min = pts[0];
    let mut p_max = pts[0];
    for &p in &pts[..count] {
        let proj = line_dir.dot(p);
        if proj < t_min {
            t_min = proj;
            p_min = p;
        }
        if proj > t_max {
            t_max = proj;
            p_max = p;
        }
    }
    Some((t_min, t_max, p_min, p_max))
}

/// Searches for a point of `a` strictly inside `b` or a point of `b` strictly inside `a`.
fn find_contained_point(a: &ClashMesh, b: &ClashMesh) -> Option<DVec3> {
    if let Some(p) = sample_point_inside(a, b) {
        return Some(p);
    }
    sample_point_inside(b, a)
}

fn sample_point_inside(src: &ClashMesh, target: &ClashMesh) -> Option<DVec3> {
    // Check up to 16 triangle centroids and vertices of `src` that fall inside `target.bounds`.
    let mut tested = 0usize;
    for (idx, tb) in src.tri_boxes.iter().enumerate() {
        if !tb.overlaps(&target.bounds, 0.0) {
            continue;
        }
        let Some(corners) = src.tri_corners(idx as u32) else {
            continue;
        };
        let centroid = (corners[0] + corners[1] + corners[2]) / 3.0;
        if point_strictly_inside(target, centroid) {
            return Some(centroid);
        }
        tested += 1;
        if tested >= 16 {
            break;
        }
    }
    None
}

/// Returns true if `p` is strictly inside `mesh` (not on its boundary within `SURFACE_EPS`),
/// using a 3-ray majority-vote parity test over `mesh.bvh`.
fn point_strictly_inside(mesh: &ClashMesh, p: DVec3) -> bool {
    if !mesh.bounds.overlaps(&Aabb3::from_min_max(p, p), -SURFACE_EPS) {
        return false;
    }

    // Reject points lying on or within SURFACE_EPS of the boundary surface.
    let probe_box = Aabb3::from_min_max(p, p).expand(SURFACE_EPS);
    let mut near = Vec::new();
    mesh.bvh.query_aabb(&probe_box, 0.0, &mut near);
    let surf_sq = SURFACE_EPS * SURFACE_EPS;
    for tri_idx in near {
        if let Some(corners) = mesh.tri_corners(tri_idx) {
            let closest = closest_point_on_triangle(p, corners);
            if p.distance_squared(closest) <= surf_sq {
                return false;
            }
        }
    }

    let mut inside_votes = 0u32;
    for dir in RAY_DIRS {
        let mut hits = 0u32;
        mesh.bvh.visit_ray(p, dir, |tri_idx| {
            if let Some(corners) = mesh.tri_corners(tri_idx)
                && ray_intersects_triangle(p, dir, corners)
            {
                hits += 1;
            }
        });
        if hits % 2 == 1 {
            inside_votes += 1;
        }
    }
    inside_votes >= 2
}

/// Möller-Trumbore ray-triangle intersection for `t > 0`.
fn ray_intersects_triangle(origin: DVec3, dir: DVec3, tri: [DVec3; 3]) -> bool {
    let e1 = tri[1] - tri[0];
    let e2 = tri[2] - tri[0];
    let h = dir.cross(e2);
    let det = e1.dot(h);
    if det.abs() <= 1e-14 {
        return false;
    }
    let inv_det = 1.0 / det;
    let s = origin - tri[0];
    let u = inv_det * s.dot(h);
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = s.cross(e1);
    let v = inv_det * dir.dot(q);
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    let t = inv_det * e2.dot(q);
    t > 1e-9
}

/// Exact minimum squared Euclidean distance and closest points between two 3D triangles.
pub(crate) fn tri_tri_closest_points(a_world: [DVec3; 3], b_world: [DVec3; 3]) -> (f64, DVec3, DVec3) {
    let origin = a_world[0];
    let a = a_world.map(|p| p - origin);
    let b = b_world.map(|p| p - origin);

    let mut best_sq = f64::INFINITY;
    let mut best_a = a[0];
    let mut best_b = b[0];

    // 1. All 9 edge-to-edge pairs.
    for i in 0..3 {
        let a0 = a[i];
        let a1 = a[(i + 1) % 3];
        for j in 0..3 {
            let b0 = b[j];
            let b1 = b[(j + 1) % 3];
            let (pa, pb) = seg_seg_closest_points(a0, a1, b0, b1);
            let d2 = pa.distance_squared(pb);
            if d2 < best_sq {
                best_sq = d2;
                best_a = pa;
                best_b = pb;
            }
        }
    }

    // 2. Vertices of A to triangle B.
    for &va in &a {
        let pb = closest_point_on_triangle(va, b);
        let d2 = va.distance_squared(pb);
        if d2 < best_sq {
            best_sq = d2;
            best_a = va;
            best_b = pb;
        }
    }

    // 3. Vertices of B to triangle A.
    for &vb in &b {
        let pa = closest_point_on_triangle(vb, a);
        let d2 = pa.distance_squared(vb);
        if d2 < best_sq {
            best_sq = d2;
            best_a = pa;
            best_b = vb;
        }
    }

    (best_sq, best_a + origin, best_b + origin)
}

/// Closest point on triangle `tri` to point `p` (Voronoi region classification).
fn closest_point_on_triangle(p: DVec3, tri: [DVec3; 3]) -> DVec3 {
    let [a, b, c] = tri;
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;

    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }

    let bp = p - b;
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return a + ab * v;
    }

    let cp = p - c;
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return a + ac * w;
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return b + (c - b) * w;
    }

    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    a + ab * v + ac * w
}

/// Closest pair of points between segments `[p1, q1]` and `[p2, q2]`.
fn seg_seg_closest_points(p1: DVec3, q1: DVec3, p2: DVec3, q2: DVec3) -> (DVec3, DVec3) {
    let d1 = q1 - p1;
    let d2 = q2 - p2;
    let r = p1 - p2;
    let a = d1.dot(d1);
    let e = d2.dot(d2);
    let f = d2.dot(r);

    let (s, t) = if a <= 1e-20 && e <= 1e-20 {
        (0.0, 0.0)
    } else if a <= 1e-20 {
        (0.0, (f / e).clamp(0.0, 1.0))
    } else {
        let c = d1.dot(r);
        if e <= 1e-20 {
            ((-c / a).clamp(0.0, 1.0), 0.0)
        } else {
            let b = d1.dot(d2);
            let denom = a * e - b * b;
            let mut s = if denom != 0.0 {
                ((b * f - c * e) / denom).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let mut t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
            (s, t)
        }
    };

    (p1 + d1 * s, p2 + d2 * t)
}
