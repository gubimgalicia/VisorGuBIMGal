//! The two-storey building with wall openings, boolean-clipped roof, mapped-item bollards,
//! spaces, and coloured materials (`test/fixtures/authored/building-booleans.ifc`),
//! checked against its independently computed expected values (`building-booleans.expected.json`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use wasm_api::batches::Batch;
use wasm_api::loaded::LoadedModel;

const RECORD_WORDS: usize = 7;
const FLAG_TRANSPARENT: u32 = 1 << 0;
const FLAG_DEGRADED: u32 = 1 << 1;
const FLAG_HIDDEN_BY_DEFAULT: u32 = 1 << 2;
const FLAG_CLOSED: u32 = 1 << 3;

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/authored")
}

fn ifc() -> String {
    fs::read_to_string(folder().join("building-booleans.ifc")).unwrap()
}

fn expected() -> String {
    fs::read_to_string(folder().join("building-booleans.expected.json")).unwrap()
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
    let shape = model
        .element_mesh(express_id)
        .unwrap_or_else(|| panic!("no mesh for #{express_id}"));
    (
        shape.positions.as_chunks::<3>().0.to_vec(),
        shape.indices.as_chunks::<3>().0.to_vec(),
    )
}

/// Signed volume, measured from the first corner for precision.
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

fn check_element_volume_and_bbox(
    model: &mut LoadedModel,
    text: &str,
    json: &str,
    class_token: &str,
    name: &str,
    section_key: &str,
    volume_key: &str,
) -> f64 {
    let name_token = format!("'{name}'");
    let json_name = format!("\"{name}\"");
    let id = element_id(text, &[class_token, &name_token]);
    let (corners, triangles) = shape(model, id);
    let (wanted, tolerance) = quantity(json, &[section_key, &json_name, volume_key]);
    let measured = volume(&corners, &triangles);
    assert!(
        (measured - wanted).abs() <= tolerance,
        "{name} (#{id}) volume {measured} against {wanted} ± {tolerance}"
    );
    for (axis, axis_name) in ["x", "y", "z"].into_iter().enumerate() {
        let values = corners.iter().map(|corner| corner[axis]);
        let least = values.clone().fold(f64::INFINITY, f64::min);
        let most = values.fold(f64::NEG_INFINITY, f64::max);
        let min_key = format!("\"{axis_name}_min\":");
        let max_key = format!("\"{axis_name}_max\":");
        let (low, low_tol) = quantity(json, &[section_key, &json_name, "\"bbox\":", &min_key]);
        let (high, high_tol) = quantity(json, &[section_key, &json_name, "\"bbox\":", &max_key]);
        assert!(
            (least - low).abs() <= low_tol,
            "{name} (#{id}) {axis_name}_min {least} against {low} ± {low_tol}"
        );
        assert!(
            (most - high).abs() <= high_tol,
            "{name} (#{id}) {axis_name}_max {most} against {high} ± {high_tol}"
        );
    }
    measured
}

#[test]
fn walls_slabs_fillings_proxies_and_spaces_match_their_expected_volumes_and_boxes() {
    let (text, json) = (ifc(), expected());
    let mut model = LoadedModel::open(text.clone().into_bytes()).unwrap();

    let walls = [
        "guBIM south wall L1",
        "guBIM north wall L1",
        "guBIM west wall L1",
        "guBIM east wall L1",
        "guBIM south wall L2",
        "guBIM north wall L2",
        "guBIM west wall L2",
        "guBIM east wall L2",
    ];
    let mut wall_sum = 0.0;
    for name in walls {
        wall_sum += check_element_volume_and_bbox(
            &mut model,
            &text,
            &json,
            "=IFCWALL(",
            name,
            "\"walls\":",
            "\"net_volume\":",
        );
    }
    let (wanted_wall_total, wall_tol) = quantity(&json, &["\"totals\":", "\"wall_net_volume\":"]);
    assert!(
        (wall_sum - wanted_wall_total).abs() <= wall_tol,
        "wall_net_volume {wall_sum} against {wanted_wall_total}"
    );

    let slabs = ["guBIM ground slab", "guBIM intermediate slab", "guBIM roof slab"];
    let mut slab_sum = 0.0;
    for name in slabs {
        slab_sum += check_element_volume_and_bbox(
            &mut model,
            &text,
            &json,
            "=IFCSLAB(",
            name,
            "\"slabs\":",
            "\"volume\":",
        );
    }
    let (wanted_slab_total, slab_tol) = quantity(&json, &["\"totals\":", "\"slab_volume\":"]);
    assert!(
        (slab_sum - wanted_slab_total).abs() <= slab_tol,
        "slab_volume {slab_sum} against {wanted_slab_total}"
    );

    let fillings = [
        ("=IFCDOOR(", "guBIM door 1"),
        ("=IFCWINDOW(", "guBIM window 1"),
        ("=IFCWINDOW(", "guBIM window 2"),
        ("=IFCWINDOW(", "guBIM window 3"),
        ("=IFCWINDOW(", "guBIM window 4"),
    ];
    let mut filling_sum = 0.0;
    for (class_token, name) in fillings {
        filling_sum += check_element_volume_and_bbox(
            &mut model,
            &text,
            &json,
            class_token,
            name,
            "\"fillings\":",
            "\"volume\":",
        );
    }
    let (wanted_filling_total, filling_tol) =
        quantity(&json, &["\"totals\":", "\"filling_volume\":"]);
    assert!(
        (filling_sum - wanted_filling_total).abs() <= filling_tol,
        "filling_volume {filling_sum} against {wanted_filling_total}"
    );

    let bollards = [
        "guBIM bollard 1",
        "guBIM bollard 2",
        "guBIM bollard 3",
        "guBIM bollard 4",
        "guBIM bollard 5",
    ];
    let mut proxy_sum = 0.0;
    for name in bollards {
        proxy_sum += check_element_volume_and_bbox(
            &mut model,
            &text,
            &json,
            "=IFCBUILDINGELEMENTPROXY(",
            name,
            "\"proxies\":",
            "\"volume\":",
        );
    }
    let (wanted_proxy_total, proxy_tol) = quantity(&json, &["\"totals\":", "\"proxy_volume\":"]);
    assert!(
        (proxy_sum - wanted_proxy_total).abs() <= proxy_tol,
        "proxy_volume {proxy_sum} against {wanted_proxy_total}"
    );

    let element_sum = wall_sum + slab_sum + filling_sum + proxy_sum;
    let (wanted_element_total, element_tol) =
        quantity(&json, &["\"totals\":", "\"element_volume\":"]);
    assert!(
        (element_sum - wanted_element_total).abs() <= element_tol,
        "element_volume {element_sum} against {wanted_element_total}"
    );

    for name in ["guBIM space 1", "guBIM space 2"] {
        check_element_volume_and_bbox(
            &mut model,
            &text,
            &json,
            "=IFCSPACE(",
            name,
            "\"spaces\":",
            "\"volume\":",
        );
    }
}

