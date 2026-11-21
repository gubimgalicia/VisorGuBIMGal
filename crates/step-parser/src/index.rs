//! Single-pass entity indexer.

use std::collections::HashMap;

use crate::parser::Parser;
use crate::{Entry, ErrorKind, IdTable, ParseError, StepIndex, Value};

struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

struct Record {
    id: u32,
    type_names: Vec<String>,
    start: usize,
    end: usize,
}

impl<'a> Scanner<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn error(&self, kind: ErrorKind) -> ParseError {
        ParseError::new(self.pos, kind)
    }

    fn error_at(&self, offset: usize, kind: ErrorKind) -> ParseError {
        ParseError::new(offset, kind)
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn peek_at(&self, ahead: usize) -> Option<u8> {
        let at = self.pos.checked_add(ahead)?;
        self.bytes.get(at).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.pos = self.pos.saturating_add(1);
        Some(byte)
    }

    fn skip_ws_comments(&mut self) -> Result<(), ParseError> {
        loop {
            match self.peek() {
                Some(byte) if byte.is_ascii_whitespace() => {
                    self.pos = self.pos.saturating_add(1);
                }
                Some(b'/') if self.peek_at(1) == Some(b'*') => self.skip_comment()?,
                _ => return Ok(()),
            }
        }
    }

    fn skip_comment(&mut self) -> Result<(), ParseError> {
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

    /// Skip the body of a single-quoted string. The opening quote is consumed.
    fn skip_single_quoted(&mut self) -> Result<(), ParseError> {
        loop {
            match self.bump() {
                None => return Err(self.error(ErrorKind::UnterminatedString)),
                Some(b'\'') => {
                    if self.peek() == Some(b'\'') {
                        self.pos = self.pos.saturating_add(1);
                    } else {
                        return Ok(());
                    }
                }
                Some(_) => {}
            }
        }
    }

    /// Skip a binary literal. The opening double quote is consumed.
    fn skip_double_quoted(&mut self) -> Result<(), ParseError> {
        loop {
            match self.bump() {
                None => return Err(self.error(ErrorKind::UnterminatedBinary)),
                Some(b'"') => return Ok(()),
                Some(_) => {}
            }
        }
    }

    fn read_word(&mut self) -> Result<String, ParseError> {
        let start = self.pos;
        let mut word = String::new();
        while let Some(byte) = self.peek() {
            if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
                word.push(byte.to_ascii_uppercase() as char);
                self.pos = self.pos.saturating_add(1);
            } else {
                break;
            }
        }
        if self.pos == start {
            Err(self.error(ErrorKind::InvalidIdentifier))
        } else {
            Ok(word)
        }
    }

    fn read_u32_digits(&mut self) -> Result<u32, ParseError> {
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

    /// Skip a parenthesised body. The opening `(` is already consumed.
    ///
    /// Records are scanned iteratively, so this cannot exhaust the stack.
    fn skip_parenthesized_body(&mut self) -> Result<(), ParseError> {
        let mut depth = 1usize;
        loop {
            match self.peek() {
                None => return Err(self.error(ErrorKind::UnexpectedEof)),
                Some(b'\'') => {
                    self.pos = self.pos.saturating_add(1);
                    self.skip_single_quoted()?;
                }
                Some(b'"') => {
                    self.pos = self.pos.saturating_add(1);
                    self.skip_double_quoted()?;
                }
                Some(b'/') if self.peek_at(1) == Some(b'*') => self.skip_comment()?,
                Some(b'(') => {
                    self.pos = self.pos.saturating_add(1);
                    depth = depth.saturating_add(1);
                }
                Some(b')') => {
                    self.pos = self.pos.saturating_add(1);
                    depth -= 1;
                    if depth == 0 {
                        return Ok(());
                    }
                }
                Some(_) => {
                    self.pos = self.pos.saturating_add(1);
                }
            }
        }
    }

    /// Scan `#id = TYPE(...);` or `#id = (TYPE(...)TYPE(...));` without decoding
    /// its parameters. Complex instances yield every partial type name in file
    /// order; ordinary instances yield exactly one.
    fn scan_entity(&mut self) -> Result<Record, ParseError> {
        let start = self.pos;
        if self.peek() != Some(b'#') {
            return Err(self.error(ErrorKind::MalformedEntity));
        }
        self.pos = self.pos.saturating_add(1);
        let id = self.read_u32_digits()?;

        self.skip_ws_comments()?;
        match self.bump() {
            Some(b'=') => {}
            Some(byte) => {
                return Err(self.error_at(
                    self.pos.saturating_sub(1),
                    ErrorKind::UnexpectedByte(byte),
                ));
            }
            None => return Err(self.error(ErrorKind::UnexpectedEof)),
        }

        self.skip_ws_comments()?;
        let mut type_names = Vec::new();
        if self.peek() == Some(b'(') {
            // Complex entity instance: `(A(...)B(...))`.
            self.pos = self.pos.saturating_add(1);
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
                let name = self.read_word()?;
                type_names.push(name);
                self.skip_ws_comments()?;
                if self.peek() != Some(b'(') {
                    return Err(self.error(ErrorKind::MalformedEntity));
                }
                self.pos = self.pos.saturating_add(1);
                self.skip_parenthesized_body()?;
            }
        } else {
            let name = self.read_word()?;
            type_names.push(name);
            self.skip_ws_comments()?;
            if self.peek() != Some(b'(') {
                return Err(self.error(ErrorKind::MalformedEntity));
            }
            self.pos = self.pos.saturating_add(1);
            self.skip_parenthesized_body()?;
        }

        if type_names.is_empty() {
            return Err(self.error(ErrorKind::MalformedEntity));
        }

        self.skip_ws_comments()?;
        if self.peek() != Some(b';') {
            return Err(self.error(ErrorKind::MalformedEntity));
        }
        self.pos = self.pos.saturating_add(1);

        Ok(Record {
            id,
            type_names,
            start,
            end: self.pos,
        })
    }

    /// Skip to and including the next statement-ending semicolon.
    ///
    /// Parentheses are deliberately not balanced here: a truncated record is
    /// exactly what we are recovering from, so the next semicolon outside a
    /// string or comment is the safest place to resume.
    fn resync_to_statement_end(&mut self) -> bool {
        loop {
            match self.peek() {
                None => return false,
                Some(b';') => {
                    self.pos = self.pos.saturating_add(1);
                    return true;
                }
                Some(b'\'') => {
                    self.pos = self.pos.saturating_add(1);
                    if self.skip_single_quoted().is_err() {
                        return false;
                    }
                }
                Some(b'"') => {
                    self.pos = self.pos.saturating_add(1);
                    if self.skip_double_quoted().is_err() {
                        return false;
                    }
                }
                Some(b'/') if self.peek_at(1) == Some(b'*') => {
                    if self.skip_comment().is_err() {
                        return false;
                    }
                }
                Some(_) => {
                    self.pos = self.pos.saturating_add(1);
                }
            }
        }
    }

    /// Skip to and including the next semicolon. Used for header statements.
    fn skip_statement(&mut self) -> Result<(), ParseError> {
        loop {
            match self.peek() {
                None => return Err(self.error(ErrorKind::UnexpectedEof)),
                Some(b';') => {
                    self.pos = self.pos.saturating_add(1);
                    return Ok(());
                }
                Some(b'\'') => {
                    self.pos = self.pos.saturating_add(1);
                    self.skip_single_quoted()?;
                }
                Some(b'"') => {
                    self.pos = self.pos.saturating_add(1);
                    self.skip_double_quoted()?;
                }
                Some(b'/') if self.peek_at(1) == Some(b'*') => self.skip_comment()?,
                Some(_) => {
                    self.pos = self.pos.saturating_add(1);
                }
            }
        }
    }
}

