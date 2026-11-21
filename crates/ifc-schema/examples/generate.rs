//! Generate the compact static schema tables from buildingSMART EXPRESS files.
//!
//! This is an example, not a build dependency: it uses only `std` and is run
//! manually when a source schema changes.
//!
//! ```text
//! cargo run -p ifc-schema --example generate -- \
//!   --ifc2x3 IFC2X3_TC1.exp \
//!   --ifc4 IFC4.exp \
//!   --ifc4x3 IFC4X3_ADD2.exp \
//!   --out crates/ifc-schema/src/tables.rs
//! ```
//!
//! The `.exp` files are deliberately not part of this repository. See
//! `crates/ifc-schema/GENERATING.md` for their sources and licence status.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

const NO_PARENT: u32 = u32::MAX;

#[derive(Debug)]
struct RawEntity {
    name: String,
    parent: Option<String>,
    is_abstract: bool,
    /// Explicit attributes declared directly on this entity, in declaration order.
    attributes: Vec<(String, bool)>,
    /// Names redeclared in DERIVE, e.g. `SELF\IfcNamedUnit.Dimensions`.
    derived: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    Header,
    Explicit,
    Derive,
    Inverse,
    Unique,
    Where,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("generate: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut paths: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut out: Option<PathBuf> = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--ifc2x3" | "--ifc4" | "--ifc4x3" => {
                let value = args.next().ok_or_else(|| format!("{arg} needs a path"))?;
                paths.insert(arg, PathBuf::from(value));
            }
            "--out" => {
                let value = args.next().ok_or("--out needs a path")?;
                out = Some(PathBuf::from(value));
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let out = out.ok_or("missing --out")?;

    let mut schemas = Vec::new();
    for (flag, rust_name) in [
        ("--ifc2x3", "IFC2X3"),
        ("--ifc4", "IFC4"),
        ("--ifc4x3", "IFC4X3"),
    ] {
        let path = paths
            .get(flag)
            .ok_or_else(|| format!("missing {flag} <file.exp>"))?;
        let text = fs::read_to_string(path)
            .map_err(|err| format!("{}: {err}", path.display()))?;
        let mut entities = parse_entities(&text)
            .map_err(|err| format!("{}: {err}", path.display()))?;
        finish_entity_list(&mut entities)
            .map_err(|err| format!("{}: {err}", path.display()))?;
        eprintln!(
            "{rust_name}: {} entities, {} own attributes from {}",
            entities.len(),
            entities.iter().map(|e| e.attributes.len()).sum::<usize>(),
            path.display()
        );
        schemas.push((rust_name, entities));
    }

    let output = render(&schemas)?;
    fs::write(&out, output).map_err(|err| format!("{}: {err}", out.display()))?;
    eprintln!("wrote {}", out.display());
    Ok(())
}

fn strip_comments(input: &str) -> Result<String, String> {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut depth = 0usize;
    while let Some(ch) = chars.next() {
        if ch == '(' && chars.peek() == Some(&'*') {
            chars.next();
            depth += 1;
        } else if depth > 0 && ch == '*' && chars.peek() == Some(&')') {
            chars.next();
            depth -= 1;
        } else if depth == 0 {
            out.push(ch);
        }
    }
    if depth == 0 {
        Ok(out)
    } else {
        Err("unterminated (* comment *)".to_string())
    }
}

fn parse_entities(input: &str) -> Result<Vec<RawEntity>, String> {
    let text = strip_comments(input)?;
    let mut lines = text.lines();
    let mut entities = Vec::new();

    while let Some(line) = lines.next() {
        let mut words = line.split_whitespace();
        if words.next() != Some("ENTITY") {
            continue;
        }
        let raw_name = words.next().ok_or("ENTITY without a name")?;
        let name = raw_name.trim_end_matches(';').to_string();
        if name.is_empty() {
            return Err("ENTITY without a name".to_string());
        }

        let mut header = String::new();
        let mut header_done = false;
        let mut explicit = String::new();
        let mut derive = String::new();
        let mut section = Section::Header;
        let mut closed = false;

        for line in lines.by_ref() {
            let trimmed = line.trim();
            if trimmed.starts_with("END_ENTITY") {
                closed = true;
                break;
            }
            let first = trimmed.split_whitespace().next().unwrap_or("");
            match first {
                "DERIVE" => {
                    section = Section::Derive;
                    continue;
                }
                "INVERSE" => {
                    section = Section::Inverse;
                    continue;
                }
                "UNIQUE" => {
                    section = Section::Unique;
                    continue;
                }
                "WHERE" => {
                    section = Section::Where;
                    continue;
                }
                _ => {}
            }

            match section {
                Section::Header => {
                    let starts_header =
                        matches!(first, "ABSTRACT" | "SUPERTYPE" | "SUBTYPE");
                    if !header_done && (!header.is_empty() || starts_header) {
                        header.push_str(trimmed);
                        header.push('\n');
                        if trimmed.ends_with(';') {
                            header_done = true;
                        }
                    } else {
                        section = Section::Explicit;
                        explicit.push_str(trimmed);
                        explicit.push('\n');
                    }
                }
                Section::Explicit => {
                    explicit.push_str(trimmed);
                    explicit.push('\n');
                }
                Section::Derive => {
                    derive.push_str(trimmed);
                    derive.push('\n');
                }
                Section::Inverse | Section::Unique | Section::Where => {}
            }
        }
        if !closed {
            return Err(format!("ENTITY {name} is not closed by END_ENTITY;"));
        }

        let parent = parse_parent(&header)?;
        let is_abstract = header
            .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
            .any(|word| word == "ABSTRACT");
        let attributes = parse_explicit(&explicit)
            .map_err(|err| format!("ENTITY {name}: {err}"))?;
        let derived =
            parse_derived(&derive).map_err(|err| format!("ENTITY {name}: {err}"))?;

        entities.push(RawEntity {
            name,
            parent,
            is_abstract,
            attributes,
            derived,
        });
    }

    if entities.is_empty() {
        return Err("no ENTITY declarations found".to_string());
    }
    Ok(entities)
}

fn parse_parent(header: &str) -> Result<Option<String>, String> {
    let Some(position) = header.find("SUBTYPE OF") else {
        return Ok(None);
    };
    let after = &header[position + "SUBTYPE OF".len()..];
    let start = after.find('(').ok_or("SUBTYPE OF without '('")?;
    let mut depth = 0usize;
    let mut end = None;
    for (offset, ch) in after[start..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(start + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end.ok_or("SUBTYPE OF without ')'")?;
    let inside = &after[start + 1..end];
    let parents: Vec<&str> = inside
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    match parents.as_slice() {
        [] => Ok(None),
        [parent] => Ok(Some((*parent).to_string())),
        _ => Err(format!(
            "multiple supertypes are not supported: {}",
            parents.join(", ")
        )),
    }
}

fn parse_explicit(text: &str) -> Result<Vec<(String, bool)>, String> {
    let mut attributes = Vec::new();
    for declaration in text.split(';') {
        let declaration = declaration.trim();
        if declaration.is_empty() {
            continue;
        }
        let (lhs, rhs) = declaration
            .split_once(':')
            .ok_or_else(|| format!("attribute without ':': {declaration}"))?;
        let name = attribute_name(lhs);
        if name.is_empty() {
            return Err(format!("attribute without a name: {declaration}"));
        }
        let optional = rhs.trim_start().starts_with("OPTIONAL");
        attributes.push((name, optional));
    }
    Ok(attributes)
}

fn parse_derived(text: &str) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for declaration in text.split(';') {
        let declaration = declaration.trim();
        if declaration.is_empty() {
            continue;
        }
        let (lhs, _) = declaration
            .split_once(':')
            .ok_or_else(|| format!("DERIVE attribute without ':': {declaration}"))?;
        let name = attribute_name(lhs);
        if !name.is_empty() {
            names.push(name);
        }
    }
    Ok(names)
}

/// Turn `SELF\IfcNamedUnit.Dimensions` or `Dimensions` into `Dimensions`.
fn attribute_name(lhs: &str) -> String {
    let lhs = lhs.trim();
    let lhs = lhs.rsplit('\\').next().unwrap_or(lhs);
    let lhs = lhs.rsplit('.').next().unwrap_or(lhs);
    lhs.trim().to_string()
}

/// Sort entities for case-insensitive binary search and validate the graph.
fn finish_entity_list(entities: &mut [RawEntity]) -> Result<(), String> {
    for entity in entities.iter() {
        for (name, _) in &entity.attributes {
            check_identifier(name)?;
        }
        for name in &entity.derived {
            check_identifier(name)?;
        }
        check_identifier(&entity.name)?;
        if let Some(parent) = &entity.parent {
            check_identifier(parent)?;
        }
    }

    let mut seen = BTreeSet::new();
    for entity in entities.iter() {
        if !seen.insert(entity.name.as_str()) {
            return Err(format!("duplicate ENTITY {}", entity.name));
        }
    }

    entities.sort_by_key(|a| a.name.to_ascii_uppercase());
    for pair in entities.windows(2) {
        if pair[0].name.eq_ignore_ascii_case(&pair[1].name) {
            return Err(format!(
                "entity names differ only by case: {} and {}",
                pair[0].name, pair[1].name
            ));
        }
    }

    let index: BTreeMap<String, usize> = entities
        .iter()
        .enumerate()
        .map(|(idx, entity)| (entity.name.to_ascii_uppercase(), idx))
        .collect();

    for entity in entities.iter() {
        if let Some(parent) = &entity.parent
            && !index.contains_key(&parent.to_ascii_uppercase()) {
                return Err(format!(
                    "ENTITY {} has unknown supertype {parent}",
                    entity.name
                ));
            }
    }

    // Detect cycles. A depth that keeps growing past the entity count is a cycle.
    for start in 0..entities.len() {
        let mut current = start;
        let mut steps = 0usize;
        while let Some(parent) = &entities[current].parent {
            current = *index
                .get(&parent.to_ascii_uppercase())
                .ok_or_else(|| "unknown supertype".to_string())?;
            steps += 1;
            if steps > entities.len() {
                return Err(format!(
                    "inheritance cycle involving ENTITY {}",
                    entities[start].name
                ));
            }
        }
    }

    // An explicit attribute may not shadow an inherited one. If that ever
    // happens the generated table needs an override, not a duplicate.
    for idx in 0..entities.len() {
        let inherited = inherited_attribute_names(entities, &index, idx)?;
        for (name, _) in &entities[idx].attributes {
            if inherited.contains(name.as_str()) {
                return Err(format!(
                    "ENTITY {} redeclares inherited attribute {name} explicitly",
                    entities[idx].name
                ));
            }
        }
    }

    Ok(())
}

fn check_identifier(name: &str) -> Result<(), String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(format!("invalid EXPRESS identifier {name:?}"));
    }
    Ok(())
}

fn inherited_attribute_names(
    entities: &[RawEntity],
    index: &BTreeMap<String, usize>,
    entity_idx: usize,
) -> Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    let mut current = entities[entity_idx].parent.as_ref();
    let mut steps = 0usize;
    while let Some(parent) = current {
        let parent_idx = *index
            .get(&parent.to_ascii_uppercase())
            .ok_or_else(|| format!("unknown supertype {parent}"))?;
        for (name, _) in &entities[parent_idx].attributes {
            names.insert(name.clone());
        }
        current = entities[parent_idx].parent.as_ref();
        steps += 1;
        if steps > entities.len() {
            return Err("inheritance cycle".to_string());
        }
    }
    Ok(names)
}

