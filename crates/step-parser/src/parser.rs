//! Tokeniser and decoder for ISO 10303-21 parameter values.
//!
//! Every access goes through bounds-checked helpers; malformed input produces a
//! [`ParseError`] and never panics.

use crate::{Entity, ErrorKind, ParseError, Value};

/// Maximum nesting depth for lists and typed values. Bound so that hostile input
/// cannot exhaust the stack; real ISO 10303-21 data stays far below this.
pub(crate) const MAX_NESTING_DEPTH: usize = 64;

/// Byte length limit guard for escape directives, so a corrupt file cannot make
/// the decoder allocate without bound. Values this large do not occur in practice.
const MAX_ESCAPE_UNITS: usize = 1 << 20;

pub(crate) fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Append a run of raw string bytes: UTF-8 when the run is valid, otherwise
/// Latin-1 byte by byte, which is what pre-UTF-8 STEP files use.
fn flush_raw_bytes(out: &mut String, raw: &mut Vec<u8>) {
    if raw.is_empty() {
        return;
    }
    match std::str::from_utf8(raw) {
        Ok(text) => out.push_str(text),
        Err(_) => out.extend(raw.iter().map(|byte| char::from(*byte))),
    }
    raw.clear();
}

/// Upper-cases an ASCII name in one allocation of its exact length, rather than one per
/// doubling as pushing a character at a time does.
fn upper_case(name: &[u8]) -> String {
    name.iter().map(|byte| char::from(byte.to_ascii_uppercase())).collect()
}

/// A cursor over one entity record (or a header statement).
pub(crate) struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    limit: usize,
}

impl<'a> Parser<'a> {
    pub(crate) fn new(bytes: &'a [u8], start: usize, limit: usize) -> Self {
        let limit = limit.min(bytes.len());
        Self {
            bytes,
            pos: start.min(limit),
            limit,
        }
    }

    pub(crate) fn position(&self) -> usize {
        self.pos
    }

    fn error(&self, kind: ErrorKind) -> ParseError {
        ParseError::new(self.pos, kind)
    }

    fn error_at(&self, offset: usize, kind: ErrorKind) -> ParseError {
        ParseError::new(offset, kind)
    }

    fn peek(&self) -> Option<u8> {
        if self.pos < self.limit {
            self.bytes.get(self.pos).copied()
        } else {
            None
        }
    }

    fn peek_at(&self, ahead: usize) -> Option<u8> {
        let at = self.pos.checked_add(ahead)?;
        if at < self.limit {
            self.bytes.get(at).copied()
        } else {
            None
        }
    }

    fn bump(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.pos = self.pos.saturating_add(1);
        Some(byte)
    }

    fn remaining_starts_with(&self, needle: &[u8]) -> bool {
        let end = self.pos.saturating_add(needle.len());
        if end > self.limit {
            return false;
        }
        match self.bytes.get(self.pos..end) {
            Some(slice) => slice == needle,
            None => false,
        }
    }

    /// Skip whitespace and `/* ... */` comments.
    pub(crate) fn skip_ws_comments(&mut self) -> Result<(), ParseError> {
        loop {
            match self.peek() {
                Some(byte) if byte.is_ascii_whitespace() => {
                    self.pos = self.pos.saturating_add(1);
                }
                Some(b'/') if self.peek_at(1) == Some(b'*') => {
                    self.skip_comment()?;
                }
                _ => return Ok(()),
            }
        }
    }

    fn skip_comment(&mut self) -> Result<(), ParseError> {
        // Current position is on '/', next is '*'.
        self.pos = self.pos.saturating_add(2);
        loop {
            match self.bump() {
                None => return Err(self.error(ErrorKind::UnterminatedComment)),
                Some(b'*') if self.peek() == Some(b'/') => {
                    self.pos = self.pos.saturating_add(1);
                    return Ok(());
                }
                Some(_) => {}
            }
        }
    }

