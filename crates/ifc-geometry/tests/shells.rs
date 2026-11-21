//! Shells whose faces disagree about which way is out, as real exporters write them.

use glam::DVec3;
use ifc_geometry::hash::set_secret;
use ifc_geometry::{Mesh, ModelEvaluator};
use step_parser::index;

const CORNERS: &str = "#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
    #2=IFCWALL('w',$,$,$,$,$,#3,$);\n\
    #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
    #4=IFCSHAPEREPRESENTATION($,'Body','SurfaceModel',(#5));\n\
    #10=IFCCARTESIANPOINT((0.,0.,0.));\n\
    #11=IFCCARTESIANPOINT((1.,0.,0.));\n\
    #12=IFCCARTESIANPOINT((1.,2.,0.));\n\
    #13=IFCCARTESIANPOINT((0.,2.,0.));\n\
    #14=IFCCARTESIANPOINT((0.,0.,3.));\n\
    #15=IFCCARTESIANPOINT((1.,0.,3.));\n\
    #16=IFCCARTESIANPOINT((1.,2.,3.));\n\
    #17=IFCCARTESIANPOINT((0.,2.,3.));\n";

/// A 1 by 2 by 3 box of six faces. `top` is the top face's loop, outward when `#14,#15,#16,#17`.
fn faces(top: &str) -> String {
    let loops = [
        "#10,#13,#12,#11".to_string(),
        top.to_string(),
        "#10,#11,#15,#14".to_string(),
        "#11,#12,#16,#15".to_string(),
        "#12,#13,#17,#16".to_string(),
        "#13,#10,#14,#17".to_string(),
    ];
    let mut text = String::new();
    for (index, points) in loops.iter().enumerate() {
        let at = 20 + index * 3;
        text += &format!(
            "#{at}=IFCPOLYLOOP(({points}));\n#{}=IFCFACEOUTERBOUND(#{at},.T.);\n#{}=IFCFACE((#{}));\n",
            at + 1,
            at + 2,
            at + 1
        );
    }
    text + "#40=IFCCONNECTEDFACESET((#22,#25,#28,#31,#34,#37));\n"
}

fn evaluate(body: &str) -> Mesh {
    evaluate_in("IFC2X3", body)
}

fn evaluate_in(schema: &str, body: &str) -> Mesh {
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{CORNERS}{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(2).expect("the element evaluates");
    element.meshes.into_iter().next().expect("a mesh").mesh
}

fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() <= 1e-9, "{actual} against {expected}");
}

#[test]
fn a_surface_model_with_one_face_written_backwards_closes_outward() {
    let body = faces("#17,#16,#15,#14") + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let mesh = evaluate(&body);
    close(mesh.volume(), 6.0);
    assert_eq!(mesh.open_edges(), 0);
}

#[test]
fn a_shell_written_inside_out_turns_outward() {
    let body = "#41=IFCCLOSEDSHELL((#22,#25,#28,#31,#34,#37));\n#5=IFCFACETEDBREP(#41);\n";
    // Every face reversed, by the flag on each bound.
    let inverted = faces("#14,#15,#16,#17").replace(",.T.)", ",.F.)");
    close(evaluate(&(inverted + body)).volume(), 6.0);
}

#[test]
fn a_shell_written_correctly_keeps_its_triangles() {
    let body = faces("#14,#15,#16,#17") + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let mesh = evaluate(&body);
    let mut repaired = mesh.clone();
    repaired.orient_shell();
    assert_eq!(repaired, mesh);
    close(mesh.volume(), 6.0);
}

fn flipped(mut mesh: Mesh, triangles: &[usize]) -> Mesh {
    for index in triangles {
        mesh.triangles[*index].swap(1, 2);
    }
    mesh
}

fn unit_box() -> Mesh {
    Mesh::cuboid(DVec3::ZERO, DVec3::splat(1.0))
}

#[test]
fn every_way_of_flipping_one_face_of_a_box_is_repaired() {
    for face in 0..6 {
        let mut mesh = flipped(unit_box(), &[face * 2, face * 2 + 1]);
        assert_ne!(mesh.open_edges(), 0);
        mesh.orient_shell();
        assert_eq!(mesh.open_edges(), 0, "face {face}");
        close(mesh.volume(), 1.0);
    }
}

