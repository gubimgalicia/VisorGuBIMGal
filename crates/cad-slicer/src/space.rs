//! Plan space labels: name, area (m²) and a guaranteed interior point for each cut `IfcSpace`.

use crate::cut::{self, Frame};
use crate::geom::Loop;
use glam::DVec2;
use ifc_geometry::Mesh;

/// Where a space label's area comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AreaSource {
    /// From an `IfcQuantityArea` attached to the `IfcSpace` (converted to m²).
    Quantity,
    /// Computed from the 2D polygon area of the plan cut outline (m²).
    Outline,
}

/// One `IfcSpace` supplied to the slicer for plan labelling.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpaceInput {
    pub model_id: u32,
    pub element_id: u32,
    /// Display name from IFC (`Name` / `LongName`): untrusted text.
    pub name: String,
    /// Optional explicit area in m² from `IfcQuantityArea`; preferred over the cut outline.
    pub quantity_area_m2: Option<f64>,
    pub mesh: Mesh,
}

/// One space label placed on a plan drawing.
#[derive(Debug, Clone, PartialEq)]
pub struct SpaceLabel {
    pub model_id: u32,
    pub element_id: u32,
    pub name: String,
    /// Area in square metres.
    pub area_m2: f64,
    pub area_source: AreaSource,
    /// Point strictly inside the cut outline, in drawing coordinates.
    pub position: DVec2,
}

const MIN_SPACE_AREA: f64 = 1e-4;

/// Cuts each space against the plan frame and produces a deterministic list of labels.
pub(crate) fn extract_space_labels(spaces: &[SpaceInput], frame: &Frame) -> Vec<SpaceLabel> {
    let mut labels = Vec::new();
    for space in spaces {
        let mut loops = Vec::new();
        cut::cut_mesh(&space.mesh, frame, &mut loops);
        let closed: Vec<Loop> = loops
            .into_iter()
            .filter(|ring| ring.closed && ring.points.len() >= 3)
            .collect();
        if closed.is_empty() {
            continue;
        }
        let outline_area = closed.iter().map(Loop::area).sum::<f64>().abs();
        if !outline_area.is_finite() || outline_area < MIN_SPACE_AREA {
            continue;
        }
        let Some(position) = interior_point(&closed) else {
            continue;
        };
        let (area_m2, area_source) = match space.quantity_area_m2 {
            Some(area) if area.is_finite() && area > 0.0 => (area, AreaSource::Quantity),
            _ => (outline_area, AreaSource::Outline),
        };
        labels.push(SpaceLabel {
            model_id: space.model_id,
            element_id: space.element_id,
            name: space.name.clone(),
            area_m2,
            area_source,
            position,
        });
    }
    labels.sort_by_key(|label| (label.model_id, label.element_id));
    labels
}

/// Even-odd point-in-polygon test against all closed rings of a space (handles holes).
pub(crate) fn point_in_loops(point: DVec2, loops: &[Loop]) -> bool {
    let mut inside = false;
    for ring in loops {
        if !ring.closed || ring.points.len() < 3 {
            continue;
        }
        for (a, b) in ring.segments() {
            let crosses = (a.y > point.y) != (b.y > point.y);
            if crosses {
                let x_hit = a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y);
                if point.x < x_hit {
                    inside = !inside;
                }
            }
        }
    }
    inside
}

/// Squared distance from `p` to segment `(a, b)`.
fn point_segment_dist_sq(p: DVec2, a: DVec2, b: DVec2) -> f64 {
    let ab = b - a;
    let len_sq = ab.length_squared();
    if len_sq <= 1e-18 {
        return p.distance_squared(a);
    }
    let t = ((p - a).dot(ab) / len_sq).clamp(0.0, 1.0);
    p.distance_squared(a + ab * t)
}

/// Minimum distance from `p` to any boundary segment of `loops`.
fn boundary_distance_sq(p: DVec2, loops: &[Loop]) -> f64 {
    let mut best = f64::INFINITY;
    for ring in loops {
        for (a, b) in ring.segments() {
            best = best.min(point_segment_dist_sq(p, a, b));
        }
    }
    best
}

