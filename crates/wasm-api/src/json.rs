//! A small JSON writer for the infrequent, non-geometry data crossing the WASM boundary.

pub trait ToJson {
    fn write_json(&self, out: &mut String);
}

/// Serialises a value to a new string.
pub fn to_json<T: ToJson + ?Sized>(value: &T) -> String {
    let mut out = String::new();
    value.write_json(&mut out);
    out
}

impl ToJson for str {
    fn write_json(&self, out: &mut String) {
        out.push('"');
        for character in self.chars() {
            match character {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                control if control < '\u{20}' => {
                    out.push_str(&format!("\\u{:04x}", control as u32));
                }
                other => out.push(other),
            }
        }
        out.push('"');
    }
}

impl ToJson for String {
    fn write_json(&self, out: &mut String) {
        self.as_str().write_json(out);
    }
}

/// JSON has no infinities or NaN, and a file may contain anything: those become `null`.
impl ToJson for f64 {
    fn write_json(&self, out: &mut String) {
        if self.is_finite() {
            out.push_str(&self.to_string());
        } else {
            out.push_str("null");
        }
    }
}

impl ToJson for u32 {
    fn write_json(&self, out: &mut String) {
        out.push_str(&self.to_string());
    }
}

impl ToJson for usize {
    fn write_json(&self, out: &mut String) {
        out.push_str(&self.to_string());
    }
}

impl<T: ToJson + ?Sized> ToJson for &T {
    fn write_json(&self, out: &mut String) {
        (**self).write_json(out);
    }
}

impl<T: ToJson> ToJson for [T] {
    fn write_json(&self, out: &mut String) {
        out.push('[');
        for (index, item) in self.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            item.write_json(out);
        }
        out.push(']');
    }
}

impl<T: ToJson> ToJson for Vec<T> {
    fn write_json(&self, out: &mut String) {
        self.as_slice().write_json(out);
    }
}

impl<T: ToJson, const N: usize> ToJson for [T; N] {
    fn write_json(&self, out: &mut String) {
        self.as_slice().write_json(out);
    }
}

/// Writes one JSON object, field by field.
pub struct Object<'a> {
    out: &'a mut String,
    empty: bool,
}

impl<'a> Object<'a> {
    pub fn new(out: &'a mut String) -> Self {
        out.push('{');
        Self { out, empty: true }
    }

    pub fn field<T: ToJson + ?Sized>(mut self, name: &str, value: &T) -> Self {
        if !self.empty {
            self.out.push(',');
        }
        self.empty = false;
        name.write_json(self.out);
        self.out.push(':');
        value.write_json(self.out);
        self
    }

    /// An absent optional field is left out, as the TypeScript types expect.
    pub fn some<T: ToJson>(self, name: &str, value: &Option<T>) -> Self {
        match value {
            Some(value) => self.field(name, value),
            None => self,
        }
    }

    pub fn end(self) {
        self.out.push('}');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_json_requires() {
        assert_eq!(to_json("a\"b\\c\n\u{1}é"), r#""a\"b\\c\n\u0001é""#);
    }

    #[test]
    fn non_finite_numbers_become_null() {
        assert_eq!(to_json(&[1.5, f64::NAN, f64::INFINITY]), "[1.5,null,null]");
    }

    #[test]
    fn absent_fields_are_left_out() {
        let mut out = String::new();
        Object::new(&mut out)
            .some("a", &None::<u32>)
            .field("b", &1_u32)
            .some("c", &Some(2_u32))
            .end();
        assert_eq!(out, r#"{"b":1,"c":2}"#);
    }
}