#[test]
fn separate_solids_in_one_mesh_are_each_turned_outward() {
    let far = Mesh::cuboid(DVec3::splat(5.0), DVec3::splat(7.0));
    let mut mesh = unit_box();
    let first = mesh.positions.len() as u32;
    mesh.positions.extend(far.positions);
    // The second box inside out, so the two would cancel in a sum over the whole mesh.
    mesh.triangles.extend(far.triangles.iter().map(|[a, b, c]| [a + first, c + first, b + first]));
    mesh.orient_shell();
    close(mesh.volume(), 1.0 + 8.0);
}

/// Boxes from the corners given, in one mesh with no shared corners, each wound inward when
/// its flag says so.
fn boxes(parts: &[(f64, f64, bool)]) -> Mesh {
    let mut mesh = Mesh::default();
    for (low, high, inward) in parts {
        let part = Mesh::cuboid(DVec3::splat(*low), DVec3::splat(*high));
        let first = mesh.positions.len() as u32;
        mesh.positions.extend(part.positions);
        mesh.triangles.extend(part.triangles.iter().map(|[a, b, c]| {
            if *inward { [a + first, c + first, b + first] } else { [a + first, b + first, c + first] }
        }));
    }
    mesh
}

#[test]
fn a_closed_part_inside_another_is_a_cavity_whichever_way_it_was_written() {
    // A 6 m cube with a 2 m cavity, as Tekla writes the cores of a hollow slab: one shell of two
    // parts that share no edge.
    for (outer, inner) in [(false, true), (false, false), (true, true), (true, false)] {
        let mut mesh = boxes(&[(0.0, 6.0, outer), (2.0, 4.0, inner)]);
        mesh.orient_shell();
        close(mesh.volume(), 216.0 - 8.0);
    }
}

#[test]
fn a_cavity_is_found_in_a_part_written_partly_backwards() {
    // Two of the outer cube's faces wound inward: taken as written, it would wind around the
    // cavity a third of a turn, not once.
    let mut mesh = flipped(boxes(&[(0.0, 6.0, false), (2.0, 4.0, false)]), &[0, 1, 2, 3]);
    mesh.orient_shell();
    close(mesh.volume(), 216.0 - 8.0);
}

#[test]
fn an_island_in_a_cavity_is_solid_again() {
    let mut mesh = boxes(&[(3.0, 4.0, true), (0.0, 7.0, false), (1.0, 6.0, false)]);
    mesh.orient_shell();
    close(mesh.volume(), 343.0 - 125.0 + 1.0);
    // And a cavity in that island, three deep.
    let mut mesh = boxes(&[(0.0, 9.0, false), (1.0, 8.0, true), (2.0, 7.0, false), (3.0, 6.0, false)]);
    mesh.orient_shell();
    close(mesh.volume(), 729.0 - 343.0 + 125.0 - 27.0);
}

/// The volume of the triangles from `first` on, which are one part of `mesh`.
fn volume_from(mesh: &Mesh, first: usize) -> f64 {
    mesh.triangles[first..]
        .iter()
        .map(|triangle| triangle.map(|id| mesh.positions[id as usize]))
        .map(|[a, b, c]| a.dot(b.cross(c)) / 6.0)
        .sum()
}

#[test]
fn an_open_part_holds_no_cavity_and_is_none() {
    // A 6 m box with no top around a 2 m cube: the open part winds most of the way round the
    // cube, but only a closed part has an inside.
    let mut mesh = unit_box();
    mesh.positions.iter_mut().for_each(|point| *point *= 6.0);
    mesh.triangles.drain(2..4);
    let first = mesh.triangles.len();
    let cube = Mesh::cuboid(DVec3::splat(2.0), DVec3::splat(4.0));
    let offset = mesh.positions.len() as u32;
    mesh.positions.extend(cube.positions);
    mesh.triangles.extend(cube.triangles.iter().map(|[a, b, c]| [a + offset, b + offset, c + offset]));
    let open = mesh.triangles[..first].to_vec();
    mesh.orient_shell();
    close(volume_from(&mesh, first), 8.0);
    assert_eq!(mesh.triangles[..first], open[..], "the open part keeps its facing");
}

