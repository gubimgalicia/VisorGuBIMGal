//! Element search, checked against a file written for it: every expected id is read off the
//! file text below.

use spatial_tree::{ElementQuery, ModelData, SearchField};
use step_parser::index;

const FILE: &str = r"ISO-10303-21;
HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj00000000000000001',$,'Proyecto',$,$,$,$,$,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,());
#10=IFCWALL('2aBcDeFgHiJkLmNoPqRsTu',$,'Muro exterior',$,$,$,#2,$,$);
#11=IFCWALL('2abcdefghijklmnopqrstu',$,'Muro interior',$,$,$,#2,$,$);
#12=IFCSLAB('3SLAB00000000000000001',$,'Forjado',$,$,$,#2,$,$);
#13=IFCCURTAINWALL('3CW0000000000000000001',$,'Fachada',$,$,$,#2,$,$);
#14=IFCDOOR('1DOOR00000000000000001',$,$,$,$,$,#2,$,$,$,$,$,$);
#15=IFCOPENINGELEMENT('1OPEN00000000000000001',$,'Muro hueco',$,$,$,#2,$,$);
#16=IFCWALL('1NOREP0000000000000001',$,'Muro sin forma',$,$,$,$,$,$);
#17=IFCBEAM('1BEAM00000000000000001',$,'Viga',$,$,$,#2,$,$);
#18=IFCSTAIR('1STAIR0000000000000001',$,'Escalera \X2\00D1\X0\and\X2\00FA\X0\',$,$,$,#2,$,$);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI 60'),$);
#21=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#22=IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCTHERMALTRANSMITTANCEMEASURE(0.35),$);
#23=IFCPROPERTYSET('0PSET00000000000000001',$,'Pset_WallCommon',$,(#20,#21,#22));
#24=IFCRELDEFINESBYPROPERTIES('0REL000000000000000001',$,$,$,(#10),#23);
#25=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);
#26=IFCPROPERTYSET('0PSET00000000000000002',$,'Pset_WallCommon',$,(#25));
#27=IFCRELDEFINESBYPROPERTIES('0REL000000000000000002',$,$,$,(#11),#26);
#30=IFCPROPERTYENUMERATEDVALUE('Status',$,(IFCLABEL('NEW'),IFCLABEL('EXISTING')),$);
#31=IFCPROPERTYBOUNDEDVALUE('Load',$,IFCREAL(2.5),IFCREAL(1.5),$,IFCREAL(2.));
#32=IFCPROPERTYLISTVALUE('Layers',$,(IFCLABEL('Hormigon'),IFCLABEL('Acero')),$);
#33=IFCPROPERTYTABLEVALUE('Curve',$,(IFCREAL(10.),IFCREAL(20.)),(IFCREAL(0.125),IFCREAL(0.25)),$,$,$,$);
#34=IFCPROPERTYSINGLEVALUE('Grade',$,IFCLABEL('C30/37'),$);
#35=IFCCOMPLEXPROPERTY('Concrete',$,$,(#34));
#36=IFCPROPERTYSET('0PSET00000000000000003',$,'Pset_SlabCustom',$,(#30,#31,#32,#33,#35));
#37=IFCRELDEFINESBYPROPERTIES('0REL000000000000000003',$,$,$,(#12),#36);
#40=IFCQUANTITYLENGTH('Width',$,$,12.75,$);
#41=IFCELEMENTQUANTITY('0QTO000000000000000001',$,'Qto_CurtainWallQuantities',$,$,(#40));
#42=IFCRELDEFINESBYPROPERTIES('0REL000000000000000004',$,$,$,(#13),#41);
#43=IFCPROPERTYSINGLEVALUE('Tolerance',$,IFCREAL(1.E-7),$);
#44=IFCPROPERTYSINGLEVALUE('Count',$,IFCINTEGER(3),$);
#45=IFCPROPERTYSET('0PSET00000000000000005',$,'Pset_DoorCustom',$,(#43,#44));
#46=IFCRELDEFINESBYPROPERTIES('0REL000000000000000005',$,$,$,(#14),#45);
#50=IFCPROPERTYSINGLEVALUE('Span',$,IFCLABEL('largo'),$);
#51=IFCPROPERTYSET('0PSET00000000000000006',$,'Pset_BeamCommon',$,(#50));
#52=IFCPROPERTYSINGLEVALUE('Profile',$,IFCLABEL('IPE 300'),$);
#53=IFCPROPERTYSET('0PSET00000000000000007',$,'Pset_BeamType',$,(#52));
#54=IFCBEAMTYPE('0TYPE00000000000000001',$,'Tipo viga',$,$,(#51,#53),$,$,$,.BEAM.);
#55=IFCRELDEFINESBYTYPE('0REL000000000000000006',$,$,$,(#17),#54);
#56=IFCPROPERTYSINGLEVALUE('Span',$,IFCLABEL('corto'),$);
#57=IFCPROPERTYSET('0PSET00000000000000008',$,'Pset_BeamCommon',$,(#56));
#58=IFCRELDEFINESBYPROPERTIES('0REL000000000000000007',$,$,$,(#17),#57);
#60=IFCRELDEFINESBYPROPERTIES('0REL000000000000000008',$,$,$,(#15,#16),#23);
ENDSEC;
END-ISO-10303-21;
";

fn find(field: SearchField, text: &str, property_name: Option<&str>) -> Vec<u32> {
    let file = index(FILE.as_bytes()).unwrap();
    let data = ModelData::open(&file).unwrap();
    data.find_elements(&ElementQuery {
        field,
        text: text.to_string(),
        property_name: property_name.map(str::to_string),
    })
}

