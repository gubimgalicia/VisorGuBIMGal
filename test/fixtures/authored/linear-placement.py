"""Author linear-placement.ifc with Blender 5.0 + IfcOpenShell 0.8.4.

Design (all lengths in metres, project length unit metre):
  The road alignment is a copy of road-alignment.ifc: horizontal line 200,
  clothoid 0 -> R500 over 120, arc R500 over 300, clothoid R500 -> 0 over
  120, line 200, left-turning, start (0,0) heading east. The vertical layout
  is the same but is not used by the placements.

  Ten 1 x 1 x 1 m IfcBuildingElementProxy boxes are placed with
  IfcLinearPlacement on the horizontal basis curve of that alignment. The
  IfcAxis2PlacementLinear of each box leaves Axis and RefDirection unset, so
  per IFC 4.3 both default to the curve frame: local X along the curve
  tangent at Location and local Z up. Each box is centred on its placement
  origin in local coordinates, so its world centre is the location of the
  IfcPointByDistanceExpression. Some stations are on the entry and exit
  clothoids.

  OffsetLateral is positive to the left of the curve as seen in the positive
  parametrisation direction (IFC 4.3, IfcPointByDistanceExpression). With the
  local Z axis up, the local Y axis is then also to the left, so the world
  centre is (x - o*sin(h), y + o*cos(h), z + v) where h is the tangent
  heading and o, v are the lateral and vertical offsets.

The expected values are computed here from the design parameters only. The
horizontal coordinates come from composite 8-point Gauss-Legendre integration
of cos/sin(heading) over intervals of at most 10 m (error < 1e-9 m for these
analytic integrands). Nothing here uses IfcOpenShell geometry.
"""

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path

# The alignment API needs shapely, which Blender's Python lacks: name a folder that has it.
if "GUBIM_BLENDER_PY" in os.environ:
    sys.path.insert(0, os.environ["GUBIM_BLENDER_PY"])

import ifcopenshell
import ifcopenshell.api.alignment as alignment_api
import ifcopenshell.api.context
import ifcopenshell.api.project
import ifcopenshell.api.root
import ifcopenshell.api.unit

NAME = "linear-placement"
SCHEMA = "IFC4X3_ADD2"
BOX = 1.0  # edge length of every box, m

# ---------------------------------------------------------------- design ----
R1 = 500.0
L_SPIRAL = 120.0
A2 = R1 * L_SPIRAL

H_SEGMENTS = [
    # (predefined type, start station, length m, start radius, end radius)
    ("LINE", 0.0, 200.0, 0.0, 0.0),
    ("CLOTHOID", 200.0, L_SPIRAL, 0.0, R1),
    ("CIRCULARARC", 320.0, 300.0, R1, R1),
    ("CLOTHOID", 620.0, L_SPIRAL, R1, 0.0),
    ("LINE", 740.0, 200.0, 0.0, 0.0),
]
H_LENGTH = sum(s[2] for s in H_SEGMENTS)  # 940.0

V_SEGMENTS = [
    ("CONSTANTGRADIENT", 0.0, 0.0, 0.02, 0.02, 400.0),
    ("PARABOLICARC", 400.0, 8.0, 0.02, -0.015, 200.0),
    ("CONSTANTGRADIENT", 600.0, 8.5, -0.015, -0.015, 340.0),
]

# (name, station m, lateral offset m, vertical offset m)
PLACEMENTS = [
    ("BOX-01", 50.0, 0.0, 0.5),
    ("BOX-02", 150.0, -2.5, 0.5),
    ("BOX-03", 230.0, 2.0, 0.5),       # entry clothoid
    ("BOX-04", 280.0, -1.5, 1.5),      # entry clothoid
    ("BOX-05", 350.0, 3.0, 0.5),       # circular arc
    ("BOX-06", 400.0, 0.0, 2.5),       # circular arc
    ("BOX-07", 500.0, -3.5, 0.5),      # circular arc
    ("BOX-08", 590.0, 1.0, 0.5),       # circular arc
    ("BOX-09", 650.0, -2.0, 0.5),      # exit clothoid
    ("BOX-10", 880.0, 2.5, 0.5),       # final straight
]