#[test]
fn a_part_in_the_bounds_of_a_concave_one_but_not_in_it_is_not_its_cavity() {
    // One closed L-shaped prism, 10 m high, and cubes in the corner the L leaves empty: one
    // well clear of it, one a hand's width from both its inner walls.
    let outline = [(0.0, 0.0), (10.0, 0.0), (10.0, 2.0), (2.0, 2.0), (2.0, 10.0), (0.0, 10.0)];
    let mut mesh = Mesh::default();
    for z in [0.0, 10.0] {
        mesh.positions.extend(outline.iter().map(|(x, y)| DVec3::new(*x, *y, z)));
    }
    for [a, b, c] in [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]] {
        mesh.triangles.push([a, c, b]);
        mesh.triangles.push([a + 6, b + 6, c + 6]);
    }
    for side in 0..6u32 {
        let next = (side + 1) % 6;
        mesh.triangles.push([side, next, next + 6]);
        mesh.triangles.push([side, next + 6, side + 6]);
    }
    close(mesh.volume(), 360.0);
    let first = mesh.triangles.len();
    for (low, high) in [(DVec3::splat(5.0), DVec3::splat(6.0)), (DVec3::new(2.1, 2.1, 5.0), DVec3::new(2.6, 2.6, 5.5))] {
        let cube = Mesh::cuboid(low, high);
        let offset = mesh.positions.len() as u32;
        mesh.positions.extend(cube.positions);
        mesh.triangles.extend(cube.triangles.iter().map(|[a, b, c]| [a + offset, b + offset, c + offset]));
    }
    mesh.orient_shell();
    close(volume_from(&mesh, first), 1.0 + 0.125);
    close(mesh.volume(), 361.125);
}

#[test]
fn parts_that_only_overlap_stay_solid() {
    // None holds another, so none is a cavity, however each was written.
    let mut mesh = boxes(&[(0.0, 2.0, false), (0.5, 2.5, true), (1.0, 3.0, false)]);
    mesh.orient_shell();
    close(mesh.volume(), 8.0 + 8.0 + 8.0);
}

#[test]
fn cavities_are_looked_for_in_shells_of_up_to_2000_closed_parts() {
    // Every pair of parts is compared, so a shell of very many is left as it was before.
    for (count, cavity) in [(2_000, -8.0), (2_001, 8.0)] {
        let mut parts = vec![(0.0, 6.0, false), (2.0, 4.0, false)];
        parts.extend((0..count - 2).map(|index| (10.0 + 2.0 * index as f64, 11.0 + 2.0 * index as f64, false)));
        let mut mesh = boxes(&parts);
        mesh.orient_shell();
        close(mesh.volume(), 216.0 + cavity + (count - 2) as f64);
    }
}

#[test]
fn a_part_beside_a_hollow_one_is_not_its_cavity() {
    // An L of two boxes would hold this one in its bounding box, but not in its material.
    let mut mesh = boxes(&[(5.0, 6.0, false)]);
    let l = [
        Mesh::cuboid(DVec3::ZERO, DVec3::new(10.0, 2.0, 10.0)),
        Mesh::cuboid(DVec3::new(0.0, 2.0, 0.0), DVec3::new(2.0, 10.0, 10.0)),
    ];
    for part in l {
        let first = mesh.positions.len() as u32;
        mesh.positions.extend(part.positions);
        mesh.triangles.extend(part.triangles.iter().map(|[a, b, c]| [a + first, b + first, c + first]));
    }
    mesh.orient_shell();
    close(mesh.volume(), 1.0 + 200.0 + 160.0);
}

/// A 6 m cube with a 2 m cube inside, both written as faces of one closed shell, with the
/// inner cube's faces as the file has them.
fn hollow_brep(inner_inward: bool) -> String {
    let outer = Mesh::cuboid(DVec3::ZERO, DVec3::splat(6.0));
    let inner = Mesh::cuboid(DVec3::splat(2.0), DVec3::splat(4.0));
    let mut text = String::new();
    let mut faces = Vec::new();
    let mut id = 100;
    for (mesh, inward) in [(outer, false), (inner, inner_inward)] {
        let first = id;
        for point in &mesh.positions {
            text += &format!("#{id}=IFCCARTESIANPOINT(({:.1},{:.1},{:.1}));\n", point.x, point.y, point.z);
            id += 1;
        }
        for [a, b, c] in &mesh.triangles {
            let (b, c) = if inward { (c, b) } else { (b, c) };
            text += &format!(
                "#{id}=IFCPOLYLOOP((#{},#{},#{}));\n#{}=IFCFACEOUTERBOUND(#{id},.T.);\n#{}=IFCFACE((#{}));\n",
                first + a,
                first + b,
                first + c,
                id + 1,
                id + 2,
                id + 1
            );
            faces.push(format!("#{}", id + 2));
            id += 3;
        }
    }
    text + &format!("#41=IFCCLOSEDSHELL(({}));\n#5=IFCFACETEDBREP(#41);\n", faces.join(","))
}

