//! The single-storey building authored in millimetres with a scaled `IfcMapConversion`
//! (`test/fixtures/authored/units-mm-georef.ifc`), checked against its independently
//! computed expected values in metres (`units-mm-georef.expected.json`).

use std::fs;
use std::path::{Path, PathBuf};
use wasm_api::batches::Batch;
use wasm_api::loaded::LoadedModel;

const RECORD_WORDS: usize = 7;
const FLAG_DEGRADED: u32 = 1 << 1;

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/authored")
}

fn ifc() -> String {
    fs::read_to_string(folder().join("units-mm-georef.ifc")).unwrap()
}

fn expected() -> String {
    fs::read_to_string(folder().join("units-mm-georef.expected.json")).unwrap()
}

/// The express id of the one element whose line holds every part of `needles`.
fn element_id(text: &str, needles: &[&str]) -> u32 {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| needles.iter().all(|needle| line.contains(needle)))
        .collect();
    assert_eq!(lines.len(), 1, "{needles:?}");
    lines[0][1..lines[0].find('=').unwrap()].parse().unwrap()
}

/// The `value` and `tolerance` of the quantity reached by finding each key of `path` in turn.
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

fn shape(model: &mut LoadedModel, express_id: u32) -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let shape = model
        .element_mesh(express_id)
        .unwrap_or_else(|| panic!("no mesh for #{express_id}"));
    (
        shape.positions.as_chunks::<3>().0.to_vec(),
        shape.indices.as_chunks::<3>().0.to_vec(),
    )
}

