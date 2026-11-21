//! Streaming ISO 10303-21 (STEP) lexer and `expressId` index. Owner: DeepSeek (T-020).
//!
//! The crate deliberately makes a single, allocation-light pass over the input to
//! build an index of entity records. Parameters are only tokenised when an entity
//! is decoded through [`StepIndex::decode`], so opening a large model does not
//! allocate a `Value` tree for every instance.
//!
//! Only the public ISO 10303-21 physical file format is implemented. No other
//! STEP/BIM parser was consulted.

mod index;
mod parser;

use std::collections::HashMap;
use std::fmt;
use std::ops::Range;

/// A decoded STEP parameter value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// `$`
    Null,
    /// `*`
    Derived,
    /// A signed integer literal.
    Integer(i64),
    /// A real literal such as `1.`, `.5` or `1.E-5`.
    Real(f64),
    /// A decoded string literal. STEP escape directives are resolved.
    String(String),
    /// An enumeration such as `.FOO.`, stored without the dots and upper-cased.
    Enum(String),
    /// An entity reference such as `#42`.
    Ref(u32),
    /// A typed parameter such as `IFCLABEL('x')`.
    Typed { name: String, value: Box<Value> },
    /// A parenthesised list, which may be nested.
    List(Vec<Value>),
    /// A binary literal. The payload is the decoded byte sequence.
    Binary(Vec<u8>),
}

/// One decoded entity instance.
#[derive(Debug, Clone, PartialEq)]
pub struct Entity {
    /// Upper-cased entity type name, for example `IFCWALLSTANDARDCASE`.
    ///
    /// For a complex instance this is the name of the first partial.
    pub type_name: String,
    /// The entity parameters, in file order.
    ///
    /// For a complex instance these are the parameters of the first partial.
    pub params: Vec<Value>,
    /// The partials of a complex instance after the first, in file order.
    /// Empty for an ordinary entity.
    pub other_parts: Vec<(String, Vec<Value>)>,
}

impl Entity {
    /// Every partial in file order: the first is [`Self::type_name`] with
    /// [`Self::params`], so an ordinary entity yields exactly that one.
    pub fn parts(&self) -> impl Iterator<Item = (&str, &[Value])> + '_ {
        std::iter::once((self.type_name.as_str(), self.params.as_slice())).chain(
            self.other_parts
                .iter()
                .map(|(name, params)| (name.as_str(), params.as_slice())),
        )
    }
}

/// The reason a [`ParseError`] was produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorKind {
    /// The input ended while more syntax was required.
    UnexpectedEof,
    /// A byte was not valid where it appeared.
    UnexpectedByte(u8),
    /// An identifier was expected but none was present.
    InvalidIdentifier,
    /// A numeric literal could not be parsed.
    InvalidNumber,
    /// An integer literal did not fit in `i64`.
    IntegerOverflow,
    /// An entity reference or identifier did not fit in `u32`.
    IdentifierOverflow,
    /// A string literal was not closed.
    UnterminatedString,
    /// A `/* ... */` comment was not closed.
    UnterminatedComment,
    /// A binary literal was not closed.
    UnterminatedBinary,
    /// A string escape directive was malformed.
    InvalidEscape,
    /// An entity record did not match the `#id = TYPE(...);` shape.
    MalformedEntity,
    /// A value was nested more deeply than the parser's safety limit.
    NestingTooDeep,
    /// The requested entity id is not present in the index.
    UnknownEntity(u32),
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorKind::UnexpectedEof => write!(f, "unexpected end of input"),
            ErrorKind::UnexpectedByte(byte) => {
                write!(f, "unexpected byte 0x{byte:02X}")
            }
            ErrorKind::InvalidIdentifier => write!(f, "expected an identifier"),
            ErrorKind::InvalidNumber => write!(f, "invalid numeric literal"),
            ErrorKind::IntegerOverflow => write!(f, "integer literal is out of range"),
            ErrorKind::IdentifierOverflow => write!(f, "identifier is out of range"),
            ErrorKind::UnterminatedString => write!(f, "unterminated string literal"),
            ErrorKind::UnterminatedComment => write!(f, "unterminated comment"),
            ErrorKind::UnterminatedBinary => write!(f, "unterminated binary literal"),
            ErrorKind::InvalidEscape => write!(f, "invalid string escape directive"),
            ErrorKind::MalformedEntity => write!(f, "malformed entity record"),
            ErrorKind::NestingTooDeep => write!(f, "value nesting exceeds the depth limit"),
            ErrorKind::UnknownEntity(id) => write!(f, "unknown entity #{id}"),
        }
    }
}

/// A parse failure, with the byte offset in the original input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    /// Byte offset into the input passed to [`index`].
    pub offset: usize,
    /// Machine-readable failure kind.
    pub kind: ErrorKind,
}

impl ParseError {
    pub(crate) fn new(offset: usize, kind: ErrorKind) -> Self {
        Self { offset, kind }
    }