#[test]
fn a_brep_whose_shell_holds_a_cavity_keeps_it_hollow() {
    for inner_inward in [true, false] {
        let mesh = evaluate(&hollow_brep(inner_inward));
        assert_eq!(mesh.triangles.len(), 24);
        close(mesh.volume(), 216.0 - 8.0);
    }
}

#[test]
fn a_solid_in_another_face_set_is_not_a_cavity() {
    // Revit writes each solid of a family as a face set of its own, and a part buried in another
    // is joined to it, not cut from it. The same two cubes as above, one per face set.
    let text = hollow_brep(false).replace(
        "#5=IFCFACETEDBREP(#41);",
        "#42=IFCCONNECTEDFACESET((#OUTER));\n#43=IFCCONNECTEDFACESET((#INNER));\n#5=IFCFACEBASEDSURFACEMODEL((#42,#43));",
    );
    let faces = text.split("IFCCLOSEDSHELL((").nth(1).unwrap().split("))").next().unwrap().to_string();
    let (outer, inner) = faces.split_at(faces.match_indices(',').nth(11).unwrap().0);
    let text = text.replace("#OUTER", outer).replace("#INNER", &inner[1..]);
    let mesh = evaluate(&text);
    assert_eq!(mesh.triangles.len(), 24);
    close(mesh.volume(), 216.0 + 8.0);
}

#[test]
fn an_open_surface_keeps_the_way_most_of_it_faces() {
    // A box with no top: 10 triangles, one flipped. There is no inside, so the rest decide.
    let mut open = unit_box();
    open.triangles.drain(2..4);
    let wanted = open.clone();
    let mut mesh = flipped(open, &[3]);
    mesh.orient_shell();
    assert_eq!(mesh, wanted);
}

#[test]
fn an_open_surface_facing_inward_is_left_that_way() {
    // Volume means nothing without a closed boundary, so it must not turn this round.
    let mut open = unit_box();
    open.triangles.drain(2..4);
    open.triangles.iter_mut().for_each(|triangle| triangle.swap(1, 2));
    let wanted = open.clone();
    open.orient_shell();
    assert_eq!(open, wanted);
}

#[test]
fn an_edge_of_three_faces_does_not_panic_or_lose_triangles() {
    let mut mesh = Mesh {
        positions: vec![
            DVec3::ZERO,
            DVec3::X,
            DVec3::Y,
            DVec3::NEG_Y,
            DVec3::Z,
        ],
        triangles: vec![[0, 1, 2], [0, 1, 3], [0, 1, 4]],
    };
    let wanted = mesh.clone();
    mesh.orient_shell();
    // Each face is a part of its own: joined across the fork, the second would turn to
    // disagree with the first, since both run 0 to 1.
    assert_eq!(mesh, wanted);
}

#[test]
fn an_edge_of_three_faces_at_a_corner_of_many_edges_joins_nothing() {
    // The same fork, with 40 more triangles meeting only at corner 0, so its edges are many
    // and grouped by sorting rather than scanning.
    let mut positions = vec![DVec3::ZERO, DVec3::X, DVec3::Y, DVec3::NEG_Y, DVec3::Z];
    let mut triangles = vec![[0, 1, 2], [0, 1, 3], [0, 1, 4]];
    for at in 0..40u32 {
        let angle = f64::from(at) * 0.15;
        positions.push(DVec3::new(-2.0, angle.cos(), angle.sin()));
        positions.push(DVec3::new(-2.0, angle.cos(), angle.sin()) + DVec3::new(0.0, 0.0, 0.05));
        triangles.push([0, 5 + 2 * at, 6 + 2 * at]);
    }
    let mut mesh = Mesh { positions, triangles };
    let wanted = mesh.clone();
    mesh.orient_shell();
    assert_eq!(mesh, wanted);
}

