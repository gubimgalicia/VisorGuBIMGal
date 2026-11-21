# Generating the schema tables

`src/tables.rs` is generated. It holds entity names, attribute names, inheritance and attribute order, and it is used to read IFC files. The EXPRESS sources are not part of this repository.

```text
cargo run -p ifc-schema --example generate -- \
  --ifc2x3 IFC2X3_TC1.exp \
  --ifc4 IFC4.exp \
  --ifc4x3 IFC4X3_ADD2.exp \
  --out crates/ifc-schema/src/tables.rs
```

## Sources and attribution

| Schema | Notice in or with the source file |
|---|---|
| IFC2X3 TC1 | Copyright buildingSMART International Ltd., 1996-2020. All rights reserved. |
| IFC4 ADD2 TC1 | Copyright buildingSMART International Limited, 1996-2020. May be used in software development, or translated into another computer language, without prior written consent, provided that full attribution is given. |
| IFC4X3 ADD2 | Copyright buildingSMART International. Licensed under CC BY-ND 4.0, from `buildingSMART/IFC4.x-development`. |

The EXPRESS files are published by buildingSMART International. This project is not affiliated with or endorsed by buildingSMART.

## Rules for this file

The notices differ, and the IFC2X3 one is the most restrictive. D-011 in `COORDINATION.md` records why the tables are used anyway. These rules follow from it:

- The tables hold only what is needed to read a file: names, order, inheritance and flags. Never add descriptions, rules or functions.
- Names are never edited by hand. Regenerate instead.
- The tables are not covered by the project licence. `NOTICE.md` says so and must travel with any build that includes them.
- `.exp` files are never committed.
