//! Before the host sets a secret, a native build draws one from the standard library.

use ifc_geometry::hash::Keyed;
use std::hash::BuildHasher;

#[test]
fn maps_built_before_a_secret_is_set_each_get_their_own() {
    let hashes: Vec<u64> = (0..8).map(|_| Keyed::default().hash_one(42u32)).collect();
    assert!(hashes.windows(2).all(|pair| pair[0] != pair[1]), "{hashes:?}");
}
