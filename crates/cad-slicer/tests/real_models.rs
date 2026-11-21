//! Real kernel output against an oracle that shares nothing with the slicer: whether a point is
//! inside a closed mesh, decided by counting ray crossings.

use cad_slicer::{Axis, Cut, DrawingMesh, DrawingOptions, Look, draw, to_dxf, to_svg};
use glam::DVec3;
use ifc_geometry::{Mesh, ModelEvaluator};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use step_parser::index;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn models() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for folder in ["test/fixtures", "public/samples"] {
        for entry in fs::read_dir(root().join(folder)).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|extension| extension == "ifc") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn load(path: &Path) -> Vec<DrawingMesh> {
    let bytes = fs::read(path).unwrap();
    let file = index(&bytes).unwrap();
    let mut evaluator = ModelEvaluator::new(&file).unwrap();
    let mut meshes = Vec::new();
    for id in evaluator.element_ids() {
        if let Some(element) = evaluator.evaluate(id) {
            for item in element.meshes {
                meshes.push(DrawingMesh::new(0, id, format!("Element {id}"), item.mesh));
            }
        }
    }
    meshes
}

fn bounds(mesh: &Mesh) -> (DVec3, DVec3) {
    let start = (DVec3::INFINITY, DVec3::NEG_INFINITY);
    mesh.positions.iter().fold(start, |(min, max), point| (min.min(*point), max.max(*point)))
}

/// Moller-Trumbore, along a direction no model is aligned with.
fn crosses(origin: DVec3, [a, b, c]: [DVec3; 3]) -> bool {
    let direction = DVec3::new(0.0137, 0.00911, 1.0).normalize();
    let (ab, ac) = (b - a, c - a);
    let side = direction.cross(ac);
    let determinant = ab.dot(side);
    if determinant.abs() < 1e-14 {
        return false;
    }
    let to_origin = origin - a;
    let u = to_origin.dot(side) / determinant;
    let up = to_origin.cross(ab);
    let v = direction.dot(up) / determinant;
    u >= 0.0 && v >= 0.0 && u + v <= 1.0 && ac.dot(up) / determinant > 0.0
}

fn inside(point: DVec3, mesh: &Mesh) -> bool {
    mesh.triangle_corners().filter(|corners| crosses(point, *corners)).count() % 2 == 1
}

fn cuts(low: DVec3, high: DVec3) -> Vec<Cut> {
    let middle = (low + high) / 2.0;
    let look = |axis, position, look| Cut::Section { axis, position, look };
    vec![
        Cut::Plan { z: middle.z + (high.z - low.z) * 0.0137 },
        look(Axis::X, middle.x + (high.x - low.x) * 0.0173, Look::Positive),
        look(Axis::Y, middle.y - (high.y - low.y) * 0.0211, Look::Negative),
    ]
}

/// Whether a mesh encloses a volume once coincident vertices are welded. Files often repeat
/// vertices per face, which says nothing about whether the solid is closed.
fn watertight(mesh: &Mesh) -> bool {
    let key = |point: DVec3| (point * 1e7).round().as_i64vec3().to_array();
    let mut edges: BTreeMap<([i64; 3], [i64; 3]), i32> = BTreeMap::new();
    for [a, b, c] in mesh.triangle_corners() {
        for (from, to) in [(a, b), (b, c), (c, a)] {
            let (from, to) = (key(from), key(to));
            if from != to {
                *edges.entry((from.min(to), from.max(to))).or_default() += if from < to { 1 } else { -1 };
            }
        }
    }
    !mesh.is_empty() && edges.values().all(|balance| *balance == 0)
}