/// Area-weighted centroid of a single closed polygon, computed relative to its first vertex.
fn loop_centroid(ring: &Loop) -> Option<DVec2> {
    let n = ring.points.len();
    if n < 3 {
        return None;
    }
    let origin = ring.points[0];
    let mut twice_area = 0.0;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..n {
        let p0 = ring.points[i] - origin;
        let p1 = ring.points[(i + 1) % n] - origin;
        let cross = p0.perp_dot(p1);
        twice_area += cross;
        cx += (p0.x + p1.x) * cross;
        cy += (p0.y + p1.y) * cross;
    }
    if twice_area.abs() < 1e-12 {
        return None;
    }
    let centroid = origin + DVec2::new(cx / (3.0 * twice_area), cy / (3.0 * twice_area));
    centroid.is_finite().then_some(centroid)
}

/// Finds a deterministic point strictly inside the space outline, maximizing clearance from edges.
///
/// Tries the centroid of the largest ring plus horizontal scanline midpoints across both a regular
/// grid and vertex-band midpoints, so non-convex L/U shapes and rings with holes always land
/// strictly inside the widest interior region.
pub(crate) fn interior_point(loops: &[Loop]) -> Option<DVec2> {
    let largest = loops
        .iter()
        .filter(|ring| ring.closed && ring.points.len() >= 3)
        .max_by(|a, b| a.area().abs().total_cmp(&b.area().abs()))?;

    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut ys = Vec::new();
    for ring in loops {
        for p in &ring.points {
            if p.is_finite() {
                min_y = min_y.min(p.y);
                max_y = max_y.max(p.y);
                ys.push(p.y);
            }
        }
    }
    if !min_y.is_finite() || !max_y.is_finite() || max_y <= min_y {
        return None;
    }

    let mut best: Option<(f64, DVec2)> = None;
    let mut consider = |candidate: DVec2| {
        if !candidate.is_finite() || !point_in_loops(candidate, loops) {
            return;
        }
        let dist_sq = boundary_distance_sq(candidate, loops);
        if best.is_none_or(|(best_d, _)| dist_sq > best_d) {
            best = Some((dist_sq, candidate));
        }
    };

    if let Some(centroid) = loop_centroid(largest) {
        consider(centroid);
    }

    // Build deterministic scanline Y coordinates: 16 uniform slices + midpoints of distinct vertex Ys.
    let mut scan_ys = Vec::with_capacity(32);
    const GRID_STEPS: usize = 16;
    for step in 1..GRID_STEPS {
        scan_ys.push(min_y + (max_y - min_y) * (step as f64 / GRID_STEPS as f64));
    }
    ys.sort_by(f64::total_cmp);
    ys.dedup_by(|a, b| (*a - *b).abs() < 1e-7);
    for pair in ys.windows(2) {
        scan_ys.push((pair[0] + pair[1]) * 0.5);
    }

    let mut xs = Vec::new();
    for y in scan_ys {
        xs.clear();
        for ring in loops {
            if !ring.closed || ring.points.len() < 3 {
                continue;
            }
            for (a, b) in ring.segments() {
                if (a.y > y) != (b.y > y) {
                    let x = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
                    if x.is_finite() {
                        xs.push(x);
                    }
                }
            }
        }
        xs.sort_by(f64::total_cmp);
        for span in xs.as_chunks::<2>().0 {
            if span[1] - span[0] > 1e-6 {
                consider(DVec2::new((span[0] + span[1]) * 0.5, y));
            }
        }
    }

    best.map(|(_, point)| point)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Cut;
    use glam::DVec3;

    fn rect_loop(x0: f64, y0: f64, x1: f64, y1: f64, ccw: bool) -> Loop {
        let mut pts = vec![
            DVec2::new(x0, y0),
            DVec2::new(x1, y0),
            DVec2::new(x1, y1),
            DVec2::new(x0, y1),
        ];
        if !ccw {
            pts.reverse();
        }
        Loop { points: pts, closed: true }
    }

    fn box_mesh(min: DVec3, max: DVec3) -> Mesh {
        let positions = vec![
            DVec3::new(min.x, min.y, min.z),
            DVec3::new(max.x, min.y, min.z),
            DVec3::new(max.x, max.y, min.z),
            DVec3::new(min.x, max.y, min.z),
            DVec3::new(min.x, min.y, max.z),
            DVec3::new(max.x, min.y, max.z),
            DVec3::new(max.x, max.y, max.z),
            DVec3::new(min.x, max.y, max.z),
        ];
        let triangles = vec![
            [0, 2, 1], [0, 3, 2],
            [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4],
            [2, 3, 7], [2, 7, 6],
            [1, 2, 6], [1, 6, 5],
            [3, 0, 4], [3, 4, 7],
        ];
        Mesh { positions, triangles }
    }

    #[test]
    fn interior_point_is_centre_for_rectangle() {
        let loops = vec![rect_loop(1.0, 2.0, 5.0, 6.0, true)];
        let p = interior_point(&loops).expect("interior point");
        assert!((p.x - 3.0).abs() < 1e-9 && (p.y - 4.0).abs() < 1e-9, "{p:?}");
        assert!(point_in_loops(p, &loops));
    }

    #[test]
    fn interior_point_stays_inside_concave_l_shape() {
        // Thin L-shape whose bounding-box centre and centroid both lie outside the polygon.
        let l_shape = Loop {
            points: vec![
                DVec2::new(0.0, 0.0),
                DVec2::new(10.0, 0.0),
                DVec2::new(10.0, 1.0),
                DVec2::new(1.0, 1.0),
                DVec2::new(1.0, 10.0),
                DVec2::new(0.0, 10.0),
            ],
            closed: true,
        };
        let loops = vec![l_shape];
        let centroid = loop_centroid(&loops[0]).unwrap();
        assert!(!point_in_loops(centroid, &loops), "centroid should fall outside this thin L");
        let p = interior_point(&loops).expect("interior point");
        assert!(point_in_loops(p, &loops), "point {p:?} must lie strictly inside the L");
    }

    #[test]
    fn interior_point_avoids_central_hole() {
        // 10x10 room with a 6x6 central core: centre (5, 5) is inside the hole.
        let loops = vec![
            rect_loop(0.0, 0.0, 10.0, 10.0, true),
            rect_loop(2.0, 2.0, 8.0, 8.0, false),
        ];
        assert!(!point_in_loops(DVec2::new(5.0, 5.0), &loops));
        let p = interior_point(&loops).expect("interior point");
        assert!(point_in_loops(p, &loops), "point {p:?} landed inside hole");
    }

    #[test]
    fn prefers_quantity_area_and_falls_back_to_outline() {
        let frame = Frame::of(Cut::Plan { z: 1.5 }).unwrap();
        let spaces = vec![
            SpaceInput {
                model_id: 0,
                element_id: 10,
                name: "Room A".into(),
                quantity_area_m2: Some(25.5),
                mesh: box_mesh(DVec3::new(0.0, 0.0, 0.0), DVec3::new(4.0, 5.0, 3.0)),
            },
            SpaceInput {
                model_id: 0,
                element_id: 20,
                name: "Room B".into(),
                quantity_area_m2: None,
                mesh: box_mesh(DVec3::new(5.0, 0.0, 0.0), DVec3::new(9.0, 5.0, 3.0)),
            },
            SpaceInput {
                model_id: 0,
                element_id: 30,
                name: "Upper Room".into(),
                quantity_area_m2: Some(12.0),
                mesh: box_mesh(DVec3::new(0.0, 0.0, 4.0), DVec3::new(4.0, 3.0, 7.0)),
            },
        ];
        let labels = extract_space_labels(&spaces, &frame);
        assert_eq!(labels.len(), 2, "Upper Room is not cut by z=1.5");
        assert_eq!(labels[0].name, "Room A");
        assert!((labels[0].area_m2 - 25.5).abs() < 1e-9);
        assert_eq!(labels[0].area_source, AreaSource::Quantity);
        assert_eq!(labels[1].name, "Room B");
        assert!((labels[1].area_m2 - 20.0).abs() < 1e-9);
        assert_eq!(labels[1].area_source, AreaSource::Outline);
    }
}
