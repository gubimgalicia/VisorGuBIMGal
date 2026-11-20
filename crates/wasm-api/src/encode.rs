//! JSON shapes of `src/domain/kernel/KernelPort.ts` and `src/domain/models/ModelRecord.ts`.

use crate::json::{Object, ToJson, to_json};
use ifc_geometry::Diagnostic as GeometryDiagnostic;
use std::collections::BTreeMap;
use spatial_tree::{
    AttributeValue, CoordinateReference, Diagnostic, ElementDetails, MaterialConstituent,
    MaterialInfo, MaterialLayer, MaterialProfile, ModelSummary, PropertyItem, PropertySet,
    PropertyValue, SpatialElement, SpatialNode, SpatialTree, TypeObjectRef,
};

/// Notes that change nothing the user sees. Everything else is worth a warning.
pub(crate) fn severity(code: &str) -> &'static str {
    match code {
        "map-scale-default" => "info",
        _ => "warning",
    }
}

impl ToJson for Diagnostic {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("severity", severity(self.code))
            .field("code", self.code)
            .field("message", &self.message)
            .end();
    }
}

impl ToJson for GeometryDiagnostic {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("severity", severity(self.code))
            .field("code", self.code)
            .field("message", &self.message)
            .some("expressId", &self.express_id)
            .end();
    }
}

impl ToJson for CoordinateReference {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .some("crsId", &self.crs_id)
            .field("source", self.source)
            .some("localToMap", &self.local_to_map)
            .some("verticalDatum", &self.vertical_datum)
            .field("confidence", self.confidence)
            .some("latLng", &self.lat_lng)
            .some("crsName", &self.crs_name)
            .some("mapProjection", &self.map_projection)
            .some("mapZone", &self.map_zone)
            .some("mapUnit", &self.map_unit)
            .some("geodeticDatum", &self.geodetic_datum)
            .some("trueNorth", &self.true_north)
            .end();
    }
}

impl ToJson for ModelSummary {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("schema", self.schema)
            .field("schemaIdentifier", &self.schema_identifier)
            .field("entityCount", &self.entity_count)
            .field("elementCount", &self.element_count)
            .field("lengthUnitScale", &self.length_unit_scale)
            .field("lengthUnitSource", if self.length_declared { "ifc" } else { "default" })
            .field("coordinateReference", &self.coordinate_reference)
            .field("diagnostics", &self.diagnostics)
            .end();
    }
}

impl ToJson for SpatialElement {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("expressId", &self.express_id)
            .field("type", &self.type_name)
            .some("name", &self.name)
            .field("via", if self.referenced { "references" } else { "contains" })
            .end();
    }
}

impl ToJson for SpatialNode {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("expressId", &self.express_id)
            .field("type", &self.type_name)
            .some("name", &self.name)
            .some("longName", &self.long_name)
            .some("elevation", &self.elevation)
            .some("level", &self.level)
            .field("children", &self.children)
            .field("elements", &self.elements)
            .end();
    }
}

impl ToJson for SpatialTree {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("root", &self.root)
            .field("unassigned", &self.unassigned)
            .end();
    }
}

impl ToJson for AttributeValue {
    fn write_json(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Number(number) => number.write_json(out),
            Self::Text(text) => text.write_json(out),
            Self::Ref(id) => Object::new(out).field("ref", id).end(),
            Self::Enum(name) => Object::new(out).field("enum", name).end(),
            Self::Typed { type_name, value } => Object::new(out)
                .field("type", type_name)
                .field("value", value.as_ref())
                .end(),
            Self::List(items) => items.write_json(out),
        }
    }
}

/// A `PropertyScalar`: what a property shows, stripped of its IFC typing.
struct Scalar<'a>(&'a AttributeValue);

impl ToJson for Scalar<'_> {
    fn write_json(&self, out: &mut String) {
        match self.0 {
            AttributeValue::Null => out.push_str("null"),
            AttributeValue::Number(number) => number.write_json(out),
            AttributeValue::Text(text) => text.write_json(out),
            AttributeValue::Enum(name) => match name.as_str() {
                "T" => out.push_str("true"),
                "F" => out.push_str("false"),
                "U" => out.push_str("null"),
                other => other.write_json(out),
            },
            AttributeValue::Ref(id) => format!("#{id}").write_json(out),
            AttributeValue::Typed { value, .. } => Scalar(value).write_json(out),
            AttributeValue::List(items) => joined(items).write_json(out),
        }
    }
}