    /// Byte offset into the input passed to [`index`].
    pub fn offset(&self) -> usize {
        self.offset
    }

    /// Machine-readable failure kind.
    pub fn kind(&self) -> &ErrorKind {
        &self.kind
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "STEP parse error at byte {}: {}", self.offset, self.kind)
    }
}

impl std::error::Error for ParseError {}

/// A borrowed view of one indexed entity record.
#[derive(Debug, Clone, Copy)]
pub struct EntityRef<'a> {
    /// The `expressId` from the `#id =` prefix.
    pub id: u32,
    /// Upper-cased entity type name.
    pub type_name: &'a str,
    /// Position of [`Self::type_name`] in [`StepIndex::type_names`], so callers can
    /// resolve each type once per file instead of once per entity.
    pub type_index: u32,
    /// First byte of the record (`#`).
    pub start: usize,
    /// One past the final byte of the record (after `;`).
    pub end: usize,
}

impl EntityRef<'_> {
    /// The byte range of the whole record, including the trailing semicolon.
    pub fn byte_range(&self) -> Range<usize> {
        self.start..self.end
    }
}

#[derive(Debug, Clone, Copy)]
struct Entry {
    id: u32,
    type_idx: u32,
    start: usize,
    end: usize,
}

/// Entry position by `expressId`. Exporters number entities densely, so most files
/// get a plain table indexed by id; scattered ids keep the hash map.
#[derive(Debug)]
enum IdTable {
    Dense(Vec<u32>),
    Sparse(HashMap<u32, u32>),
}

const NO_ENTRY: u32 = u32::MAX;

impl IdTable {
    fn new(by_id: HashMap<u32, u32>) -> Self {
        let limit = by_id.len().saturating_mul(2).saturating_add(1024);
        match by_id.keys().max() {
            Some(&max) if (max as usize) < limit => {
                let mut table = vec![NO_ENTRY; max as usize + 1];
                for (id, entry) in by_id {
                    table[id as usize] = entry;
                }
                Self::Dense(table)
            }
            _ => Self::Sparse(by_id),
        }
    }

    fn get(&self, id: u32) -> Option<u32> {
        match self {
            Self::Dense(table) => table.get(id as usize).copied().filter(|at| *at != NO_ENTRY),
            Self::Sparse(map) => map.get(&id).copied(),
        }
    }
}

#[cfg(test)]
mod id_table_tests {
    use super::{HashMap, IdTable};

    fn table(ids: &[u32]) -> IdTable {
        let by_id: HashMap<u32, u32> = ids.iter().enumerate().map(|(at, id)| (*id, at as u32)).collect();
        IdTable::new(by_id)
    }

    #[test]
    fn a_table_by_id_is_kept_within_twice_the_entities_plus_1024() {
        // Inside WASM a table up to u32::MAX would need 16 GB and kill the model.
        assert!(matches!(table(&[7, u32::MAX]), IdTable::Sparse(_)));
        assert!(matches!(table(&[1, 2, 5_000]), IdTable::Sparse(_)));
        // Mostly empty, but 901 slots are 3.6 KB: any small file may use a table.
        assert!(matches!(table(&[1, 2, 3, 900]), IdTable::Dense(_)));
        assert!(matches!(table(&[]), IdTable::Sparse(_)));
    }

    #[test]
    fn both_layouts_answer_none_for_an_id_they_do_not_hold() {
        for ids in [&[1, 2, 4][..], &[1, 2, 4, 5_000]] {
            let table = table(ids);
            assert_eq!(table.get(2), Some(1));
            assert_eq!(table.get(4), Some(2));
            assert_eq!(table.get(3), None, "a gap, {table:?}");
            assert_eq!(table.get(0), None);
            assert_eq!(table.get(u32::MAX), None);
        }
    }
}

/// A lazily-decoded index over an ISO 10303-21 file.
///
/// Building the index stores only identifiers, byte ranges and one interned type
/// name per entity. Parameter values are decoded on demand by [`Self::decode`].
#[derive(Debug)]
pub struct StepIndex<'a> {
    bytes: &'a [u8],
    schemas: Vec<String>,
    entries: Vec<Entry>,
    by_id: IdTable,
    types: Vec<String>,
    type_lookup: HashMap<String, u32>,
    by_type: HashMap<u32, Vec<u32>>,
    duplicates: Vec<u32>,
    skipped: Vec<ParseError>,
}

impl<'a> StepIndex<'a> {
    /// Schema identifiers found in the `FILE_SCHEMA` header statement.
    pub fn schema_identifiers(&self) -> &[String] {
        &self.schemas
    }

    /// Number of unique entity ids in the index.
    ///
    /// Duplicate ids are tolerated: the first record wins, later records are
    /// reported by [`Self::duplicate_ids`] and are not counted.
    pub fn entity_count(&self) -> usize {
        self.entries.len()
    }

