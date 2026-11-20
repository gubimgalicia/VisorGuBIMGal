//! The drawing path of `docs/05` section 6, natively: model chunks into one sheet. Expected
//! values come from the files themselves or from hand arithmetic, never from this code's output.

use std::fs;
use std::path::Path;
use wasm_api::drawing::{DrawingRequest, ExportOptions, SheetStore};
use wasm_api::loaded::LoadedModel;

const NO_DEPTH: f64 = f64::NAN;

fn read(path: &str) -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(path)).unwrap()
}

fn model(path: &str) -> LoadedModel {
    LoadedModel::open(read(path)).unwrap()
}

fn request(words: &[f64]) -> DrawingRequest {
    DrawingRequest::decode(words).unwrap()
}

/// A plan at `z` with projection and hatching off.
fn plan(z: f64) -> Vec<f64> {
    vec![0.0, z, -1.0, NO_DEPTH, 0.0, 0.0, 1.0]
}

fn chunks(model: &mut LoadedModel, words: &[f64], max_triangles: usize) -> Vec<Vec<u8>> {
    model.start_drawing(request(words));
    let mut out = Vec::new();
    while let Some(chunk) = model.next_drawing_chunk(max_triangles) {
        out.push(chunk);
    }
    model.finish_drawing();
    out
}

fn dxf(sheet: &SheetStore) -> Vec<u8> {
    let options = ExportOptions {
        svg: false,
        scale: 1.0,
        show_hidden: true,
        show_hatching: true,
        comment: None,
    };
    sheet.export(&options).unwrap()
}

/// The sum of (x1 - x0, y1 - y0) segment lengths in a DXF: its LINE entities' total length.
fn line_length(dxf: &[u8]) -> f64 {
    let text = String::from_utf8_lossy(dxf);
    let lines: Vec<&str> = text.split("\r\n").collect();
    let mut total = 0.0;
    let mut at = 0;
    while at + 1 < lines.len() {
        if lines[at].trim() == "0" && lines[at + 1] == "LINE" {
            let mut value = [0.0_f64; 4];
            let mut cursor = at + 2;
            while cursor + 1 < lines.len() && lines[cursor].trim() != "0" {
                let slot = match lines[cursor].trim() {
                    "10" => Some(0),
                    "20" => Some(1),
                    "11" => Some(2),
                    "21" => Some(3),
                    _ => None,
                };
                if let Some(slot) = slot {
                    value[slot] = lines[cursor + 1].trim().parse().unwrap();
                }
                cursor += 2;
            }
            total += (value[2] - value[0]).hypot(value[3] - value[1]);
            at = cursor;
        } else {
            at += 1;
        }
    }
    total
}

#[test]
fn a_cut_through_a_real_wall_has_the_perimeter_the_file_declares() {
    // SimpleWall #219: Length 4000, Width 200 in its own quantities, so 8.4 m around at a height
    // clear of its openings. The wall is 4 m high.
    let mut wall = model("public/samples/SimpleWall.ifc");
    let words = plan(3.9);
    let mut sheet = SheetStore::new(request(&words));
    for chunk in chunks(&mut wall, &words, 65536) {
        sheet.add_chunk(0, &chunk);
    }
    assert_eq!(sheet.generate(), "[]");
    let length = line_length(&dxf(&sheet));
    assert!((length - 8.4).abs() < 1e-6, "{length}");
}