use SearchField::{Any, Class, GlobalId, Name, Property};

#[test]
fn names_match_as_substrings_without_case() {
    assert_eq!(find(Name, "muro", None), [10, 11], "not the opening #15, not #16 without shape");
    assert_eq!(find(Name, "MURO", None), [10, 11]);
    assert_eq!(find(Name, "  exterior ", None), [10], "trimmed");
    assert_eq!(find(Name, "ÑANDÚ", None), [18], "decoded \\X2\\ text, Unicode case");
    assert_eq!(find(Name, "viga", None), [17], "the type's name is not the element's");
    assert_eq!(find(Name, "proyecto", None), [] as [u32; 0], "the project has no shape");
}

#[test]
fn classes_match_their_ifc_name() {
    assert_eq!(find(Class, "wall", None), [10, 11, 13]);
    assert_eq!(find(Class, "IfcWall", None), [10, 11]);
    assert_eq!(find(Class, "ifcslab", None), [12]);
    assert_eq!(find(Class, "opening", None), [] as [u32; 0], "openings are never elements");
}

#[test]
fn global_ids_keep_their_case() {
    assert_eq!(find(GlobalId, "2aBcDe", None), [10]);
    assert_eq!(find(GlobalId, "2abcde", None), [11]);
    assert_eq!(find(GlobalId, "BEAM", None), [17]);
    assert_eq!(find(GlobalId, "beam", None), [] as [u32; 0]);
}

#[test]
fn property_values_match_as_the_panel_shows_them() {
    assert_eq!(find(Property, "ei 6", None), [10], "not #15 or #16, which share the set");
    assert_eq!(find(Property, "true", None), [10], "IFCBOOLEAN(.T.)");
    assert_eq!(find(Property, "false", None), [11]);
    assert_eq!(find(Property, "0.35", None), [10]);
    assert_eq!(find(Property, "existing", None), [12], "enumerated");
    assert_eq!(find(Property, "1.5", None), [12], "bounded");
    assert_eq!(find(Property, "acero", None), [12], "list");
    assert_eq!(find(Property, "0.125", None), [12], "table");
    assert_eq!(find(Property, "c30", None), [12], "inside a complex property");
    assert_eq!(find(Property, "12.75", None), [13], "quantity");
    assert_eq!(find(Property, "1e-7", None), [14], "numbers as JavaScript prints them");
    assert_eq!(find(Property, "3", None), [10, 12, 14, 17], "0.35, C30/37, IFCINTEGER(3), IPE 300");
    assert_eq!(find(Property, "3", Some("count")), [14]);
    assert_eq!(find(Property, "ipe", None), [17], "from the type");
    assert_eq!(find(Property, "largo", None), [] as [u32; 0], "the beam's own set overrides it");
    assert_eq!(find(Property, "corto", None), [17]);
    assert_eq!(find(Property, "pset", None), [] as [u32; 0], "set names are not values");
    assert_eq!(find(Property, "isexternal", None), [] as [u32; 0], "property names are not values");
}

#[test]
fn a_property_name_narrows_the_search() {
    assert_eq!(find(Property, "true", Some("isexternal")), [10]);
    assert_eq!(find(Property, "", Some("IsExternal")), [10, 11], "empty text: has the property");
    assert_eq!(find(Property, "true", Some("FireRating")), [] as [u32; 0]);
    assert_eq!(find(Property, "c30", Some("grade")), [12], "a member of a complex property");
    assert_eq!(find(Property, "c30", Some("concrete")), [12], "the complex property itself");
    assert_eq!(find(Property, "", Some(" span ")), [17], "trimmed");
    assert_eq!(find(Property, "", Some("Profile")), [17], "a type's property");
}

#[test]
fn any_looks_everywhere() {
    assert_eq!(find(Any, "muro", None), [10, 11]);
    assert_eq!(find(Any, "slab", None), [12], "class");
    assert_eq!(find(Any, "2aBcDe", None), [10], "GlobalId, with its case");
    assert_eq!(find(Any, "acero", None), [12], "property value");
    assert_eq!(find(Any, "1DOOR", None), [14]);
    assert_eq!(find(Any, "corto", Some("FireRating")), [17], "a property name only narrows Property");
}

#[test]
fn nothing_to_look_for_finds_nothing() {
    for field in [Any, Name, Class, GlobalId, Property] {
        assert_eq!(find(field, "", None), [] as [u32; 0], "{field:?}");
        assert_eq!(find(field, "   ", None), [] as [u32; 0], "{field:?}");
        assert_eq!(find(field, "", Some("  ")), [] as [u32; 0], "{field:?}");
    }
    assert_eq!(find(Name, "", Some("IsExternal")), [] as [u32; 0], "only Property takes a name");
}

#[test]
fn every_real_sample_answers_in_ascending_order() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/samples");
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "ifc") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        let file = index(&bytes).unwrap();
        let data = ModelData::open(&file).unwrap();
        let count = data.summary().element_count;
        for field in [Any, Name, Class, GlobalId, Property] {
            let found = data.find_elements(&ElementQuery {
                field,
                text: "a".to_string(),
                property_name: None,
            });
            assert!(found.windows(2).all(|pair| pair[0] < pair[1]), "{path:?} {field:?}");
            assert!(found.len() <= count, "{path:?} {field:?}");
        }
        let classes = data.find_elements(&ElementQuery {
            field: Class,
            text: "ifc".to_string(),
            property_name: None,
        });
        assert_eq!(classes.len(), count, "{path:?}: every element's class starts with Ifc");
    }
}
