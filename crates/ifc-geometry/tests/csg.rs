//! Booleans checked against exact volumes, watertightness and volume conservation.

use glam::{DMat3, DVec3};
use ifc_geometry::{Mesh, intersect, subtract, subtract_all};
use std::time::Instant;

fn v(x: f64, y: f64, z: f64) -> DVec3 {
    DVec3::new(x, y, z)
}

/// A wall 10 m long, 0.3 m thick and 3 m high.
fn wall() -> Mesh {
    Mesh::cuboid(v(0.0, 0.0, 0.0), v(10.0, 0.3, 3.0))
}

#[track_caller]
fn assert_solid(mesh: &Mesh, volume: f64) {
    assert!((mesh.volume() - volume).abs() < 1e-6, "volume {} != {volume}", mesh.volume());
    assert_eq!(mesh.open_edges(), 0, "not watertight");
}

#[test]
fn opening_flush_with_both_wall_faces() {
    let cut = Mesh::cuboid(v(4.0, 0.0, 1.0), v(5.0, 0.3, 2.0));
    assert_solid(&subtract(&wall(), &cut).unwrap(), 9.0 - 0.3);
}

#[test]
fn opening_overshooting_the_wall() {
    let cut = Mesh::cuboid(v(4.0, -0.1, 1.0), v(5.0, 0.4, 2.0));
    assert_solid(&subtract(&wall(), &cut).unwrap(), 9.0 - 0.3);
}

#[test]
fn recess_that_does_not_pass_through() {
    let cut = Mesh::cuboid(v(4.0, 0.2, 1.0), v(5.0, 0.4, 2.0));
    assert_solid(&subtract(&wall(), &cut).unwrap(), 9.0 - 0.1);
}

#[test]
fn door_sharing_the_floor_plane() {
    let cut = Mesh::cuboid(v(4.0, 0.0, 0.0), v(5.0, 0.3, 2.1));
    assert_solid(&subtract(&wall(), &cut).unwrap(), 9.0 - 0.3 * 2.1);
}

#[test]
fn opening_at_a_corner_of_the_wall() {
    let cut = Mesh::cuboid(v(0.0, 0.0, 0.0), v(1.0, 0.3, 1.0));
    assert_solid(&subtract(&wall(), &cut).unwrap(), 9.0 - 0.3);
}

#[test]
fn opening_outside_the_solid_changes_nothing() {
    let cut = Mesh::cuboid(v(20.0, 0.0, 0.0), v(21.0, 1.0, 1.0));
    assert_solid(&subtract(&wall(), &cut).unwrap(), 9.0);
}

#[test]
fn opening_swallowing_the_solid_leaves_nothing() {
    let cut = Mesh::cuboid(v(-1.0, -1.0, -1.0), v(11.0, 1.0, 4.0));
    let result = subtract(&wall(), &cut).unwrap();
    assert!(result.is_empty(), "{} triangles left", result.triangles.len());
}

#[test]
fn identical_solids_cancel() {
    assert!(subtract(&wall(), &wall()).unwrap().is_empty());
}

#[test]
fn overlapping_openings_in_sequence() {
    let first = Mesh::cuboid(v(4.0, -0.1, 1.0), v(5.0, 0.4, 2.0));
    let second = Mesh::cuboid(v(4.5, -0.1, 1.5), v(5.5, 0.4, 2.5));
    let once = subtract(&wall(), &first).unwrap();
    let twice = subtract(&once, &second).unwrap();
    assert_solid(&twice, 9.0 - 0.3 - 0.3 + 0.3 * 0.25);
}

#[test]
fn opening_rotated_about_the_vertical() {
    let turn = DMat3::from_rotation_z(0.6);
    let center = v(5.0, 0.15, 1.5);
    let cut = Mesh::cuboid(v(-0.5, -1.0, -0.5), v(0.5, 1.0, 0.5))
        .map_positions(|p| center + turn * p);
    let result = subtract(&wall(), &cut).unwrap();
    assert_eq!(result.open_edges(), 0);
    // The cut is a parallelogram in plan: width / cos(0.6) by the wall thickness.
    let removed = 1.0 / 0.6_f64.cos() * 0.3 * 1.0;
    assert!((result.volume() - (9.0 - removed)).abs() < 1e-6, "{}", result.volume());
}

