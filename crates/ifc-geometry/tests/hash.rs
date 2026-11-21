//! The keyed hash spreads keys a file could choose to collide, under any secret.

use ifc_geometry::hash::{Keyed, set_secret};
use std::collections::HashSet;
use std::hash::{BuildHasher, Hasher};

/// Secrets as a random source gives them, from SplitMix64. The bound needs a random secret: one
/// such as `[1, 2, 3, 4]`, with a zero half, makes every key alike.
const SECRETS: [[u64; 4]; 8] = {
    let mut state: u64 = 0;
    let mut secrets = [[0; 4]; 8];
    let mut at = 0;
    while at < 32 {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut word = state;
        word = (word ^ (word >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        word = (word ^ (word >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        secrets[at / 4][at % 4] = word ^ (word >> 31);
        at += 1;
    }
    secrets
};

/// How many of a map's first 4096 buckets the hashes reach. Random hashes reach about 2589.
fn buckets(hashes: &[u64]) -> usize {
    hashes.iter().map(|hash| hash & 0xfff).collect::<HashSet<_>>().len()
}

/// The bits a map on a 32-bit target keeps beside its bucket: bits 25 to 31.
fn tags(hashes: &[u64]) -> usize {
    hashes.iter().map(|hash| (hash >> 25) & 0x7f).collect::<HashSet<_>>().len()
}

fn assert_spread(name: &str, hashes: &[u64]) {
    let distinct = hashes.iter().collect::<HashSet<_>>().len();
    assert_eq!(distinct, hashes.len(), "{name}: equal hashes");
    assert!(buckets(hashes) > 2400, "{name}: {} buckets", buckets(hashes));
    assert_eq!(tags(hashes), 128, "{name}: tags");
}

#[test]
fn ids_that_differ_only_in_high_bits_spread() {
    for secret in SECRETS {
        let keyed = Keyed::with_secret(secret);
        let hashes: Vec<u64> = (0..4096u32).map(|id| keyed.hash_one(id << 20)).collect();
        assert_spread("ids", &hashes);
    }
}

#[test]
fn coordinates_that_differ_only_in_sign_and_exponent_spread() {
    for secret in SECRETS {
        let keyed = Keyed::with_secret(secret);
        let hashes: Vec<u64> = (0..4096u64)
            .map(|top| keyed.hash_one((top << 52 | 0x1234, 1.5f64.to_bits(), (-2.0f64).to_bits())))
            .collect();
        assert_spread("first coordinate", &hashes);
        let hashes: Vec<u64> = (0..4096u64)
            .map(|top| keyed.hash_one((1.5f64.to_bits(), 0.0f64.to_bits(), top << 52)))
            .collect();
        assert_spread("last coordinate", &hashes);
    }
}

#[test]
fn whole_coordinates_spread() {
    // Whole numbers, and most coordinates in a file, leave the low half of an f64 zero.
    for secret in SECRETS {
        let keyed = Keyed::with_secret(secret);
        let hashes: Vec<u64> = (0..4096)
            .map(|at| keyed.hash_one((f64::from(at).to_bits(), 0.5f64.to_bits(), 2.0f64.to_bits())))
            .collect();
        assert_spread("whole numbers", &hashes);
    }
}

#[test]
fn coordinates_in_another_order_or_with_cancelling_changes_hash_apart() {
    let (x, y, z) = (1.25f64.to_bits(), (-7.5f64).to_bits(), 3.0f64.to_bits());
    for secret in SECRETS {
        let keyed = Keyed::with_secret(secret);
        let key = keyed.hash_one((x, y, z));
        assert_ne!(key, keyed.hash_one((y, x, z)));
        assert_ne!(key, keyed.hash_one((x, z, y)));
        // The sign of one coordinate and a low bit of the next: a multiply then a shift or
        // rotate, the usual fast hash, carries the first into the second whatever its key.
        for shift in 0..64 {
            assert_ne!(key, keyed.hash_one((x ^ 1 << 63, y ^ 1 << shift, z)), "bit {shift}");
        }
    }
}

#[test]
fn byte_keys_spread() {
    for secret in SECRETS {
        let keyed = Keyed::with_secret(secret);
        let short: Vec<u64> = (0..4096u16).map(|high| keyed.hash_one([0u8, 0, 0, 0, 0, 0, 0, 0, 7, 0, (high >> 8) as u8, high as u8])).collect();
        assert_spread("bytes", &short);
    }
}

#[test]
fn the_secret_changes_every_hash_and_new_maps_take_it() {
    let keys: Vec<(u64, u64, u64)> = (0..64).map(|at| (at, at * 3, at * 7)).collect();
    let [first, second] = [SECRETS[0], SECRETS[1]].map(Keyed::with_secret);
    for key in &keys {
        assert_ne!(first.hash_one(key), second.hash_one(key));
    }
    for secret in SECRETS {
        set_secret(secret);
        let current = Keyed::default();
        let expected = Keyed::with_secret(secret);
        assert!(keys.iter().all(|key| current.hash_one(key) == expected.hash_one(key)));
    }
}

#[test]
fn bytes_that_differ_only_by_trailing_zeros_hash_apart() {
    for secret in SECRETS {
        let keyed = Keyed::with_secret(secret);
        let raw = |bytes: &[u8]| {
            let mut hasher = keyed.build_hasher();
            hasher.write(bytes);
            hasher.finish()
        };
        assert_ne!(raw(&[1]), raw(&[1, 0]));
        assert_ne!(raw(&[]), raw(&[0]));
        assert_ne!(raw(&[1; 8]), raw(&[1, 1, 1, 1, 1, 1, 1, 1, 0]));
    }
}

#[test]
fn words_past_the_secret_cannot_trade_places() {
    for secret in SECRETS {
        let keyed = Keyed::with_secret(secret);
        let key = (1u64, 2u64, 3u64, 4u64, 5u64, 6u64);
        assert_ne!(keyed.hash_one(key), keyed.hash_one((5u64, 2u64, 3u64, 4u64, 1u64, 6u64)));
        assert_ne!(keyed.hash_one(key), keyed.hash_one((1u64, 6u64, 3u64, 4u64, 5u64, 2u64)));
    }
}

#[test]
fn a_secret_with_zero_halves_still_tells_keys_apart() {
    for secret in [[0; 4], [1, 2, 3, 4], [u64::MAX, 0, u64::MAX, 0], [0, u64::MAX, 0, u64::MAX]] {
        let keyed = Keyed::with_secret(secret);
        let hashes: Vec<u64> = (0..4096u32).map(|id| keyed.hash_one(id << 20)).collect();
        assert_spread("ids", &hashes);
        // Whole numbers leave a coordinate's low half zero, at each word of the key.
        let whole = |at: u32| f64::from(at).to_bits();
        let fixed = 0.5f64.to_bits();
        for (name, key) in [
            ("first", &(|at| (whole(at), fixed, fixed)) as &dyn Fn(u32) -> (u64, u64, u64)),
            ("second", &|at| (fixed, whole(at), fixed)),
            ("third", &|at| (fixed, fixed, whole(at))),
        ] {
            let hashes: Vec<u64> = (0..4096).map(|at| keyed.hash_one(key(at))).collect();
            assert_spread(name, &hashes);
        }
    }
}