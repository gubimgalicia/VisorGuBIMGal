//! IFC geometry evaluation: placements, solids, meshes and booleans. Owner: Claude (T-030..T-032).

pub mod csg;
mod curves;
pub mod hash;
pub mod mesh;
pub mod model;
mod nurbs;
mod solids;

pub use csg::{CsgError, intersect, seal, subtract, subtract_all, union};
pub use mesh::Mesh;
pub use model::{Diagnostic, ElementGeometry, ElementMesh, InstanceOf, ModelEvaluator, UnsupportedSchema};