#[test]
fn fourteen_windows_in_one_wall() {
    let mut mesh = Mesh::cuboid(v(0.0, 0.0, 0.0), v(30.0, 0.3, 3.0));
    let mut expected = 27.0;
    for i in 0..14 {
        let x = 0.5 + i as f64 * 2.0;
        let cut = Mesh::cuboid(v(x, -0.1, 1.0), v(x + 1.2, 0.4, 2.2));
        mesh = subtract(&mesh, &cut).unwrap();
        expected -= 1.2 * 1.2 * 0.3;
    }
    assert_solid(&mesh, expected);
}

#[test]
fn fourteen_windows_in_one_pass() {
    let wall = Mesh::cuboid(v(0.0, 0.0, 0.0), v(30.0, 0.3, 3.0));
    let cuts: Vec<Mesh> = (0..14)
        .map(|i| {
            let x = 0.5 + i as f64 * 2.0;
            Mesh::cuboid(v(x, -0.1, 1.0), v(x + 1.2, 0.4, 2.2))
        })
        .collect();
    assert_solid(&subtract_all(&wall, &cuts).unwrap(), 27.0 - 14.0 * 1.2 * 1.2 * 0.3);
}

#[test]
fn overlapping_and_touching_cuts_in_one_call() {
    let cuts = [
        Mesh::cuboid(v(4.0, -0.1, 1.0), v(5.0, 0.4, 2.0)),
        Mesh::cuboid(v(4.5, -0.1, 1.5), v(5.5, 0.4, 2.5)),
        // Shares a whole face with the first.
        Mesh::cuboid(v(3.0, -0.1, 1.0), v(4.0, 0.4, 2.0)),
    ];
    assert_solid(
        &subtract_all(&wall(), &cuts).unwrap(),
        9.0 - 0.3 - 0.3 + 0.3 * 0.25 - 0.3,
    );
}

#[test]
fn no_cuts_returns_the_solid() {
    assert_solid(&subtract_all(&wall(), &[]).unwrap(), 9.0);
}

#[test]
fn one_pass_matches_sequential_cuts() {
    let mut rng = Rng(0xA076_1D64_78BD_642F);
    for round in 0..300 {
        let snap = round % 2 == 0;
        let solid = random_box(&mut rng, snap);
        let cuts: Vec<Mesh> = (0..5).map(|_| random_box(&mut rng, snap)).collect();
        let batched = subtract_all(&solid, &cuts).unwrap();
        let mut sequential = solid.clone();
        for cut in &cuts {
            sequential = subtract(&sequential, cut).unwrap();
        }
        assert_eq!(batched.open_edges(), 0, "round {round}: not watertight");
        let gap = (batched.volume() - sequential.volume()).abs();
        assert!(gap < 1e-6, "round {round}: volume gap {gap}");
    }
}

/// Exact remaining volume of axis-aligned boxes on a 0.05 m grid, by counting cells.
fn grid_volume(solid: &Mesh, cuts: &[Mesh]) -> f64 {
    let bounds = |mesh: &Mesh| {
        let min = mesh.positions.iter().fold(DVec3::INFINITY, |a, p| a.min(*p));
        let max = mesh.positions.iter().fold(DVec3::NEG_INFINITY, |a, p| a.max(*p));
        (min, max)
    };
    let (low, high) = bounds(solid);
    let boxes: Vec<_> = cuts.iter().map(bounds).collect();
    let cell = 0.05;
    let count = |a: f64, b: f64| ((b - a) / cell).round() as i64;
    let mut kept = 0u64;
    for i in 0..count(low.x, high.x) {
        for j in 0..count(low.y, high.y) {
            for k in 0..count(low.z, high.z) {
                let p = low + DVec3::new(i as f64 + 0.5, j as f64 + 0.5, k as f64 + 0.5) * cell;
                if !boxes.iter().any(|(a, b)| p.cmpgt(*a).all() && p.cmplt(*b).all()) {
                    kept += 1;
                }
            }
        }
    }
    kept as f64 * cell * cell * cell
}