#[test]
fn material_hatching_crosses_the_chunks_onto_the_sheet() {
    // Two 2 m blocks from 0.1 to 2.1 m, cut at half height. The concrete one, #100, has rows at
    // 0 degrees every 0.25 m through 0.1 m, so 7 lines inside its edges, and at 90 degrees every
    // 0.5 m, 4 lines, each 2 m. The glass one, #150, has no usable spacing, so its name gives
    // 0 degrees every 0.25 m: 8 lines of 2 m.
    let words = vec![0.0, 0.5, -1.0, NO_DEPTH, 0.0, 1.0, 1.0];
    let mut sheet = SheetStore::new(request(&words));
    for chunk in chunks(&mut model("test/fixtures/hatching-materials.ifc"), &words, 1) {
        sheet.add_chunk(0, &chunk);
    }
    let report = sheet.generate();
    assert_eq!(report.matches("bad-hatch-style").count(), 1, "{report}");
    assert!(report.contains("\"expressId\":150"), "{report}");
    let export = |show_hatching| {
        let options =
            ExportOptions { svg: false, scale: 1.0, show_hidden: true, show_hatching, comment: None };
        line_length(&sheet.export(&options).unwrap())
    };
    let (outlines, hatch) = (export(false), export(true) - export(false));
    assert!((outlines - 16.0).abs() < 1e-4, "{outlines}");
    assert!((hatch - (22.0 + 16.0)).abs() < 1e-4, "{hatch}");
}

#[test]
fn a_plane_past_the_model_sends_nothing() {
    let mut wall = model("public/samples/SimpleWall.ifc");
    // Above the wall, looking down, with no projection: nothing touches the plane.
    assert!(chunks(&mut wall, &plan(50.0), 65536).is_empty());
    // Below it, looking down: everything is in front of the plane, even with projection.
    let below = vec![0.0, -50.0, -1.0, NO_DEPTH, 1.0, 0.0, 1.0];
    assert!(chunks(&mut wall, &below, 65536).is_empty());
    // Above it with projection, but the wall's top is 46 m beyond a depth of 1.
    let shallow = vec![0.0, 50.0, -1.0, 1.0, 1.0, 0.0, 1.0];
    assert!(chunks(&mut wall, &shallow, 65536).is_empty());
    // The same with no limit: the wall is seen from above.
    let seen = vec![0.0, 50.0, -1.0, NO_DEPTH, 1.0, 0.0, 1.0];
    assert!(!chunks(&mut wall, &seen, 65536).is_empty());
}

#[test]
fn the_filter_works_in_frame_coordinates() {
    // A quarter turn with a 1000 m offset takes model (x, y) to (1000 - y, x). The wall lies
    // around model x in -1.7..2.3, so a section at map y = 0 crosses it, and x = 1000 too.
    let turn: [f64; 16] = [
        0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1000.0, 0.0, 0.0, 1.0,
    ];
    let section = |position: f64| {
        let mut words = vec![2.0, position, 1.0, NO_DEPTH, 0.0, 0.0, 1.0];
        words.extend_from_slice(&turn);
        words
    };
    let mut wall = model("public/samples/SimpleWall.ifc");
    assert!(!chunks(&mut wall, &section(0.0), 65536).is_empty());
    // Model coordinates would have crossed at y = 0 too, so a plane at map y = 500 must not.
    assert!(chunks(&mut wall, &section(500.0), 65536).is_empty());
}

#[test]
fn a_map_frame_draws_at_map_coordinates() {
    // The fixture's conversion places its origin at 536000, 4747000, 260.
    let mut wall = model("test/fixtures/georef-galicia-utm29n.ifc");
    let transform: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 536000.0, 4747000.0, 260.0, 1.0,
    ];
    let mut words = plan(261.0);
    words.extend_from_slice(&transform);
    let cut = plan(261.0);
    let mut sheet = SheetStore::new(request(&cut));
    for chunk in chunks(&mut wall, &words, 65536) {
        sheet.add_chunk(0, &chunk);
    }
    sheet.generate();
    let text = String::from_utf8_lossy(&dxf(&sheet)).into_owned();
    assert!(text.contains("53600"), "no eastings near 536000");
    assert!(text.contains("474700"), "no northings near 4747000");
}