# --------------------------------------------------------------- maths ----
def heading(s):
    """Tangent heading angle (rad) of the horizontal alignment at station s."""
    if s <= 200.0:
        return 0.0
    if s <= 320.0:
        u = s - 200.0
        return u * u / (2.0 * A2)
    if s <= 620.0:
        return 0.12 + (s - 320.0) / R1
    if s <= 740.0:
        u = s - 620.0
        return 0.72 + u / R1 - u * u / (2.0 * R1 * L_SPIRAL)
    return 0.84


_GL_X = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290,
         -0.1834346424956498, 0.1834346424956498, 0.5255324099163290,
         0.7966664774136267, 0.9602898564975363]
_GL_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873,
         0.3626837833783620, 0.3626837833783620, 0.3137066458778873,
         0.2223810344533745, 0.1012285362903763]


def integrate(f, a, b, max_step=10.0):
    """Composite 8-point Gauss-Legendre integration of a smooth f."""
    if b == a:
        return 0.0
    n = max(1, int(math.ceil((b - a) / max_step)))
    step = (b - a) / n
    total = 0.0
    for i in range(n):
        lo = a + i * step
        mid = lo + 0.5 * step
        half = 0.5 * step
        total += half * sum(w * f(mid + half * x)
                            for x, w in zip(_GL_X, _GL_W))
    return total


def point(s):
    """World (x, y) at station s, independent of any IFC geometry engine."""
    return (integrate(lambda t: math.cos(heading(t)), 0.0, s),
            integrate(lambda t: math.sin(heading(t)), 0.0, s))


def placed_centre(station, lateral, vertical):
    """World centre of a box at station with lateral/vertical offsets."""
    x, y = point(station)
    h = heading(station)
    return (x - lateral * math.sin(h),
            y + lateral * math.cos(h),
            vertical)


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
    # The alignment API appends to an existing IfcRelAggregates through an
    # unordered collection, so fix the member order for byte-identical runs.
    for rel in model.by_type("IfcRelAggregates"):
        rel.RelatedObjects = sorted(rel.RelatedObjects, key=lambda e: e.id())
    for rel in model.by_type("IfcRelContainedInSpatialStructure"):
        rel.RelatedElements = sorted(rel.RelatedElements, key=lambda e: e.id())


# ------------------------------------------------------------ authoring ----
def cartesian(model, coords):
    return model.createIfcCartesianPoint(tuple(float(c) for c in coords))


def create_alignment(model):
    alignment = alignment_api.create(
        model, name="guBIM road alignment (linear placement)",
        include_vertical=True, include_geometry=True)
    horizontal = alignment_api.get_horizontal_layout(alignment)
    vertical = alignment_api.get_vertical_layout(alignment)

    for ptype, start_station, seg_length, r0, r1 in H_SEGMENTS:
        x, y = point(start_station)
        params = model.create_entity(
            "IfcAlignmentHorizontalSegment",
            StartPoint=cartesian(model, (x, y)),
            StartDirection=float(heading(start_station)),
            StartRadiusOfCurvature=float(r0),
            EndRadiusOfCurvature=float(r1),
            SegmentLength=float(seg_length),
            PredefinedType=ptype)
        matrix = alignment_api.create_layout_segment(model, horizontal, params)
        end_x, end_y = point(start_station + seg_length)
        assert abs(matrix[0][3] - end_x) < 1e-6, (ptype, matrix[0][3], end_x)
        assert abs(matrix[1][3] - end_y) < 1e-6, (ptype, matrix[1][3], end_y)

    for ptype, start_station, start_height, g0, g1, seg_length in V_SEGMENTS:
        params = model.create_entity(
            "IfcAlignmentVerticalSegment",
            StartDistAlong=float(start_station),
            StartHeight=float(start_height),
            StartGradient=float(g0),
            EndGradient=float(g1),
            HorizontalLength=float(seg_length),
            PredefinedType=ptype)
        alignment_api.create_layout_segment(model, vertical, params)
    return alignment


def basis_curve_of(alignment):
    """The horizontal IfcCompositeCurve that carries the stationing."""
    for rep in alignment.Representation.Representations:
        if rep.RepresentationIdentifier == "FootPrint":
            return rep.Items[0]
    raise AssertionError("alignment has no FootPrint representation")


