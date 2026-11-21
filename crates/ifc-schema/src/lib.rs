//! IFC2X3, IFC4 and IFC4X3 entity metadata generated from EXPRESS.
//!
//! The tables hold inheritance and attribute order and nothing else: a Rust type per entity
//! would add over a thousand types to the WebAssembly binary, and callers only need to know
//! which STEP parameter holds which attribute. Regeneration: `GENERATING.md`.

mod tables;
pub mod units;

use std::cmp::Ordering;

const NO_PARENT: u32 = u32::MAX;

#[doc(hidden)]
#[derive(Debug)]
pub struct AttributeRecord {
    name: &'static str,
    optional: bool,
}

#[doc(hidden)]
#[derive(Debug)]
pub struct EntityRecord {
    name: &'static str,
    parent: u32,
    attr_start: u32,
    attr_len: u16,
    derived_start: u32,
    derived_len: u16,
    is_abstract: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SchemaId {
    Ifc2x3,
    Ifc4,
    Ifc4x3,
}

impl SchemaId {
    /// Maps FILE_SCHEMA text to a supported schema, or `None` for anything else.
    pub fn from_identifiers(identifiers: &[String]) -> Option<Self> {
        identifiers.iter().find_map(|identifier| {
            match identifier.trim().to_ascii_uppercase().as_str() {
                "IFC2X3" | "IFC2X3_TC1" => Some(Self::Ifc2x3),
                "IFC4" | "IFC4_ADD1" | "IFC4_ADD2" | "IFC4_ADD2_TC1" => Some(Self::Ifc4),
                "IFC4X3" | "IFC4X3_ADD1" | "IFC4X3_ADD2" | "IFC4X3_TC1" => Some(Self::Ifc4x3),
                _ => None,
            }
        })
    }

    /// The canonical name used in the kernel contract.
    pub fn canonical_name(self) -> &'static str {
        match self {
            Self::Ifc2x3 => "IFC2X3",
            Self::Ifc4 => "IFC4",
            Self::Ifc4x3 => "IFC4X3",
        }
    }
}

#[derive(Debug)]
pub struct Schema {
    attributes: &'static [AttributeRecord],
    entity_attributes: &'static [u16],
    derived_attributes: &'static [&'static str],
    entities: &'static [EntityRecord],
}

static IFC2X3: Schema = Schema {
    attributes: tables::IFC2X3_ATTRIBUTES,
    entity_attributes: tables::IFC2X3_ENTITY_ATTRIBUTES,
    derived_attributes: tables::IFC2X3_DERIVED_ATTRIBUTES,
    entities: tables::IFC2X3_ENTITIES,
};

static IFC4: Schema = Schema {
    attributes: tables::IFC4_ATTRIBUTES,
    entity_attributes: tables::IFC4_ENTITY_ATTRIBUTES,
    derived_attributes: tables::IFC4_DERIVED_ATTRIBUTES,
    entities: tables::IFC4_ENTITIES,
};

static IFC4X3: Schema = Schema {
    attributes: tables::IFC4X3_ATTRIBUTES,
    entity_attributes: tables::IFC4X3_ENTITY_ATTRIBUTES,
    derived_attributes: tables::IFC4X3_DERIVED_ATTRIBUTES,
    entities: tables::IFC4X3_ENTITIES,
};

pub fn schema(id: SchemaId) -> &'static Schema {
    match id {
        SchemaId::Ifc2x3 => &IFC2X3,
        SchemaId::Ifc4 => &IFC4,
        SchemaId::Ifc4x3 => &IFC4X3,
    }
}

/// Orders by ASCII-uppercased bytes, matching the generated sort.
fn compare_ignoring_case(a: &str, b: &str) -> Ordering {
    a.bytes()
        .map(|byte| byte.to_ascii_uppercase())
        .cmp(b.bytes().map(|byte| byte.to_ascii_uppercase()))
}