    /// Duplicate entity ids encountered while indexing, in file order.
    pub fn duplicate_ids(&self) -> &[u32] {
        &self.duplicates
    }

    /// Entity records that were malformed and therefore skipped, in file order.
    ///
    /// A malformed record does not make [`index`] fail: the scanner resynchronises
    /// at the next statement-ending semicolon and continues with later records.
    pub fn skipped(&self) -> &[ParseError] {
        &self.skipped
    }

    /// Look up one entity by `expressId`.
    pub fn get(&self, id: u32) -> Option<EntityRef<'_>> {
        let entry_idx = self.by_id.get(id)?;
        let entry = self.entries.get(entry_idx as usize)?;
        let type_name = self.types.get(entry.type_idx as usize)?;
        Some(EntityRef {
            id: entry.id,
            type_name: type_name.as_str(),
            type_index: entry.type_idx,
            start: entry.start,
            end: entry.end,
        })
    }

    /// Iterate every entity in file order.
    pub fn entities(&self) -> impl Iterator<Item = EntityRef<'_>> + '_ {
        self.entries.iter().filter_map(move |entry| self.ref_for(entry))
    }

    /// Iterate every entity id in file order.
    pub fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.entries.iter().map(|entry| entry.id)
    }

    /// Iterate the ids of entities whose type name matches `type_name`.
    ///
    /// Matching is ASCII case-insensitive. Results are in file order.
    pub fn ids_by_type<'s>(&'s self, type_name: &str) -> impl Iterator<Item = u32> + 's {
        let type_idx = self
            .type_lookup
            .get(&type_name.to_ascii_uppercase())
            .copied();
        let ids: &[u32] = type_idx
            .and_then(|idx| self.by_type.get(&idx))
            .map(|ids| ids.as_slice())
            .unwrap_or(&[]);
        ids.iter().copied()
    }

    /// Iterate every distinct entity type name, in first-seen order.
    pub fn type_names(&self) -> impl Iterator<Item = &str> + '_ {
        self.types.iter().map(String::as_str)
    }

    /// Decode one entity by `expressId`.
    pub fn decode(&self, id: u32) -> Result<Entity, ParseError> {
        let entity = self
            .get(id)
            .ok_or_else(|| ParseError::new(self.bytes.len(), ErrorKind::UnknownEntity(id)))?;
        self.decode_ref(entity)
    }

    /// Decode an entity previously obtained from [`Self::get`] or [`Self::entities`].
    pub fn decode_ref(&self, entity: EntityRef<'_>) -> Result<Entity, ParseError> {
        let mut parser = parser::Parser::new(self.bytes, entity.start, entity.end);
        parser.parse_entity()
    }

    /// The numbers of a record whose only parameter is a list of two or three plain numbers,
    /// such as most `IFCCARTESIANPOINT`s, read with no allocation. `None` for any other shape,
    /// valid or not: then [`Self::decode_ref`] has the answer. Whenever this answers, it
    /// agrees with that.
    pub fn decode_coordinates(&self, entity: EntityRef<'_>) -> Option<([f64; 3], usize)> {
        parser::Parser::new(self.bytes, entity.start, entity.end).parse_coordinates()
    }

    /// The references of a record whose only parameter is a list of references, such as most
    /// `IFCPOLYLOOP`s and `IFCFACE`s, read into `out` with no other allocation. `false`, with
    /// `out` empty, for any other shape, valid or not: then [`Self::decode_ref`] has the
    /// answer. Whenever this answers, it agrees with that.
    pub fn decode_references(&self, entity: EntityRef<'_>, out: &mut Vec<u32>) -> bool {
        out.clear();
        let read = parser::Parser::new(self.bytes, entity.start, entity.end)
            .parse_reference_list(out)
            .is_some();
        if !read {
            out.clear();
        }
        read
    }

    /// The parameters of a record written as a reference then `.T.` or `.F.`, such as most
    /// `IFCFACEOUTERBOUND`s, read with no allocation. `None` for any other shape, valid or
    /// not: then [`Self::decode_ref`] has the answer. Whenever this answers, it agrees with
    /// that.
    pub fn decode_reference_and_boolean(&self, entity: EntityRef<'_>) -> Option<(u32, bool)> {
        parser::Parser::new(self.bytes, entity.start, entity.end).parse_reference_and_boolean()
    }

    fn ref_for(&self, entry: &Entry) -> Option<EntityRef<'_>> {
        let type_name = self.types.get(entry.type_idx as usize)?;
        Some(EntityRef {
            id: entry.id,
            type_name: type_name.as_str(),
            type_index: entry.type_idx,
            start: entry.start,
            end: entry.end,
        })
    }
}

/// Index an ISO 10303-21 byte stream.
///
/// This performs one forward pass. It records the header schema identifiers and,
/// for every entity, the `expressId`, type name and byte range. Parameters are not
/// parsed here.
pub fn index(bytes: &[u8]) -> Result<StepIndex<'_>, ParseError> {
    index::build(bytes)
}