#[test]
fn one_pass_and_sequential_match_exact_grid_volume() {
    let mut rng = Rng(0xA076_1D64_78BD_642F);
    let mut failures = Vec::new();
    for round in 0..300 {
        let snap = round % 2 == 0;
        let solid = random_box(&mut rng, snap);
        let cuts: Vec<Mesh> = (0..5).map(|_| random_box(&mut rng, snap)).collect();
        if !snap {
            continue;
        }
        let exact = grid_volume(&solid, &cuts);
        let batched = subtract_all(&solid, &cuts).unwrap();
        let mut sequential = solid.clone();
        for cut in &cuts {
            sequential = subtract(&sequential, cut).unwrap();
        }
        let (b, s) = (batched.volume(), sequential.volume());
        if (b - exact).abs() > 1e-6 || (s - exact).abs() > 1e-6 {
            failures.push(format!("round {round}: exact {exact:.5} batched {b:.5} sequential {s:.5}"));
        }
    }
    assert!(failures.is_empty(), "{} failures\n{}", failures.len(), failures.join("\n"));
}

/// Deterministic, so a failure reproduces.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }

    fn range(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * self.next()
    }
}

fn random_box(rng: &mut Rng, snap: bool) -> Mesh {
    let mut size = v(rng.range(0.2, 2.0), rng.range(0.2, 2.0), rng.range(0.2, 2.0));
    let mut center = v(rng.range(-1.0, 1.0), rng.range(-1.0, 1.0), rng.range(-1.0, 1.0));
    if snap {
        // Whole tenths force shared planes and edges, the hard case for tolerances.
        size = (size * 10.0).round().max(DVec3::ONE) / 10.0;
        center = (center * 10.0).round() / 10.0;
    }
    let turn = if snap {
        DMat3::IDENTITY
    } else {
        DMat3::from_axis_angle(
            v(rng.range(-1.0, 1.0), rng.range(-1.0, 1.0), rng.range(0.1, 1.0)).normalize(),
            rng.range(0.0, 6.0),
        )
    };
    Mesh::cuboid(-size / 2.0, size / 2.0).map_positions(|p| center + turn * p)
}

fn conservation(snap: bool, seed: u64, rounds: usize) {
    let mut rng = Rng(seed);
    let mut worst_gap: f64 = 0.0;
    for round in 0..rounds {
        let a = random_box(&mut rng, snap);
        let b = random_box(&mut rng, snap);
        let outside = subtract(&a, &b).unwrap();
        let inside = intersect(&a, &b).unwrap();
        let gap = (outside.volume() + inside.volume() - a.volume()).abs();
        worst_gap = worst_gap.max(gap);
        assert!(gap < 1e-6, "round {round}: volume gap {gap}");
        assert_eq!(outside.open_edges(), 0, "round {round}: difference not watertight");
        assert_eq!(inside.open_edges(), 0, "round {round}: intersection not watertight");
    }
    println!("{rounds} rounds, snap={snap}: worst volume gap {worst_gap:.2e} m3");
}

#[test]
fn volume_is_conserved_for_random_rotated_boxes() {
    conservation(false, 0x9E37_79B9_7F4A_7C15, 2000);
}

#[test]
fn volume_is_conserved_for_boxes_sharing_planes() {
    conservation(true, 0xD1B5_4A32_D192_ED03, 2000);
}

fn sleeved_slab(rng: &mut Rng, sleeves: usize, offset: DVec3) -> (Mesh, Vec<Mesh>) {
    let solid = Mesh::cuboid(offset, offset + v(100.0, 100.0, 0.3));
    let cuts = (0..sleeves)
        .map(|_| {
            let corner = offset + v(rng.range(1.0, 98.0), rng.range(1.0, 98.0), -0.1);
            Mesh::cuboid(corner, corner + v(0.3, 0.3, 0.5))
        })
        .collect();
    (solid, cuts)
}

#[test]
fn slabs_with_scattered_sleeves_stay_watertight() {
    for seed in 1..=20u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let (solid, cuts) = sleeved_slab(&mut rng, 100, DVec3::ZERO);
        let mesh = subtract_all(&solid, &cuts).unwrap();
        assert_eq!(mesh.open_edges(), 0, "seed {seed}");
    }
}