#[test]
fn a_closed_cone_with_a_tip_of_many_edges_turns_outward() {
    // A tall cone of 48 sides, tip first and base centre second, so their edges are grouped by
    // sorting; every third side is turned inward. Each side is larger than a base triangle, so
    // only joining across the tip and the base centre, and judging the whole by its volume,
    // turns them all outward.
    let segments = 48u32;
    let mut positions = vec![DVec3::new(0.0, 0.0, 10.0), DVec3::ZERO];
    for at in 0..segments {
        let angle = std::f64::consts::TAU * f64::from(at) / f64::from(segments);
        positions.push(DVec3::new(angle.cos(), angle.sin(), 0.0));
    }
    let rim = |at: u32| 2 + at % segments;
    let mut triangles = Vec::new();
    for at in 0..segments {
        let side = [0, rim(at), rim(at + 1)];
        triangles.push(if at % 3 == 0 { [side[0], side[2], side[1]] } else { side });
        triangles.push([1, rim(at + 1), rim(at)]);
    }
    let mut mesh = Mesh { positions, triangles };
    assert!(!mesh.is_closed_outward());
    mesh.orient_shell();
    assert!(mesh.is_closed_outward());
    assert!(mesh.volume() > 0.0);
}

#[test]
fn a_large_shell_is_walked_without_recursion() {
    // A strip of a million triangles, every other one flipped: a recursive walk would overflow
    // the 1 MB stack of a WASM build.
    let count = 500_000u32;
    let mut mesh = Mesh::default();
    for column in 0..=count {
        mesh.positions.push(DVec3::new(f64::from(column), 0.0, 0.0));
        mesh.positions.push(DVec3::new(f64::from(column), 1.0, 0.0));
    }
    for column in 0..count {
        let (a, b, c, d) = (column * 2, column * 2 + 2, column * 2 + 3, column * 2 + 1);
        mesh.triangles.push([a, b, c]);
        mesh.triangles.push(if column % 2 == 0 { [a, c, d] } else { [a, d, c] });
    }
    mesh.orient_shell();
    let up = mesh.triangle_corners().filter(|[a, b, c]| (b - a).cross(c - a).z > 0.0).count();
    assert_eq!(up, mesh.triangles.len());
}


const CUBE_POINTS: &str = "#20=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,2.,0.),(0.,2.,0.),(0.,0.,2.),(2.,0.,2.),(2.,2.,2.),(0.,2.,2.)));\n";

#[test]
fn a_triangulated_set_written_inward_turns_outward() {
    // The twelve triangles of a 2 m cube, every one wound towards the inside.
    let faces = "((1,2,3),(1,3,4),(5,7,6),(5,8,7),(1,6,2),(1,5,6),(2,7,3),(2,6,7),(3,8,4),(3,7,8),(4,5,1),(4,8,5))";
    let body = format!("{CUBE_POINTS}#5=IFCTRIANGULATEDFACESET(#20,$,.T.,{faces},$);\n");
    close(evaluate_in("IFC4", &body).volume(), 8.0);
}

#[test]
fn a_polygonal_set_written_inward_turns_outward() {
    let loops = ["1,2,3,4", "5,8,7,6", "1,5,6,2", "2,6,7,3", "3,7,8,4", "4,8,5,1"];
    let mut body = CUBE_POINTS.to_string();
    for (index, points) in loops.iter().enumerate() {
        body += &format!("#{}=IFCINDEXEDPOLYGONALFACE(({points}));\n", 30 + index);
    }
    body += "#5=IFCPOLYGONALFACESET(#20,.T.,(#30,#31,#32,#33,#34,#35),$);\n";
    close(evaluate_in("IFC4", &body).volume(), 8.0);
}

/// Two walls using one mapped box, the second moved 10 m along X.
const MAPPED: &str = "#2=IFCWALL('w',$,$,$,$,$,#3,$);\n\
    #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
    #4=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#50));\n\
    #6=IFCWALL('x',$,$,$,$,$,#7,$);\n\
    #7=IFCPRODUCTDEFINITIONSHAPE($,$,(#8));\n\
    #8=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#51));\n\
    #50=IFCMAPPEDITEM(#52,#53);\n\
    #51=IFCMAPPEDITEM(#52,#54);\n\
    #52=IFCREPRESENTATIONMAP(#55,#56);\n\
    #53=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#57,$,$);\n\
    #54=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#58,$,$);\n\
    #55=IFCAXIS2PLACEMENT3D(#57,$,$);\n\
    #56=IFCSHAPEREPRESENTATION($,'Body','Brep',(#5));\n\
    #57=IFCCARTESIANPOINT((0.,0.,0.));\n\
    #58=IFCCARTESIANPOINT((10.,0.,0.));\n";

