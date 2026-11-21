"""Author units-mm-georef.ifc with Blender 5.0 + IfcOpenShell 0.8.4.

Design (IFC project length unit: millimetre; expected values in metres):
  building:  a one-storey small building, external footprint 8.00 x 5.00 m,
             wall thickness 0.25 m and wall height 3.00 m.
  slabs:     floor slab 8.00 x 5.00 x 0.20 m at z = 0.00..0.20 m;
             roof slab 8.40 x 5.40 x 0.20 m at z = 3.20..3.40 m
             (0.20 m overhang on every side).
  walls:     four axis-aligned IfcWall boxes 3.00 m high on top of the
             floor slab: south and north walls 8.00 m long, west and east
             walls 4.50 m long, all 0.25 m thick.  The volumes do not overlap.
  georef:    IfcProjectedCRS EPSG:25829 (ETRS89 / UTM zone 29N) with an
             IfcMapConversion at easting 536500, northing 4747500, height
             260, no rotation and Scale = 0.001.  Local model coordinates
             are millimetres, so Scale converts them to CRS metres:
             map_easting  = 536500 + 0.001 * local_x_mm
                          = 536500 + local_x_m
             map_northing = 4747500 + local_y_m
             map_height   = 260 + local_z_m.
             XAxisAbscissa = 1 and XAxisOrdinate = 0 mean local +X is map
             east and local +Y is map north.

All geometry is a rectangular box, so volumes and bounding boxes below are
closed-form products and sums of the design dimensions.  IfcOpenShell is used
only to write the file, never to obtain geometry values.  The only unit
conversion in the expected values is millimetres -> metres (divide by 1000),
which is exactly the same factor as IfcMapConversion.Scale here.
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

# The alignment API needs shapely, which Blender's Python lacks: name a folder that has it.
if "GUBIM_BLENDER_PY" in os.environ:
    sys.path.insert(0, os.environ["GUBIM_BLENDER_PY"])

import ifcopenshell
import ifcopenshell.api.context
import ifcopenshell.api.georeference
import ifcopenshell.api.project
import ifcopenshell.api.root
import ifcopenshell.api.unit

NAME = "units-mm-georef"
SCHEMA = "IFC4X3_ADD2"

# ---------------------------------------------------------------- design ----
# IFC lengths are millimetres; the expected JSON reports metres.
MM = 0.001

FOOTPRINT_X = 8000.0        # mm
FOOTPRINT_Y = 5000.0        # mm
WALL_THICKNESS = 250.0      # mm
WALL_HEIGHT = 3000.0        # mm
SLAB_THICKNESS = 200.0      # mm
ROOF_OVERHANG = 200.0       # mm
FLOOR_TOP = SLAB_THICKNESS  # 200 mm
ROOF_BOTTOM = FLOOR_TOP + WALL_HEIGHT  # 3200 mm
ROOF_X = FOOTPRINT_X + 2.0 * ROOF_OVERHANG  # 8400 mm
ROOF_Y = FOOTPRINT_Y + 2.0 * ROOF_OVERHANG  # 5400 mm
EASTING = 536500.0          # m
NORTHING = 4747500.0        # m
ORTHOGONAL_HEIGHT = 260.0   # m
SCALE = 0.001               # local millimetres -> CRS metres
CRS_NAME = "EPSG:25829"

# (name, ifc class, predefined type, centre x, centre y, base z,
#  size x, size y, size z) in millimetres; every solid is a box.
ELEMENTS = [
    ("guBIM floor slab", "IfcSlab", "FLOOR",
     FOOTPRINT_X / 2.0, FOOTPRINT_Y / 2.0, 0.0,
     FOOTPRINT_X, FOOTPRINT_Y, SLAB_THICKNESS),
    ("guBIM south wall", "IfcWall", "SOLIDWALL",
     FOOTPRINT_X / 2.0, WALL_THICKNESS / 2.0, FLOOR_TOP,
     FOOTPRINT_X, WALL_THICKNESS, WALL_HEIGHT),
    ("guBIM north wall", "IfcWall", "SOLIDWALL",
     FOOTPRINT_X / 2.0, FOOTPRINT_Y - WALL_THICKNESS / 2.0, FLOOR_TOP,
     FOOTPRINT_X, WALL_THICKNESS, WALL_HEIGHT),
    ("guBIM west wall", "IfcWall", "SOLIDWALL",
     WALL_THICKNESS / 2.0, FOOTPRINT_Y / 2.0, FLOOR_TOP,
     WALL_THICKNESS, FOOTPRINT_Y - 2.0 * WALL_THICKNESS, WALL_HEIGHT),
    ("guBIM east wall", "IfcWall", "SOLIDWALL",
     FOOTPRINT_X - WALL_THICKNESS / 2.0, FOOTPRINT_Y / 2.0, FLOOR_TOP,
     WALL_THICKNESS, FOOTPRINT_Y - 2.0 * WALL_THICKNESS, WALL_HEIGHT),
    ("guBIM roof slab", "IfcSlab", "ROOF",
     FOOTPRINT_X / 2.0, FOOTPRINT_Y / 2.0, ROOF_BOTTOM,
     ROOF_X, ROOF_Y, SLAB_THICKNESS),
]

# --------------------------------------------------------- deterministic ---
_IFC64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"


def deterministic_guid(seed):
    """Stable 22-character IfcGloballyUniqueId derived from a seed string."""
    n = int.from_bytes(hashlib.sha256(seed.encode("utf-8")).digest()[:16], "big")
    out = []
    for _ in range(22):
        out.append(_IFC64[n & 63])
        n >>= 6
    return "".join(reversed(out))


def make_deterministic(model):
    for entity in sorted(model, key=lambda e: e.id()):
        if entity.is_a("IfcRoot"):
            entity.GlobalId = deterministic_guid(
                "%s:%d:%s" % (NAME, entity.id(), entity.is_a()))


# ------------------------------------------------------------ authoring ----
def cartesian(model, values):
    return model.create_entity(
        "IfcCartesianPoint", Coordinates=tuple(float(v) for v in values))


def direction(model, ratios):
    return model.create_entity(
        "IfcDirection", DirectionRatios=tuple(float(r) for r in ratios))


def relation(model, ifc_class, **attrs):
    return model.create_entity(
        ifc_class, GlobalId="0000000000000000000000", OwnerHistory=None,
        Name=None, Description=None, **attrs)


def local_placement(model, relative_to, location=(0.0, 0.0, 0.0)):
    axes = model.create_entity(
        "IfcAxis2Placement3D",
        Location=cartesian(model, location),
        Axis=direction(model, (0.0, 0.0, 1.0)),
        RefDirection=direction(model, (1.0, 0.0, 0.0)))
    return model.create_entity(
        "IfcLocalPlacement", PlacementRelTo=relative_to, RelativePlacement=axes)


def box_solid(model, dx, dy, dz):
    """Extruded rectangle centred on the placement, 0..dz above it."""
    profile = model.create_entity(
        "IfcRectangleProfileDef", ProfileType="AREA",
        Position=model.create_entity(
            "IfcAxis2Placement2D",
            Location=cartesian(model, (0.0, 0.0)),
            RefDirection=direction(model, (1.0, 0.0))),
        XDim=float(dx), YDim=float(dy))
    return model.create_entity(
        "IfcExtrudedAreaSolid", SweptArea=profile,
        Position=model.create_entity(
            "IfcAxis2Placement3D",
            Location=cartesian(model, (0.0, 0.0, 0.0)),
            Axis=direction(model, (0.0, 0.0, 1.0)),
            RefDirection=direction(model, (1.0, 0.0, 0.0))),
        ExtrudedDirection=direction(model, (0.0, 0.0, 1.0)),
        Depth=float(dz))


def add_representation(model, context, product, solid):
    shape = model.create_entity(
        "IfcShapeRepresentation", ContextOfItems=context,
        RepresentationIdentifier="Body", RepresentationType="SweptSolid",
        Items=[solid])
    product.Representation = model.create_entity(
        "IfcProductDefinitionShape", Representations=[shape])
    return shape


def element(model, storey, ifc_class, name, predefined_type,
            cx, cy, base_z, dx, dy, dz, context):
    product = ifcopenshell.api.root.create_entity(
        model, ifc_class=ifc_class, name=name,
        predefined_type=predefined_type)
    product.ObjectPlacement = local_placement(
        model, storey.ObjectPlacement, location=(cx, cy, base_z))
    solid = box_solid(model, dx, dy, dz)
    add_representation(model, context, product, solid)
    return product


def build(path):
    model = ifcopenshell.api.project.create_file(version=SCHEMA)

    project = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcProject", name="guBIM millimetre georeferenced building")
    length_unit = ifcopenshell.api.unit.add_si_unit(
        model, unit_type="LENGTHUNIT", prefix="MILLI")
    area_unit = ifcopenshell.api.unit.add_si_unit(
        model, unit_type="AREAUNIT", prefix=None)
    volume_unit = ifcopenshell.api.unit.add_si_unit(
        model, unit_type="VOLUMEUNIT", prefix=None)
    angle_unit = ifcopenshell.api.unit.add_si_unit(
        model, unit_type="PLANEANGLEUNIT", prefix=None)
    units = ifcopenshell.api.unit.assign_unit(
        model, units=[length_unit, area_unit, volume_unit, angle_unit])
    # assign_unit iterates an unordered collection; fix the order so the
    # serialised file is byte-identical on every run.
    units.Units = (length_unit, area_unit, volume_unit, angle_unit)

    # The georeferencing API uses the model geometric context as the source
    # CRS, so the context must exist before add_georeferencing is called.
    model_ctx = ifcopenshell.api.context.add_context(
        model, context_type="Model")
    body = ifcopenshell.api.context.add_context(
        model, context_type="Model", context_identifier="Body",
        target_view="MODEL_VIEW", parent=model_ctx)

    site = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcSite", name="guBIM site")
    site.ObjectPlacement = local_placement(model, None)
    building = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcBuilding", name="guBIM building")
    building.ObjectPlacement = local_placement(model, site.ObjectPlacement)
    storey = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcBuildingStorey", name="guBIM ground floor")
    storey.Elevation = 0.0
    storey.ObjectPlacement = local_placement(
        model, building.ObjectPlacement, location=(0.0, 0.0, 0.0))

    # Aggregation is authored explicitly: the API helper recalculates
    # placements and allocates their points in set order, which would make
    # reruns non-identical.  Our placements are already correct.
    relation(model, "IfcRelAggregates",
             RelatingObject=project, RelatedObjects=[site])
    relation(model, "IfcRelAggregates",
             RelatingObject=site, RelatedObjects=[building])
    relation(model, "IfcRelAggregates",
             RelatingObject=building, RelatedObjects=[storey])

    products = []
    for (name, ifc_class, ptype, cx, cy, z0, dx, dy, dz) in ELEMENTS:
        products.append(element(
            model, storey, ifc_class, name, ptype,
            cx, cy, z0, dx, dy, dz, body))

    relation(model, "IfcRelContainedInSpatialStructure",
             RelatedElements=products, RelatingStructure=storey)

    map_unit = ifcopenshell.api.unit.add_si_unit(
        model, unit_type="LENGTHUNIT", prefix=None)
    ifcopenshell.api.georeference.add_georeferencing(model)
    ifcopenshell.api.georeference.edit_georeferencing(
        model,
        projected_crs={
            "Name": CRS_NAME,
            "GeodeticDatum": "ETRS89",
            "MapProjection": "UTM zone 29N",
            "MapZone": "29N",
            "MapUnit": map_unit,
        },
        coordinate_operation={
            "Eastings": EASTING,
            "Northings": NORTHING,
            "OrthogonalHeight": ORTHOGONAL_HEIGHT,
            "XAxisAbscissa": 1.0,
            "XAxisOrdinate": 0.0,
            "Scale": SCALE,
        })

    # Stable header: no personal data, no local paths, fixed timestamp.
    model.header.file_name.name = NAME + ".ifc"
    model.header.file_name.time_stamp = "2026-01-01T00:00:00"
    model.header.file_name.author = ("guBIM",)
    model.header.file_name.organization = ("guBIM",)
    model.header.file_name.originating_system = "guBIM"
    model.header.file_name.authorization = ""

    make_deterministic(model)
    model.write(str(path))
    # IfcOpenShell writes CRLF on Windows; normalise to LF so the committed
    # file is byte-identical to a rerun on any platform.
    path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n"))
    check_model(model)
    return model


def check_model(model):
    """Guard the structure the expected values rely on."""
    assert model.by_type("IfcSIUnit")[0].Prefix == "MILLI"
    assert model.by_type("IfcSIUnit")[0].Name == "METRE"
    assert len(model.by_type("IfcWall")) == 4
    assert len(model.by_type("IfcSlab")) == 2
    assert len(model.by_type("IfcBuildingStorey")) == 1
    assert len(model.by_type("IfcExtrudedAreaSolid")) == 6
    assert len(model.by_type("IfcRectangleProfileDef")) == 6
    assert len(model.by_type("IfcMapConversion")) == 1
    assert len(model.by_type("IfcProjectedCRS")) == 1
    conversion = model.by_type("IfcMapConversion")[0]
    assert abs(conversion.Eastings - EASTING) < 1e-9
    assert abs(conversion.Northings - NORTHING) < 1e-9
    assert abs(conversion.OrthogonalHeight - ORTHOGONAL_HEIGHT) < 1e-9
    assert abs(conversion.XAxisAbscissa - 1.0) < 1e-12
    assert abs(conversion.XAxisOrdinate - 0.0) < 1e-12
    assert abs(conversion.Scale - SCALE) < 1e-12
    assert model.by_type("IfcProjectedCRS")[0].Name == CRS_NAME


# ------------------------------------------------------------- expected ----
def value(v, unit, tol, note):
    return {"value": v, "unit": unit, "tolerance": tol, "note": note}


def bbox(x0, x1, y0, y1, z0, z1, note):
    return {
        "x_min": value(x0, "m", 1e-6, note),
        "x_max": value(x1, "m", 1e-6, note),
        "y_min": value(y0, "m", 1e-6, note),
        "y_max": value(y1, "m", 1e-6, note),
        "z_min": value(z0, "m", 1e-6, note),
        "z_max": value(z1, "m", 1e-6, note),
    }


def world_point(x_mm, y_mm, z_mm):
    """Independent closed form: scale then translate, no rotation."""
    return (EASTING + SCALE * x_mm,
            NORTHING + SCALE * y_mm,
            ORTHOGONAL_HEIGHT + SCALE * z_mm)


def self_check():
    # Closed-form checks on the design, independent of any IFC library.
    floor = FOOTPRINT_X * FOOTPRINT_Y * SLAB_THICKNESS
    roof = ROOF_X * ROOF_Y * SLAB_THICKNESS
    long_walls = 2.0 * FOOTPRINT_X * WALL_THICKNESS * WALL_HEIGHT
    short_walls = 2.0 * (FOOTPRINT_Y - 2.0 * WALL_THICKNESS) \
        * WALL_THICKNESS * WALL_HEIGHT
    total = floor + roof + long_walls + short_walls
    assert abs(floor / 1e9 - 8.0) < 1e-12
    assert abs(roof / 1e9 - 9.072) < 1e-12
    assert abs(long_walls / 1e9 - 12.0) < 1e-12
    assert abs(short_walls / 1e9 - 6.75) < 1e-12
    assert abs(total / 1e9 - 35.822) < 1e-12
    assert world_point(0.0, 0.0, 0.0) == (536500.0, 4747500.0, 260.0)
    assert world_point(8000.0, 5000.0, 3400.0) == \
        (536508.0, 4747505.0, 263.4)


def expected(model):
    elements = []
    total_volume = 0.0
    for (name, ifc_class, ptype, cx, cy, z0, dx, dy, dz) in ELEMENTS:
        volume = dx * MM * dy * MM * dz * MM
        total_volume += volume
        x0, x1 = (cx - dx / 2.0) * MM, (cx + dx / 2.0) * MM
        y0, y1 = (cy - dy / 2.0) * MM, (cy + dy / 2.0) * MM
        zz0, zz1 = z0 * MM, (z0 + dz) * MM
        centre = world_point(cx, cy, z0 + dz / 2.0)
        elements.append({
            "name": name,
            "ifc_class": ifc_class,
            "predefined_type": ptype,
            "storey": "guBIM ground floor",
            "size": {
                "x": value(dx * MM, "m", 1e-9, "design dimension, mm / 1000"),
                "y": value(dy * MM, "m", 1e-9, "design dimension, mm / 1000"),
                "z": value(dz * MM, "m", 1e-9, "design dimension, mm / 1000"),
            },
            "volume": value(volume, "m3", 1e-9,
                            "x * y * z of the design box in metres"),
            "bbox": bbox(x0, x1, y0, y1, zz0, zz1,
                         "placement centre +/- half size, mm / 1000"),
            "centre_world": {
                "easting": value(centre[0], "m", 1e-9,
                                 "536500 + 0.001 * local x_mm"),
                "northing": value(centre[1], "m", 1e-9,
                                  "4747500 + 0.001 * local y_mm"),
                "height": value(centre[2], "m", 1e-9,
                                "260 + 0.001 * local z_mm"),
            },
        })

    local_x0 = -ROOF_OVERHANG * MM
    local_x1 = (FOOTPRINT_X + ROOF_OVERHANG) * MM
    local_y0 = -ROOF_OVERHANG * MM
    local_y1 = (FOOTPRINT_Y + ROOF_OVERHANG) * MM
    local_z0 = 0.0
    local_z1 = (ROOF_BOTTOM + SLAB_THICKNESS) * MM
    world_lo = world_point(local_x0 / MM, local_y0 / MM, local_z0 / MM)
    world_hi = world_point(local_x1 / MM, local_y1 / MM, local_z1 / MM)

    return {
        "file": NAME + ".ifc",
        "schema": SCHEMA,
        "authoring": {
            "tool": "Blender 5.0 with IfcOpenShell 0.8.4",
            "author": "guBIM",
            "licence": "MIT OR Apache-2.0",
        },
        "units": {
            "length": "m",
            "area": "m2",
            "volume": "m3",
            "angle": "rad",
            "count": "1",
            "ifc_project_length_unit": "mm (IfcSIUnit LENGTHUNIT, Prefix "
                                       "MILLI, Name METRE)",
            "note": "The IFC file stores lengths in millimetres.  Every "
                    "length, coordinate, bounding box and volume in this "
                    "file is reported in metres, i.e. the IFC length value "
                    "divided by 1000.",
        },
        "tolerance_note": "Every numeric quantity carries its own tolerance. "
                          "Expected values are in metres after the IFC "
                          "millimetre-to-metre conversion.  Volumes and "
                          "bounding boxes are closed-form products of the "
                          "design dimensions, exact to 1e-9; the 1e-6 m "
                          "tolerances allow for viewer float precision.  "
                          "World coordinates apply IfcMapConversion with "
                          "Scale = 0.001 and no rotation.",
        "georeference": {
            "projected_crs": CRS_NAME,
            "eastings": value(EASTING, "m", 1e-9,
                              "IfcMapConversion.Eastings"),
            "northings": value(NORTHING, "m", 1e-9,
                               "IfcMapConversion.Northings"),
            "orthogonal_height": value(ORTHOGONAL_HEIGHT, "m", 1e-9,
                                       "IfcMapConversion.OrthogonalHeight"),
            "x_axis_abscissa": value(1.0, "1", 1e-12,
                                     "map east is local +X (no rotation)"),
            "x_axis_ordinate": value(0.0, "1", 1e-12,
                                     "map north is local +Y (no rotation)"),
            "scale": value(SCALE, "1", 1e-12,
                           "IfcMapConversion.Scale: local millimetres to "
                           "CRS metres"),
            "note": "map_easting = 536500 + 0.001 * local_x_mm = "
                    "536500 + local_x_m; map_northing = 4747500 + "
                    "local_y_m; map_height = 260 + local_z_m.",
        },
        "computation": {
            "units": "All six boxes were designed in millimetres.  Dividing "
                     "each IFC length by 1000 gives metres; no other unit "
                     "conversion is needed because area and volume units are "
                     "square and cubic metres.",
            "volumes": "Each element is an IfcExtrudedAreaSolid of an "
                       "IfcRectangleProfileDef, so its volume is exactly "
                       "x * y * z of the design box.  The four walls sit "
                       "between the floor and roof slabs and do not overlap "
                       "each other (west and east walls span only the clear "
                       "4.50 m between the south and north walls).",
            "bbox": "Each box has an axis-aligned placement at its centre "
                    "in plan and at its base in Z, and a rectangle profile "
                    "centred on that placement.  The bounding box is therefore "
                    "centre +/- half size in X and Y and base..base+height "
                    "in Z.",
            "georeference": "IfcMapConversion has no rotation, so each local "
                            "(x, y, z) in millimetres maps to (536500 + "
                            "0.001*x, 4747500 + 0.001*y, 260 + 0.001*z) in "
                            "metres.  This is the same factor as the "
                            "millimetre-to-metre unit conversion, on purpose: "
                            "the fixture checks that Scale is applied to the "
                            "local coordinates before translation.",
            "extent": "The roof overhangs the walls by 0.20 m on all four "
                      "sides, so the model extent is x = -0.20..8.20 m, "
                      "y = -0.20..5.20 m, z = 0.00..3.40 m.",
        },
        "counts": {
            "IfcProject": value(1, "1", 0, "authored"),
            "IfcSite": value(1, "1", 0, "authored"),
            "IfcBuilding": value(1, "1", 0, "authored"),
            "IfcBuildingStorey": value(1, "1", 0, "single storey"),
            "IfcWall": value(4, "1", 0, "four perimeter walls"),
            "IfcSlab": value(2, "1", 0, "floor and roof"),
            "IfcExtrudedAreaSolid": value(6, "1", 0,
                                          "one box per element"),
            "IfcRectangleProfileDef": value(6, "1", 0,
                                            "one profile per solid"),
            "IfcMapConversion": value(1, "1", 0, "scaled georeference"),
            "IfcProjectedCRS": value(1, "1", 0, "EPSG:25829"),
            "IfcRelContainedInSpatialStructure": value(
                1, "1", 0, "all six elements in the storey"),
            "IfcRelAggregates": value(3, "1", 0,
                                      "project > site > building > storey"),
        },
        "elements": elements,
        "model_extent_local": bbox(local_x0, local_x1, local_y0, local_y1,
                                   local_z0, local_z1,
                                   "outer envelope including the roof overhang"),
        "model_extent_world": {
            "easting_min": value(world_lo[0], "m", 1e-9,
                                 "536500 + 0.001 * local x_min_mm"),
            "easting_max": value(world_hi[0], "m", 1e-9,
                                 "536500 + 0.001 * local x_max_mm"),
            "northing_min": value(world_lo[1], "m", 1e-9,
                                  "4747500 + 0.001 * local y_min_mm"),
            "northing_max": value(world_hi[1], "m", 1e-9,
                                  "4747500 + 0.001 * local y_max_mm"),
            "height_min": value(world_lo[2], "m", 1e-9,
                                "260 + 0.001 * local z_min_mm"),
            "height_max": value(world_hi[2], "m", 1e-9,
                                "260 + 0.001 * local z_max_mm"),
        },
        "totals": {
            "wall_volume": value(18.75, "m3", 1e-9,
                                 "2 * 8.00 * 0.25 * 3.00 + 2 * 4.50 * 0.25 "
                                 "* 3.00"),
            "slab_volume": value(17.072, "m3", 1e-9,
                                 "floor 8.00 * 5.00 * 0.20 + roof 8.40 * "
                                 "5.40 * 0.20"),
            "element_volume": value(total_volume, "m3", 1e-9,
                                    "sum of the six element volumes"),
        },
    }


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?",
                        default=str(Path(__file__).parent))
    args = parser.parse_args(argv)
    directory = Path(args.directory)

    try:
        self_check()
        model = build(directory / (NAME + ".ifc"))
        doc = expected(model)
        (directory / (NAME + ".expected.json")).write_text(
            json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n")
        print("wrote %s (%d bytes)" % (directory / (NAME + ".ifc"),
                                       (directory / (NAME + ".ifc")).stat().st_size))
        print("entities:", len(list(model)))
        print("done")
    except Exception as e:
        print("ERROR", type(e).__name__, str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