#[test]
fn building_booleans_streams_colours_materials_and_spatial_tree_with_zero_diagnostics() {
    let (text, json) = (ifc(), expected());
    let mut model = LoadedModel::open(text.clone().into_bytes()).unwrap();

    let tree = model.spatial_tree_json().expect("spatial tree present");
    assert!(tree.contains("\"guBIM level 1\""), "{tree}");
    assert!(tree.contains("\"guBIM level 2\""), "{tree}");

    model.start_stream();
    let batches: Vec<Batch> = std::iter::from_fn(|| model.next_batch(usize::MAX)).collect();
    let complete = model.finish_stream();
    assert!(complete.contains(r#""diagnostics":[]"#), "{complete}");

    let mut records_by_id: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
    for batch in &batches {
        // Records and, since A13, instances: [express id, shape id, rgba, flags].
        let records = batch.mesh_table.as_chunks::<RECORD_WORDS>().0.iter().map(|record| (record[0], record[5], record[6]));
        let instances = batch.instance_table.as_chunks::<4>().0.iter().map(|row| (row[0], row[2], row[3]));
        for (express_id, rgba, flags) in records.chain(instances) {
            assert_eq!(flags & FLAG_DEGRADED, 0, "#{express_id} degraded");
            assert_ne!(flags & FLAG_CLOSED, 0, "#{express_id} not closed");
            records_by_id.insert(express_id, (rgba, flags));
        }
    }
    // 8 walls + 3 slabs + 5 fillings + 5 proxies + 2 spaces = 23 elements.
    assert_eq!(records_by_id.len(), 23, "{records_by_id:?}");

    let material_checks = [
        ("guBIM brick", "=IFCWALL(", "guBIM south wall L1", false),
        ("guBIM concrete", "=IFCSLAB(", "guBIM roof slab", false),
        ("guBIM wood", "=IFCDOOR(", "guBIM door 1", false),
        ("guBIM glass", "=IFCWINDOW(", "guBIM window 1", true),
        ("guBIM steel", "=IFCBUILDINGELEMENTPROXY(", "guBIM bollard 1", false),
    ];
    for (material_name, class_token, element_name, expect_transparent) in material_checks {
        let id = element_id(&text, &[class_token, &format!("'{element_name}'")]);
        let (rgba, flags) = records_by_id[&id];
        let mat_key = format!("\"{material_name}\"");
        let (r, _) = quantity(&json, &["\"materials\":", &mat_key, "\"r\":"]);
        let (g, _) = quantity(&json, &["\"materials\":", &mat_key, "\"g\":"]);
        let (b, _) = quantity(&json, &["\"materials\":", &mat_key, "\"b\":"]);
        let (transparency, _) = quantity(&json, &["\"materials\":", &mat_key, "\"transparency\":"]);
        let expected_rgba = (((r * 255.0).round() as u32) << 24)
            | (((g * 255.0).round() as u32) << 16)
            | (((b * 255.0).round() as u32) << 8)
            | (((1.0 - transparency) * 255.0).round() as u32);
        assert_eq!(
            rgba, expected_rgba,
            "{element_name} (#{id}) rgba {rgba:#010x} against {expected_rgba:#010x}"
        );
        assert_eq!(
            (flags & FLAG_TRANSPARENT) != 0,
            expect_transparent,
            "{element_name} (#{id}) transparent flag"
        );
        let details = model.element_details_json(id).expect("element details");
        assert!(
            details.contains(material_name),
            "{element_name} (#{id}) details missing {material_name}: {details}"
        );
    }

    for space_name in ["guBIM space 1", "guBIM space 2"] {
        let id = element_id(&text, &["=IFCSPACE(", &format!("'{space_name}'")]);
        let (_, flags) = records_by_id[&id];
        assert_ne!(
            flags & FLAG_HIDDEN_BY_DEFAULT,
            0,
            "{space_name} (#{id}) should be hidden by default"
        );
    }
}