def create_box_solid(model):
    """A 1 x 1 x 1 m extruded rectangle centred on the local origin."""
    profile = model.create_entity(
        "IfcRectangleProfileDef", ProfileType="AREA",
        XDim=float(BOX), YDim=float(BOX))
    position = model.create_entity(
        "IfcAxis2Placement3D",
        Location=cartesian(model, (0.0, 0.0, -0.5 * BOX)))
    solid = model.create_entity(
        "IfcExtrudedAreaSolid", SweptArea=profile, Position=position,
        ExtrudedDirection=model.create_entity(
            "IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=float(BOX))
    return solid


def create_box(model, name, body, basis, station, lateral, vertical):
    product = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcBuildingElementProxy", name=name)

    location = model.create_entity(
        "IfcPointByDistanceExpression",
        DistanceAlong=model.create_entity("IfcLengthMeasure", float(station)),
        OffsetLateral=float(lateral),
        OffsetVertical=float(vertical),
        BasisCurve=basis)
    # Axis and RefDirection are left unset: per IFC 4.3 they are relative to
    # the curve, and when omitted they default to the curve frame (local X
    # along the tangent at Location, local Z up). Writing world coordinates
    # here would turn the box by a further heading, because the viewer applies
    # them in that frame.
    axes = model.create_entity("IfcAxis2PlacementLinear", Location=location)
    product.ObjectPlacement = model.create_entity(
        "IfcLinearPlacement", RelativePlacement=axes)

    shape = model.create_entity(
        "IfcShapeRepresentation", ContextOfItems=body,
        RepresentationIdentifier="Body", RepresentationType="SweptSolid",
        Items=[create_box_solid(model)])
    product.Representation = model.create_entity(
        "IfcProductDefinitionShape", Representations=[shape])
    return product


def relation(model, ifc_class, **attrs):
    return model.create_entity(
        ifc_class, GlobalId="0000000000000000000000", OwnerHistory=None,
        Name=None, Description=None, **attrs)


def build(path):
    model = ifcopenshell.api.project.create_file(version=SCHEMA)
    project = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcProject", name="guBIM linear placement")
    length_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="LENGTHUNIT")
    area_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="AREAUNIT")
    volume_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="VOLUMEUNIT")
    units = ifcopenshell.api.unit.assign_unit(
        model, units=[length_unit, area_unit, volume_unit])
    units.Units = (length_unit, area_unit, volume_unit)

    model_ctx = ifcopenshell.api.context.add_context(model, context_type="Model")
    body = ifcopenshell.api.context.add_context(
        model, context_type="Model", context_identifier="Body",
        target_view="MODEL_VIEW", parent=model_ctx)

    site = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcSite", name="guBIM site")
    road = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcRoad", name="guBIM road")
    relation(model, "IfcRelAggregates",
             RelatingObject=project, RelatedObjects=[site])
    relation(model, "IfcRelAggregates",
             RelatingObject=site, RelatedObjects=[road])

    alignment = create_alignment(model)
    basis = basis_curve_of(alignment)

    boxes = [create_box(model, name, body, basis, station, lateral, vertical)
             for name, station, lateral, vertical in PLACEMENTS]
    relation(model, "IfcRelContainedInSpatialStructure",
             RelatedElements=[alignment] + boxes, RelatingStructure=road)

    model.header.file_name.name = NAME + ".ifc"
    model.header.file_name.time_stamp = "2026-01-01T00:00:00"
    model.header.file_name.author = ("guBIM",)
    model.header.file_name.organization = ("guBIM",)
    model.header.file_name.originating_system = "guBIM"
    model.header.file_name.authorization = ""

    make_deterministic(model)
    model.write(str(path))
    path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n"))
    return model, basis


# ------------------------------------------------------------- expected ----
def value(v, unit, tol, note):
    return {"value": v, "unit": unit, "tolerance": tol, "note": note}


def segment_at(station):
    for ptype, start, length, _r0, _r1 in H_SEGMENTS:
        if start <= station < start + length:
            return ptype
    return H_SEGMENTS[-1][0]