/// Cut area of each closed element against the oracle, for the whole of a model.
fn check_areas(name: &str, meshes: &[DrawingMesh]) -> (usize, usize, usize, f64) {
    let (mut cuts_made, mut open, mut wrong) = (0, 0, 0);
    let mut worst: f64 = 0.0;
    for item in meshes.iter().filter(|item| watertight(&item.mesh)) {
        let (low, high) = bounds(&item.mesh);
        for cut in cuts(low, high) {
            let options = DrawingOptions { include_hatching: true, ..DrawingOptions::cut_only(cut) };
            let drawing = draw(std::slice::from_ref(item), &options);
            let frame = drawing.frame;
            let (mut u_low, mut u_high) = (f64::INFINITY, f64::NEG_INFINITY);
            let (mut v_low, mut v_high) = (f64::INFINITY, f64::NEG_INFINITY);
            for corner in 0..8 {
                let pick = |axis: usize, low: f64, high: f64| if corner >> axis & 1 == 1 { high } else { low };
                let flat = frame.project(DVec3::new(pick(0, low.x, high.x), pick(1, low.y, high.y), pick(2, low.z, high.z)));
                (u_low, u_high) = (u_low.min(flat.x), u_high.max(flat.x));
                (v_low, v_high) = (v_low.min(flat.y), v_high.max(flat.y));
            }
            let steps = 96;
            let cell = (u_high - u_low) * (v_high - v_low) / (steps * steps) as f64;
            let pitch = ((u_high - u_low) / steps as f64).max((v_high - v_low) / steps as f64);
            let mut hits = 0usize;
            for i in 0..steps {
                for j in 0..steps {
                    let u = u_low + (u_high - u_low) * (i as f64 + 0.5) / steps as f64;
                    let v = v_low + (v_high - v_low) * (j as f64 + 0.5) / steps as f64;
                    hits += inside(frame.unproject(glam::DVec2::new(u, v)), &item.mesh) as usize;
                }
            }
            let expected = hits as f64 * cell;
            let layers = &drawing.layers;
            let area: f64 = layers.iter().flat_map(|layer| &layer.loops).filter(|ring| ring.closed).map(|ring| ring.area()).sum();
            let any_open = drawing.diagnostics.iter().any(|item| item.code == "open-cut-loop");
            cuts_made += 1;
            open += any_open as usize;
            if any_open {
                let rings: Vec<(bool, usize, f64)> = layers.iter().flat_map(|layer| &layer.loops).map(|ring| (ring.closed, ring.points.len(), ring.area())).collect();
                println!("  {name} #{} {cut:?}: open loop, tris {}, rings {rings:?}", item.element_id, item.mesh.triangles.len());
            }
            // A grid can only misjudge cells that the outline passes through.
            let perimeter: f64 = layers
                .iter()
                .flat_map(|layer| &layer.loops)
                .flat_map(|ring| ring.segments())
                .map(|(from, to)| from.distance(to))
                .sum();
            let allowance = perimeter * pitch * 0.75 + cell * 2.0;
            let miss = (area - expected).abs();
            if miss > allowance {
                wrong += 1;
                if wrong <= 6 {
                    println!("  {name} #{} {cut:?}: loops {area:.5}, oracle {expected:.5}, allowed {allowance:.5}, open {any_open}", item.element_id);
                }
            }
            if expected > 0.0 {
                worst = worst.max(miss / allowance.max(1e-12));
            }
            for segment in layers.iter().flat_map(|layer| &layer.hatch).step_by(7) {
                let middle = frame.unproject((segment.a + segment.b) / 2.0);
                if !inside(middle, &item.mesh) {
                    wrong += 1;
                    println!("  {name} #{}: hatch outside at {middle}", item.element_id);
                    break;
                }
            }
        }
    }
    (cuts_made, open, wrong, worst)
}

#[test]
fn every_model_cuts_as_the_oracle_says() {
    let mut failures = 0;
    for path in models() {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let meshes = load(&path);
        let (cuts_made, open, wrong, worst) = check_areas(&name, &meshes);
        println!("{name:<30} cuts {cuts_made:>4}  open {open:>3}  wrong {wrong:>3}  worst {:.0}% of allowance", worst * 100.0);
        failures += open + wrong;
    }
    assert_eq!(failures, 0);
}

#[test]
fn far_from_the_origin_cuts_stay_the_same() {
    // The size of a UTM coordinate in Galicia.
    let shift = DVec3::new(536_000.0, 4_747_000.0, 260.0);
    let mut failures = 0;
    for path in models() {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let moved: Vec<DrawingMesh> = load(&path)
            .into_iter()
            .map(|mut item| {
                item.mesh = item.mesh.map_positions(|point| point + shift);
                item
            })
            .collect();
        let (cuts_made, open, wrong, worst) = check_areas(&name, &moved);
        println!("{name:<30} cuts {cuts_made:>4}  open {open:>3}  wrong {wrong:>3}  worst {:.0}% of allowance", worst * 100.0);
        failures += open + wrong;
    }
    assert_eq!(failures, 0);
}

#[test]
fn write_sheets_for_outside_tools() {
    let Ok(folder) = std::env::var("SHEETS") else { return };
    for path in models() {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let meshes = load(&path);
        let (mut low, mut high) = (DVec3::INFINITY, DVec3::NEG_INFINITY);
        for item in &meshes {
            let (a, b) = bounds(&item.mesh);
            (low, high) = (low.min(a), high.max(b));
        }
        for (label, cut) in ["plan", "sectionx", "sectiony"].iter().zip(cuts(low, high)) {
            let options = DrawingOptions { cut, depth: None, include_projection: true, include_hatching: true };
            let drawing = draw(&meshes, &options);
            fs::write(format!("{folder}/{name}-{label}.dxf"), to_dxf(&drawing)).unwrap();
            fs::write(format!("{folder}/{name}-{label}.svg"), to_svg(&drawing)).unwrap();
            let lines: usize = drawing.layers.iter().map(|layer| layer.visible.len() + layer.hidden.len()).sum();
            println!("{name}-{label}: {} layers, {lines} lines, {} diagnostics", drawing.layers.len(), drawing.diagnostics.len());
        }
    }
}
