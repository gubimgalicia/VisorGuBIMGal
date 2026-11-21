use std::panic::{AssertUnwindSafe, catch_unwind};

use step_parser::index;

const SAMPLE: &[u8] = br#"ISO-10303-21;
HEADER;
/* a comment with #999= HIDDEN(); and a ; semicolon */
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('// name //','2020-10-28T18:06:27',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCORGANIZATION($,'Autodesk Revit 2021 (ENU)',$,$,$);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#2,$,$);
#5=IFCPROPERTYSINGLEVALUE('Label',$,IFCLABEL('it''s a value'),$);
#6=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.0174532925199433),#3);
#7=IFCWALL('2nxdYR2RHCDBiKJulbA_QU',#1,'Wall (1); #2',$,(#2,#3),#4,$,.ELEMENT.,$);
#8=IFCRELAGGREGATES('id',#1,$,$,(#1),(#2,#3,#4,#5,#6,#7));
#9=IFCBINARYTEST("0FF",'caf\X2\00E9\X0\',.T.,*);
ENDSEC;
END-ISO-10303-21;
"#;

fn exercise(bytes: &[u8]) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let index = match index(bytes) {
            Ok(index) => index,
            Err(_) => return,
        };
        for entity in index.entities() {
            let _ = index.decode(entity.id);
        }
    }));
    assert!(outcome.is_ok(), "index/decode panicked on a robustness case");
}

#[test]
fn every_byte_length_prefix_is_panic_free() {
    for len in 0..=SAMPLE.len() {
        let prefix = match SAMPLE.get(..len) {
            Some(prefix) => prefix,
            None => continue,
        };
        exercise(prefix);
    }
}

#[test]
fn every_single_byte_corruption_is_panic_free() {
    let replacements = [0x00u8, b'\'', b'"', b'\\', b'(', b')', b';', b'#', b'.', 0xFF];

    for offset in 0..SAMPLE.len() {
        for replacement in replacements {
            let mut corrupted = SAMPLE.to_vec();
            if let Some(byte) = corrupted.get_mut(offset) {
                *byte = replacement;
            }
            exercise(&corrupted);
        }
    }
}

#[test]
fn truncation_inside_each_entity_is_panic_free() {
    let index = index(SAMPLE).unwrap();
    for entity in index.entities() {
        for end in entity.start..entity.end {
            let prefix = match SAMPLE.get(..end) {
                Some(prefix) => prefix,
                None => continue,
            };
            exercise(prefix);
        }
    }
}
