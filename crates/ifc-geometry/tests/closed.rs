//! Which meshes may have their back faces culled: `Mesh::is_closed_outward`.

use glam::DVec3;
use ifc_geometry::mesh::Mesh;

fn cube() -> Mesh {
    Mesh::cuboid(DVec3::new(-1.0, -2.0, 0.0), DVec3::new(3.0, 1.0, 2.5))
}

fn flipped(mut mesh: Mesh) -> Mesh {
    mesh.triangles.iter_mut().for_each(|triangle| triangle.swap(1, 2));
    mesh
}

/// The same triangles with three corners of their own each, at the same positions.
fn unshared(mesh: &Mesh) -> Mesh {
    let positions: Vec<DVec3> = mesh.triangle_corners().flatten().collect();
    let triangles = (0..mesh.triangles.len() as u32).map(|at| [3 * at, 3 * at + 1, 3 * at + 2]).collect();
    Mesh { positions, triangles }
}

/// Both meshes in one.
fn joined(one: &Mesh, two: &Mesh) -> Mesh {
    let offset = one.positions.len() as u32;
    let mut mesh = one.clone();
    mesh.positions.extend(&two.positions);
    mesh.triangles.extend(two.triangles.iter().map(|triangle| triangle.map(|index| index + offset)));
    mesh
}

#[test]
fn a_box_is_closed_and_inside_out_it_is_not() {
    assert!(cube().is_closed_outward());
    assert!(!flipped(cube()).is_closed_outward());
}

#[test]
fn a_box_far_from_the_origin_is_closed() {
    let far = cube().map_positions(|p| p + DVec3::new(536000.0, 4747000.0, 260.0));
    assert!(far.is_closed_outward());
}

#[test]
fn a_box_missing_a_face_or_with_one_face_turned_is_not() {
    let mut missing = cube();
    missing.triangles.truncate(10);
    assert!(!missing.is_closed_outward(), "two triangles missing");
    let mut one = cube();
    one.triangles.pop();
    assert!(!one.is_closed_outward(), "an odd number of triangles");
    let mut turned = cube();
    turned.triangles[4].swap(1, 2);
    assert!(!turned.is_closed_outward(), "one triangle turned");
}

#[test]
fn corners_at_one_position_count_as_one() {
    assert!(unshared(&cube()).is_closed_outward());
    assert!(!unshared(&flipped(cube())).is_closed_outward());
    // -0.0 and 0.0 are one position.
    let mut signed = unshared(&cube().map_positions(|p| p - DVec3::new(-1.0, -2.0, 0.0)));
    for position in &mut signed.positions {
        if position.x == 0.0 && position.y == 0.0 {
            position.x = -0.0;
            break;
        }
    }
    assert!(signed.positions.iter().any(|p| p.x.to_bits() == (-0.0f64).to_bits()));
    assert!(signed.is_closed_outward());
}

#[test]
fn every_part_must_wind_outward() {
    let other = cube().map_positions(|p| p + DVec3::new(10.0, 0.0, 0.0));
    assert!(joined(&cube(), &other).is_closed_outward(), "two boxes apart");
    assert!(!joined(&cube(), &flipped(other.clone())).is_closed_outward(), "one inside out");
    // A box with a cavity: the inner box winds inward, so it is left alone.
    let cavity = flipped(Mesh::cuboid(DVec3::new(0.0, -1.0, 0.5), DVec3::new(1.0, 0.0, 1.5)));
    assert!(!joined(&cube(), &cavity).is_closed_outward(), "a cavity");
    // Its total volume is still positive: only the per-part test sees the cavity.
    assert!(joined(&cube(), &cavity).volume() > 0.0);
}

#[test]
fn a_mirrored_box_whose_winding_was_not_flipped_is_not() {
    let mirrored = cube().map_positions(|p| DVec3::new(-p.x, p.y, p.z));
    assert!(!mirrored.is_closed_outward());
    assert!(flipped(mirrored).is_closed_outward());
}

#[test]
fn a_side_of_three_or_four_faces_is_not_closed() {
    // A fin: one more triangle on an edge of the box, and the same triangle turned, so its
    // sides still pair up in number.
    let mut fin = cube();
    fin.positions.push(DVec3::new(-1.0, -5.0, 0.0));
    let tip = fin.positions.len() as u32 - 1;
    fin.triangles.push([0, 1, tip]);
    fin.triangles.push([0, tip, 1]);
    assert!(!fin.is_closed_outward());
}

#[test]
fn a_triangle_with_a_repeated_corner_cannot_close_a_hole() {
    // Such a triangle runs both ways along its one real side, so it pairs with itself and has
    // no area: it never stands in for a side a hole lacks.
    let mut holed = cube();
    let [a, b, c] = holed.triangles.remove(0);
    let [d, e, f] = holed.triangles.remove(0);
    for [from, to] in [[a, b], [b, c], [c, a], [d, e], [e, f], [f, d]] {
        holed.triangles.push([to, from, from]);
        holed.triangles.push([to, to, from]);
    }
    assert!(!holed.is_closed_outward(), "flaps on the hole's sides");
    // A triangle on one corner repeats its side.
    let mut pointed = cube();
    pointed.triangles.extend([[5, 5, 5], [0, 0, 6]]);
    assert!(!pointed.is_closed_outward(), "a triangle of three equal corners");
}

