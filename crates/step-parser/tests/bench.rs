use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use step_parser::index;

#[test]
#[ignore = "benchmark: run with --release --ignored --nocapture"]
fn bench_index_many_simple_walls() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("public")
        .join("samples")
        .join("ManySimpleWalls.ifc");
    let bytes = fs::read(&path).unwrap();

    // One warm-up pass, then a short run so the printed number is stable.
    let warm = index(&bytes).unwrap();
    assert_eq!(warm.entity_count(), 9776);

    let rounds = 50u32;
    let start = Instant::now();
    for _ in 0..rounds {
        let index = index(&bytes).unwrap();
        assert_eq!(index.entity_count(), 9776);
    }
    let elapsed = start.elapsed();

    let per_pass = elapsed / rounds;
    println!(
        "index ManySimpleWalls.ifc: {} bytes, 9776 entities, {:?} per pass, {:?} for {} passes",
        bytes.len(),
        per_pass,
        elapsed,
        rounds
    );
}
