//! Fixed-point text for the exporters: the same characters as `format!("{value:.N}")`, faster.
//!
//! `format!` rounds the exact binary value to N decimals, which takes big-number arithmetic for
//! every coordinate: about a tenth of a large drawing's time went there. Here the value is scaled
//! by 10^N and rounded as an integer. Scaling can be off by a few units in the last place, so the
//! integer is trusted only when the scaled value is clearly away from a tie (…5 exactly at the
//! last kept digit); near a tie, and for values too large for an exact integer, `format!` decides.

use std::fmt::Write;

/// How far from a tie, in units of the last kept digit, the scaled value must be. The product
/// `value × 10^N` is within 2⁻⁵² of it relatively, under 0.01 units below 2⁴³ (8.8e12), the
/// largest scaled value taken here.
const TIE_MARGIN: f64 = 0.01;
/// Above this the fast path is not used: the scaled value's error could reach the margin.
const MAX_SCALED: f64 = 8.0e12;

const POWERS: [f64; 10] = [1.0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];

/// `format!("{value:.decimals}")` for a finite value, `decimals` at most 9.
pub(crate) fn fixed(value: f64, decimals: usize) -> String {
    debug_assert!(decimals < POWERS.len());
    let scaled = value * POWERS[decimals];
    let magnitude = scaled.abs();
    let fraction = magnitude - magnitude.floor();
    if !scaled.is_finite() || magnitude >= MAX_SCALED || (fraction - 0.5).abs() <= TIE_MARGIN {
        return format!("{value:.decimals$}");
    }
    let units = magnitude.round() as u64;
    let mut out = String::with_capacity(24);
    // A negative value that rounds to zero still prints its sign, as format! does.
    if value.is_sign_negative() {
        out.push('-');
    }
    let power = 10u64.pow(decimals as u32);
    let _ = write!(out, "{}", units / power);
    if decimals > 0 {
        let _ = write!(out, ".{:0width$}", units % power, width = decimals);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::fixed;

    /// A small deterministic generator, so a failure can be replayed.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 11
        }
        fn unit(&mut self) -> f64 {
            self.next() as f64 / (1u64 << 53) as f64
        }
    }

    fn same(value: f64, decimals: usize) {
        assert_eq!(fixed(value, decimals), format!("{value:.decimals$}"), "{value:e} with {decimals}");
    }

    #[test]
    fn matches_format_on_random_values_at_every_scale() {
        let mut rng = Lcg(0x5eed);
        for _ in 0..2_000_000 {
            let exponent = (rng.unit() * 20.0) as i32 - 8;
            let value = (rng.unit() - 0.5) * 10f64.powi(exponent);
            for decimals in [4, 6] {
                same(value, decimals);
            }
        }
    }

    #[test]
    fn matches_format_at_map_coordinates() {
        // UTM eastings and northings, as the drawings of georeferenced models carry them.
        let mut rng = Lcg(42);
        for _ in 0..1_000_000 {
            let easting = 166_000.0 + rng.unit() * 668_000.0;
            let northing = rng.unit() * 9_400_000.0;
            for decimals in [4, 6] {
                same(easting, decimals);
                same(northing, decimals);
                same(-northing, decimals);
            }
        }
    }

    #[test]
    fn matches_format_at_ties_and_edges() {
        let mut values = vec![0.0, -0.0, 0.5, -0.5, 1.5, 2.5, 1e-7, -1e-7, 4e-5, -4e-5, 5e-5, -5e-5, 9.99995, 0.12345, 0.000_05];
        // Exact ties and their neighbours one ulp away, at both precisions.
        for k in [1u64, 3, 5, 125, 12_345, 98_765_431] {
            for decimals in [4usize, 6] {
                let tie = (k as f64 + 0.5) / 10f64.powi(decimals as i32);
                values.extend([tie, -tie, f64::from_bits(tie.to_bits() + 1), f64::from_bits(tie.to_bits() - 1)]);
            }
        }
        values.extend([8.0e8, 8.8e8, 9.0e8, 1e9, 1e12, 1e15, 1e300, f64::MIN_POSITIVE, f64::MAX / 2.0]);
        for value in values {
            for decimals in [0, 1, 4, 6, 9] {
                same(value, decimals);
                same(-value, decimals);
            }
        }
    }
}