impl Schema {
    /// Case-insensitive, since STEP files use upper case and EXPRESS uses mixed case.
    pub fn entity(&'static self, type_name: &str) -> Option<EntityDef> {
        let index = self
            .entities
            .binary_search_by(|record| compare_ignoring_case(record.name, type_name))
            .ok()?;
        Some(EntityDef {
            schema: self,
            index,
        })
    }

    /// Every concrete entity that is, or descends from, `ancestor`.
    pub fn subtypes_of(&'static self, ancestor: &str) -> Vec<&'static str> {
        (0..self.entities.len())
            .map(|index| EntityDef {
                schema: self,
                index,
            })
            .filter(|entity| !entity.is_abstract() && entity.is_a(ancestor))
            .map(|entity| entity.name())
            .collect()
    }
}

/// One attribute, at its position in the STEP parameter list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttributeDef {
    pub name: &'static str,
    pub optional: bool,
    /// A subtype computes this attribute, so the file holds `*` at this position.
    pub derived: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct EntityDef {
    schema: &'static Schema,
    index: usize,
}

impl EntityDef {
    fn record(&self) -> Option<&'static EntityRecord> {
        self.schema.entities.get(self.index)
    }

    pub fn name(&self) -> &'static str {
        self.record().map_or("", |record| record.name)
    }

    pub fn parent(&self) -> Option<EntityDef> {
        let parent = self.record()?.parent;
        (parent != NO_PARENT).then_some(EntityDef {
            schema: self.schema,
            index: parent as usize,
        })
    }

    pub fn is_abstract(&self) -> bool {
        self.record().is_some_and(|record| record.is_abstract)
    }

    /// Whether this entity is `ancestor` or descends from it.
    pub fn is_a(&self, ancestor: &str) -> bool {
        self.lineage()
            .any(|entity| entity.name().eq_ignore_ascii_case(ancestor))
    }

    /// This entity, then each supertype up to the root.
    fn lineage(&self) -> impl Iterator<Item = EntityDef> + use<> {
        std::iter::successors(Some(*self), EntityDef::parent)
    }

    fn own_attributes(&self) -> &'static [u16] {
        self.record()
            .and_then(|record| {
                let start = record.attr_start as usize;
                self.schema
                    .entity_attributes
                    .get(start..start + record.attr_len as usize)
            })
            .unwrap_or(&[])
    }

    fn overrides(&self, name: &str) -> bool {
        self.record()
            .and_then(|record| {
                let start = record.derived_start as usize;
                self.schema
                    .derived_attributes
                    .get(start..start + record.derived_len as usize)
            })
            .is_some_and(|names| names.contains(&name))
    }

    fn attribute_record(&self, id: u16) -> Option<&'static AttributeRecord> {
        self.schema.attributes.get(id as usize)
    }

    /// Every explicit attribute in STEP parameter order, root ancestor first.
    pub fn attributes(&self) -> Vec<AttributeDef> {
        let mut lineage: Vec<EntityDef> = self.lineage().collect();
        lineage.reverse();

        let mut attributes = Vec::new();
        for (depth, entity) in lineage.iter().enumerate() {
            for id in entity.own_attributes() {
                let Some(record) = entity.attribute_record(*id) else {
                    continue;
                };
                attributes.push(AttributeDef {
                    name: record.name,
                    optional: record.optional,
                    derived: lineage[depth + 1..]
                        .iter()
                        .any(|subtype| subtype.overrides(record.name)),
                });
            }
        }
        attributes
    }

    /// Number of STEP parameters of this entity.
    pub fn attribute_count(&self) -> usize {
        self.lineage().map(|entity| entity.own_attributes().len()).sum()
    }

    /// Position of `name` in the STEP parameter list. Does not allocate.
    pub fn attribute_index(&self, name: &str) -> Option<usize> {
        let mut after = self.attribute_count();
        for entity in self.lineage() {
            let own = entity.own_attributes();
            after -= own.len();
            let found = own.iter().position(|id| {
                entity
                    .attribute_record(*id)
                    .is_some_and(|record| record.name.eq_ignore_ascii_case(name))
            });
            if let Some(position) = found {
                return Some(after + position);
            }
        }
        None
    }
}