#[test]
fn parts_join_only_across_sides_so_nothing_of_no_volume_hides_an_inward_part() {
    // Joined by corners, a triangle with a repeated corner or two faces back to back would make
    // an inside-out box one part with an outward one, whose larger volume would hide it.
    let big = Mesh::cuboid(DVec3::ZERO, DVec3::splat(4.0));
    let small = flipped(Mesh::cuboid(DVec3::splat(10.0), DVec3::splat(11.0)));
    let two = joined(&big, &small);
    assert!(!two.is_closed_outward());
    let (a, b) = (0, big.positions.len() as u32);
    let mut flapped = two.clone();
    flapped.triangles.extend([[a, a, b], [1, 1, 7]]);
    assert!(!flapped.is_closed_outward(), "joined by triangles with a repeated corner");
    let mut sheet = two.clone();
    sheet.triangles.extend([[a, b, b + 6], [a, b + 6, b]]);
    assert!(!sheet.is_closed_outward(), "joined by two faces back to back");
    // Such a part has no volume, so even on a closed box it leaves the mesh open: safe.
    let mut flap_on_box = cube();
    flap_on_box.triangles.extend([[0, 0, 6], [3, 5, 5]]);
    assert!(!flap_on_box.is_closed_outward(), "a box with two triangles of no area");
    // Across the box's diagonal to a corner of its own, so no side is one of the box's.
    let mut sheet_on_box = cube();
    sheet_on_box.positions.push(DVec3::new(0.0, -1.0, 1.0));
    sheet_on_box.triangles.extend([[0, 6, 8], [0, 8, 6]]);
    assert!(!sheet_on_box.is_closed_outward(), "a box with two faces back to back inside it");
}

#[test]
fn broken_meshes_are_not_closed() {
    assert!(!Mesh::default().is_closed_outward(), "empty");
    let mut out_of_range = cube();
    out_of_range.triangles[0][0] = 99;
    assert!(!out_of_range.is_closed_outward(), "an index past the corners");
    let mut not_a_number = cube();
    not_a_number.positions[6].z = f64::NAN;
    assert!(!not_a_number.is_closed_outward(), "a corner that is not a number");
}

#[test]
fn a_fine_cone_is_closed_and_with_a_face_twice_it_is_not() {
    // 48 sides leave the tip and the centre of the base: more than are scanned one by one.
    let segments = 48u32;
    let mut positions = vec![DVec3::new(0.0, 0.0, 2.0), DVec3::ZERO];
    for segment in 0..segments {
        let azimuth = std::f64::consts::TAU * f64::from(segment) / f64::from(segments);
        positions.push(DVec3::new(azimuth.cos(), azimuth.sin(), 0.0));
    }
    let rim = |segment: u32| 2 + segment % segments;
    let mut triangles = Vec::new();
    for segment in 0..segments {
        triangles.push([0, rim(segment), rim(segment + 1)]);
        triangles.push([1, rim(segment + 1), rim(segment)]);
    }
    let cone = Mesh { positions, triangles };
    assert!(cone.is_closed_outward());
    assert!(!flipped(cone.clone()).is_closed_outward());
    let mut twice = cone.clone();
    twice.triangles.extend([cone.triangles[0], cone.triangles[1]]);
    assert!(!twice.is_closed_outward(), "a face repeated");
    // Two faces apart taken out: sides without their reverse, though none is repeated.
    let mut holed = cone.clone();
    holed.triangles.remove(40);
    holed.triangles.remove(0);
    assert!(!holed.is_closed_outward(), "two faces missing");
}

#[test]
fn a_finely_divided_sphere_is_closed_without_deep_recursion() {
    // 2 x 400 x 400 triangles in one part.
    let (rings, segments) = (400u32, 400u32);
    let mut positions = vec![DVec3::Z, -DVec3::Z];
    for ring in 1..rings {
        let polar = std::f64::consts::PI * f64::from(ring) / f64::from(rings);
        for segment in 0..segments {
            let azimuth = std::f64::consts::TAU * f64::from(segment) / f64::from(segments);
            positions.push(DVec3::new(polar.sin() * azimuth.cos(), polar.sin() * azimuth.sin(), polar.cos()));
        }
    }
    let at = |ring: u32, segment: u32| 2 + (ring - 1) * segments + segment % segments;
    let mut triangles = Vec::new();
    for segment in 0..segments {
        triangles.push([0, at(1, segment), at(1, segment + 1)]);
        triangles.push([1, at(rings - 1, segment + 1), at(rings - 1, segment)]);
        for ring in 1..rings - 1 {
            let (a, b) = (at(ring, segment), at(ring, segment + 1));
            let (c, d) = (at(ring + 1, segment), at(ring + 1, segment + 1));
            triangles.push([a, c, d]);
            triangles.push([a, d, b]);
        }
    }
    let sphere = Mesh { positions, triangles };
    assert!(sphere.is_closed_outward());
    assert!(!flipped(sphere).is_closed_outward());
}
