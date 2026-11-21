use clash_detector::{Aabb3, BroadItem, ClashMesh, ClashOutcome, broad_phase_pairs, test_pair};
use glam::{DMat3, DVec3};
use ifc_geometry::Mesh;

fn box_mesh(min: [f64; 3], max: [f64; 3]) -> ClashMesh {
    ClashMesh::new(Mesh::cuboid(DVec3::from_array(min), DVec3::from_array(max)))
        .expect("non-empty cuboid")
}

fn rotated_box_mesh(min: [f64; 3], max: [f64; 3], angle_z_rad: f64) -> ClashMesh {
    let rot = DMat3::from_rotation_z(angle_z_rad);
    let m = Mesh::cuboid(DVec3::from_array(min), DVec3::from_array(max)).map_positions(|p| rot * p);
    ClashMesh::new(m).expect("non-empty rotated cuboid")
}

#[test]
fn touching_faces_are_not_a_clash() {
    let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let b = box_mesh([1.0, 0.0, 0.0], [2.0, 1.0, 1.0]);
    assert_eq!(test_pair(&a, &b, 0.0), None);

    // Flush T-junction touching: smaller box resting against middle of a larger face.
    let c = box_mesh([1.0, 0.2, 0.2], [2.0, 0.8, 0.8]);
    assert_eq!(test_pair(&a, &c, 0.0), None);

    // Same T-junction rotated 35 degrees so AABBs strictly overlap while solids still only touch.
    let a_rot = rotated_box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], 0.61);
    let c_rot = rotated_box_mesh([1.0, 0.2, 0.2], [2.0, 0.8, 0.8], 0.61);
    assert!(a_rot.bounds.strict_overlaps(&c_rot.bounds, 1e-6));
    assert_eq!(test_pair(&a_rot, &c_rot, 0.0), None);
}

#[test]
fn one_millimetre_overlap_is_a_hard_clash() {
    let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let b = box_mesh([0.999, 0.0, 0.0], [1.999, 1.0, 1.0]);

    let outcome = test_pair(&a, &b, 0.0).expect("1 mm overlap must be detected as hard clash");
    match outcome {
        ClashOutcome::Hard {
            penetration_m,
            volume_m3,
            point,
        } => {
            assert!(
                (penetration_m - 0.001).abs() < 1e-6,
                "expected 1 mm penetration, got {penetration_m}"
            );
            let vol = volume_m3.expect("closed boxes should report CSG volume");
            assert!(
                (vol - 0.001).abs() < 1e-6,
                "expected 0.001 m^3 volume, got {vol}"
            );
            assert!((point.x - 0.9995).abs() < 1e-5);
            assert!((point.y - 0.5).abs() < 1e-5);
            assert!((point.z - 0.5).abs() < 1e-5);
        }
        other => panic!("expected hard clash, got {other:?}"),
    }
}

#[test]
fn fifty_mm_gap_is_soft_clash_at_60mm_and_none_at_40mm() {
    let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let b = box_mesh([1.050, 0.0, 0.0], [2.050, 1.0, 1.0]);

    // Hard clash mode: none.
    assert_eq!(test_pair(&a, &b, 0.0), None);

    // 40 mm clearance: 50 mm gap is safe -> none.
    assert_eq!(test_pair(&a, &b, 0.040), None);

    // 60 mm clearance: 50 mm gap is a soft clash with gap ~ 0.050 m.
    let outcome = test_pair(&a, &b, 0.060).expect("50 mm gap must be a soft clash at 60 mm");
    match outcome {
        ClashOutcome::Soft { gap_m, point } => {
            assert!(
                (gap_m - 0.050).abs() < 1e-6,
                "expected 50 mm gap, got {gap_m}"
            );
            assert!((point.x - 1.025).abs() < 1e-5);
        }
        other => panic!("expected soft clash, got {other:?}"),
    }
}