def expected(model):
    items = []
    for name, station, lateral, vertical in PLACEMENTS:
        x, y, z = placed_centre(station, lateral, vertical)
        h = heading(station)
        # A 1 x 1 x 1 box with local x along the tangent and local y to the
        # left: its AABB spans half a box along both horizontal axes.
        c, s = abs(math.cos(h)), abs(math.sin(h))
        items.append({
            "name": name,
            "station": value(station, "m", 1e-9,
                             "design parameter, distance along the horizontal basis curve"),
            "lateral_offset": value(lateral, "m", 1e-9,
                                    "IfcPointByDistanceExpression.OffsetLateral, positive left"),
            "vertical_offset": value(vertical, "m", 1e-9,
                                     "IfcPointByDistanceExpression.OffsetVertical, global up"),
            "segment": segment_at(station),
            "centre_x": value(x, "m", 1e-3,
                              "x(s) - o*sin(h), with x(s)=integral of cos(heading)"),
            "centre_y": value(y, "m", 1e-3,
                              "y(s) + o*cos(h), with y(s)=integral of sin(heading)"),
            "centre_z": value(z, "m", 1e-9,
                              "vertical offset; the basis curve is the horizontal alignment"),
            "heading": value(h, "rad", 1e-12,
                             "closed form from the clothoid/arc/line design parameters"),
            "yaw_degrees": value(math.degrees(h), "deg", 1e-10,
                                 "heading converted to degrees"),
            "volume": value(BOX ** 3, "m3", 1e-4,
                            "1 x 1 x 1 m box, closed form; the 1e-4 m3 "
                            "tolerance allows for 32-bit float vertex "
                            "positions in the viewer"),
            "bbox_size_x": value(BOX * (c + s), "m", 1e-3,
                                 "(|cos h| + |sin h|) * 1 m for a yawed unit "
                                 "box; 1e-3 m allows for 32-bit float vertex "
                                 "positions"),
            "bbox_size_y": value(BOX * (c + s), "m", 1e-3,
                                 "(|cos h| + |sin h|) * 1 m for a yawed unit "
                                 "box; 1e-3 m allows for 32-bit float vertex "
                                 "positions"),
            "bbox_size_z": value(BOX, "m", 1e-3,
                                 "box height; 1e-3 m allows for 32-bit float "
                                 "vertex positions"),
            "bbox_min_x": value(x - 0.5 * BOX * (c + s), "m", 1e-3,
                                "centre_x minus half the yawed extent"),
            "bbox_max_x": value(x + 0.5 * BOX * (c + s), "m", 1e-3,
                                "centre_x plus half the yawed extent"),
            "bbox_min_y": value(y - 0.5 * BOX * (c + s), "m", 1e-3,
                                "centre_y minus half the yawed extent"),
            "bbox_max_y": value(y + 0.5 * BOX * (c + s), "m", 1e-3,
                                "centre_y plus half the yawed extent"),
            "bbox_min_z": value(z - 0.5 * BOX, "m", 1e-9,
                                "centre_z minus half the box height"),
            "bbox_max_z": value(z + 0.5 * BOX, "m", 1e-9,
                                "centre_z plus half the box height"),
        })

    return {
        "file": NAME + ".ifc",
        "schema": SCHEMA,
        "authoring": {
            "tool": "Blender 5.0 with IfcOpenShell 0.8.4",
            "author": "guBIM",
            "licence": "MIT OR Apache-2.0",
        },
        "units": {"length": "m", "area": "m2", "volume": "m3",
                  "angle": "rad", "count": "1"},
        "tolerance_note": "Every numeric quantity carries its own tolerance; "
                          "lengths are in metres in the IFC project coordinate "
                          "system (no georeferencing). Coordinate tolerances are "
                          "1 mm (1e-3 m). The independent integration itself is "
                          "good to about 1e-9 m.",
        "computation": {
            "alignment": "Copy of the road-alignment design; x(s) and y(s) are "
                         "cos/sin(heading) integrated with composite 8-point "
                         "Gauss-Legendre on intervals <= 10 m. heading(s) is "
                         "closed form from the line/clothoid/arc parameters. "
                         "Independent of IfcOpenShell geometry.",
            "placement": "IfcLinearPlacement with an IfcAxis2PlacementLinear "
                         "whose Location is an IfcPointByDistanceExpression on "
                         "the horizontal IfcCompositeCurve (FootPrint) of the "
                         "alignment. Axis and RefDirection are left unset, so "
                         "per IFC 4.3 they default to the curve frame: local X "
                         "along the curve tangent at Location and local Z up. "
                         "OffsetLateral is positive to the left. The 1 x 1 x 1 "
                         "box solid is centred on the local origin, so the "
                         "world box centre is the placement origin: "
                         "(x(s)-o*sin h, y(s)+o*cos h, v).",
            "bbox": "For a unit cube yawed by h about Z, the axis-aligned "
                    "horizontal extent is |cos h|+|sin h| in both X and Y.",
            "tolerances": "Volume and bounding-box sizes use 1e-4 m3 and "
                          "1e-3 m: a viewer moves vertex positions as 32-bit "
                          "floats, so the closed forms cannot be reproduced to "
                          "1e-12.",
            "counts": "Counts of the entities written below.",
        },
        "counts": {
            "IfcProject": value(1, "1", 0, "authored"),
            "IfcSite": value(1, "1", 0, "authored"),
            "IfcRoad": value(1, "1", 0, "authored"),
            "IfcAlignment": value(1, "1", 0,
                                  "one alignment with horizontal basis curve and gradient curve"),
            "IfcBuildingElementProxy": value(len(PLACEMENTS), "1", 0, "authored"),
            "IfcLinearPlacement": value(len(PLACEMENTS) + 11, "1", 0,
                                        "10 box placements plus 11 referent placements created with the alignment"),
            "IfcPointByDistanceExpression": value(len(PLACEMENTS) + 11, "1", 0,
                                                  "10 box placements plus 11 referent placements"),
            "IfcAxis2PlacementLinear": value(len(PLACEMENTS) + 11, "1", 0,
                                             "10 box placements plus 11 referent placements"),
            "IfcReferent": value(11, "1", 0,
                                 "key points and start stations created with the alignment"),
            "IfcExtrudedAreaSolid": value(len(PLACEMENTS), "1", 0,
                                          "one 1 x 1 x 1 box solid per proxy"),
            "IfcRectangleProfileDef": value(len(PLACEMENTS), "1", 0,
                                            "1 m by 1 m profile per box"),
            "IfcRelContainedInSpatialStructure": value(1, "1", 0,
                                                       "alignment and all boxes in the road"),
            "IfcRelAggregates": value(2, "1", 0, "project -> site -> road"),
        },
        "alignment": {
            "horizontal_length": value(H_LENGTH, "m", 1e-9,
                                       "200 + 120 + 300 + 120 + 200"),
            "basis_curve": "horizontal IfcCompositeCurve (FootPrint representation)",
            "segment_types": [s[0] for s in H_SEGMENTS],
        },
        "placements": items,
    }