    fn expect(&mut self, expected: u8) -> Result<(), ParseError> {
        match self.bump() {
            Some(byte) if byte == expected => Ok(()),
            Some(byte) => Err(self.error_at(
                self.pos.saturating_sub(1),
                ErrorKind::UnexpectedByte(byte),
            )),
            None => Err(self.error(ErrorKind::UnexpectedEof)),
        }
    }

    fn parse_ident(&mut self) -> Result<String, ParseError> {
        let start = self.pos;
        while self.peek().is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_') {
            self.pos = self.pos.saturating_add(1);
        }
        if self.pos == start {
            Err(self.error(ErrorKind::InvalidIdentifier))
        } else {
            Ok(upper_case(self.bytes.get(start..self.pos).unwrap_or_default()))
        }
    }

    fn parse_u32_digits(&mut self) -> Result<u32, ParseError> {
        let start = self.pos;
        let mut value: u64 = 0;
        while let Some(byte) = self.peek() {
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                _ => break,
            };
            value = value * 10 + u64::from(digit);
            if value > u64::from(u32::MAX) {
                return Err(self.error(ErrorKind::IdentifierOverflow));
            }
            self.pos = self.pos.saturating_add(1);
        }
        if self.pos == start {
            Err(self.error(ErrorKind::InvalidIdentifier))
        } else {
            Ok(value as u32)
        }
    }

    /// Parse `#id = TYPE(...);` or the complex form `#id = (TYPE(...)TYPE(...));`.
    pub(crate) fn parse_entity(&mut self) -> Result<Entity, ParseError> {
        self.skip_ws_comments()?;
        self.expect(b'#')?;
        self.parse_u32_digits()?;
        self.skip_ws_comments()?;
        self.expect(b'=')?;
        self.skip_ws_comments()?;
        if self.peek() == Some(b'(') {
            let mut parts = self.parse_complex_parts()?.into_iter();
            self.skip_ws_comments()?;
            self.expect(b';')?;
            let (type_name, params) = parts
                .next()
                .ok_or_else(|| self.error(ErrorKind::MalformedEntity))?;
            Ok(Entity {
                type_name,
                params,
                other_parts: parts.collect(),
            })
        } else {
            let type_name = self.parse_ident()?;
            let params = self.parse_outer_params()?;
            self.skip_ws_comments()?;
            self.expect(b';')?;
            Ok(Entity {
                type_name,
                params,
                other_parts: Vec::new(),
            })
        }
    }

    /// Skips `#id=NAME(`, the start of an ordinary record, for the readers below, which
    /// allocate nothing and give `None` for any shape but their own, valid or not. Then
    /// [`Self::parse_entity`] has the answer.
    fn skip_record_start(&mut self) -> Option<()> {
        self.skip_ws_comments().ok()?;
        self.expect(b'#').ok()?;
        self.parse_u32_digits().ok()?;
        self.skip_ws_comments().ok()?;
        self.expect(b'=').ok()?;
        self.skip_ws_comments().ok()?;
        let name_start = self.pos;
        while self.peek().is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_') {
            self.pos = self.pos.saturating_add(1);
        }
        if self.pos == name_start {
            return None;
        }
        self.skip_ws_comments().ok()?;
        self.expect(b'(').ok()
    }

    /// Skips `);`, the end of a record.
    fn skip_record_end(&mut self) -> Option<()> {
        self.skip_ws_comments().ok()?;
        self.expect(b')').ok()?;
        self.skip_ws_comments().ok()?;
        self.expect(b';').ok()
    }

    /// Reads `#n`, a reference.
    fn parse_reference(&mut self) -> Option<u32> {
        self.skip_ws_comments().ok()?;
        self.expect(b'#').ok()?;
        self.parse_u32_digits().ok()
    }

    /// Reads `#id=NAME((a,b));` or `#id=NAME((a,b,c));` with plain numbers.
    pub(crate) fn parse_coordinates(&mut self) -> Option<([f64; 3], usize)> {
        self.skip_record_start()?;
        self.skip_ws_comments().ok()?;
        self.expect(b'(').ok()?;
        let mut values = [0.0; 3];
        let mut count = 0;
        loop {
            self.skip_ws_comments().ok()?;
            let number = match (self.peek()?, self.peek_at(1)) {
                (b'+' | b'-' | b'0'..=b'9', _) => true,
                (b'.', Some(next)) => next.is_ascii_digit(),
                _ => false,
            };
            if !number || count == values.len() {
                return None;
            }
            values[count] = match self.parse_number().ok()? {
                Value::Real(value) => value,
                Value::Integer(value) => value as f64,
                _ => return None,
            };
            count += 1;
            self.skip_ws_comments().ok()?;
            match self.bump()? {
                b',' => {}
                b')' => break,
                _ => return None,
            }
        }
        self.skip_record_end()?;
        (count >= 2).then_some((values, count))
    }

    /// Reads `#id=NAME((#a,#b,...));` into `out`, which may hold some of it on `None`.
    pub(crate) fn parse_reference_list(&mut self, out: &mut Vec<u32>) -> Option<()> {
        self.skip_record_start()?;
        self.skip_ws_comments().ok()?;
        self.expect(b'(').ok()?;
        self.skip_ws_comments().ok()?;
        if self.peek() == Some(b')') {
            self.pos = self.pos.saturating_add(1);
        } else {
            loop {
                out.push(self.parse_reference()?);
                self.skip_ws_comments().ok()?;
                match self.bump()? {
                    b',' => {}
                    b')' => break,
                    _ => return None,
                }
            }
        }
        self.skip_record_end()
    }

    /// Reads `#id=NAME(#a,.T.);` or `#id=NAME(#a,.F.);`, in either case.
    pub(crate) fn parse_reference_and_boolean(&mut self) -> Option<(u32, bool)> {
        self.skip_record_start()?;
        let reference = self.parse_reference()?;
        self.skip_ws_comments().ok()?;
        self.expect(b',').ok()?;
        self.skip_ws_comments().ok()?;
        self.expect(b'.').ok()?;
        let value = match self.bump()?.to_ascii_uppercase() {
            b'T' => true,
            b'F' => false,
            _ => return None,
        };
        self.expect(b'.').ok()?;
        self.skip_record_end()?;
        Some((reference, value))
    }

    /// Parse `(NAME(params)NAME(params)...)`, the body of a complex instance.
    fn parse_complex_parts(&mut self) -> Result<Vec<(String, Vec<Value>)>, ParseError> {
        self.expect(b'(')?;
        let mut parts = Vec::new();
        loop {
            self.skip_ws_comments()?;
            match self.peek() {
                Some(b')') => {
                    self.pos = self.pos.saturating_add(1);
                    break;
                }
                None => return Err(self.error(ErrorKind::UnexpectedEof)),
                Some(_) => {}
            }
            let name = self.parse_ident()?;
            let params = self.parse_outer_params()?;
            parts.push((name, params));
        }
        if parts.is_empty() {
            Err(self.error(ErrorKind::MalformedEntity))
        } else {
            Ok(parts)
        }
    }

    /// Parse the parenthesised parameter list of an entity or header statement.
    pub(crate) fn parse_outer_params(&mut self) -> Result<Vec<Value>, ParseError> {
        self.skip_ws_comments()?;
        self.expect(b'(')?;
        let mut values = Vec::new();
        self.skip_ws_comments()?;
        if self.peek() == Some(b')') {
            self.pos = self.pos.saturating_add(1);
            return Ok(values);
        }
        loop {
            values.push(self.parse_value(0)?);
            self.skip_ws_comments()?;
            match self.bump() {
                Some(b',') => {
                    self.skip_ws_comments()?;
                }
                Some(b')') => break,
                Some(byte) => {
                    return Err(self.error_at(
                        self.pos.saturating_sub(1),
                        ErrorKind::UnexpectedByte(byte),
                    ));
                }
                None => return Err(self.error(ErrorKind::UnexpectedEof)),
            }
        }
        Ok(values)
    }

    fn parse_value(&mut self, depth: usize) -> Result<Value, ParseError> {
        if depth > MAX_NESTING_DEPTH {
            return Err(self.error(ErrorKind::NestingTooDeep));
        }
        self.skip_ws_comments()?;
        let byte = match self.peek() {
            Some(byte) => byte,
            None => return Err(self.error(ErrorKind::UnexpectedEof)),
        };
        match byte {
            b'$' => {
                self.pos = self.pos.saturating_add(1);
                Ok(Value::Null)
            }
            b'*' => {
                self.pos = self.pos.saturating_add(1);
                Ok(Value::Derived)
            }
            b'\'' => self.parse_string().map(Value::String),
            b'"' => self.parse_binary().map(Value::Binary),
            b'#' => {
                self.pos = self.pos.saturating_add(1);
                self.parse_u32_digits().map(Value::Ref)
            }
            b'(' => self.parse_list(depth.saturating_add(1)).map(Value::List),
            b'.' if self.peek_at(1).is_some_and(|next| next.is_ascii_digit()) =>
            {
                self.parse_number()
            }
            b'.' => self.parse_enum().map(Value::Enum),
            b'+' | b'-' | b'0'..=b'9' => self.parse_number(),
            byte if byte.is_ascii_alphabetic() => {
                let name = self.parse_ident()?;
                self.skip_ws_comments()?;
                self.expect(b'(')?;
                let value = self.parse_value(depth.saturating_add(1))?;
                self.skip_ws_comments()?;
                self.expect(b')')?;
                Ok(Value::Typed {
                    name,
                    value: Box::new(value),
                })
            }
            byte => Err(self.error(ErrorKind::UnexpectedByte(byte))),
        }
    }

    fn parse_list(&mut self, depth: usize) -> Result<Vec<Value>, ParseError> {
        if depth > MAX_NESTING_DEPTH {
            return Err(self.error(ErrorKind::NestingTooDeep));
        }
        self.expect(b'(')?;
        let mut values = Vec::new();
        self.skip_ws_comments()?;
        if self.peek() == Some(b')') {
            self.pos = self.pos.saturating_add(1);
            return Ok(values);
        }
        loop {
            values.push(self.parse_value(depth)?);
            self.skip_ws_comments()?;
            match self.bump() {
                Some(b',') => {
                    self.skip_ws_comments()?;
                }
                Some(b')') => break,
                Some(byte) => {
                    return Err(self.error_at(
                        self.pos.saturating_sub(1),
                        ErrorKind::UnexpectedByte(byte),
                    ));
                }
                None => return Err(self.error(ErrorKind::UnexpectedEof)),
            }
        }
        Ok(values)
    }

    fn parse_enum(&mut self) -> Result<String, ParseError> {
        self.expect(b'.')?;
        let start = self.pos;
        loop {
            match self.bump() {
                Some(b'.') => break,
                Some(byte) if byte.is_ascii_alphanumeric() || byte == b'_' => {}
                Some(byte) => {
                    return Err(self.error_at(
                        self.pos.saturating_sub(1),
                        ErrorKind::UnexpectedByte(byte),
                    ));
                }
                None => return Err(self.error(ErrorKind::UnexpectedEof)),
            }
        }
        let value = self.bytes.get(start..self.pos.saturating_sub(1)).unwrap_or_default();
        if value.is_empty() {
            Err(self.error(ErrorKind::InvalidIdentifier))
        } else {
            Ok(upper_case(value))
        }
    }

    fn parse_number(&mut self) -> Result<Value, ParseError> {
        let start = self.pos;
        if matches!(self.peek(), Some(b'+') | Some(b'-')) {
            self.pos = self.pos.saturating_add(1);
        }

        let mut has_digit = false;
        let mut is_real = false;
        loop {
            match self.peek() {
                Some(b'0'..=b'9') => {
                    has_digit = true;
                    self.pos = self.pos.saturating_add(1);
                }
                Some(b'.') => {
                    is_real = true;
                    self.pos = self.pos.saturating_add(1);
                }
                Some(b'e' | b'E') => {
                    is_real = true;
                    self.pos = self.pos.saturating_add(1);
                    if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                        self.pos = self.pos.saturating_add(1);
                    }
                }
                _ => break,
            }
        }

        if !has_digit {
            return Err(self.error(ErrorKind::InvalidNumber));
        }

        let text = match self.bytes.get(start..self.pos) {
            Some(text) => text,
            None => return Err(self.error(ErrorKind::InvalidNumber)),
        };
        let text = std::str::from_utf8(text).map_err(|_| self.error(ErrorKind::InvalidNumber))?;

        if is_real {
            match text.parse::<f64>() {
                Ok(value) if value.is_finite() => Ok(Value::Real(value)),
                _ => Err(self.error(ErrorKind::InvalidNumber)),
            }
        } else {
            match text.parse::<i64>() {
                Ok(value) => Ok(Value::Integer(value)),
                Err(_) => Err(self.error(ErrorKind::IntegerOverflow)),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, ParseError> {
        self.expect(b'\'')?;
        let mut out = String::new();
        let mut raw: Vec<u8> = Vec::new();
        loop {
            match self.bump() {
                None => {
                    flush_raw_bytes(&mut out, &mut raw);
                    return Err(self.error(ErrorKind::UnterminatedString));
                }
                Some(b'\'') => {
                    if self.peek() == Some(b'\'') {
                        flush_raw_bytes(&mut out, &mut raw);
                        self.pos = self.pos.saturating_add(1);
                        out.push('\'');
                    } else {
                        flush_raw_bytes(&mut out, &mut raw);
                        return Ok(out);
                    }
                }
                Some(b'\\') => {
                    flush_raw_bytes(&mut out, &mut raw);
                    self.parse_escape(&mut out)?;
                }
                // Raw bytes are collected and decoded as a run: valid UTF-8 is
                // kept as UTF-8, otherwise the run falls back to Latin-1.
                Some(byte) => raw.push(byte),
            }
        }
    }

    fn parse_escape(&mut self, out: &mut String) -> Result<(), ParseError> {
        let directive = match self.bump() {
            Some(byte) => byte,
            None => return Err(self.error(ErrorKind::UnterminatedString)),
        };
        match directive {
            b'\\' => {
                out.push('\\');
                Ok(())
            }
            b'N' | b'n' => {
                if self.peek() == Some(b'\\') {
                    self.pos = self.pos.saturating_add(1);
                    out.push('\n');
                    Ok(())
                } else {
                    // Be lenient with files that use `\N` without a closing slash.
                    out.push('\n');
                    Ok(())
                }
            }
            b'T' | b't' => {
                if self.peek() == Some(b'\\') {
                    self.pos = self.pos.saturating_add(1);
                    out.push('\t');
                    Ok(())
                } else {
                    out.push('\t');
                    Ok(())
                }
            }
            b'S' | b's' => {
                self.expect(b'\\')?;
                let shifted = match self.bump() {
                    Some(byte) => byte,
                    None => return Err(self.error(ErrorKind::UnterminatedString)),
                };
                if shifted < 0x80 {
                    out.push(char::from(shifted + 0x80));
                } else {
                    out.push(char::from(shifted));
                }
                Ok(())
            }
            b'X' | b'x' => self.parse_hex_escape(out),
            b'P' | b'p' => {
                // Code-page directive: `\P<letter>\`. It changes no character by
                // itself, so consume up to and including the closing slash.
                loop {
                    match self.bump() {
                        None => return Err(self.error(ErrorKind::UnterminatedString)),
                        Some(b'\\') => return Ok(()),
                        Some(_) => {}
                    }
                }
            }
            other => {
                // Unknown directive: preserve it rather than losing data.
                out.push('\\');
                out.push(char::from(other));
                Ok(())
            }
        }
    }

    fn parse_hex_escape(&mut self, out: &mut String) -> Result<(), ParseError> {
        match self.peek() {
            Some(b'\\') => {
                self.pos = self.pos.saturating_add(1);
                let value = self.read_hex_digits(2)?;
                out.push(char::from(value as u8));
                Ok(())
            }
            Some(b'2') => {
                self.pos = self.pos.saturating_add(1);
                self.expect(b'\\')?;
                let mut units = Vec::new();
                loop {
                    if self.remaining_starts_with(b"\\X0\\") {
                        self.pos = self.pos.saturating_add(4);
                        break;
                    }
                    if units.len() >= MAX_ESCAPE_UNITS {
                        return Err(self.error(ErrorKind::InvalidEscape));
                    }
                    units.push(self.read_hex_digits(4)? as u16);
                }
                for decoded in char::decode_utf16(units) {
                    out.push(decoded.unwrap_or(char::REPLACEMENT_CHARACTER));
                }
                Ok(())
            }
            Some(b'4') => {
                self.pos = self.pos.saturating_add(1);
                self.expect(b'\\')?;
                let mut count = 0usize;
                loop {
                    if self.remaining_starts_with(b"\\X0\\") {
                        self.pos = self.pos.saturating_add(4);
                        break;
                    }
                    if count >= MAX_ESCAPE_UNITS {
                        return Err(self.error(ErrorKind::InvalidEscape));
                    }
                    let value = self.read_hex_digits(8)?;
                    out.push(char::from_u32(value).unwrap_or(char::REPLACEMENT_CHARACTER));
                    count = count.saturating_add(1);
                }
                Ok(())
            }
            _ => Err(self.error(ErrorKind::InvalidEscape)),
        }
    }

    fn read_hex_digits(&mut self, count: usize) -> Result<u32, ParseError> {
        let mut value: u32 = 0;
        for _ in 0..count {
            match self.bump() {
                Some(byte) => match hex_value(byte) {
                    Some(nibble) => value = (value << 4) | u32::from(nibble),
                    None => {
                        return Err(self.error_at(
                            self.pos.saturating_sub(1),
                            ErrorKind::InvalidEscape,
                        ));
                    }
                },
                None => return Err(self.error(ErrorKind::UnexpectedEof)),
            }
        }
        Ok(value)
    }

    fn parse_binary(&mut self) -> Result<Vec<u8>, ParseError> {
        self.expect(b'"')?;
        let mut nibbles = Vec::new();
        loop {
            match self.bump() {
                None => return Err(self.error(ErrorKind::UnterminatedBinary)),
                Some(b'"') => break,
                Some(byte) if byte.is_ascii_whitespace() => {}
                Some(byte) => match hex_value(byte) {
                    Some(nibble) => nibbles.push(nibble),
                    None => {
                        return Err(self.error_at(
                            self.pos.saturating_sub(1),
                            ErrorKind::UnexpectedByte(byte),
                        ));
                    }
                },
            }
        }

        if nibbles.is_empty() {
            return Ok(Vec::new());
        }

        // The first nibble is the number of unused bits in the final octet.
        let first = nibbles.first().copied().unwrap_or(0);
        let data: &[u8] = if first <= 3 {
            match nibbles.get(1..) {
                Some(data) => data,
                None => &[],
            }
        } else {
            nibbles.as_slice()
        };

        let mut bytes = Vec::with_capacity(data.len() / 2);
        let (pairs, rest) = data.as_chunks::<2>();
        for [high, low] in pairs {
            bytes.push((high << 4) | low);
        }
        if let Some(high) = rest.first() {
            bytes.push(*high);
        }
        Ok(bytes)
    }
}
