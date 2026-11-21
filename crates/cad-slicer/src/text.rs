//! Text that leaves the crate: CP1252 for DXF and XML escaping for SVG.

/// The byte CP1252 gives a character. `None` means the codepage cannot carry it, including
/// the five undefined bytes 0x81, 0x8D, 0x8F, 0x90 and 0x9D.
pub(crate) fn cp1252(character: char) -> Option<u8> {
    match character {
        '\u{0020}'..='\u{007E}' => Some(character as u8),
        '\u{00A0}'..='\u{00FF}' => Some(character as u8),
        '\u{20AC}' => Some(0x80),
        '\u{201A}' => Some(0x82),
        '\u{0192}' => Some(0x83),
        '\u{201E}' => Some(0x84),
        '\u{2026}' => Some(0x85),
        '\u{2020}' => Some(0x86),
        '\u{2021}' => Some(0x87),
        '\u{02C6}' => Some(0x88),
        '\u{2030}' => Some(0x89),
        '\u{0160}' => Some(0x8A),
        '\u{2039}' => Some(0x8B),
        '\u{0152}' => Some(0x8C),
        '\u{017D}' => Some(0x8E),
        '\u{2018}' => Some(0x91),
        '\u{2019}' => Some(0x92),
        '\u{201C}' => Some(0x93),
        '\u{201D}' => Some(0x94),
        '\u{2022}' => Some(0x95),
        '\u{2013}' => Some(0x96),
        '\u{2014}' => Some(0x97),
        '\u{02DC}' => Some(0x98),
        '\u{2122}' => Some(0x99),
        '\u{0161}' => Some(0x9A),
        '\u{203A}' => Some(0x9B),
        '\u{0153}' => Some(0x9C),
        '\u{017E}' => Some(0x9E),
        '\u{0178}' => Some(0x9F),
        _ => None,
    }
}

/// A group value as CP1252 bytes. Control characters are removed, which is what stops a name
/// from ending a line early, and anything the codepage cannot carry becomes `?`.
pub(crate) fn dxf_bytes(raw: &str, limit: usize) -> Vec<u8> {
    let mut out = Vec::new();
    for character in raw.chars() {
        if out.len() >= limit {
            break;
        }
        // CR, LF, NUL and the C0/C1 controls never reach the file.
        if character.is_control() {
            continue;
        }
        out.push(cp1252(character).unwrap_or(b'?'));
    }
    out
}

/// XML text: the five escapes, no control character other than tab, line feed and carriage
/// return, and nothing XML 1.0 forbids. A control from a file name must not reach the panel.
pub(crate) fn xml_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for character in raw.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\u{0009}' | '\u{000A}' | '\u{000D}' => out.push(character),
            c if c.is_control() => {}
            c if (c as u32) >= 0xD800 && (c as u32) <= 0xDFFF => {}
            c if (c as u32) == 0xFFFE || (c as u32) == 0xFFFF => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cp1252_covers_latin_one_and_the_specials() {
        assert_eq!(cp1252('A'), Some(0x41));
        assert_eq!(cp1252('ñ'), Some(0xF1));
        assert_eq!(cp1252('€'), Some(0x80));
        assert_eq!(cp1252('—'), Some(0x97));
        // The five undefined bytes have no character.
        assert_eq!(cp1252('\u{0081}'), None);
        assert_eq!(cp1252('日'), None);
    }

    #[test]
    fn values_lose_controls_and_unsupported_characters() {
        assert_eq!(dxf_bytes("a\r\nb\0c", 255), b"abc");
        assert_eq!(dxf_bytes("Muro 日本", 255), b"Muro ??");
        assert_eq!(dxf_bytes("abcdef", 3), b"abc");
        // A newline in a name must never end the group early.
        assert!(!dxf_bytes("x\ny", 255).contains(&b'\n'));
    }

    #[test]
    fn xml_text_escapes_the_five_and_drops_the_forbidden() {
        assert_eq!(xml_text("<script>\"&'"), "&lt;script&gt;&quot;&amp;&apos;");
        assert_eq!(xml_text("a\u{0001}b"), "ab");
        assert_eq!(xml_text("line\nbreak"), "line\nbreak");
        // DEL and the C1 controls are valid XML but not text a drawing should carry.
        assert_eq!(xml_text("a\u{007F}b\u{0085}c"), "abc");
    }
}