#[test]
fn nested_box_inside_larger_box_is_hard_clash() {
    let outer = box_mesh([0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let inner = box_mesh([1.0, 1.0, 1.0], [2.0, 2.0, 2.0]);

    let outcome = test_pair(&outer, &inner, 0.0).expect("nested box must be a hard clash");
    match outcome {
        ClashOutcome::Hard {
            penetration_m,
            volume_m3,
            point,
        } => {
            assert!((penetration_m - 1.0).abs() < 1e-6);
            assert!((volume_m3.unwrap() - 1.0).abs() < 1e-6);
            assert!((point - DVec3::new(1.5, 1.5, 1.5)).length() < 1e-5);
        }
        other => panic!("expected hard clash, got {other:?}"),
    }
}

#[test]
fn utm_coordinates_preserve_millimetre_accuracy() {
    let shift = [500_000.0, 4_700_000.0, 350.0];
    let add = |p: [f64; 3]| [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]];

    let a = box_mesh(add([0.0, 0.0, 0.0]), add([1.0, 1.0, 1.0]));
    let b_touch = box_mesh(add([1.0, 0.0, 0.0]), add([2.0, 1.0, 1.0]));
    let b_hit = box_mesh(add([0.999, 0.0, 0.0]), add([1.999, 1.0, 1.0]));
    let b_gap = box_mesh(add([1.050, 0.0, 0.0]), add([2.050, 1.0, 1.0]));

    assert_eq!(test_pair(&a, &b_touch, 0.0), None);
    assert!(matches!(test_pair(&a, &b_hit, 0.0), Some(ClashOutcome::Hard { .. })));
    assert_eq!(test_pair(&a, &b_gap, 0.040), None);
    assert!(matches!(test_pair(&a, &b_gap, 0.060), Some(ClashOutcome::Soft { .. })));
}

#[test]
fn broad_phase_prunes_non_overlapping_and_deduplicates_self_and_symmetric_pairs() {
    let items = vec![
        BroadItem {
            model_index: 0,
            express_id: 1,
            bounds: Aabb3::from_min_max(DVec3::new(0.0, 0.0, 0.0), DVec3::new(1.0, 1.0, 1.0)),
        },
        BroadItem {
            model_index: 0,
            express_id: 2,
            bounds: Aabb3::from_min_max(DVec3::new(0.5, 0.0, 0.0), DVec3::new(1.5, 1.0, 1.0)),
        },
        BroadItem {
            model_index: 0,
            express_id: 3,
            bounds: Aabb3::from_min_max(DVec3::new(10.0, 0.0, 0.0), DVec3::new(11.0, 1.0, 1.0)),
        },
    ];
    let pairs = broad_phase_pairs(&items, &items, 0.0);
    assert_eq!(pairs, vec![(0, 1)]);
}

#[test]
fn rotated_one_mm_overlap_and_open_sheet_pierce_are_detected() {
    // Rotated boxes overlapping by 1 mm along their local X axis.
    let a_rot = rotated_box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], 0.52);
    let b_rot = rotated_box_mesh([0.999, 0.0, 0.0], [1.999, 1.0, 1.0], 0.52);
    let hit = test_pair(&a_rot, &b_rot, 0.0).expect("rotated 1 mm overlap must clash");
    match hit {
        ClashOutcome::Hard { volume_m3, .. } => {
            let vol = volume_m3.expect("rotated closed boxes should report CSG volume");
            assert!((vol - 0.001).abs() < 1e-5, "expected ~0.001 m^3, got {vol}");
        }
        other => panic!("expected hard clash, got {other:?}"),
    }

    // Open mesh (cuboid missing its top face) pierced by a solid box -> non-CSG fallback.
    let mut open_box = Mesh::cuboid(DVec3::ZERO, DVec3::ONE);
    open_box.triangles.truncate(10); // drop 2 triangles -> open shell
    let open = ClashMesh::new(open_box).expect("open box");
    assert!(!open.closed);
    let piercer = box_mesh([0.5, 0.2, 0.2], [1.5, 0.8, 0.8]);
    let open_hit = test_pair(&open, &piercer, 0.0).expect("pierced open shell must clash");
    assert!(matches!(open_hit, ClashOutcome::Hard { volume_m3: None, .. }));
}