fn mapped_file(item: &str) -> String {
    format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;\n#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n\
         {}{MAPPED}{item}ENDSEC;END-ISO-10303-21;",
        CORNERS.split_once("#10=").map(|(_, rest)| format!("#10={rest}")).unwrap()
    )
}

#[test]
fn each_instance_of_a_mapped_item_keeps_its_own_place() {
    let body = faces("#14,#15,#16,#17") + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let text = mapped_file(&body);
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    for (id, x) in [(2, 0.0), (6, 10.0), (2, 0.0)] {
        let element = evaluator.evaluate(id).expect("the element evaluates");
        let mesh = &element.meshes[0].mesh;
        close(mesh.volume(), 6.0);
        let least = mesh.positions.iter().fold(f64::INFINITY, |least, point| least.min(point.x));
        close(least, x);
    }
    assert!(evaluator.diagnostics().is_empty());
}

#[test]
fn a_problem_in_a_mapped_item_is_reported_for_each_element_using_it() {
    // A face bounded by a loop the kernel cannot use is skipped, with a warning.
    let body = faces("#14,#15,#16,#17").replace("#20=IFCPOLYLOOP((#10,#13,#12,#11));", "#20=IFCVERTEXLOOP(#61);\n#61=IFCVERTEXPOINT(#10);")
        + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    assert!(body.contains("IFCVERTEXLOOP"), "{body}");
    let text = mapped_file(&body);
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    evaluator.evaluate(2).expect("the first element evaluates");
    let first = evaluator.diagnostics().len();
    assert!(first > 0, "the item should warn");
    evaluator.evaluate(6).expect("the second element evaluates");
    assert!(evaluator.diagnostics().len() > first, "{:?}", evaluator.diagnostics());
}

#[test]
fn triangular_faces_are_kept_and_zero_area_ones_are_dropped() {
    // A tetrahedron of four faces, plus one face with all three corners on a line.
    let body = "#20=IFCPOLYLOOP((#10,#12,#11));#21=IFCFACEOUTERBOUND(#20,.T.);#22=IFCFACE((#21));\n\
        #23=IFCPOLYLOOP((#10,#11,#14));#24=IFCFACEOUTERBOUND(#23,.T.);#25=IFCFACE((#24));\n\
        #26=IFCPOLYLOOP((#11,#12,#14));#27=IFCFACEOUTERBOUND(#26,.T.);#28=IFCFACE((#27));\n\
        #29=IFCPOLYLOOP((#12,#10,#14));#30=IFCFACEOUTERBOUND(#29,.T.);#31=IFCFACE((#30));\n\
        #32=IFCPOLYLOOP((#10,#14,#60));#33=IFCFACEOUTERBOUND(#32,.T.);#34=IFCFACE((#33));\n\
        #60=IFCCARTESIANPOINT((0.,0.,6.));\n\
        #40=IFCCONNECTEDFACESET((#22,#25,#28,#31,#34));\n\
        #5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let mesh = evaluate(body);
    assert_eq!(mesh.triangles.len(), 4);
    // Base 1 by 2 over 2, height 3, over 3.
    close(mesh.volume(), 1.0 * 2.0 / 2.0 * 3.0 / 3.0);
}


#[test]
fn a_set_with_no_shared_indices_still_closes_outward() {
    // A 2 m cube as 36 corners, one per triangle corner, every triangle wound inward: nothing
    // shares an index, so adjacency has to come from where the corners are.
    let cube = Mesh::cuboid(DVec3::ZERO, DVec3::splat(2.0));
    let mut mesh = Mesh::default();
    for [a, b, c] in cube.triangle_corners() {
        let first = mesh.positions.len() as u32;
        mesh.positions.extend([a, c, b]);
        mesh.triangles.push([first, first + 1, first + 2]);
    }
    close(mesh.volume(), -8.0);
    mesh.orient_shell();
    close(mesh.volume(), 8.0);
}