#[derive(Default)]
struct Interned {
    keys: Vec<(String, bool)>,
    lookup: BTreeMap<(String, bool), u16>,
}

impl Interned {
    fn intern(&mut self, name: &str, optional: bool) -> Result<u16, String> {
        let key = (name.to_string(), optional);
        if let Some(index) = self.lookup.get(&key) {
            return Ok(*index);
        }
        let index = u16::try_from(self.keys.len())
            .map_err(|_| "too many distinct attribute declarations".to_string())?;
        self.keys.push(key.clone());
        self.lookup.insert(key, index);
        Ok(index)
    }
}

fn render(schemas: &[( &str, Vec<RawEntity>)]) -> Result<String, String> {
    let mut output = String::new();
    output.push_str(
        "// @generated by `cargo run -p ifc-schema --example generate`.\n\
         // Source: buildingSMART EXPRESS schemas. Do not edit by hand.\n\
         // Copyright buildingSMART International Limited. Not covered by this project's\n\
         // licence: see NOTICE.md. Regeneration: crates/ifc-schema/GENERATING.md\n\n\
         use crate::{AttributeRecord, EntityRecord};\n\n",
    );

    for (rust_name, entities) in schemas {
        let index: BTreeMap<String, usize> = entities
            .iter()
            .enumerate()
            .map(|(idx, entity)| (entity.name.to_ascii_uppercase(), idx))
            .collect();

        let mut interned = Interned::default();
        let mut entity_attributes: Vec<u16> = Vec::new();
        let mut entity_attr_ranges: Vec<(u32, u16)> = Vec::with_capacity(entities.len());
        let mut derived_names: Vec<&str> = Vec::new();
        let mut entity_derived_ranges: Vec<(u32, u16)> = Vec::with_capacity(entities.len());

        for entity in entities {
            let start = u32::try_from(entity_attributes.len())
                .map_err(|_| "entity attribute table too large".to_string())?;
            for (name, optional) in &entity.attributes {
                let attr_idx = interned.intern(name, *optional)?;
                entity_attributes.push(attr_idx);
            }
            let len = u16::try_from(entity_attributes.len() - start as usize)
                .map_err(|_| "too many attributes on one entity".to_string())?;
            entity_attr_ranges.push((start, len));

            let inherited = inherited_attribute_names(entities, &index, index[&entity.name.to_ascii_uppercase()])?;
            let d_start = u32::try_from(derived_names.len())
                .map_err(|_| "derived attribute table too large".to_string())?;
            let mut d_len = 0u16;
            for name in &entity.derived {
                if inherited.contains(name) {
                    derived_names.push(name);
                    d_len = d_len
                        .checked_add(1)
                        .ok_or("too many derived overrides")?;
                }
            }
            entity_derived_ranges.push((d_start, d_len));
        }

        writeln!(
            output,
            "pub(crate) static {rust_name}_ATTRIBUTES: &[AttributeRecord] = &["
        )
        .map_err(|err| err.to_string())?;
        for (name, optional) in &interned.keys {
            writeln!(
                output,
                "    AttributeRecord {{ name: \"{name}\", optional: {optional} }},"
            )
            .map_err(|err| err.to_string())?;
        }
        output.push_str("];\n\n");

        writeln!(
            output,
            "pub(crate) static {rust_name}_ENTITY_ATTRIBUTES: &[u16] = &["
        )
        .map_err(|err| err.to_string())?;
        for chunk in entity_attributes.chunks(16) {
            output.push_str("    ");
            for value in chunk {
                write!(output, "{value}, ").map_err(|err| err.to_string())?;
            }
            output.push('\n');
        }
        output.push_str("];\n\n");

        writeln!(
            output,
            "pub(crate) static {rust_name}_DERIVED_ATTRIBUTES: &[&str] = &["
        )
        .map_err(|err| err.to_string())?;
        for name in &derived_names {
            writeln!(output, "    \"{name}\",").map_err(|err| err.to_string())?;
        }
        output.push_str("];\n\n");

        writeln!(
            output,
            "pub(crate) static {rust_name}_ENTITIES: &[EntityRecord] = &["
        )
        .map_err(|err| err.to_string())?;
        for (entity, (attr_start, attr_len), (derived_start, derived_len)) in entities
            .iter()
            .zip(entity_attr_ranges.iter())
            .zip(entity_derived_ranges.iter())
            .map(|((e, a), d)| (e, a, d))
        {
            let parent = entity
                .parent
                .as_ref()
                .and_then(|parent| index.get(&parent.to_ascii_uppercase()).copied())
                .map(|idx| idx as u32)
                .unwrap_or(NO_PARENT);
            writeln!(
                output,
                "    EntityRecord {{ name: \"{}\", parent: {parent}, attr_start: {attr_start}, attr_len: {attr_len}, derived_start: {derived_start}, derived_len: {derived_len}, is_abstract: {} }},",
                entity.name, entity.is_abstract
            )
            .map_err(|err| err.to_string())?;
        }
        output.push_str("];\n\n");
    }

    Ok(output)
}
