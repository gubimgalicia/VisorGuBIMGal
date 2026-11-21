//! A 20 km georeferenced road, `test/fixtures/generated/road-20km.ifc`, against the values its
//! generator computes from the design by plane geometry.

use std::fs;
use std::path::{Path, PathBuf};
use wasm_api::batches::{Batch, MAX_BATCH_RADIUS};
use wasm_api::loaded::LoadedModel;

const RECORD_WORDS: usize = 7;
const DEGRADED: u32 = 1 << 1;

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/generated")
}

fn open() -> LoadedModel {
    LoadedModel::open(fs::read(folder().join("road-20km.ifc")).unwrap()).unwrap()
}

/// The numbers after `key` in a one-record line of the expected file.
fn numbers(line: &str, key: &str) -> Vec<f64> {
    let rest = &line[line.find(key).unwrap_or_else(|| panic!("{key} in {line}")) + key.len()..];
    let end = rest.find([']', ',', '}']).unwrap();
    let list = if rest.starts_with('[') { &rest[1..rest.find(']').unwrap()] } else { &rest[..end] };
    list.split(',').map(|value| value.trim().parse().unwrap()).collect()
}

fn records(key: &str) -> Vec<String> {
    let text = fs::read_to_string(folder().join("road-20km.expected.json")).unwrap();
    text.lines().filter(|line| line.trim_start().starts_with('{') && line.contains(key)).map(str::to_owned).collect()
}

/// The corners an element's mesh is drawn with, absolute, in f64.
fn corners(model: &mut LoadedModel, express_id: u32) -> Vec<[f64; 3]> {
    let shape = model.element_mesh(express_id).unwrap_or_else(|| panic!("no mesh for #{express_id}"));
    shape.positions.as_chunks::<3>().0.to_vec()
}

#[test]
fn every_kilometre_post_stands_where_the_design_puts_it() {
    let mut model = open();
    let posts = records("\"centre\"");
    assert_eq!(posts.len(), 21);
    for post in &posts {
        let id = numbers(post, "\"id\":")[0] as u32;
        let expected = numbers(post, "\"centre\":");
        let corners = corners(&mut model, id);
        // A box: the middle of its corners' extent is its centre, whatever way it turns.
        let centre: Vec<f64> = (0..3)
            .map(|axis| {
                let values = corners.iter().map(|corner| corner[axis]);
                (values.clone().fold(f64::INFINITY, f64::min) + values.fold(f64::NEG_INFINITY, f64::max)) / 2.0
            })
            .collect();
        for axis in 0..3 {
            assert!((centre[axis] - expected[axis]).abs() < 1e-3, "#{id} {post}: {centre:?}");
        }
    }
}

#[test]
fn the_courses_have_their_heights_and_volumes() {
    let mut model = open();
    for course in records("\"volume\"") {
        let id = numbers(&course, "\"id\":")[0] as u32;
        let shape = model.element_mesh(id).unwrap();
        let corners = shape.positions.as_chunks::<3>().0;
        let low = corners.iter().map(|corner| corner[2]).fold(f64::INFINITY, f64::min);
        let high = corners.iter().map(|corner| corner[2]).fold(f64::NEG_INFINITY, f64::max);
        assert!((low - numbers(&course, "\"zMin\":")[0]).abs() < 1e-6, "{course}: low {low}");
        assert!((high - numbers(&course, "\"zMax\":")[0]).abs() < 1e-6, "{course}: high {high}");
        // Signed volume about the first corner. Chords of the arcs cut the curve a little short.
        let reference = corners[0];
        let point = |index: u32| -> [f64; 3] {
            let corner = corners[index as usize];
            std::array::from_fn(|axis| corner[axis] - reference[axis])
        };
        let volume: f64 = shape
            .indices
            .as_chunks::<3>()
            .0
            .iter()
            .map(|&[a, b, c]| {
                let ([ax, ay, az], [bx, by, bz], [cx, cy, cz]) = (point(a), point(b), point(c));
                (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6.0
            })
            .sum();
        let expected = numbers(&course, "\"volume\":")[0];
        assert!((volume - expected).abs() < 1e-4 * expected, "{course}: volume {volume}");
    }
}

#[test]
fn the_road_streams_within_the_batch_radius_and_with_its_map_reference() {
    let mut model = open();
    let summary = model.summary_json();
    assert!(summary.contains("EPSG:25829"), "{summary}");
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
    assert!(!complete.contains(r#""severity":"warning""#) && !complete.contains("batch-radius"), "{complete}");
    // 23 elements: 2 courses, longer than one batch radius, in several pieces each, and 21 posts.
    let drawn: std::collections::BTreeSet<u32> = batches
        .iter()
        .flat_map(|batch| batch.mesh_table.as_chunks::<RECORD_WORDS>().0.iter().map(|record| record[0]))
        .collect();
    assert_eq!(drawn.len(), 23, "{drawn:?}");
    assert!(batches.len() >= 3, "{} batches", batches.len());
}