fn federated(order: &[usize]) -> Vec<u8> {
    let words = plan(1.0);
    let parts = [
        chunks(&mut model("public/samples/SimpleWall.ifc"), &words, 1),
        chunks(&mut model("public/samples/ManySimpleWalls.ifc"), &words, 1),
    ];
    let mut sheet = SheetStore::new(request(&words));
    for at in order {
        let (index, chunk) = (at / 100, at % 100);
        if let Some(bytes) = parts[index].get(chunk) {
            sheet.add_chunk(index as u32, bytes);
        }
    }
    assert_eq!(sheet.generate(), "[]");
    dxf(&sheet)
}

#[test]
fn the_sheet_does_not_depend_on_arrival_order() {
    let mut forward: Vec<usize> = (0..2).flat_map(|m| (0..99).map(move |c| m * 100 + c)).collect();
    let first = federated(&forward);
    assert!(first.len() > 1000);
    forward.reverse();
    assert_eq!(first, federated(&forward));
}

#[test]
fn a_lost_model_leaves_nothing_on_the_sheet() {
    let words = plan(1.0);
    let wall = chunks(&mut model("public/samples/SimpleWall.ifc"), &words, 65536);
    let many = chunks(&mut model("public/samples/ManySimpleWalls.ifc"), &words, 1);
    assert!(many.len() > 1);

    let mut alone = SheetStore::new(request(&words));
    wall.iter().for_each(|chunk| alone.add_chunk(0, chunk));
    alone.generate();

    let mut partial = SheetStore::new(request(&words));
    wall.iter().for_each(|chunk| partial.add_chunk(0, chunk));
    partial.add_chunk(1, &many[0]);
    partial.drop_model(1);
    partial.generate();
    assert_eq!(dxf(&alone), dxf(&partial));
}