# ----------------------------------------------------------------- main ----
def self_check():
    """Compare the closed forms and the model against the independent maths."""
    assert abs(heading(940.0) - 0.84) < 1e-15
    # The entry clothoid offset must match the power series.
    cx = cy = 0.0
    for n in range(10):
        sign = -1.0 if n % 2 else 1.0
        cx += (sign * L_SPIRAL ** (4 * n + 1) /
               ((4 * n + 1) * math.factorial(2 * n) * (2.0 * A2) ** (2 * n)))
        cy += (sign * L_SPIRAL ** (4 * n + 3) /
               ((4 * n + 3) * math.factorial(2 * n + 1) *
                (2.0 * A2) ** (2 * n + 1)))
    x, y = point(320.0)
    assert abs((x - 200.0) - cx) < 1e-9, (x - 200.0, cx)
    assert abs(y - cy) < 1e-9, (y, cy)
    # A zero lateral offset lies on the curve; a left offset is up-left.
    x, y, z = placed_centre(100.0, 0.0, 0.5)
    assert abs(x - 100.0) < 1e-9 and abs(y) < 1e-9 and z == 0.5
    x, y, z = placed_centre(100.0, 1.0, 0.5)
    assert abs(x - 100.0) < 1e-9 and abs(y - 1.0) < 1e-9 and z == 0.5


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?", default=str(Path(__file__).parent))
    args = parser.parse_args(argv)
    directory = Path(args.directory)

    self_check()
    model, _basis = build(directory / (NAME + ".ifc"))
    doc = expected(model)
    (directory / (NAME + ".expected.json")).write_text(
        json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8",
        newline="\n")

    print("wrote %s (%d bytes)" % (directory / (NAME + ".ifc"),
                                   (directory / (NAME + ".ifc")).stat().st_size))
    print("entities:", len(list(model)))
    print("done")


if __name__ == "__main__":
    main()