fn volume(corners: &[[f64; 3]], triangles: &[[u32; 3]]) -> f64 {
    let reference = corners[0];
    let point = |index: u32| -> [f64; 3] {
        std::array::from_fn(|axis| corners[index as usize][axis] - reference[axis])
    };
    triangles
        .iter()
        .map(|&[a, b, c]| {
            let ([ax, ay, az], [bx, by, bz], [cx, cy, cz]) = (point(a), point(b), point(c));
            (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6.0
        })
        .sum()
}

/// Parses `"localToMap":[...]` from `summary_json()` as a 16-element column-major matrix.
fn parse_local_to_map(summary: &str) -> [f64; 16] {
    let key = "\"localToMap\":[";
    let start = summary.find(key).expect("localToMap in summary") + key.len();
    let end = start + summary[start..].find(']').unwrap();
    let values: Vec<f64> = summary[start..end]
        .split(',')
        .map(|part| part.trim().parse().unwrap())
        .collect();
    values.try_into().unwrap()
}

fn transform_point(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}

#[test]
fn millimetre_building_elements_and_georeference_match_expected_metres() {
    let (text, json) = (ifc(), expected());
    let mut model = LoadedModel::open(text.clone().into_bytes()).unwrap();
    let summary = model.summary_json();
    assert!(summary.contains("\"lengthUnitScale\":0.001"), "{summary}");
    assert!(summary.contains("\"crsId\":\"EPSG:25829\""), "{summary}");
    assert!(summary.contains("\"confidence\":\"verified\""), "{summary}");
    assert!(summary.contains("\"mapUnit\":\"m\""), "{summary}");
    assert!(summary.contains("\"diagnostics\":[]"), "{summary}");

    let local_to_map = parse_local_to_map(&summary);
    let (eastings, east_tol) = quantity(&json, &["\"georeference\":", "\"eastings\":"]);
    let (northings, north_tol) = quantity(&json, &["\"georeference\":", "\"northings\":"]);
    let (orth_height, height_tol) =
        quantity(&json, &["\"georeference\":", "\"orthogonal_height\":"]);
    assert!((local_to_map[12] - eastings).abs() <= east_tol);
    assert!((local_to_map[13] - northings).abs() <= north_tol);
    assert!((local_to_map[14] - orth_height).abs() <= height_tol);
    // Because file_scale == 0.001, map_scale == 1.0, and IfcMapConversion.Scale == 0.001,
    // model metres map 1:1 to CRS metres before translation.
    assert!((local_to_map[0] - 1.0).abs() <= 1e-12);
    assert!((local_to_map[5] - 1.0).abs() <= 1e-12);
    assert!((local_to_map[10] - 1.0).abs() <= 1e-12);

    let elements = [
        ("=IFCSLAB(", "guBIM floor slab", false),
        ("=IFCWALL(", "guBIM south wall", true),
        ("=IFCWALL(", "guBIM north wall", true),
        ("=IFCWALL(", "guBIM west wall", true),
        ("=IFCWALL(", "guBIM east wall", true),
        ("=IFCSLAB(", "guBIM roof slab", false),
    ];

    let mut wall_sum = 0.0;
    let mut slab_sum = 0.0;
    let mut model_min = [f64::INFINITY; 3];
    let mut model_max = [f64::NEG_INFINITY; 3];

    for (class_token, name, is_wall) in elements {
        let id = element_id(&text, &[class_token, &format!("'{name}'")]);
        let (corners, triangles) = shape(&mut model, id);
        let json_name = format!("\"{name}\"");
        let (wanted_vol, vol_tol) =
            quantity(&json, &["\"elements\":", &json_name, "\"volume\":"]);
        let measured_vol = volume(&corners, &triangles);
        assert!(
            (measured_vol - wanted_vol).abs() <= vol_tol,
            "{name} (#{id}) volume {measured_vol} against {wanted_vol} ± {vol_tol}"
        );
        if is_wall {
            wall_sum += measured_vol;
        } else {
            slab_sum += measured_vol;
        }

        let mut local_centre = [0.0; 3];
        for (axis, axis_name) in ["x", "y", "z"].into_iter().enumerate() {
            let values = corners.iter().map(|corner| corner[axis]);
            let least = values.clone().fold(f64::INFINITY, f64::min);
            let most = values.fold(f64::NEG_INFINITY, f64::max);
            model_min[axis] = model_min[axis].min(least);
            model_max[axis] = model_max[axis].max(most);
            local_centre[axis] = 0.5 * (least + most);

            let (wanted_size, size_tol) = quantity(
                &json,
                &[
                    "\"elements\":",
                    &json_name,
                    "\"size\":",
                    &format!("\"{axis_name}\":"),
                ],
            );
            assert!(
                ((most - least) - wanted_size).abs() <= size_tol + 1e-6,
                "{name} {axis_name} size {} against {wanted_size}",
                most - least
            );

            let (low, low_tol) = quantity(
                &json,
                &[
                    "\"elements\":",
                    &json_name,
                    "\"bbox\":",
                    &format!("\"{axis_name}_min\":"),
                ],
            );
            let (high, high_tol) = quantity(
                &json,
                &[
                    "\"elements\":",
                    &json_name,
                    "\"bbox\":",
                    &format!("\"{axis_name}_max\":"),
                ],
            );
            assert!(
                (least - low).abs() <= low_tol,
                "{name} {axis_name}_min {least} against {low}"
            );
            assert!(
                (most - high).abs() <= high_tol,
                "{name} {axis_name}_max {most} against {high}"
            );
        }

        let world_centre = transform_point(&local_to_map, local_centre);
        for (axis, world_key) in ["\"easting\":", "\"northing\":", "\"height\":"]
            .into_iter()
            .enumerate()
        {
            let (wanted_world, world_tol) = quantity(
                &json,
                &["\"elements\":", &json_name, "\"centre_world\":", world_key],
            );
            assert!(
                (world_centre[axis] - wanted_world).abs() <= world_tol + 1e-6,
                "{name} world {world_key} {} against {wanted_world}",
                world_centre[axis]
            );
        }
    }

    let (wanted_wall_vol, wall_tol) = quantity(&json, &["\"totals\":", "\"wall_volume\":"]);
    let (wanted_slab_vol, slab_tol) = quantity(&json, &["\"totals\":", "\"slab_volume\":"]);
    let (wanted_total_vol, total_tol) = quantity(&json, &["\"totals\":", "\"element_volume\":"]);
    assert!((wall_sum - wanted_wall_vol).abs() <= wall_tol);
    assert!((slab_sum - wanted_slab_vol).abs() <= slab_tol);
    assert!((wall_sum + slab_sum - wanted_total_vol).abs() <= total_tol);

    for (axis, axis_name) in ["x", "y", "z"].into_iter().enumerate() {
        let (low, low_tol) = quantity(
            &json,
            &["\"model_extent_local\":", &format!("\"{axis_name}_min\":")],
        );
        let (high, high_tol) = quantity(
            &json,
            &["\"model_extent_local\":", &format!("\"{axis_name}_max\":")],
        );
        assert!((model_min[axis] - low).abs() <= low_tol);
        assert!((model_max[axis] - high).abs() <= high_tol);
    }

    let world_min = transform_point(&local_to_map, model_min);
    let world_max = transform_point(&local_to_map, model_max);
    for (axis, prefix) in ["easting", "northing", "height"].into_iter().enumerate() {
        let (low, low_tol) = quantity(
            &json,
            &["\"model_extent_world\":", &format!("\"{prefix}_min\":")],
        );
        let (high, high_tol) = quantity(
            &json,
            &["\"model_extent_world\":", &format!("\"{prefix}_max\":")],
        );
        assert!((world_min[axis] - low).abs() <= low_tol + 1e-6);
        assert!((world_max[axis] - high).abs() <= high_tol + 1e-6);
    }

    model.start_stream();
    let batches: Vec<Batch> = std::iter::from_fn(|| model.next_batch(usize::MAX)).collect();
    let complete = model.finish_stream();
    assert!(complete.contains(r#""diagnostics":[]"#), "{complete}");
    let mut count = 0;
    for batch in &batches {
        for record in batch.mesh_table.as_chunks::<RECORD_WORDS>().0 {
            assert_eq!(record[6] & FLAG_DEGRADED, 0);
            count += 1;
        }
    }
    assert_eq!(count, 6);
}
