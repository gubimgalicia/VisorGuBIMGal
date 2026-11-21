"""Author bridge.ifc with Blender 5.0 + IfcOpenShell 0.8.4.

Design (all lengths in metres, project length unit metre):
  horizontal: line 100, circular arc R=400 left over 200, line 100.
              Total length 400 m, start (0, 0) heading east (+X).
  vertical:   constant 0 % over the whole 400 m (z = 0).
  bridge:     IfcBridge (GIRDER) in a project -> site -> bridge hierarchy.
  deck:       one IfcSlab, top at z = 0, represented by one
              IfcSectionedSolidHorizontal along the horizontal alignment:
              rectangle profile 10.00 m wide x 1.00 m thick, sections every
              10 m (so the curved part is a chain of chords).
  piers:      three IfcColumn boxes, 2.00 x 2.00 m in plan and 8.00 m tall,
              with their top faces in contact with the deck soffit at z = -1
              and their bases at z = -9.  Each pier is yawed to the
              alignment tangent at its station (100, 200 and 300 m).

The expected values in bridge.expected.json are computed here from the design
parameters only.  Horizontal coordinates use the closed-form line/arc
integral of cos/sin(heading).  The deck bounding box is the ideal 10 m band
sampled every 0.1 m; its 0.05 m tolerance covers the 10 m chord
approximation (sagitta at R = 405 m is about 0.031 m).  Deck volume uses the
cross-section area times horizontal length; the 0.5 m3 tolerance covers the
same chord shortening (about 0.13 m3).  Nothing here reads IfcOpenShell
geometry.
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

NAME = "bridge"
SCHEMA = "IFC4X3_ADD2"

# ---------------------------------------------------------------- design ----
R1 = 400.0
H_SEGMENTS = [
    # (predefined type, start station, length m, start radius, end radius)
    ("LINE", 0.0, 100.0, 0.0, 0.0),
    ("CIRCULARARC", 100.0, 200.0, R1, R1),
    ("LINE", 300.0, 100.0, 0.0, 0.0),
]
H_LENGTH = sum(s[2] for s in H_SEGMENTS)  # 400.0

V_SEGMENTS = [
    # (predefined type, start station, start height, start gradient,
    #  end gradient, horizontal length)
    ("CONSTANTGRADIENT", 0.0, 0.0, 0.0, 0.0, H_LENGTH),
]

DECK_WIDTH = 10.0
DECK_THICKNESS = 1.0
DECK_TOP_Z = 0.0
DECK_SECTION_SPACING = 10.0

PIER_WIDTH = 2.0
PIER_DEPTH = 2.0
PIER_HEIGHT = 8.0
PIER_TOP_Z = DECK_TOP_Z - DECK_THICKNESS      # -1.0, under the deck
PIER_BASE_Z = PIER_TOP_Z - PIER_HEIGHT        # -9.0
PIER_STATIONS = [100.0, 200.0, 300.0]

STATIONS = [0.0, 50.0, 100.0, 150.0, 200.0, 250.0,
            300.0, 350.0, 400.0]


# --------------------------------------------------------------- maths ----
def heading(s):
    """Tangent heading (rad) of the horizontal alignment at station s."""
    if s <= 100.0:
        return 0.0
    if s <= 300.0:
        return (s - 100.0) / R1
    return 200.0 / R1  # 0.5 rad


def point(s):
    """World (x, y) at station s from the line/arc design, no IFC geometry."""
    if s <= 100.0:
        return s, 0.0
    if s <= 300.0:
        h = (s - 100.0) / R1
        return 100.0 + R1 * math.sin(h), R1 * (1.0 - math.cos(h))
    h = 200.0 / R1
    x_end = 100.0 + R1 * math.sin(h)
    y_end = R1 * (1.0 - math.cos(h))
    dx, dy = s - 300.0, 0.0
    return (x_end + dx * math.cos(h) - dy * math.sin(h),
            y_end + dx * math.sin(h) + dy * math.cos(h))


def offset_point(s, lateral):
    """Point at station s offset laterally (positive left) from the centre."""
    x, y = point(s)
    h = heading(s)
    return x - lateral * math.sin(h), y + lateral * math.cos(h)


def band_bbox(lateral_lo, lateral_hi, z_lo, z_hi, step=0.1):
    """Axis-aligned bbox of a constant-width band swept along the alignment."""
    xs = []
    ys = []
    samples = int(math.ceil(H_LENGTH / step))
    for i in range(samples + 1):
        s = min(i * step, H_LENGTH)
        for lateral in (lateral_lo, lateral_hi):
            x, y = offset_point(s, lateral)
            xs.append(x)
            ys.append(y)
    return {
        "x_min": min(xs), "x_max": max(xs),
        "y_min": min(ys), "y_max": max(ys),
        "z_min": z_lo, "z_max": z_hi,
    }


# 8-point Gauss-Legendre nodes and weights on [-1, 1], for the self-check.
_GL_X = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290,
         -0.1834346424956498, 0.1834346424956498, 0.5255324099163290,
         0.7966664774136267, 0.9602898564975363]
_GL_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873,
         0.3626837833783620, 0.3626837833783620, 0.3137066458778873,
         0.2223810344533745, 0.1012285362903763]


def integrate(f, a, b, max_step=10.0):
    """Composite 8-point Gauss-Legendre integration, only for checking."""
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
    # The API appends to unordered collections; fix the order for
    # byte-identical reruns.
    for rel in model.by_type("IfcRelAggregates"):
        rel.RelatedObjects = sorted(rel.RelatedObjects, key=lambda e: e.id())
    for rel in model.by_type("IfcRelContainedInSpatialStructure"):
        rel.RelatedElements = sorted(rel.RelatedElements, key=lambda e: e.id())


# ------------------------------------------------------------ authoring ----
def cartesian(model, coords):
    return model.create_entity("IfcCartesianPoint",
                               Coordinates=tuple(float(c) for c in coords))


def direction(model, ratios):
    return model.create_entity("IfcDirection",
                               DirectionRatios=tuple(float(r) for r in ratios))


def relation(model, ifc_class, **attrs):
    return model.create_entity(
        ifc_class, GlobalId="0000000000000000000000", OwnerHistory=None,
        Name=None, Description=None, **attrs)


def local_placement(model, relative_to, location=(0.0, 0.0, 0.0),
                    ref_direction=None):
    axes = model.create_entity(
        "IfcAxis2Placement3D",
        Location=cartesian(model, location),
        Axis=direction(model, (0.0, 0.0, 1.0)),
        RefDirection=(None if ref_direction is None
                      else direction(model, ref_direction)))
    return model.create_entity("IfcLocalPlacement",
                               PlacementRelTo=relative_to,
                               RelativePlacement=axes)


def create_alignment(model):
    alignment = alignment_api.create(
        model, name="guBIM bridge alignment", include_vertical=True,
        include_geometry=True)
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
            for item in rep.Items:
                if item.is_a("IfcCompositeCurve"):
                    return item
    raise AssertionError("alignment has no horizontal FootPrint curve")


def rectangle_profile(model, width, depth, y_offset=0.0):
    return model.create_entity(
        "IfcRectangleProfileDef", ProfileType="AREA",
        Position=model.create_entity(
            "IfcAxis2Placement2D",
            Location=cartesian(model, (0.0, y_offset))),
        XDim=float(width), YDim=float(depth))


def add_representation(model, context, product, items, rep_type):
    shape = model.create_entity(
        "IfcShapeRepresentation", ContextOfItems=context,
        RepresentationIdentifier="Body", RepresentationType=rep_type,
        Items=items)
    product.Representation = model.create_entity(
        "IfcProductDefinitionShape", Representations=[shape])


def create_deck(model, context, bridge, basis):
    deck = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcSlab", name="guBIM bridge deck")
    deck.ObjectType = "BridgeDeck"
    deck.ObjectPlacement = local_placement(model, bridge.ObjectPlacement)

    # Rectangle 10 m wide (profile X, lateral) by 1 m thick (profile Y,
    # vertical), with its top edge at profile y = 0.
    profile = rectangle_profile(model, DECK_WIDTH, DECK_THICKNESS,
                                -0.5 * DECK_THICKNESS)
    count = int(round(H_LENGTH / DECK_SECTION_SPACING))
    positions = []
    for i in range(count + 1):
        station = min(i * DECK_SECTION_SPACING, H_LENGTH)
        location = model.create_entity(
            "IfcPointByDistanceExpression",
            DistanceAlong=model.create_entity("IfcLengthMeasure",
                                              float(station)),
            OffsetLateral=0.0,
            OffsetVertical=0.0,
            BasisCurve=basis)
        # IFC 4.3: for a sectioned solid horizontal the profile X axis is
        # RefDirection and the profile Y axis is Axis. Set RefDirection to
        # the horizontal left normal and Axis to global up, so the 10 m
        # profile X dimension is the deck width and the 1 m profile Y
        # dimension is its thickness. Leaving them unset would take
        # RefDirection from the curve tangent and put the width along the
        # road instead of across it.
        positions.append(model.create_entity(
            "IfcAxis2PlacementLinear", Location=location,
            Axis=direction(model, (0.0, 0.0, 1.0)),
            RefDirection=direction(model, (0.0, 1.0, 0.0))))
    solid = model.create_entity(
        "IfcSectionedSolidHorizontal",
        Directrix=basis,
        CrossSections=[profile] * len(positions),
        CrossSectionPositions=positions)
    add_representation(model, context, deck, [solid], "SolidModel")
    return deck


def create_pier(model, context, bridge, name, station):
    x, y = point(station)
    h = heading(station)
    pier = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcColumn", name=name)
    pier.ObjectType = "BridgePier"
    pier.PredefinedType = "COLUMN"
    pier.ObjectPlacement = local_placement(
        model, bridge.ObjectPlacement,
        location=(x, y, PIER_BASE_Z),
        ref_direction=(math.cos(h), math.sin(h), 0.0))

    profile = rectangle_profile(model, PIER_WIDTH, PIER_DEPTH)
    solid = model.create_entity(
        "IfcExtrudedAreaSolid",
        SweptArea=profile,
        Position=model.create_entity(
            "IfcAxis2Placement3D",
            Location=cartesian(model, (0.0, 0.0, 0.0))),
        ExtrudedDirection=direction(model, (0.0, 0.0, 1.0)),
        Depth=float(PIER_HEIGHT))
    add_representation(model, context, pier, [solid], "SweptSolid")
    return pier


def build(path):
    model = ifcopenshell.api.project.create_file(version=SCHEMA)
    project = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcProject", name="guBIM bridge")
    length_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="LENGTHUNIT")
    area_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="AREAUNIT")
    volume_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="VOLUMEUNIT")
    units = ifcopenshell.api.unit.assign_unit(
        model, units=[length_unit, area_unit, volume_unit])
    # assign_unit iterates an unordered collection; fix the order so the
    # serialised file is byte-identical on every run.
    units.Units = (length_unit, area_unit, volume_unit)

    model_ctx = ifcopenshell.api.context.add_context(model, context_type="Model")
    body = ifcopenshell.api.context.add_context(
        model, context_type="Model", context_identifier="Body",
        target_view="MODEL_VIEW", parent=model_ctx)

    site = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcSite", name="guBIM site")
    site.ObjectPlacement = local_placement(model, None)
    bridge = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcBridge", name="guBIM bridge")
    bridge.PredefinedType = "GIRDER"
    bridge.ObjectPlacement = local_placement(model, site.ObjectPlacement)
    relation(model, "IfcRelAggregates",
             RelatingObject=project, RelatedObjects=[site])
    relation(model, "IfcRelAggregates",
             RelatingObject=site, RelatedObjects=[bridge])

    alignment = create_alignment(model)
    basis = basis_curve_of(alignment)

    deck = create_deck(model, body, bridge, basis)
    piers = [create_pier(model, body, bridge, "guBIM pier %d" % (i + 1),
                         station)
             for i, station in enumerate(PIER_STATIONS)]

    relation(model, "IfcRelContainedInSpatialStructure",
             RelatedElements=[alignment, deck] + piers,
             RelatingStructure=bridge)

    # Header: no personal data, fixed timestamp for byte-identical reruns.
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
    assert len(model.by_type("IfcBridge")) == 1
    assert len(model.by_type("IfcSlab")) == 1
    assert len(model.by_type("IfcColumn")) == len(PIER_STATIONS)
    assert len(model.by_type("IfcSectionedSolidHorizontal")) == 1
    assert len(model.by_type("IfcExtrudedAreaSolid")) == len(PIER_STATIONS)
    assert model.by_type("IfcBridge")[0].PredefinedType == "GIRDER"
    positions = model.by_type("IfcSectionedSolidHorizontal")[0].CrossSectionPositions
    assert len(positions) == int(round(H_LENGTH / DECK_SECTION_SPACING)) + 1
    first = positions[0]
    assert abs(first.Axis.DirectionRatios[2] - 1.0) < 1e-12
    assert abs(first.RefDirection.DirectionRatios[0]) < 1e-12
    assert abs(first.RefDirection.DirectionRatios[1] - 1.0) < 1e-12
    for pier, station in zip(
            sorted(model.by_type("IfcColumn"), key=lambda p: p.Name),
            PIER_STATIONS):
        x, y = point(station)
        axes = pier.ObjectPlacement.RelativePlacement
        assert abs(axes.Location.Coordinates[0] - x) < 1e-9
        assert abs(axes.Location.Coordinates[1] - y) < 1e-9
        assert abs(axes.Location.Coordinates[2] - PIER_BASE_Z) < 1e-9


# ------------------------------------------------------------- expected ----
def value(v, unit, tol, note):
    return {"value": v, "unit": unit, "tolerance": tol, "note": note}


def segment_at(station):
    for ptype, start, length, _r0, _r1 in H_SEGMENTS:
        if start <= station < start + length:
            return ptype
    return H_SEGMENTS[-1][0]


def expected(model):
    segments = []
    for index, (ptype, start, length, r0, _r1) in enumerate(H_SEGMENTS):
        x0, y0 = point(start)
        x1, y1 = point(start + length)
        segments.append({
            "index": index + 1,
            "type": ptype,
            "start_station": value(start, "m", 1e-9, "design parameter"),
            "end_station": value(start + length, "m", 1e-9, "start + length"),
            "length": value(length, "m", 1e-9, "design parameter"),
            "radius": value(r0, "m", 1e-9,
                            "0 means infinite radius (straight); positive "
                            "means a left turn"),
            "start_x": value(x0, "m", 1e-6,
                             "closed-form line/arc integral from station 0"),
            "start_y": value(y0, "m", 1e-6,
                             "closed-form line/arc integral from station 0"),
            "end_x": value(x1, "m", 1e-6,
                           "closed-form line/arc integral from station 0"),
            "end_y": value(y1, "m", 1e-6,
                           "closed-form line/arc integral from station 0"),
            "start_heading": value(heading(start), "rad", 1e-12,
                                   "closed form from the design parameters"),
            "end_heading": value(heading(start + length), "rad", 1e-12,
                                 "closed form from the design parameters"),
        })

    stations = []
    for station in STATIONS:
        x, y = point(station)
        stations.append({
            "station": value(station, "m", 1e-9,
                             "distance along the horizontal alignment"),
            "x": value(x, "m", 1e-6,
                       "closed-form integral of cos(heading); checked against "
                       "8-point Gauss-Legendre integration"),
            "y": value(y, "m", 1e-6,
                       "closed-form integral of sin(heading); checked against "
                       "8-point Gauss-Legendre integration"),
            "z": value(0.0, "m", 1e-9,
                       "constant 0 % vertical alignment over the whole bridge"),
            "heading": value(heading(station), "rad", 1e-12,
                             "closed form: 0 on the lines, (s-100)/400 on the arc"),
            "segment": segment_at(station),
        })

    deck_bbox = band_bbox(-0.5 * DECK_WIDTH, 0.5 * DECK_WIDTH,
                          DECK_TOP_Z - DECK_THICKNESS, DECK_TOP_Z)
    deck = {
        "name": "guBIM bridge deck",
        "ifc_class": "IfcSlab",
        "length": value(H_LENGTH, "m", 1e-6,
                        "horizontal alignment length; the deck is flat"),
        "width": value(DECK_WIDTH, "m", 1e-9, "design parameter"),
        "thickness": value(DECK_THICKNESS, "m", 1e-9, "design parameter"),
        "plan_area": value(DECK_WIDTH * H_LENGTH, "m2", 0.5,
                           "width x horizontal length (ideal arc band)"),
        "volume": value(DECK_WIDTH * DECK_THICKNESS * H_LENGTH, "m3", 0.5,
                        "10 x 1 x 400 = 4000 m3 ideal; the 10 m chord "
                        "sections shorten the curved centre line by about "
                        "0.13 m, hence the 0.5 m3 tolerance"),
        "bbox_local": {key: value(val, "m", 0.05, note)
                       for key, val, note in (
                           ("x_min", deck_bbox["x_min"],
                            "minimum over both band edges sampled every 0.1 m"),
                           ("x_max", deck_bbox["x_max"],
                            "maximum over both band edges sampled every 0.1 m"),
                           ("y_min", deck_bbox["y_min"],
                            "minimum over both band edges sampled every 0.1 m"),
                           ("y_max", deck_bbox["y_max"],
                            "maximum over both band edges sampled every 0.1 m"),
                           ("z_min", deck_bbox["z_min"],
                            "top at z=0, soffit 1 m below"),
                           ("z_max", deck_bbox["z_max"], "deck top at z=0"),
                       )},
    }

    piers = []
    for index, station in enumerate(PIER_STATIONS):
        x, y = point(station)
        h = heading(station)
        c, s = abs(math.cos(h)), abs(math.sin(h))
        half_x = 0.5 * PIER_WIDTH * c + 0.5 * PIER_DEPTH * s
        half_y = 0.5 * PIER_WIDTH * s + 0.5 * PIER_DEPTH * c
        piers.append({
            "name": "guBIM pier %d" % (index + 1),
            "ifc_class": "IfcColumn",
            "station": value(station, "m", 1e-9,
                             "design parameter, distance along the alignment"),
            "centre_x": value(x, "m", 1e-6,
                              "alignment x(s) at the pier station"),
            "centre_y": value(y, "m", 1e-6,
                              "alignment y(s) at the pier station"),
            "centre_z": value(PIER_BASE_Z + 0.5 * PIER_HEIGHT, "m", 1e-9,
                              "mid-height of the pier"),
            "heading": value(h, "rad", 1e-12,
                             "alignment tangent heading; the pier is yawed "
                             "to it"),
            "width": value(PIER_WIDTH, "m", 1e-9, "design parameter"),
            "depth": value(PIER_DEPTH, "m", 1e-9, "design parameter"),
            "height": value(PIER_HEIGHT, "m", 1e-9, "design parameter"),
            "base_z": value(PIER_BASE_Z, "m", 1e-9,
                            "top of deck soffit (-1) minus 8 m"),
            "top_z": value(PIER_TOP_Z, "m", 1e-9,
                           "deck soffit, in contact with the deck"),
            "volume": value(PIER_WIDTH * PIER_DEPTH * PIER_HEIGHT, "m3",
                            1e-4,
                            "2 x 2 x 8, closed form; 1e-4 m3 allows for "
                            "32-bit float vertex positions in the viewer"),
            "bbox_local": {key: value(val, "m", 1e-3, note)
                           for key, val, note in (
                               ("x_min", x - half_x,
                                "centre_x minus (|cos h|*1 + |sin h|*1)"),
                               ("x_max", x + half_x,
                                "centre_x plus (|cos h|*1 + |sin h|*1)"),
                               ("y_min", y - half_y,
                                "centre_y minus (|sin h|*1 + |cos h|*1)"),
                               ("y_max", y + half_y,
                                "centre_y plus (|sin h|*1 + |cos h|*1)"),
                               ("z_min", PIER_BASE_Z, "pier base"),
                               ("z_max", PIER_TOP_Z, "pier top at the deck soffit"),
                           )},
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
                          "system (no georeferencing). Alignment coordinates "
                          "and pier positions are exact to the closed forms "
                          "within 1e-6 m; the deck bounding box uses 0.05 m "
                          "to cover the 10 m chord approximation of the "
                          "curved 10 m band.",
        "computation": {
            "horizontal": "x(s) and y(s) are the closed-form integrals of "
                          "cos(heading) and sin(heading): a straight line for "
                          "0..100, x = 100 + R sin((s-100)/R) and "
                          "y = R (1 - cos((s-100)/R)) for the 200 m left arc, "
                          "then a straight line at heading 0.5 rad. Checked "
                          "against composite 8-point Gauss-Legendre "
                          "integration with 10 m intervals (agreement better "
                          "than 1e-9 m). Nothing uses IfcOpenShell geometry.",
            "vertical": "The vertical layout is a single constant 0 % "
                        "gradient, so z(s) = 0 everywhere.",
            "deck": "One IfcSectionedSolidHorizontal on the horizontal "
                    "IfcCompositeCurve: a 10.00 x 1.00 m rectangle profile "
                    "with its top at the alignment elevation, cross-sections "
                    "every 10 m from 0 to 400 m. Each IfcAxis2PlacementLinear "
                    "sets Axis to global up and RefDirection to the horizontal "
                    "left normal, because IFC 4.3 defines the profile X axis "
                    "as RefDirection and the profile Y axis as Axis. Volume = "
                    "10 x 1 x 400 = 4000 m3 ideal; the chord approximation of "
                    "the 200 m arc gives about 3999.87 m3.",
            "deck_bbox": "A constant-width band swept along the alignment has "
                         "its extreme plan coordinates on one of its two edge "
                         "curves. Both edges are sampled every 0.1 m; the "
                         "0.05 m tolerance covers the 10 m chord sagitta "
                         "(about 0.031 m at R = 405 m).",
            "piers": "Each pier is an IfcColumn with a 2 x 2 m rectangle "
                     "profile extruded 8 m along local +Z. Its object "
                     "placement puts the local origin at the alignment point "
                     "on the pier station, z = -9, with local X along the "
                     "tangent, so the pier is yawed by the alignment heading. "
                     "The axis-aligned bbox half extents of a 2 x 2 square "
                     "yawed by h are |cos h| + |sin h| in both X and Y.",
            "counts": "Counts of the entities authored below.",
        },
        "counts": {
            "IfcProject": value(1, "1", 0, "authored"),
            "IfcSite": value(1, "1", 0, "authored"),
            "IfcBridge": value(1, "1", 0, "GIRDER, contains the deck and piers"),
            "IfcAlignment": value(1, "1", 0,
                                  "one alignment with horizontal basis curve and gradient curve"),
            "IfcAlignmentHorizontal": value(1, "1", 0, "authored"),
            "IfcAlignmentVertical": value(1, "1", 0, "authored"),
            "IfcSlab": value(1, "1", 0, "the bridge deck"),
            "IfcColumn": value(len(PIER_STATIONS), "1", 0, "the three piers"),
            "IfcSectionedSolidHorizontal": value(1, "1", 0, "the deck solid"),
            "IfcExtrudedAreaSolid": value(len(PIER_STATIONS), "1", 0,
                                          "one extrusion per pier"),
            "IfcRectangleProfileDef": value(1 + len(PIER_STATIONS), "1", 0,
                                            "one deck profile plus one per pier"),
            "IfcRelContainedInSpatialStructure": value(1, "1", 0,
                                                       "alignment, deck and piers in the bridge"),
            "IfcRelAggregates": value(2, "1", 0, "project -> site -> bridge"),
        },
        "alignment": {
            "total_length": value(H_LENGTH, "m", 1e-9,
                                  "100 + 200 + 100"),
            "turning_direction": "left (counter-clockwise, heading increases)",
            "segments": segments,
            "stations": stations,
        },
        "elements": {"deck": deck, "piers": piers},
    }


# ----------------------------------------------------------------- main ----
def self_check():
    """Compare the closed forms with independent numerical integration."""
    assert abs(heading(0.0)) < 1e-15
    assert abs(heading(100.0)) < 1e-15
    assert abs(heading(200.0) - 0.25) < 1e-15
    assert abs(heading(300.0) - 0.5) < 1e-15
    assert abs(heading(400.0) - 0.5) < 1e-15
    assert abs(point(0.0)[0]) < 1e-15 and abs(point(0.0)[1]) < 1e-15
    assert abs(point(100.0)[0] - 100.0) < 1e-12
    assert abs(point(100.0)[1]) < 1e-12
    # The arc end is the closed-form 400 sin(0.5), 400 (1 - cos(0.5)).
    assert abs(point(300.0)[0] - (100.0 + R1 * math.sin(0.5))) < 1e-12
    assert abs(point(300.0)[1] - R1 * (1.0 - math.cos(0.5))) < 1e-12
    # The final line has length 100 at heading 0.5.
    x300, y300 = point(300.0)
    assert abs(point(400.0)[0] -
               (x300 + 100.0 * math.cos(0.5))) < 1e-12
    assert abs(point(400.0)[1] -
               (y300 + 100.0 * math.sin(0.5))) < 1e-12
    # Independent integration of the tangent.
    for station in (50.0, 100.0, 150.0, 200.0, 250.0, 300.0, 350.0, 400.0):
        ix = integrate(lambda t: math.cos(heading(t)), 0.0, station,
                       max_step=5.0)
        iy = integrate(lambda t: math.sin(heading(t)), 0.0, station,
                       max_step=5.0)
        x, y = point(station)
        assert abs(x - ix) < 1e-9, (station, x, ix)
        assert abs(y - iy) < 1e-9, (station, y, iy)
    # The deck band contains its centre line and the piers are below it.
    x, y = offset_point(200.0, 0.0)
    assert abs(x - point(200.0)[0]) < 1e-12
    assert PIER_BASE_Z < PIER_TOP_Z <= DECK_TOP_Z


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
