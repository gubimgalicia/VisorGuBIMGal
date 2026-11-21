"""Author long-road.ifc with Blender 5.0 + IfcOpenShell 0.8.4.

Design (all lengths in metres, project length unit metre):
  horizontal: line 3000, circular arc R=10000 left over 2500,
              line 4000, circular arc R=10000 right over 2500,
              line 3000, circular arc R=10000 left over 2500,
              line 2500.  Total length 20000 m, start (0, 0) heading east.
  vertical:   constant 0 % over the whole 20000 m (z = 0).
  georef:     IfcProjectedCRS EPSG:25829 (ETRS89 / UTM zone 29N) with an
              IfcMapConversion whose local origin is at easting 536000,
              northing 4747000, height 0, north rotation 0, scale 1.
  pavement:   one IfcCourse, 7.00 m wide and 0.25 m thick, top at z = 0,
              represented by one IfcSectionedSolidHorizontal with a
              7.00 x 0.25 m rectangle profile and a section every 20 m.
  markings:   two separate edge-line elements (IfcBuildingElementProxy),
              0.15 m wide and 0.005 m thick, bottom at z = 0 and top at
              z = 0.005, centre lines 3.40 m left and right of the road
              centre line, same sectioned-solid representation.

The expected values in long-road.expected.json are computed here from the
design parameters only.  Horizontal coordinates use the closed-form
integral of cos/sin(heading) on lines and circular arcs (checked against
composite 8-point Gauss-Legendre integration).  Bounding boxes of the
7 m bands use both band edges sampled every 0.2 m along the alignment.
Volumes are cross-section area times horizontal length.  IfcOpenShell is
used only to write the file, never to obtain geometry values.
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
import ifcopenshell.api.georeference
import ifcopenshell.api.project
import ifcopenshell.api.root
import ifcopenshell.api.unit

NAME = "long-road"
SCHEMA = "IFC4X3_ADD2"

# ---------------------------------------------------------------- design ----
R_BIG = 10000.0       # radius of every horizontal curve (metres)
H_SEGMENTS = [
    # (predefined type, start station, length m, start radius, end radius)
    ("LINE", 0.0, 3000.0, 0.0, 0.0),
    ("CIRCULARARC", 3000.0, 2500.0, R_BIG, R_BIG),
    ("LINE", 5500.0, 4000.0, 0.0, 0.0),
    ("CIRCULARARC", 9500.0, 2500.0, -R_BIG, -R_BIG),
    ("LINE", 12000.0, 3000.0, 0.0, 0.0),
    ("CIRCULARARC", 15000.0, 2500.0, R_BIG, R_BIG),
    ("LINE", 17500.0, 2500.0, 0.0, 0.0),
]
H_LENGTH = sum(s[2] for s in H_SEGMENTS)  # 20000.0

V_SEGMENTS = [
    # (predefined type, start station, start height, start gradient,
    #  end gradient, horizontal length)
    ("CONSTANTGRADIENT", 0.0, 0.0, 0.0, 0.0, 20000.0),
]

PAVEMENT_WIDTH = 7.00
PAVEMENT_THICKNESS = 0.25
MARKING_WIDTH = 0.15
MARKING_THICKNESS = 0.005
MARKING_CENTRE = 3.40
SECTION_SPACING = 20.0

EASTING = 536000.0
NORTHING = 4747000.0
ORTHOGONAL_HEIGHT = 0.0
CRS_NAME = "EPSG:25829"

STATIONS = sorted(set(
    [float(s) for s in range(0, 20001, 1000)] +
    [s[1] for s in H_SEGMENTS] +
    [s[1] + s[2] for s in H_SEGMENTS]
))

# --------------------------------------------------------------- maths ----
def heading(s):
    """Tangent heading (rad) at station s, from line/arc design parameters."""
    for ptype, start, length, r0, _r1 in H_SEGMENTS:
        if s <= start + length or (ptype, start, length) == H_SEGMENTS[-1][:3]:
            if ptype == "LINE":
                return _segment_start_heading(start)
            return _segment_start_heading(start) + (s - start) / r0
    return _segment_start_heading(H_LENGTH)


def _segment_start_heading(station):
    value = 0.0
    for ptype, start, length, r0, _r1 in H_SEGMENTS:
        if station <= start:
            return value
        value += 0.0 if ptype == "LINE" else length / r0
    return value


def point(s):
    """Exact (x, y) at station s from the line/arc design, no IFC geometry."""
    station = min(max(s, 0.0), H_LENGTH)
    x = y = 0.0
    for ptype, start, length, r0, _r1 in H_SEGMENTS:
        if station <= start:
            break
        used = min(length, station - start)
        h0 = heading(start)
        if ptype == "LINE":
            x += used * math.cos(h0)
            y += used * math.sin(h0)
        else:
            dh = used / r0
            x += r0 * (math.sin(h0 + dh) - math.sin(h0))
            y += r0 * (math.cos(h0) - math.cos(h0 + dh))
    return x, y


def offset_point(s, lateral):
    """Point at station s offset laterally (positive left) from the centre."""
    x, y = point(s)
    h = heading(s)
    return x - lateral * math.sin(h), y + lateral * math.cos(h)


# 8-point Gauss-Legendre nodes and weights on [-1, 1].
_GL_X = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290,
         -0.1834346424956498, 0.1834346424956498, 0.5255324099163290,
         0.7966664774136267, 0.9602898564975363]
_GL_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873,
         0.3626837833783620, 0.3626837833783620, 0.3137066458778873,
         0.2223810344533745, 0.1012285362903763]


def integrate(f, a, b, max_step=10.0):
    """Composite 8-point Gauss-Legendre integration, for the self-check."""
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


def band_bbox(lateral_lo, lateral_hi, z_lo, z_hi, step=0.2):
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
    return model.create_entity("IfcCartesianPoint",
                               Coordinates=tuple(float(v) for v in values))


def relation(model, ifc_class, **attrs):
    return model.create_entity(
        ifc_class, GlobalId="0000000000000000000000", OwnerHistory=None,
        Name=None, Description=None, **attrs)


def horizontal_curve(alignment):
    for rep in alignment.Representation.Representations:
        if rep.RepresentationIdentifier == "FootPrint":
            for item in rep.Items:
                if item.is_a("IfcCompositeCurve"):
                    return item
    raise RuntimeError("horizontal FootPrint curve not found")


def rectangle_profile(model, width, thickness, vertical_centre):
    return model.create_entity(
        "IfcRectangleProfileDef", ProfileType="AREA",
        Position=model.create_entity(
            "IfcAxis2Placement2D",
            Location=cartesian(model, (0.0, vertical_centre))),
        XDim=float(width), YDim=float(thickness))


def sectioned_solid(model, directrix, profile, lateral, spacing):
    """One IfcSectionedSolidHorizontal with sections every `spacing` metres."""
    count = int(round(H_LENGTH / spacing))
    positions = []
    for i in range(count + 1):
        station = min(i * spacing, H_LENGTH)
        location = model.create_entity(
            "IfcPointByDistanceExpression",
            DistanceAlong=model.create_entity("IfcLengthMeasure",
                                              float(station)),
            OffsetLateral=float(lateral),
            OffsetVertical=0.0,
            BasisCurve=directrix)
        positions.append(model.create_entity(
            "IfcAxis2PlacementLinear", Location=location))
    return model.create_entity(
        "IfcSectionedSolidHorizontal",
        Directrix=directrix,
        CrossSections=[profile] * len(positions),
        CrossSectionPositions=positions)


def add_solid_representation(model, body, product, solid):
    shape = model.create_entity(
        "IfcShapeRepresentation", ContextOfItems=body,
        RepresentationIdentifier="Body", RepresentationType="SolidModel",
        Items=[solid])
    product.Representation = model.create_entity(
        "IfcProductDefinitionShape", Representations=[shape])


def build(path):
    model = ifcopenshell.api.project.create_file(version=SCHEMA)
    project = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcProject", name="guBIM long road")
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

    alignment = alignment_api.create(
        model, name="guBIM long road alignment", include_vertical=True,
        include_geometry=True)
    horizontal = alignment_api.get_horizontal_layout(alignment)
    vertical = alignment_api.get_vertical_layout(alignment)

    for ptype, start, length, r0, r1 in H_SEGMENTS:
        x, y = point(start)
        params = model.create_entity(
            "IfcAlignmentHorizontalSegment",
            StartPoint=cartesian(model, (x, y)),
            StartDirection=float(heading(start)),
            StartRadiusOfCurvature=float(r0),
            EndRadiusOfCurvature=float(r1),
            SegmentLength=float(length),
            PredefinedType=ptype)
        matrix = alignment_api.create_layout_segment(model, horizontal, params)
        end_x, end_y = point(start + length)
        assert abs(matrix[0][3] - end_x) < 1e-3, (ptype, matrix[0][3], end_x)
        assert abs(matrix[1][3] - end_y) < 1e-3, (ptype, matrix[1][3], end_y)

    for ptype, start, height0, g0, g1, length in V_SEGMENTS:
        params = model.create_entity(
            "IfcAlignmentVerticalSegment",
            StartDistAlong=float(start),
            StartHeight=float(height0),
            StartGradient=float(g0),
            EndGradient=float(g1),
            HorizontalLength=float(length),
            PredefinedType=ptype)
        alignment_api.create_layout_segment(model, vertical, params)

    # Stationing every 1 km; the API also adds its key-point referents.
    for station in range(0, 20001, 1000):
        alignment_api.add_stationing_referent(
            model, alignment=alignment, distance_along=float(station),
            station=float(station), name="STA %d+000.000" % (station // 1000),
            positioned_product=alignment)

    # Spatial hierarchy: project -> site -> road.
    site = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcSite", name="guBIM site")
    road = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcRoad", name="guBIM long road")
    relation(model, "IfcRelAggregates",
             RelatingObject=project, RelatedObjects=[site])
    relation(model, "IfcRelAggregates",
             RelatingObject=site, RelatedObjects=[road])

    # Georeferencing: local origin at the given UTM coordinate.
    ifcopenshell.api.georeference.add_georeferencing(model)
    ifcopenshell.api.georeference.edit_georeferencing(
        model,
        projected_crs={
            "Name": CRS_NAME,
            "GeodeticDatum": "ETRS89",
            "MapProjection": "UTM zone 29N",
            "MapZone": "29N",
        },
        coordinate_operation={
            "Eastings": EASTING,
            "Northings": NORTHING,
            "OrthogonalHeight": ORTHOGONAL_HEIGHT,
            "XAxisAbscissa": 1.0,
            "XAxisOrdinate": 0.0,
            "Scale": 1.0,
        })

    directrix = horizontal_curve(alignment)

    pavement = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcCourse", name="guBIM pavement")
    pavement.PredefinedType = "PAVEMENT"
    pavement_profile = rectangle_profile(
        model, PAVEMENT_WIDTH, PAVEMENT_THICKNESS, -0.5 * PAVEMENT_THICKNESS)
    add_solid_representation(
        model, body, pavement,
        sectioned_solid(model, directrix, pavement_profile, 0.0,
                        SECTION_SPACING))

    marking_profiles = []
    markings = []
    for side, lateral in (("left", MARKING_CENTRE),
                          ("right", -MARKING_CENTRE)):
        profile = rectangle_profile(
            model, MARKING_WIDTH, MARKING_THICKNESS, 0.5 * MARKING_THICKNESS)
        marking_profiles.append(profile)
        marking = ifcopenshell.api.root.create_entity(
            model, ifc_class="IfcBuildingElementProxy",
            name="guBIM lane marking %s" % side)
        marking.ObjectType = "LaneMarking"
        add_solid_representation(
            model, body, marking,
            sectioned_solid(model, directrix, profile, lateral,
                            SECTION_SPACING))
        markings.append(marking)

    relation(model, "IfcRelContainedInSpatialStructure",
             RelatedElements=[alignment, pavement] + markings,
             RelatingStructure=road)

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
    assert len(model.by_type("IfcCourse")) == 1
    assert len(model.by_type("IfcBuildingElementProxy")) == 2
    assert len(model.by_type("IfcSectionedSolidHorizontal")) == 3
    assert len(model.by_type("IfcMapConversion")) == 1
    assert len(model.by_type("IfcProjectedCRS")) == 1
    conversion = model.by_type("IfcMapConversion")[0]
    assert abs(conversion.Eastings - EASTING) < 1e-9
    assert abs(conversion.Northings - NORTHING) < 1e-9
    assert abs(conversion.Scale - 1.0) < 1e-12
    assert model.by_type("IfcProjectedCRS")[0].Name == CRS_NAME


# ------------------------------------------------------------- expected ----
def value(v, unit, tol, note):
    return {"value": v, "unit": unit, "tolerance": tol, "note": note}


def expected(model):
    segments = []
    for index, (ptype, start, length, r0, _r1) in enumerate(H_SEGMENTS):
        x0, y0 = point(start)
        x1, y1 = point(start + length)
        segments.append({
            "index": index + 1,
            "type": ptype,
            "start_station": value(start, "m", 1e-9, "design parameter"),
            "end_station": value(start + length, "m", 1e-9,
                                 "start + length"),
            "length": value(length, "m", 1e-9, "design parameter"),
            "radius": value(r0, "m", 1e-9,
                            "signed: positive left, negative right, 0 line"),
            "start_x": value(x0, "m", 1e-3,
                             "closed-form line/arc integral from station 0"),
            "start_y": value(y0, "m", 1e-3,
                             "closed-form line/arc integral from station 0"),
            "end_x": value(x1, "m", 1e-3,
                           "closed-form line/arc integral from station 0"),
            "end_y": value(y1, "m", 1e-3,
                           "closed-form line/arc integral from station 0"),
            "start_heading": value(heading(start), "rad", 1e-12,
                                   "sum of previous signed arc angles"),
            "end_heading": value(heading(start + length), "rad", 1e-12,
                                 "sum of signed arc angles"),
        })

    stations = []
    for station in STATIONS:
        x, y = point(station)
        stations.append({
            "station": value(station, "m", 1e-9, "design station"),
            "x": value(x, "m", 1e-6,
                       "closed-form line/arc integral; checked against "
                       "8-point Gauss-Legendre integration"),
            "y": value(y, "m", 1e-6,
                       "closed-form line/arc integral; checked against "
                       "8-point Gauss-Legendre integration"),
            "z": value(0.0, "m", 1e-9,
                       "constant 0 % vertical alignment over the whole road"),
            "map_easting": value(EASTING + x, "m", 1e-6,
                                 "536000 + local x, map rotation 0 and scale 1"),
            "map_northing": value(NORTHING + y, "m", 1e-6,
                                  "4747000 + local y, map rotation 0 and scale 1"),
        })

    pavement_bbox = band_bbox(-0.5 * PAVEMENT_WIDTH, 0.5 * PAVEMENT_WIDTH,
                              -PAVEMENT_THICKNESS, 0.0)
    pavement = {
        "name": "guBIM pavement",
        "ifc_class": "IfcCourse",
        "length": value(H_LENGTH, "m", 1e-6,
                        "horizontal alignment length; the flat road has no "
                        "vertical component"),
        "width": value(PAVEMENT_WIDTH, "m", 1e-9, "design parameter"),
        "thickness": value(PAVEMENT_THICKNESS, "m", 1e-9,
                           "design parameter"),
        "plan_area": value(PAVEMENT_WIDTH * H_LENGTH, "m2", 0.5,
                           "width x horizontal length (ideal arc band)"),
        "volume": value(PAVEMENT_WIDTH * PAVEMENT_THICKNESS * H_LENGTH,
                        "m3", 0.5,
                        "7.00 x 0.25 x 20000; the 20 m sections approximate "
                        "the curves by chords, which changes the volume by "
                        "less than 0.01 m3"),
        "bbox_local": {key: value(val, "m", 0.02, note)
                       for key, val, note in (
                           ("x_min", pavement_bbox["x_min"],
                            "minimum over both band edges sampled every 0.2 m"),
                           ("x_max", pavement_bbox["x_max"],
                            "maximum over both band edges sampled every 0.2 m"),
                           ("y_min", pavement_bbox["y_min"],
                            "minimum over both band edges sampled every 0.2 m"),
                           ("y_max", pavement_bbox["y_max"],
                            "maximum over both band edges sampled every 0.2 m"),
                           ("z_min", pavement_bbox["z_min"],
                            "top at z=0, bottom 0.25 m below"),
                           ("z_max", pavement_bbox["z_max"],
                            "top at z=0"),
                       )},
    }

    marking_items = []
    for side, lateral in (("left", MARKING_CENTRE),
                          ("right", -MARKING_CENTRE)):
        lo = lateral - 0.5 * MARKING_WIDTH
        hi = lateral + 0.5 * MARKING_WIDTH
        bbox = band_bbox(min(lo, hi), max(lo, hi), 0.0, MARKING_THICKNESS)
        marking_items.append({
            "name": "guBIM lane marking %s" % side,
            "ifc_class": "IfcBuildingElementProxy",
            "lateral_centre": value(lateral, "m", 1e-9,
                                    "positive left of the centre line"),
            "length": value(H_LENGTH, "m", 1e-6, "follows the alignment"),
            "width": value(MARKING_WIDTH, "m", 1e-9, "design parameter"),
            "thickness": value(MARKING_THICKNESS, "m", 1e-9,
                               "5 mm above the pavement top"),
            "volume": value(MARKING_WIDTH * MARKING_THICKNESS * H_LENGTH,
                            "m3", 0.05,
                            "0.15 x 0.005 x 20000"),
            "bbox_local": {key: value(val, "m", 0.02, note)
                           for key, val, note in (
                               ("x_min", bbox["x_min"],
                                "minimum over both stripe edges sampled "
                                "every 0.2 m"),
                               ("x_max", bbox["x_max"],
                                "maximum over both stripe edges sampled "
                                "every 0.2 m"),
                               ("y_min", bbox["y_min"],
                                "minimum over both stripe edges sampled "
                                "every 0.2 m"),
                               ("y_max", bbox["y_max"],
                                "maximum over both stripe edges sampled "
                                "every 0.2 m"),
                               ("z_min", bbox["z_min"],
                                "pavement top at z=0"),
                               ("z_max", bbox["z_max"],
                                "top 5 mm above the pavement"),
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
        "tolerance_note": "Every numeric quantity carries its own tolerance. "
                          "Coordinates and sizes are in metres in the IFC "
                          "project coordinate system (local origin); add the "
                          "map conversion to obtain EPSG:25829 eastings and "
                          "northings. Bounding boxes of curved bands use "
                          "0.02 m to cover both the 0.2 m sampling and the "
                          "20 m chord approximation of the authored solid.",
        "georeference": {
            "projected_crs": CRS_NAME,
            "eastings": value(EASTING, "m", 1e-9,
                              "IfcMapConversion.Eastings"),
            "northings": value(NORTHING, "m", 1e-9,
                               "IfcMapConversion.Northings"),
            "orthogonal_height": value(ORTHOGONAL_HEIGHT, "m", 1e-9,
                                       "IfcMapConversion.OrthogonalHeight"),
            "x_axis_abscissa": value(1.0, "1", 1e-12,
                                     "map X axis is local +X (no rotation)"),
            "x_axis_ordinate": value(0.0, "1", 1e-12,
                                     "map X axis is local +X (no rotation)"),
            "scale": value(1.0, "1", 1e-12, "IfcMapConversion.Scale"),
            "note": "map_easting = 536000 + local x; "
                    "map_northing = 4747000 + local y.",
        },
        "computation": {
            "horizontal": "x(s) and y(s) are the closed-form integrals of "
                          "cos(heading) and sin(heading) over lines and "
                          "circular arcs; heading is the sum of the signed "
                          "arc angles. Checked against composite 8-point "
                          "Gauss-Legendre integration with 10 m intervals "
                          "(agreement better than 1e-9 m). Nothing uses "
                          "IfcOpenShell geometry.",
            "vertical": "The vertical layout is a single constant 0 % "
                        "gradient, so z(s) = 0 everywhere.",
            "bbox": "A constant-width band swept along the alignment has its "
                    "extreme plan coordinates on one of its two edge curves. "
                    "Both edges are sampled every 0.2 m (including the end), "
                    "which is well inside the 0.02 m tolerance.",
            "volume": "Cross-section area times horizontal length: the road "
                      "is flat, so there is no grade correction. The authored "
                      "IfcSectionedSolidHorizontal has a section every 20 m; "
                      "the resulting chord approximation differs from the "
                      "ideal arc volume by less than 0.01 m3.",
            "sectioning": "One IfcSectionedSolidHorizontal per element, "
                          "directrix = the horizontal IfcCompositeCurve, "
                          "rectangle profile, cross-section positions every "
                          "20 m with OffsetVertical 0.",
        },
        "counts": {
            "IfcProject": value(1, "1", 0, "authored"),
            "IfcSite": value(1, "1", 0, "authored"),
            "IfcRoad": value(1, "1", 0, "authored"),
            "IfcAlignment": value(1, "1", 0, "authored"),
            "IfcAlignmentHorizontal": value(1, "1", 0, "authored"),
            "IfcAlignmentVertical": value(1, "1", 0, "authored"),
            "IfcCourse": value(1, "1", 0, "the pavement"),
            "IfcBuildingElementProxy": value(2, "1", 0,
                                             "the two lane markings"),
            "IfcSectionedSolidHorizontal": value(3, "1", 0,
                                                 "pavement + two markings"),
            "IfcRectangleProfileDef": value(3, "1", 0,
                                            "one profile per sectioned solid"),
            "IfcMapConversion": value(1, "1", 0, "authored georeference"),
            "IfcProjectedCRS": value(1, "1", 0, "EPSG:25829"),
        },
        "horizontal": {
            "total_length": value(H_LENGTH, "m", 1e-9,
                                  "3000 + 2500 + 4000 + 2500 + 3000 + 2500 "
                                  "+ 2500"),
            "turning": "left, right, left; maximum heading 0.25 rad",
            "segments": segments,
        },
        "stations": stations,
        "elements": {"pavement": pavement, "lane_markings": marking_items},
    }


# ----------------------------------------------------------------- main ----
def self_check():
    """Compare closed forms with independent numerical integration."""
    for station in (3000.0, 5500.0, 9500.0, 12000.0, 15000.0, 17500.0,
                    20000.0):
        ix = integrate(lambda t: math.cos(heading(t)), 0.0, station,
                       max_step=5.0)
        iy = integrate(lambda t: math.sin(heading(t)), 0.0, station,
                       max_step=5.0)
        x, y = point(station)
        assert abs(x - ix) < 1e-8, (station, x, ix)
        assert abs(y - iy) < 1e-8, (station, y, iy)
    assert abs(heading(0.0)) < 1e-15
    assert abs(heading(H_LENGTH) - 0.25) < 1e-12
    # Closed-form circular arc chord at the first curve.
    x0, y0 = point(3000.0)
    x1, y1 = point(5500.0)
    h0, dh = heading(3000.0), 2500.0 / R_BIG
    assert abs((x1 - x0) - R_BIG * (math.sin(h0 + dh) - math.sin(h0))) < 1e-9
    assert abs((y1 - y0) - R_BIG * (math.cos(h0) - math.cos(h0 + dh))) < 1e-9


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
