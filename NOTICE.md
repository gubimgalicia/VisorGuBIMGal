# Notices

## Project licence

The Rust crates in `crates/` are offered under `MIT OR Apache-2.0`, except for the third-party material listed below. The licence of the rest of this repository is set by GuBIM Galicia, see `README.md`.

## buildingSMART IFC schemas

`crates/ifc-schema/src/tables.rs`, and any build that compiles it, contains entity names, attribute names, attribute order, inheritance and optional and abstract markers taken from these publications:

| Schema | Publication |
|---|---|
| IFC2X3 TC1 | Copyright buildingSMART International Ltd., 1996-2020. All rights reserved. |
| IFC4 ADD2 TC1 | Copyright buildingSMART International Limited, 1996-2020. |
| IFC4X3 ADD2 (IFC 4.3.2) | Copyright buildingSMART International Limited. Licensed under [CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/). |

**That material belongs to buildingSMART International Limited and is not covered by this project's licence.** Nothing here grants any right in it.

The tables are a machine translation of those names and structures into Rust, used only to read files in the IFC format. They do not change the specification. Descriptions, rules and functions from the schemas are not included.

The material is provided as is. buildingSMART International Limited gives no warranty for it and is not liable for its use.

## Trademarks

buildingSMART®, Home of openBIM®, openBIM® and IFC™ are (registered) trademarks of buildingSMART International Limited. This project is independent, and is not affiliated with, certified or endorsed by buildingSMART.
