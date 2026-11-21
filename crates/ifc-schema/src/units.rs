//! Project units, resolved from `IfcProject.UnitsInContext`.

use crate::Schema;
use step_parser::{StepIndex, Value};

/// Bounds the walk through conversion-based units, which refer to one another.
const MAX_UNIT_DEPTH: usize = 8;

/// The project's units, as SI scale factors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProjectUnits {
    /// Metres per file length unit.
    pub length: f64,
    /// `false` when the file declares no length unit and metres were assumed.
    pub length_declared: bool,
    /// Radians per file plane angle unit.
    pub plane_angle: f64,
}

impl Default for ProjectUnits {
    fn default() -> Self {
        Self {
            length: 1.0,
            length_declared: false,
            plane_angle: 1.0,
        }
    }
}

fn si_prefix(prefix: &str) -> f64 {
    match prefix {
        "EXA" => 1e18,
        "PETA" => 1e15,
        "TERA" => 1e12,
        "GIGA" => 1e9,
        "MEGA" => 1e6,
        "KILO" => 1e3,
        "HECTO" => 1e2,
        "DECA" => 1e1,
        "DECI" => 1e-1,
        "CENTI" => 1e-2,
        "MILLI" => 1e-3,
        "MICRO" => 1e-6,
        "NANO" => 1e-9,
        "PICO" => 1e-12,
        "FEMTO" => 1e-15,
        "ATTO" => 1e-18,
        _ => 1.0,
    }
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Real(number) => Some(*number),
        Value::Integer(number) => Some(*number as f64),
        Value::Typed { value, .. } => number(value),
        _ => None,
    }
}

/// The `(unit type, SI factor)` of a named unit.
pub fn named_unit(file: &StepIndex<'_>, schema: &'static Schema, id: u32) -> Option<(String, f64)> {
    resolve_unit(file, schema, id, 0)
}

fn resolve_unit(
    file: &StepIndex<'_>,
    schema: &'static Schema,
    id: u32,
    depth: usize,
) -> Option<(String, f64)> {
    if depth >= MAX_UNIT_DEPTH {
        return None;
    }
    let entity = file.decode(id).ok()?;
    let def = schema.entity(&entity.type_name)?;
    let attribute = |name: &str| entity.params.get(def.attribute_index(name)?);
    let Some(Value::Enum(unit_type)) = attribute("UnitType") else {
        return None;
    };

    if def.is_a("IfcSIUnit") {
        let scale = match attribute("Prefix") {
            Some(Value::Enum(prefix)) => si_prefix(prefix),
            _ => 1.0,
        };
        return Some((unit_type.clone(), scale));
    }

    if def.is_a("IfcConversionBasedUnit") {
        let Some(Value::Ref(measure_id)) = attribute("ConversionFactor") else {
            return None;
        };
        let measure = file.decode(*measure_id).ok()?;
        let measure_def = schema.entity(&measure.type_name)?;
        let value = number(measure.params.get(measure_def.attribute_index("ValueComponent")?)?)?;
        let Some(Value::Ref(base)) =
            measure.params.get(measure_def.attribute_index("UnitComponent")?)
        else {
            return None;
        };
        let (_, base_scale) = resolve_unit(file, schema, *base, depth + 1)?;
        return Some((unit_type.clone(), value * base_scale));
    }
    None
}

/// Reads the project units. Whatever the file does not declare keeps its SI default.
pub fn project_units(file: &StepIndex<'_>, schema: &'static Schema) -> ProjectUnits {
    let mut units = ProjectUnits::default();
    let Some(project_id) = file.ids_by_type("IFCPROJECT").next() else {
        return units;
    };
    let Ok(project) = file.decode(project_id) else {
        return units;
    };
    let assignment = schema
        .entity("IfcProject")
        .and_then(|def| def.attribute_index("UnitsInContext"))
        .and_then(|index| project.params.get(index));
    let Some(Value::Ref(assignment_id)) = assignment else {
        return units;
    };
    let Ok(assignment) = file.decode(*assignment_id) else {
        return units;
    };
    let Some(Value::List(list)) = assignment.params.first() else {
        return units;
    };

    for unit in list {
        let Value::Ref(id) = unit else { continue };
        let Some((unit_type, scale)) = resolve_unit(file, schema, *id, 0) else {
            continue;
        };
        if !(scale.is_finite() && scale > 0.0) {
            continue;
        }
        match unit_type.as_str() {
            "LENGTHUNIT" => {
                units.length = scale;
                units.length_declared = true;
            }
            "PLANEANGLEUNIT" => units.plane_angle = scale,
            _ => {}
        }
    }
    units
}