fn scalars(values: &[AttributeValue]) -> Vec<Scalar<'_>> {
    values.iter().map(Scalar).collect()
}

fn text(value: &AttributeValue) -> String {
    match value {
        AttributeValue::Null => String::new(),
        AttributeValue::Number(number) => number.to_string(),
        AttributeValue::Text(text) => text.clone(),
        AttributeValue::Enum(name) => name.clone(),
        AttributeValue::Ref(id) => format!("#{id}"),
        AttributeValue::Typed { value, .. } => text(value),
        AttributeValue::List(items) => joined(items),
    }
}

fn joined(values: &[AttributeValue]) -> String {
    values.iter().map(text).collect::<Vec<_>>().join(", ")
}

/// The display value of a property. `structured` keeps the detail.
fn display(value: &PropertyValue) -> String {
    match value {
        PropertyValue::Single(value) => text(value),
        PropertyValue::Enumerated(values) | PropertyValue::List(values) => joined(values),
        PropertyValue::Bounded { lower, upper, set_point } => {
            let bound = |value: &Option<AttributeValue>| value.as_ref().map(text).unwrap_or_default();
            match set_point {
                Some(point) => format!("{} ({} .. {})", text(point), bound(lower), bound(upper)),
                None => format!("{} .. {}", bound(lower), bound(upper)),
            }
        }
        PropertyValue::Table { defining, .. } => format!("{} filas", defining.len()),
        PropertyValue::Complex(items) => format!("{} propiedades", items.len()),
    }
}

struct Structured<'a>(&'a PropertyValue);

impl ToJson for Structured<'_> {
    fn write_json(&self, out: &mut String) {
        match self.0 {
            PropertyValue::Single(value) => Object::new(out)
                .field("kind", "single")
                .field("value", &Scalar(value))
                .end(),
            PropertyValue::Enumerated(values) => Object::new(out)
                .field("kind", "enumerated")
                .field("values", &scalars(values))
                .end(),
            PropertyValue::List(values) => Object::new(out)
                .field("kind", "list")
                .field("values", &scalars(values))
                .end(),
            PropertyValue::Bounded { lower, upper, set_point } => Object::new(out)
                .field("kind", "bounded")
                .some("lower", &lower.as_ref().map(Scalar))
                .some("upper", &upper.as_ref().map(Scalar))
                .some("setPoint", &set_point.as_ref().map(Scalar))
                .end(),
            PropertyValue::Table { defining, defined } => Object::new(out)
                .field("kind", "table")
                .field("defining", &scalars(defining))
                .field("defined", &scalars(defined))
                .end(),
            PropertyValue::Complex(items) => Object::new(out)
                .field("kind", "complex")
                .field("properties", items)
                .end(),
        }
    }
}

impl ToJson for PropertyItem {
    fn write_json(&self, out: &mut String) {
        let object = Object::new(out).field("name", &self.name);
        let object = match &self.value {
            PropertyValue::Single(value) => object.field("value", &Scalar(value)),
            other => object
                .field("value", &display(other))
                .field("structured", &Structured(other)),
        };
        object
            .some("type", &self.value_type)
            .field("kind", if self.is_quantity { "quantity" } else { "property" })
            .some("unit", &self.unit)
            .some("methodOfMeasurement", &self.method_of_measurement)
            .end();
    }
}

impl ToJson for PropertySet {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("name", &self.name)
            .some("globalId", &self.global_id)
            .field("properties", &self.properties)
            .end();
    }
}

/// What the properties panel shows for one single value: typed values are stripped down to their
/// scalar, `.T.` and `.F.` become `true` and `false`, and an absent or unknown value shows nothing.
fn scalar_text(value: &AttributeValue) -> Option<String> {
    Some(match value {
        AttributeValue::Null => return None,
        AttributeValue::Number(number) if !number.is_finite() => return None,
        AttributeValue::Number(number) => number.to_string(),
        AttributeValue::Text(text) => text.clone(),
        AttributeValue::Enum(name) => match name.as_str() {
            "T" => "true".to_string(),
            "F" => "false".to_string(),
            "U" => return None,
            other => other.to_string(),
        },
        AttributeValue::Ref(id) => format!("#{id}"),
        AttributeValue::Typed { value, .. } => return scalar_text(value),
        AttributeValue::List(items) => joined(items),
    })
}