#[test]
fn a_corner_at_negative_zero_is_the_same_corner() {
    // Rounding gives -0.0 as easily as 0.0, and their bits differ. Half the triangles use one.
    let cube = Mesh::cuboid(DVec3::ZERO, DVec3::splat(2.0));
    let mut mesh = Mesh::default();
    for (index, [a, b, c]) in cube.triangle_corners().enumerate() {
        let zero = |point: DVec3| {
            let axis = |value: f64| if value == 0.0 && index % 2 == 1 { -0.0 } else { value };
            DVec3::new(axis(point.x), axis(point.y), axis(point.z))
        };
        let first = mesh.positions.len() as u32;
        mesh.positions.extend([zero(a), zero(c), zero(b)]);
        mesh.triangles.push([first, first + 1, first + 2]);
    }
    mesh.orient_shell();
    close(mesh.volume(), 8.0);
}

fn diagnostics_of(body: &str) -> (Mesh, Vec<String>) {
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;\n{CORNERS}{body}ENDSEC;END-ISO-10303-21;"
    );
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let element = evaluator.evaluate(2).expect("the element evaluates");
    let mesh = element.meshes.into_iter().next().map(|item| item.mesh).unwrap_or_default();
    (mesh, evaluator.diagnostics().iter().map(|item| item.code.to_string()).collect())
}

#[test]
fn a_corner_that_cannot_be_read_is_reported() {
    // #99 does not exist, and `$` is no corner: the quad would quietly become a triangle.
    for corners in ["#14,#15,#16,#99", "#14,#15,#16,$"] {
        let body = faces(corners) + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
        let (_, codes) = diagnostics_of(&body);
        assert!(codes.iter().any(|code| code == "bad-face"), "{corners}: {codes:?}");
    }
}

#[test]
fn a_corner_that_is_not_a_point_is_not_read_as_one() {
    // #99 holds three numbers, as a point would, but a direction has no coordinates.
    let body = faces("#14,#15,#16,#99")
        + "#99=IFCDIRECTION((0.,2.,3.));\n#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let (_, codes) = diagnostics_of(&body);
    assert!(codes.iter().any(|code| code == "bad-face"), "{codes:?}");
}

#[test]
fn records_that_are_not_a_face_or_a_bound_are_not_read_as_one() {
    // Each is written as a face or a bound would be, but a face set has no bounds and an
    // edge no loop, so the top is missing.
    for (from, to) in [
        ("#25=IFCFACE((#24))", "#25=IFCCONNECTEDFACESET((#24))"),
        ("#24=IFCFACEOUTERBOUND(#23,.T.)", "#24=IFCEDGE(#23,.T.)"),
    ] {
        let body = faces("#14,#15,#16,#17").replace(from, to) + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
        assert!(body.contains(to));
        let (mesh, _) = diagnostics_of(&body);
        assert_eq!(mesh.triangles.len(), 10, "{to}");
    }
}

#[test]
fn points_written_in_other_ways_read_the_same() {
    // A typed coordinate takes the full decoder; integers and a point with no z take the fast
    // path, where z is zero. Each changes a coordinate that is not zero, so a reader that
    // returned zero would lose volume.
    let corners = CORNERS
        .replace("#16=IFCCARTESIANPOINT((1.,2.,3.))", "#16=IFCCARTESIANPOINT((IFCLENGTHMEASURE(1.),2,3))")
        .replace("#11=IFCCARTESIANPOINT((1.,0.,0.))", "#11=IFCCARTESIANPOINT((1.,0.))");
    let body = faces("#14,#15,#16,#17") + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let text = format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;\n{corners}{body}ENDSEC;END-ISO-10303-21;"
    );
    assert_ne!(corners, CORNERS);
    let file = index(text.as_bytes()).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let mesh = evaluator.evaluate(2).unwrap().meshes.remove(0).mesh;
    close(mesh.volume(), 6.0);
    assert!(evaluator.diagnostics().is_empty(), "{:?}", evaluator.diagnostics());
}