#[test]
fn damaged_chunks_are_reported_and_never_panic() {
    let words = plan(1.0);
    let chunk = chunks(&mut model("public/samples/SimpleWall.ifc"), &words, 65536).remove(0);
    for cut in (0..chunk.len()).step_by(chunk.len() / 200 + 1) {
        let mut sheet = SheetStore::new(request(&words));
        sheet.add_chunk(0, &chunk[..cut]);
        let report = sheet.generate();
        assert!(cut == 0 || report.contains("bad-drawing-chunk"), "{cut}: {report}");
    }
    // Counts claiming far more than the chunk holds must not reserve memory for them.
    let mut lying = vec![1u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    lying.extend_from_slice(&u32::MAX.to_le_bytes());
    lying.extend_from_slice(&u32::MAX.to_le_bytes());
    let mut sheet = SheetStore::new(request(&words));
    sheet.add_chunk(0, &lying);
    assert!(sheet.generate().contains("bad-drawing-chunk"));
    // The same for hatch rows.
    let mut rows = vec![1u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    rows.extend_from_slice(&u32::MAX.to_le_bytes());
    let mut sheet = SheetStore::new(request(&words));
    sheet.add_chunk(0, &rows);
    assert!(sheet.generate().contains("bad-drawing-chunk"));

    // Triangles pointing outside the mesh are the slicer's to skip.
    let mut wild = vec![1u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    wild.extend_from_slice(&[1u8, 0, 0, 0]);
    wild.extend_from_slice(&[0u8; 12]);
    let mut sheet = SheetStore::new(request(&words));
    sheet.add_chunk(0, &wild);
    sheet.generate();
}

#[test]
fn export_options_reach_the_bytes() {
    let words = vec![0.0, 1.0, -1.0, NO_DEPTH, 1.0, 1.0, 1.0];
    let mut wall = model("public/samples/SimpleWall.ifc");
    let mut sheet = SheetStore::new(request(&words));
    for chunk in chunks(&mut wall, &words, 65536) {
        sheet.add_chunk(0, &chunk);
    }
    sheet.generate();
    let export = |svg, scale, show_hidden, show_hatching, comment: Option<&str>| {
        let comment = comment.map(ToString::to_string);
        let options = ExportOptions { svg, scale, show_hidden, show_hatching, comment };
        sheet.export(&options).unwrap()
    };

    let metres = line_length(&export(false, 1.0, true, true, None));
    let millimetres = line_length(&export(false, 1000.0, true, true, None));
    // The DXF keeps fixed decimals, so the short hatch lines round a little.
    assert!((millimetres / metres - 1000.0).abs() < 1e-4, "{metres} {millimetres}");

    let bare = export(false, 1.0, true, false, None);
    assert!(line_length(&bare) < metres, "hatching did not leave the DXF");
    let noted = String::from_utf8_lossy(&export(false, 1.0, true, true, Some("EPSG:25829"))).into_owned();
    assert!(noted.starts_with("999\r\nEPSG:25829\r\n"), "{}", &noted[..40]);

    let full = export(true, 1.0, true, true, None);
    let plain = export(true, 1.0, false, false, None);
    assert!(plain.len() < full.len(), "the SVG kept what the export left out");
    assert!(!String::from_utf8_lossy(&plain).contains("stroke-dasharray"));
}

#[test]
fn hidden_lines_left_out_of_the_request_are_gone_for_good() {
    let with = vec![0.0, 1.0, -1.0, NO_DEPTH, 1.0, 0.0, 1.0];
    let without = vec![0.0, 1.0, -1.0, NO_DEPTH, 1.0, 0.0, 0.0];
    let sheet = |words: &[f64]| {
        let mut sheet = SheetStore::new(request(words));
        for chunk in chunks(&mut model("public/samples/ManySimpleWalls.ifc"), words, 65536) {
            sheet.add_chunk(0, &chunk);
        }
        sheet.generate();
        dxf(&sheet)
    };
    let (kept, dropped) = (sheet(&with), sheet(&without));
    assert!(dropped.len() < kept.len());
    assert!(!String::from_utf8_lossy(&dropped).contains("-HIDDEN"));
}

#[test]
fn a_malformed_request_is_refused() {
    assert!(DrawingRequest::decode(&[]).is_none());
    assert!(DrawingRequest::decode(&[0.0, 1.0]).is_none());
    assert!(DrawingRequest::decode(&[-1.0, 1.0, 1.0, NO_DEPTH, 0.0, 0.0, 0.0]).is_none());
    assert!(DrawingRequest::decode(&[9.0, 1.0, 1.0, NO_DEPTH, 0.0, 0.0, 0.0]).is_none());
    assert!(DrawingRequest::decode(&[3.0, 1.0, 1.0, NO_DEPTH, 0.0, 0.0, 0.0]).is_none());
    assert!(DrawingRequest::decode(&[0.0; 11]).is_none());
    assert!(DrawingRequest::decode(&[0.0; 10]).is_none());
}

#[test]
fn plane_cut_request_decodes_and_slices_wall() {
    let mut wall = model("public/samples/SimpleWall.ifc");
    // Arbitrary plane cut at z = 3.9 looking towards -Z (unnormalized normal (0, 0, -2)).
    let words = vec![3.0, 1.5, -0.5, 3.9, 0.0, 0.0, -2.0, NO_DEPTH, 0.0, 0.0, 1.0];
    let mut sheet = SheetStore::new(request(&words));
    for chunk in chunks(&mut wall, &words, 65536) {
        sheet.add_chunk(0, &chunk);
    }
    assert_eq!(sheet.generate(), "[]");
    let length = line_length(&dxf(&sheet));
    assert!((length - 8.4).abs() < 1e-6, "{length}");

    // Also accepts the 16-word transform suffix (27 words total).
    let mut with_transform = words.clone();
    with_transform.extend_from_slice(&[
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]);
    assert!(DrawingRequest::decode(&with_transform).unwrap().transform.is_some());
}

#[test]
fn every_file_reaches_a_sheet() {
    for folder in ["public/samples", "test/fixtures"] {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(folder);
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "ifc") {
                continue;
            }
            let words = vec![0.0, 1.0, -1.0, NO_DEPTH, 1.0, 1.0, 1.0];
            let mut opened = LoadedModel::open(fs::read(&path).unwrap()).unwrap();
            let mut sheet = SheetStore::new(request(&words));
            for chunk in chunks(&mut opened, &words, 65536) {
                sheet.add_chunk(0, &chunk);
            }
            let report = sheet.generate();
            assert!(!report.contains("bad-drawing-chunk"), "{path:?}: {report}");
            assert!(!dxf(&sheet).is_empty());
        }
    }
}


#[test]
fn a_bad_depth_is_ignored_and_reported_without_losing_the_model() {
    // Depth is checked only inside draw, so a negative or infinite one must not reach the filter
    // on the model's side: docs/05 section 5, a value like that is ignored with bad-depth.
    let good = vec![0.0, 50.0, -1.0, NO_DEPTH, 1.0, 0.0, 1.0];
    for bad in [-5.0, f64::NEG_INFINITY, f64::INFINITY] {
        let mut wall = model("public/samples/SimpleWall.ifc");
        let words = vec![0.0, 50.0, -1.0, bad, 1.0, 0.0, 1.0];
        assert_eq!(
            chunks(&mut wall, &words, 65536).len(),
            chunks(&mut wall, &good, 65536).len(),
            "depth {bad}"
        );
        let mut sheet = SheetStore::new(request(&words));
        for chunk in chunks(&mut wall, &words, 65536) {
            sheet.add_chunk(0, &chunk);
        }
        assert!(sheet.generate().contains("bad-depth"), "depth {bad}");
    }
}

/// One element's chunk: `express_id`, part 0, a layer, no hatch rows, and the triangles of one
/// small triangle.
fn chunk_with(express_id: u32, triangle: [u32; 3]) -> Vec<u8> {
    let mut out = Vec::new();
    for word in [express_id, 0, 1] {
        out.extend_from_slice(&word.to_le_bytes());
    }
    out.push(b'w');
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&3u32.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    for value in [0.0_f64, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    for index in triangle {
        out.extend_from_slice(&index.to_le_bytes());
    }
    out
}

fn wall_chunk(id: u32) -> Vec<u8> {
    // A real element, so that a sheet which keeps it has lines to show.
    let mut wall = model("public/samples/SimpleWall.ifc");
    let words = plan(3.9);
    let mut all = chunks(&mut wall, &words, 65536).remove(0);
    all[..4].copy_from_slice(&id.to_le_bytes());
    all
}

#[test]
fn a_bad_triangle_index_loses_that_model_whole_and_says_so() {
    let words = plan(3.9);
    let mut sheet = SheetStore::new(request(&words));
    sheet.add_chunk(0, &wall_chunk(7));
    sheet.add_chunk(0, &chunk_with(8, [0, 1, 99]));
    let report = sheet.generate();
    assert!(report.contains("bad-drawing-chunk"), "{report}");
    assert_eq!(line_length(&dxf(&sheet)), 0.0, "half a model must not be drawn");
}

#[test]
fn a_chunk_cut_short_loses_that_model_whole_and_later_chunks_too() {
    let words = plan(3.9);
    let mut sheet = SheetStore::new(request(&words));
    sheet.add_chunk(0, &wall_chunk(7));
    let good = chunk_with(8, [0, 1, 2]);
    sheet.add_chunk(0, &good[..good.len() - 4]);
    sheet.add_chunk(0, &wall_chunk(9));
    let report = sheet.generate();
    assert_eq!(report.matches("bad-drawing-chunk").count(), 1, "{report}");
    assert_eq!(line_length(&dxf(&sheet)), 0.0);
}

#[test]
fn a_bad_chunk_leaves_other_models_alone() {
    let words = plan(3.9);
    let mut sheet = SheetStore::new(request(&words));
    sheet.add_chunk(0, &chunk_with(8, [0, 1, 99]));
    sheet.add_chunk(1, &wall_chunk(7));
    let report = sheet.generate();
    assert!(report.contains("bad-drawing-chunk"), "{report}");
    assert!((line_length(&dxf(&sheet)) - 8.4).abs() < 1e-6);
}

#[test]
fn plan_space_labels_emit_building_booleans_space_from_outline_and_duplex_from_quantity() {
    // building-booleans.ifc: two IfcSpace boxes (9.40 x 7.40 x 3.00 m), one per storey, no
    // IfcQuantityArea -> falls back to outline area 9.40 * 7.40 = 69.56 m².
    let words = vec![0.0, 1.5, -1.0, NO_DEPTH, 0.0, 2.0, 0.0]; // flags=2 -> space labels
    let mut bb = model("test/fixtures/authored/building-booleans.ifc");
    let mut sheet = SheetStore::new(request(&words));
    for chunk in chunks(&mut bb, &words, 65536) {
        sheet.add_chunk(0, &chunk);
    }
    assert_eq!(sheet.generate(), "[]");
    let svg = String::from_utf8(
        sheet
            .export(&ExportOptions {
                svg: true,
                scale: 1.0,
                show_hidden: false,
                show_hatching: false,
                comment: None,
            })
            .unwrap(),
    )
    .unwrap();
    assert!(svg.contains(">guBIM space 1<"), "{svg}");
    assert!(svg.contains(">69.56 m²<"), "{svg}");
    assert!(!svg.contains("guBIM space 2"), "storey 2 space is not cut at z=1.5");

    // Duplex_A_20110907.ifc (when present locally): spaces have IfcQuantityArea ('GSA BIM Area').
    // Space #514 ('A101' / 'Foyer') declares GSA BIM Area = 17.93623674999977 m² -> "17.94 m²".
    let duplex_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("test/models/bench/Duplex_A_20110907.ifc");
    if duplex_path.exists() {
        let mut duplex = LoadedModel::open(fs::read(&duplex_path).unwrap()).unwrap();
        let mut sheet = SheetStore::new(request(&words));
        for chunk in chunks(&mut duplex, &words, 65536) {
            sheet.add_chunk(0, &chunk);
        }
        sheet.generate();
        let svg = String::from_utf8(
            sheet
                .export(&ExportOptions {
                    svg: true,
                    scale: 1.0,
                    show_hidden: false,
                    show_hatching: false,
                    comment: None,
                })
                .unwrap(),
        )
        .unwrap();
        assert!(svg.contains(">A101 Foyer<"), "missing A101 Foyer in Duplex plan");
        assert!(svg.contains(">17.94 m²<"), "missing quantity area 17.94 m² in Duplex plan");
    }
}

#[test]
fn plan_overall_dimensions_match_building_booleans_bounding_box() {
    // building-booleans.ifc footprint is 10.00 x 8.00 m.
    // flags = 6 -> include_space_labels (2) + include_dimensions (4).
    let words = vec![0.0, 1.5, -1.0, NO_DEPTH, 0.0, 6.0, 0.0];
    let mut bb = model("test/fixtures/authored/building-booleans.ifc");
    let mut sheet = SheetStore::new(request(&words));
    for chunk in chunks(&mut bb, &words, 65536) {
        sheet.add_chunk(0, &chunk);
    }
    assert_eq!(sheet.generate(), "[]");
    let svg = String::from_utf8(
        sheet
            .export(&ExportOptions {
                svg: true,
                scale: 1.0,
                show_hidden: false,
                show_hatching: false,
                comment: None,
            })
            .unwrap(),
    )
    .unwrap();
    assert!(svg.contains(">10.00 m<"), "missing 10.00 m in SVG: {svg}");
    assert!(svg.contains(">8.00 m<"), "missing 8.00 m in SVG: {svg}");
    assert!(svg.contains(">guBIM space 1<"), "missing space label alongside dimensions");

    let dxf_text = String::from_utf8_lossy(&dxf(&sheet)).into_owned();
    assert!(dxf_text.contains("DIMENSION\r\n"), "missing DIMENSION entity in DXF");
    assert!(dxf_text.contains("10.00 m\r\n"), "missing 10.00 m in DXF");
    assert!(dxf_text.contains("8.00 m\r\n"), "missing 8.00 m in DXF");
}