#[test]
fn utm_coordinates_cut_as_cleanly_as_the_origin() {
    // Galicia, ETRS89 / UTM 29N: seven significant digits before the point.
    let utm = v(536_000.0, 4_747_000.0, 260.0);
    for seed in 1..=10u64 {
        let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03));
        let (solid, cuts) = sleeved_slab(&mut rng, 40, utm);
        let exact = solid.volume() - 40.0 * 0.3 * 0.3 * 0.3;
        let mesh = subtract_all(&solid, &cuts).unwrap();
        assert_eq!(mesh.open_edges(), 0, "seed {seed}");
        // Overlapping sleeves remove less, so this is a bound rather than an equality.
        assert!(mesh.volume() >= exact - 1e-6 && mesh.volume() < solid.volume());
    }
}

#[test]
fn emptied_solid_stays_empty() {
    let swallow = Mesh::cuboid(v(-1.0, -1.0, -1.0), v(11.0, 1.0, 4.0));
    let later = Mesh::cuboid(v(0.0, 0.0, 0.0), v(11.0, 1.0, 4.0));
    let result = subtract_all(&wall(), &[swallow, later]).unwrap();
    assert!(result.is_empty(), "{} triangles left", result.triangles.len());
    assert!(intersect(&Mesh::default(), &wall()).unwrap().is_empty());
}

#[test]
#[ignore = "diagnostic for open edges; run with --release --ignored --nocapture"]
fn open_edge_report() {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for sleeves in [50, 300, 1000] {
        let solid = Mesh::cuboid(v(0.0, 0.0, 0.0), v(100.0, 100.0, 0.3));
        let cuts: Vec<Mesh> = (0..sleeves)
            .map(|_| {
                let (x, y) = (rng.range(1.0, 98.0), rng.range(1.0, 98.0));
                Mesh::cuboid(v(x, y, -0.1), v(x + 0.3, y + 0.3, 0.4))
            })
            .collect();
        let mesh = subtract_all(&solid, &cuts).unwrap();
        let mut balance = std::collections::HashMap::new();
        for [a, b, c] in &mesh.triangles {
            for (from, to) in [(*a, *b), (*b, *c), (*c, *a)] {
                let (key, step) = if from < to { ((from, to), 1) } else { ((to, from), -1) };
                *balance.entry(key).or_insert(0i32) += step;
            }
        }
        println!("--- {sleeves} sleeves");
        for ((from, to), count) in balance.iter().filter(|(_, count)| **count != 0) {
            let (a, b) = (mesh.positions[*from as usize], mesh.positions[*to as usize]);
            println!("{count:+} {a:.9?} -> {b:.9?} length {:.3e}", a.distance(b));
        }
    }
}

#[test]
#[ignore = "timing report; run with --release --ignored --nocapture"]
fn timing() {
    for windows in [1, 14, 50, 100, 300, 1000] {
        let solid = Mesh::cuboid(v(0.0, 0.0, 0.0), v(windows as f64 * 2.0 + 1.0, 0.3, 3.0));
        let cuts: Vec<Mesh> = (0..windows)
            .map(|i| {
                let x = 0.5 + i as f64 * 2.0;
                Mesh::cuboid(v(x, -0.1, 1.0), v(x + 1.2, 0.4, 2.2))
            })
            .collect();
        let start = Instant::now();
        let mesh = subtract_all(&solid, &cuts).unwrap();
        println!(
            "row of {windows}: {:?}, {} triangles, {} open edges",
            start.elapsed(),
            mesh.triangles.len(),
            mesh.open_edges()
        );
    }

    // A slab with sleeves scattered over its area, the worst case for shared planes.
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for sleeves in [50, 300, 1000] {
        let solid = Mesh::cuboid(v(0.0, 0.0, 0.0), v(100.0, 100.0, 0.3));
        let cuts: Vec<Mesh> = (0..sleeves)
            .map(|_| {
                let (x, y) = (rng.range(1.0, 98.0), rng.range(1.0, 98.0));
                Mesh::cuboid(v(x, y, -0.1), v(x + 0.3, y + 0.3, 0.4))
            })
            .collect();
        let start = Instant::now();
        let mesh = subtract_all(&solid, &cuts).unwrap();
        println!(
            "slab with {sleeves}: {:?}, {} triangles, {} open edges",
            start.elapsed(),
            mesh.triangles.len(),
            mesh.open_edges()
        );
    }
}