/// The bottom of the box as one face with a 0.5 by 0.5 hole, whose bound is listed first.
/// `complex` writes each record of the face as a complex instance of one part, which the full
/// decoder reads and the fast paths leave to it.
fn holed_face(face: &str, orientation: &str, complex: bool) -> String {
    let records = [
        "#20=IFCPOLYLOOP((#10,#11,#12,#13))".to_string(),
        "#23=IFCPOLYLOOP((#50,#51,#52,#53))".to_string(),
        format!("#21=IFCFACEOUTERBOUND(#20,{orientation})"),
        format!("#24=IFCFACEBOUND(#23,{orientation})"),
        format!("#22={face}"),
    ];
    let mut text = String::new();
    for record in records {
        let (id, body) = record.split_once('=').unwrap();
        text += &if complex { format!("{id}=({body});\n") } else { format!("{id}={body};\n") };
    }
    text + "#50=IFCCARTESIANPOINT((0.25,0.25,0.));\n#51=IFCCARTESIANPOINT((0.25,0.75,0.));\n\
        #52=IFCCARTESIANPOINT((0.75,0.75,0.));\n#53=IFCCARTESIANPOINT((0.75,0.25,0.));\n\
        #60=IFCPLANE(#61);\n#61=IFCAXIS2PLACEMENT3D(#10,$,$);\n\
        #40=IFCCONNECTEDFACESET((#22));\n#5=IFCFACEBASEDSURFACEMODEL((#40));\n"
}

/// Twice the area of each triangle along its normal, summed: the way the mesh faces.
fn facing(mesh: &Mesh) -> DVec3 {
    mesh.triangle_corners().map(|[a, b, c]| (b - a).cross(c - a)).sum()
}

#[test]
fn a_face_reads_the_same_however_its_records_are_written() {
    for (face, orientation, up) in [
        ("IFCFACE((#24,#21))", ".T.", 1.0),
        ("IFCFACE((#24,#21))", ".F.", -1.0),
        ("IFCFACESURFACE((#24,#21),#60,.T.)", ".T.", 1.0),
        ("IFCFACESURFACE((#24,#21),#60,.F.)", ".T.", -1.0),
    ] {
        let case = format!("{face} {orientation}");
        let plain = evaluate(&holed_face(face, orientation, false));
        let complex = evaluate(&holed_face(face, orientation, true));
        assert_eq!(plain, complex, "{case}");
        // The hole is cut from the outer loop, not the other way round.
        let facing = facing(&plain);
        close(facing.z, up * 2.0 * (2.0 - 0.25));
        close(facing.x, 0.0);
        close(facing.y, 0.0);
    }
}

#[test]
fn a_face_without_a_hole_turns_with_its_bound_and_its_surface_sense() {
    // The bottom of the box alone, 1 by 2 m, counter-clockwise from above as written.
    for (face, orientation, up) in [
        ("IFCFACE((#21))", ".T.", 1.0),
        ("IFCFACE((#21))", ".F.", -1.0),
        ("IFCFACESURFACE((#21),#60,.T.)", ".T.", 1.0),
        ("IFCFACESURFACE((#21),#60,.F.)", ".T.", -1.0),
        ("IFCFACESURFACE((#21),#60,.F.)", ".F.", 1.0),
    ] {
        let body = format!(
            "#20=IFCPOLYLOOP((#10,#11,#12,#13));\n#21=IFCFACEOUTERBOUND(#20,{orientation});\n#22={face};\n\
             #60=IFCPLANE(#61);\n#61=IFCAXIS2PLACEMENT3D(#10,$,$);\n\
             #40=IFCCONNECTEDFACESET((#22));\n#5=IFCFACEBASEDSURFACEMODEL((#40));\n"
        );
        let facing = facing(&evaluate(&body));
        close(facing.z, up * 2.0 * 2.0);
        close(facing.x, 0.0);
        close(facing.y, 0.0);
    }
}

#[test]
fn a_face_left_with_too_few_corners_is_reported() {
    let body = faces("#14,#15") + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let (_, codes) = diagnostics_of(&body);
    assert!(codes.iter().any(|code| code == "bad-face"), "{codes:?}");
}

#[test]
fn a_clean_shell_reports_nothing() {
    let body = faces("#14,#15,#16,#17") + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let (_, codes) = diagnostics_of(&body);
    assert!(codes.is_empty(), "{codes:?}");
}

#[test]
fn the_hash_secret_does_not_change_a_shell() {
    // Points shared by faces and a face with a hole fill the builder's maps.
    let body = faces("#14,#15,#16,#17") + "#5=IFCFACEBASEDSURFACEMODEL((#40));\n";
    let holed = holed_face("IFCFACE((#24,#21))", ".T.", false);
    let expected = (evaluate(&body), evaluate(&holed));
    for secret in [[1, 2, 3, 4], [u64::MAX; 4], [0x9e37_79b9_7f4a_7c15, 7, 0, 1 << 63]] {
        set_secret(secret);
        assert_eq!((evaluate(&body), evaluate(&holed)), expected);
    }
}
