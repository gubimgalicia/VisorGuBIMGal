//! The 20 km georeferenced road DeepSeek authored with Blender and IfcOpenShell,
//! `test/fixtures/authored/long-road.ifc`, against the values its script computes from the design.

use std::fs;
use std::path::{Path, PathBuf};
use wasm_api::batches::{Batch, MAX_BATCH_RADIUS};
use wasm_api::loaded::LoadedModel;

const RECORD_WORDS: usize = 7;
const DEGRADED: u32 = 1 << 1;

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/authored")
}

fn ifc() -> String {
    fs::read_to_string(folder().join("long-road.ifc")).unwrap()
}

fn expected() -> String {
    fs::read_to_string(folder().join("long-road.expected.json")).unwrap()
}

/// The express id of the one element whose line holds every part of `needles`.
fn element_id(text: &str, needles: &[&str]) -> u32 {
    let lines: Vec<&str> = text.lines().filter(|line| needles.iter().all(|needle| line.contains(needle))).collect();
    assert_eq!(lines.len(), 1, "{needles:?}");
    lines[0][1..lines[0].find('=').unwrap()].parse().unwrap()
}

/// The `value` and `tolerance` of the quantity reached by finding each key of `path` in turn,
/// each after the one before: the expected file writes its objects in a fixed order.
fn quantity(json: &str, path: &[&str]) -> (f64, f64) {
    let mut at = 0;
    for key in path {
        at += json[at..].find(key).unwrap_or_else(|| panic!("{key} of {path:?}")) + key.len();
    }
    let number = |key: &str| -> f64 {
        let start = at + json[at..].find(key).unwrap() + key.len();
        let rest = json[start..].trim_start();
        rest[..rest.find([',', '\n', '}']).unwrap()].trim().parse().unwrap()
    };
    (number("\"value\":"), number("\"tolerance\":"))
}

/// The element's corners and triangles, absolute, in f64.
fn shape(model: &mut LoadedModel, express_id: u32) -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let shape = model.element_mesh(express_id).unwrap_or_else(|| panic!("no mesh for #{express_id}"));
    (shape.positions.as_chunks::<3>().0.to_vec(), shape.indices.as_chunks::<3>().0.to_vec())
}

/// Signed volume, measured from the first corner for precision.
fn volume(corners: &[[f64; 3]], triangles: &[[u32; 3]]) -> f64 {
    let reference = corners[0];
    let point = |index: u32| -> [f64; 3] { std::array::from_fn(|axis| corners[index as usize][axis] - reference[axis]) };
    triangles
        .iter()
        .map(|&[a, b, c]| {
            let ([ax, ay, az], [bx, by, bz], [cx, cy, cz]) = (point(a), point(b), point(c));
            (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6.0
        })
        .sum()
}

#[test]
fn the_pavement_and_markings_have_their_volumes_and_boxes() {
    let (text, json) = (ifc(), expected());
    let mut model = LoadedModel::open(text.clone().into_bytes()).unwrap();
    let elements = [
        (element_id(&text, &["=IFCCOURSE(", "'guBIM pavement'"]), vec!["\"pavement\":"]),
        (
            element_id(&text, &["=IFCBUILDINGELEMENTPROXY(", "'guBIM lane marking left'"]),
            vec!["\"lane_markings\":", "\"guBIM lane marking left\""],
        ),
        (
            element_id(&text, &["=IFCBUILDINGELEMENTPROXY(", "'guBIM lane marking right'"]),
            vec!["\"lane_markings\":", "\"guBIM lane marking right\""],
        ),
    ];
    for (id, path) in elements {
        let (corners, triangles) = shape(&mut model, id);
        let at = |key: &str| {
            let mut full = path.clone();
            full.extend(key.split(' '));
            quantity(&json, &full)
        };
        let (wanted, tolerance) = at("\"volume\":");
        let measured = volume(&corners, &triangles);
        assert!((measured - wanted).abs() <= tolerance, "#{id} volume {measured} against {wanted} ± {tolerance}");
        for (axis, name) in ["x", "y", "z"].into_iter().enumerate() {
            let values = corners.iter().map(|corner| corner[axis]);
            let (least, most) = (values.clone().fold(f64::INFINITY, f64::min), values.fold(f64::NEG_INFINITY, f64::max));
            let (low, low_tolerance) = at(&format!("\"bbox_local\": \"{name}_min\":"));
            let (high, high_tolerance) = at(&format!("\"bbox_local\": \"{name}_max\":"));
            assert!((least - low).abs() <= low_tolerance, "#{id} {name} min {least} against {low}");
            assert!((most - high).abs() <= high_tolerance, "#{id} {name} max {most} against {high}");
        }
    }
}

#[test]
fn the_road_streams_whole_within_the_batch_radius_and_with_its_map_reference() {
    let (text, json) = (ifc(), expected());
    let mut model = LoadedModel::open(text.into_bytes()).unwrap();
    let summary = model.summary_json();
    // The map conversion's eastings and northings, as the expected file gives them.
    let (east, _) = quantity(&json, &["\"georeference\":", "\"eastings\":"]);
    let (north, _) = quantity(&json, &["\"georeference\":", "\"northings\":"]);
    assert!(summary.contains("\"crsId\":\"EPSG:25829\""), "{summary}");
    assert!(summary.contains(&format!(",{east},{north},0,1]")), "{summary}");
    model.start_stream();
    let batches: Vec<Batch> = std::iter::from_fn(|| model.next_batch(usize::MAX)).collect();
    for batch in &batches {
        for record in batch.mesh_table.as_chunks::<RECORD_WORDS>().0 {
            assert_eq!(record[6] & DEGRADED, 0, "#{} degraded", record[0]);
            for at in record[1]..record[1] + record[2] {
                let start = at as usize * 3;
                let length = batch.positions[start..start + 3].iter().map(|value| f64::from(*value).powi(2)).sum::<f64>();
                assert!(length.sqrt() <= MAX_BATCH_RADIUS + 1e-3);
            }
        }
    }
    let complete = model.finish_stream();
    assert!(complete.contains(r#""diagnostics":[]"#), "{complete}");
    // The pavement and the two markings, each longer than a batch radius and so in pieces.
    let drawn: std::collections::BTreeSet<u32> = batches
        .iter()
        .flat_map(|batch| batch.mesh_table.as_chunks::<RECORD_WORDS>().0.iter().map(|record| record[0]))
        .collect();
    assert_eq!(drawn.len(), 3, "{drawn:?}");
    assert!(batches.len() >= 6, "{} batches", batches.len());
}