/// The cell text of one property, unit included exactly as the properties panel joins it.
fn property_text(item: &PropertyItem) -> String {
    let mut text = match &item.value {
        PropertyValue::Single(value) => match scalar_text(value) {
            Some(text) => text,
            None => return "-".to_string(),
        },
        other => display(other),
    };
    if let Some(unit) = &item.unit {
        text.push(' ');
        text.push_str(unit);
    }
    text
}

/// One element of `elementSnapshotsJson`: the properties panel's values, keyed by set and name.
struct Snapshot<'a>(&'a ElementDetails);

impl ToJson for Snapshot<'_> {
    fn write_json(&self, out: &mut String) {
        let details = self.0;
        Object::new(out)
            .field("globalId", details.global_id.as_deref().unwrap_or_default())
            .field("expressId", &details.express_id)
            .field("ifcType", &details.type_name)
            .some("name", &details.name)
            .field("properties", &SnapshotProperties(&details.property_sets))
            .end();
    }
}

/// A JSON object, so a repeated key keeps the value `element_details` reaches last.
struct SnapshotProperties<'a>(&'a [PropertySet]);

impl ToJson for SnapshotProperties<'_> {
    fn write_json(&self, out: &mut String) {
        let mut values = BTreeMap::new();
        for set in self.0 {
            for item in &set.properties {
                values.insert(format!("{}.{}", set.name, item.name), property_text(item));
            }
        }
        let mut object = Object::new(out);
        for (key, value) in &values {
            object = object.field(key, value);
        }
        object.end();
    }
}

/// The snapshots for `diffModels`, ascending by expressId as the geometry stream gives them.
pub(crate) fn snapshots_json(details: &[ElementDetails]) -> String {
    to_json(&details.iter().map(Snapshot).collect::<Vec<_>>())
}

/// The contract's layer has one label. The material says more than the layer's own name.
impl ToJson for MaterialLayer {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .some("name", &self.material.as_ref().or(self.name.as_ref()))
            .some("thickness", &self.thickness)
            .end();
    }
}

impl ToJson for MaterialProfile {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .some("name", &self.name)
            .some("material", &self.material)
            .end();
    }
}

impl ToJson for MaterialConstituent {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .some("name", &self.name)
            .some("material", &self.material)
            .some("fraction", &self.fraction)
            .end();
    }
}

impl ToJson for MaterialInfo {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("kind", self.kind)
            .some("name", &self.name)
            .field("layers", &self.layers)
            .field("profiles", &self.profiles)
            .field("constituents", &self.constituents)
            .field("source", if self.from_instance { "instance" } else { "type" })
            .end();
    }
}

impl ToJson for TypeObjectRef {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("expressId", &self.express_id)
            .field("type", &self.type_name)
            .some("name", &self.name)
            .some("globalId", &self.global_id)
            .end();
    }
}

/// `attributes` is a record keyed by EXPRESS name, not a list of pairs.
struct Attributes<'a>(&'a [(String, AttributeValue)]);

impl ToJson for Attributes<'_> {
    fn write_json(&self, out: &mut String) {
        let mut object = Object::new(out);
        for (name, value) in self.0 {
            object = object.field(name, value);
        }
        object.end();
    }
}

impl ToJson for ElementDetails {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("expressId", &self.express_id)
            .some("globalId", &self.global_id)
            .field("type", &self.type_name)
            .some("name", &self.name)
            .field("attributes", &Attributes(&self.attributes))
            .field("propertySets", &self.property_sets)
            .some("typeObject", &self.type_object)
            .field("materials", &self.materials)
            .end();
    }
}

struct Point([f64; 3]);

impl ToJson for Point {
    fn write_json(&self, out: &mut String) {
        let [x, y, z] = self.0;
        Object::new(out).field("x", &x).field("y", &y).field("z", &z).end();
    }
}

struct Bounds([f64; 3], [f64; 3]);

impl ToJson for Bounds {
    fn write_json(&self, out: &mut String) {
        Object::new(out)
            .field("min", &Point(self.0))
            .field("max", &Point(self.1))
            .end();
    }
}

pub fn diagnostics_json(diagnostics: &[&GeometryDiagnostic]) -> String {
    to_json(diagnostics)
}

/// The closing event of a geometry stream, without its `type`.
pub fn complete_json(
    mesh_count: u32,
    bounds: Option<([f64; 3], [f64; 3])>,
    diagnostics: &[&GeometryDiagnostic],
) -> String {
    let mut out = String::new();
    Object::new(&mut out)
        .field("meshCount", &mesh_count)
        .some("bounds", &bounds.map(|(min, max)| Bounds(min, max)))
        .field("diagnostics", diagnostics)
        .end();
    out
}