pub(crate) fn build(bytes: &[u8]) -> Result<StepIndex<'_>, ParseError> {
    let mut scanner = Scanner::new(bytes);
    let mut schemas = Vec::new();

    let mut entries: Vec<Entry> = Vec::new();
    let mut by_id: HashMap<u32, u32> = HashMap::new();
    let mut types: Vec<String> = Vec::new();
    let mut type_lookup: HashMap<String, u32> = HashMap::new();
    let mut by_type: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut duplicates: Vec<u32> = Vec::new();
    let mut skipped: Vec<ParseError> = Vec::new();

    // Header and data section tracking. A bare `DATA;` fragment is accepted so
    // that callers can index snippets, but a file that declares itself as
    // ISO-10303-21 must contain a HEADER statement.
    let mut iso_declared = false;
    let mut header_found = false;
    let mut data_found = false;
    let mut in_data = false;

    loop {
        if let Err(err) = scanner.skip_ws_comments() {
            // An unterminated comment consumes the rest of the file. Keep what
            // was already indexed; whether that is enough is decided below.
            skipped.push(err);
            break;
        }
        let byte = match scanner.peek() {
            Some(byte) => byte,
            None => break,
        };

        if byte == b'#' {
            let record_start = scanner.pos;
            match scanner.scan_entity() {
                Ok(record) => {
                    if in_data {
                        if by_id.contains_key(&record.id) {
                            duplicates.push(record.id);
                            continue;
                        }

                        let mut primary_type_idx = None;
                        for type_name in &record.type_names {
                            let type_idx = match type_lookup.get(type_name).copied() {
                                Some(idx) => idx,
                                None => {
                                    let idx = u32::try_from(types.len()).map_err(|_| {
                                        scanner.error(ErrorKind::IdentifierOverflow)
                                    })?;
                                    type_lookup.insert(type_name.clone(), idx);
                                    types.push(type_name.clone());
                                    idx
                                }
                            };
                            if primary_type_idx.is_none() {
                                primary_type_idx = Some(type_idx);
                            }
                            let ids = by_type.entry(type_idx).or_default();
                            if ids.last() != Some(&record.id) {
                                ids.push(record.id);
                            }
                        }

                        let type_idx = primary_type_idx
                            .ok_or_else(|| scanner.error(ErrorKind::MalformedEntity))?;
                        let entry_idx = u32::try_from(entries.len())
                            .map_err(|_| scanner.error(ErrorKind::IdentifierOverflow))?;
                        entries.push(Entry {
                            id: record.id,
                            type_idx,
                            start: record.start,
                            end: record.end,
                        });
                        by_id.insert(record.id, entry_idx);
                    }
                }
                Err(err) => {
                    skipped.push(err);
                    scanner.pos = record_start;
                    if !scanner.resync_to_statement_end() {
                        break;
                    }
                }
            }
            continue;
        }

        if byte == b';' {
            // Tolerate a stray separator between statements.
            scanner.pos = scanner.pos.saturating_add(1);
            continue;
        }

        let word = match scanner.read_word() {
            Ok(word) => word,
            Err(err) => {
                skipped.push(err);
                if !scanner.resync_to_statement_end() {
                    break;
                }
                continue;
            }
        };
        if let Err(err) = scanner.skip_ws_comments() {
            skipped.push(err);
            break;
        }

        let starts_data = word == "DATA";
        match word.as_str() {
            "ISO-10303-21" => iso_declared = true,
            "HEADER" => header_found = true,
            "ENDSEC" => in_data = false,
            _ => {}
        }

        if word == "FILE_SCHEMA"
            && scanner.peek() == Some(b'(') {
                let mut parser = Parser::new(bytes, scanner.pos, bytes.len());
                match parser.parse_outer_params() {
                    Ok(params) => {
                        collect_schemas(&params, &mut schemas);
                        scanner.pos = parser.position();
                    }
                    Err(err) => skipped.push(err),
                }
            }

        match scanner.skip_statement() {
            Ok(()) => {
                if starts_data {
                    data_found = true;
                    in_data = true;
                }
            }
            Err(err) => {
                skipped.push(err);
                break;
            }
        }
    }

    if !data_found {
        return Err(ParseError::new(bytes.len(), ErrorKind::MalformedEntity));
    }
    if iso_declared && !header_found {
        return Err(ParseError::new(0, ErrorKind::MalformedEntity));
    }

    Ok(StepIndex {
        bytes,
        schemas,
        entries,
        by_id: IdTable::new(by_id),
        types,
        type_lookup,
        by_type,
        duplicates,
        skipped,
    })
}

fn collect_schemas(params: &[Value], out: &mut Vec<String>) {
    let mut stack: Vec<&Value> = params.iter().rev().collect();
    while let Some(param) = stack.pop() {
        match param {
            Value::List(values) => stack.extend(values.iter().rev()),
            Value::String(schema) => out.push(schema.clone()),
            _ => {}
        }
    }
}
