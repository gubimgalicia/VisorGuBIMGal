"""Author rail-cant.ifc with Blender 5.0 + IfcOpenShell 0.8.4.

Design (all lengths in metres, project length unit metre):
  horizontal: line 120, clothoid 0 -> R600 over 100, arc R600 over 250,
              clothoid R600 -> 0 over 100, line 150, left-turning,
              start (0,0) heading east (+X).
  vertical:   +1.0 % from 0 to 250, parabolic arc 250..450 from +1.0 % to
              -1.0 %, constant -1.0 % from 450 to 720, z(0) = 0.
  cant:       rail head distance 1.5 m; constant cant 0 from 0 to 220,
              linear transition 0 -> 0.04 m (left rail) from 220 to 300,
              constant 0.04 m from 300 to 470, linear transition back to 0
              from 470 to 550, constant 0 from 550 to 720.  Right rail stays
              at 0.  Per IFC 4.3 the cant values are rail heights relative to
              the vertical alignment.
  stationing: IfcReferent at every design station.

The expected values in rail-cant.expected.json are computed here from the
design parameters only: heading(s) is integrated with composite 8-point
Gauss-Legendre on intervals of at most 10 m (error well below 1e-9 m for
these analytic integrands).  IfcOpenShell is used only to write the file.
Cant is authored but deliberately excluded from the expected geometry: the
kernel is expected to report it as ignored, so x/y/z must follow the plain
horizontal and vertical layouts.
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

NAME = "rail-cant"
SCHEMA = "IFC4X3_ADD2"

# ---------------------------------------------------------------- design ----
R1 = 600.0            # circular arc radius
L_SPIRAL = 100.0      # each transition spiral
A2 = R1 * L_SPIRAL    # clothoid constant squared, A = sqrt(60000)

H_SEGMENTS = [
    # (predefined type, start station, length m, start radius, end radius)
    ("LINE", 0.0, 120.0, 0.0, 0.0),
    ("CLOTHOID", 120.0, L_SPIRAL, 0.0, R1),
    ("CIRCULARARC", 220.0, 250.0, R1, R1),
    ("CLOTHOID", 470.0, L_SPIRAL, R1, 0.0),
    ("LINE", 570.0, 150.0, 0.0, 0.0),
]
H_LENGTH = sum(s[2] for s in H_SEGMENTS)  # 720.0

V_SEGMENTS = [
    # (predefined type, start station, start height, start gradient,
    #  end gradient, horizontal length)
    ("CONSTANTGRADIENT", 0.0, 0.0, 0.010, 0.010, 250.0),
    ("PARABOLICARC", 250.0, 2.5, 0.010, -0.010, 200.0),
    ("CONSTANTGRADIENT", 450.0, 2.5, -0.010, -0.010, 270.0),
]
V_LENGTH = sum(s[5] for s in V_SEGMENTS)

RAIL_HEAD_DISTANCE = 1.5
CANT_CONSTANT = 0.04

CANT_SEGMENTS = [
    # (predefined type, start station, length, start cant left, end cant left,
    #  start cant right, end cant right)
    ("CONSTANTCANT", 0.0, 220.0, 0.0, 0.0, 0.0, 0.0),
    ("LINEARTRANSITION", 220.0, 80.0, 0.0, CANT_CONSTANT, 0.0, 0.0),
    ("CONSTANTCANT", 300.0, 170.0, CANT_CONSTANT, CANT_CONSTANT, 0.0, 0.0),
    ("LINEARTRANSITION", 470.0, 80.0, CANT_CONSTANT, 0.0, 0.0, 0.0),
    ("CONSTANTCANT", 550.0, 170.0, 0.0, 0.0, 0.0, 0.0),
]
CANT_LENGTH = sum(s[2] for s in CANT_SEGMENTS)

STATIONS = sorted(set(
    [0.0, 100.0, 200.0, 300.0, 400.0, 500.0, 600.0, 700.0] +
    [s[1] for s in H_SEGMENTS] +
    [s[1] + s[2] for s in H_SEGMENTS] +
    [s[1] for s in V_SEGMENTS] +
    [s[1] + s[2] for s in CANT_SEGMENTS]
))

# --------------------------------------------------------------- maths ----
def heading(s):
    """Tangent heading angle (rad) of the horizontal alignment at station s."""
    if s <= 120.0:
        return 0.0
    if s <= 220.0:
        u = s - 120.0
        return u * u / (2.0 * A2)
    if s <= 470.0:
        return 100.0 * 100.0 / (2.0 * A2) + (s - 220.0) / R1
    if s <= 570.0:
        u = s - 470.0
        return 0.5 + u / R1 - u * u / (2.0 * R1 * L_SPIRAL)
    return 0.5 + L_SPIRAL / (2.0 * R1)


def gradient(s):
    """Longitudinal gradient dh/ds of the vertical alignment at station s."""
    if s <= 250.0:
        return 0.010
    if s <= 450.0:
        return 0.010 + (-0.010 - 0.010) * (s - 250.0) / 200.0
    return -0.010


# 8-point Gauss-Legendre nodes and weights on [-1, 1].
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


def height(s):
    """World z at station s."""
    return integrate(gradient, 0.0, s)


def cant_at(s):
    """(left, right) rail height over the vertical alignment at station s."""
    for ptype, start, length, cl0, cl1, cr0, cr1 in CANT_SEGMENTS:
        if start <= s <= start + length:
            u = 0.0 if length == 0.0 else (s - start) / length
            return (cl0 + (cl1 - cl0) * u, cr0 + (cr1 - cr0) * u)
    return (CANT_SEGMENTS[-1][4], CANT_SEGMENTS[-1][6])


# Closed-form checks used only as asserts while generating.
def clothoid_offset(length):
    """(x, y) offset of a 0 -> 1/R clothoid of given length, power series."""
    x = y = 0.0
    for n in range(10):
        sign = -1.0 if n % 2 else 1.0
        x += (sign * length ** (4 * n + 1) /
              ((4 * n + 1) * math.factorial(2 * n) * (2.0 * A2) ** (2 * n)))
        y += (sign * length ** (4 * n + 3) /
              ((4 * n + 3) * math.factorial(2 * n + 1) *
               (2.0 * A2) ** (2 * n + 1)))
    return x, y


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
def build(path):
    model = ifcopenshell.api.project.create_file(version=SCHEMA)
    ifcopenshell.api.root.create_entity(model, ifc_class="IfcProject",
                                        name="guBIM rail alignment")
    length_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="LENGTHUNIT")
    area_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="AREAUNIT")
    volume_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="VOLUMEUNIT")
    units = ifcopenshell.api.unit.assign_unit(
        model, units=[length_unit, area_unit, volume_unit])
    # assign_unit iterates an unordered collection; fix the order so the
    # serialised file is byte-identical on every run.
    units.Units = (length_unit, area_unit, volume_unit)

    model_ctx = ifcopenshell.api.context.add_context(model, context_type="Model")
    ifcopenshell.api.context.add_context(
        model, context_type="Model", context_identifier="Body",
        target_view="MODEL_VIEW", parent=model_ctx)

    alignment = alignment_api.create(
        model, name="guBIM rail alignment", include_vertical=True,
        include_cant=True, include_geometry=True)
    horizontal = alignment_api.get_horizontal_layout(alignment)
    vertical = alignment_api.get_vertical_layout(alignment)
    cant = alignment_api.get_cant_layout(alignment)
    cant.RailHeadDistance = float(RAIL_HEAD_DISTANCE)

    def cartesian(x, y):
        return model.createIfcCartesianPoint((float(x), float(y)))

    # Horizontal layout, start points taken from the independent maths.
    for ptype, start_station, seg_length, r0, r1 in H_SEGMENTS:
        x, y = point(start_station)
        params = model.create_entity(
            "IfcAlignmentHorizontalSegment",
            StartPoint=cartesian(x, y),
            StartDirection=float(heading(start_station)),
            StartRadiusOfCurvature=float(r0),
            EndRadiusOfCurvature=float(r1),
            SegmentLength=float(seg_length),
            PredefinedType=ptype)
        matrix = alignment_api.create_layout_segment(model, horizontal, params)
        end_x, end_y = point(start_station + seg_length)
        assert abs(matrix[0][3] - end_x) < 1e-6, (ptype, matrix[0][3], end_x)
        assert abs(matrix[1][3] - end_y) < 1e-6, (ptype, matrix[1][3], end_y)

    # Vertical layout.
    for ptype, start_station, start_height, g0, g1, seg_length in V_SEGMENTS:
        params = model.create_entity(
            "IfcAlignmentVerticalSegment",
            StartDistAlong=float(start_station),
            StartHeight=float(start_height),
            StartGradient=float(g0),
            EndGradient=float(g1),
            HorizontalLength=float(seg_length),
            PredefinedType=ptype)
        matrix = alignment_api.create_layout_segment(model, vertical, params)
        end_station = start_station + seg_length
        assert abs(matrix[0][3] - end_station) < 1e-6, (ptype, matrix[0][3])
        assert abs(matrix[1][3] - height(end_station)) < 1e-6, \
            (ptype, matrix[1][3], height(end_station))

    # Cant layout.  Left and right cant are rail heights over the vertical
    # alignment (IFC 4.3); the left rail rises by CANT_CONSTANT while the
    # right rail stays at zero.  The API's linear transition needs at least
    # one side to change, which is the case here.
    for ptype, start_station, seg_length, cl0, cl1, cr0, cr1 in CANT_SEGMENTS:
        params = model.create_entity(
            "IfcAlignmentCantSegment",
            StartDistAlong=float(start_station),
            HorizontalLength=float(seg_length),
            StartCantLeft=float(cl0),
            EndCantLeft=float(cl1),
            StartCantRight=float(cr0),
            EndCantRight=float(cr1),
            PredefinedType=ptype)
        alignment_api.create_layout_segment(model, cant, params)

    # The API labels the cant key-point referents "xx"; give them the usual
    # transition names so the fixture carries meaningful stationing.
    for referent in model.by_type("IfcReferent"):
        if referent.Name and referent.Name.startswith("xx ("):
            station_text = referent.Name[4:-1]
            kilometres, metres = station_text.split("+")
            station = 1000.0 * int(kilometres) + float(metres)
            label = "C.T.S." if station in (220.0, 470.0) else "C.T.E."
            referent.Name = "%s (%s)" % (label, station_text)

    # Stationing: one STATION IfcReferent at every design station.
    for station in STATIONS:
        alignment_api.add_stationing_referent(
            model, alignment=alignment, distance_along=float(station),
            station=float(station), name=station_name(station),
            positioned_product=alignment)

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
    check_structure(model)
    return model


def station_name(station):
    kilometres = int(station // 1000)
    return "STA %d+%07.3f" % (kilometres, station - 1000 * kilometres)


def check_structure(model):
    """Guard the structure the expected values rely on."""
    names = [r.Name for r in model.by_type("IfcReferent") if r.Name]
    wanted = [station_name(s) for s in STATIONS]
    missing = sorted(set(wanted) - set(names))
    assert not missing, missing
    # One IfcAlignmentSegment and one IfcCurveSegment per layout segment,
    # including the zero-length closing segment each layout starts with.
    assert len(model.by_type("IfcAlignmentHorizontalSegment")) == len(H_SEGMENTS) + 1
    assert len(model.by_type("IfcAlignmentVerticalSegment")) == len(V_SEGMENTS) + 1
    assert len(model.by_type("IfcAlignmentCantSegment")) == len(CANT_SEGMENTS) + 1
    assert len(model.by_type("IfcAlignmentSegment")) == (
        len(H_SEGMENTS) + len(V_SEGMENTS) + len(CANT_SEGMENTS) + 3)
    assert len(model.by_type("IfcCurveSegment")) == len(model.by_type("IfcAlignmentSegment"))
    assert len(model.by_type("IfcSegmentedReferenceCurve")) == 1
    assert len(model.by_type("IfcGradientCurve")) == 1
    assert abs(model.by_type("IfcAlignmentCant")[0].RailHeadDistance -
               RAIL_HEAD_DISTANCE) < 1e-12


# ------------------------------------------------------------- expected ----
def value(v, unit, tol, note):
    return {"value": v, "unit": unit, "tolerance": tol, "note": note}


def expected(model):
    hsegs = []
    for index, (ptype, start_station, seg_length, r0, r1) in enumerate(H_SEGMENTS):
        x0, y0 = point(start_station)
        x1, y1 = point(start_station + seg_length)
        hsegs.append({
            "index": index + 1,
            "type": ptype,
            "start_station": value(start_station, "m", 1e-9, "design parameter"),
            "end_station": value(start_station + seg_length, "m", 1e-9,
                                 "start + length"),
            "length": value(seg_length, "m", 1e-9, "design parameter"),
            "start_x": value(x0, "m", 1e-3, "cos(heading) integrated from 0"),
            "start_y": value(y0, "m", 1e-3, "sin(heading) integrated from 0"),
            "end_x": value(x1, "m", 1e-3, "cos(heading) integrated from 0"),
            "end_y": value(y1, "m", 1e-3, "sin(heading) integrated from 0"),
            "start_heading": value(heading(start_station), "rad", 1e-12,
                                   "closed form from the design parameters"),
            "end_heading": value(heading(start_station + seg_length), "rad",
                                 1e-12, "closed form from the design parameters"),
            "start_radius": value(r0, "m", 1e-9,
                                  "0 means infinite radius (straight)"),
            "end_radius": value(r1, "m", 1e-9,
                                "0 means infinite radius (straight)"),
        })

    vsegs = []
    for index, (ptype, start_station, start_height, g0, g1, seg_length) in \
            enumerate(V_SEGMENTS):
        vsegs.append({
            "index": index + 1,
            "type": ptype,
            "start_station": value(start_station, "m", 1e-9, "design parameter"),
            "end_station": value(start_station + seg_length, "m", 1e-9,
                                 "start + horizontal length"),
            "length": value(seg_length, "m", 1e-9, "horizontal length"),
            "start_height": value(start_height, "m", 1e-9, "design parameter"),
            "end_height": value(height(start_station + seg_length), "m", 1e-3,
                                "gradient integrated from 0"),
            "start_gradient": value(g0, "1", 1e-12, "design parameter"),
            "end_gradient": value(g1, "1", 1e-12, "design parameter"),
        })

    csegs = []
    for index, (ptype, start_station, seg_length, cl0, cl1, cr0, cr1) in \
            enumerate(CANT_SEGMENTS):
        csegs.append({
            "index": index + 1,
            "type": ptype,
            "start_station": value(start_station, "m", 1e-9, "design parameter"),
            "end_station": value(start_station + seg_length, "m", 1e-9,
                                 "start + horizontal length"),
            "length": value(seg_length, "m", 1e-9, "design parameter"),
            "start_cant_left": value(cl0, "m", 1e-9,
                                     "rail height over the vertical alignment"),
            "end_cant_left": value(cl1, "m", 1e-9,
                                   "rail height over the vertical alignment"),
            "start_cant_right": value(cr0, "m", 1e-9,
                                      "rail height over the vertical alignment"),
            "end_cant_right": value(cr1, "m", 1e-9,
                                    "rail height over the vertical alignment"),
        })

    stations = []
    for station in STATIONS:
        x, y = point(station)
        left, right = cant_at(station)
        stations.append({
            "station": value(station, "m", 1e-9,
                             "stationing matches distance along (start 0, no equations)"),
            "x": value(x, "m", 1e-3,
                       "cos(heading) integrated with 8-point Gauss-Legendre, "
                       "steps <= 10 m"),
            "y": value(y, "m", 1e-3,
                       "sin(heading) integrated with 8-point Gauss-Legendre, "
                       "steps <= 10 m"),
            "z": value(height(station), "m", 1e-3,
                       "piecewise linear / parabolic gradient integrated analytically"),
            "segment": segment_at(station),
            "cant_left_ignored": value(left, "m", 1e-9,
                                       "authored rail height; must not affect x/y/z"),
            "cant_right_ignored": value(right, "m", 1e-9,
                                        "authored rail height; must not affect x/y/z"),
        })

    referents = model.by_type("IfcReferent")
    key_points = [r.Name for r in referents
                  if r.Name and not r.Name.startswith("STA ")]
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
                          "1 mm (1e-3 m), the accuracy a viewer needs; the "
                          "independent integration itself is good to about 1e-9 m.",
        "computation": {
            "horizontal": "x(s) = integral of cos(heading(t)) dt from 0 to s, "
                          "y(s) = integral of sin(heading(t)) dt; heading comes "
                          "from the clothoid/arc/line design parameters. "
                          "Composite 8-point Gauss-Legendre, intervals <= 10 m, "
                          "estimated error < 1e-9 m; checked against the "
                          "closed-form clothoid power series and the mirrored "
                          "R->infinity clothoid identity. Nothing here uses "
                          "IfcOpenShell geometry.",
            "vertical": "z(s) = integral of the piecewise gradient; constant "
                        "gradients integrate to lines, the parabolic arc to a "
                        "quadratic. Closed form, no numeric error.",
            "cant": "Cant is authored as IfcAlignmentCant + IfcAlignmentCantSegment "
                    "with a rail head distance of 1.5 m. Values are rail heights "
                    "over the vertical alignment per IFC 4.3: the left rail rises "
                    "from 0 to 0.04 m and back to 0, the right rail stays at 0. "
                    "The kernel is expected to report cant as ignored; the "
                    "expected x/y/z below are the plain horizontal/vertical "
                    "centreline and contain no cant contribution. The "
                    "cant_left_ignored / cant_right_ignored fields document the "
                    "authored data only.",
        },
        "expected_kernel_behaviour": {
            "cant": "ignored (report the IfcAlignmentCant data as unsupported/"
                    "ignored); geometry must equal the horizontal + vertical "
                    "alignment without any transverse rotation.",
            "max_cant_angle_if_applied": value(
                math.atan((CANT_CONSTANT - 0.0) / RAIL_HEAD_DISTANCE), "rad",
                1e-12, "atan((left-right)/rail head distance) in the constant "
                       "0.04 m section; informational only"),
        },
        "counts": {
            "IfcProject": value(1, "1", 0, "authored"),
            "IfcAlignment": value(1, "1", 0,
                                  "one alignment, one vertical layout, one cant "
                                  "layout, no child alignments"),
            "IfcAlignmentHorizontal": value(1, "1", 0, "authored"),
            "IfcAlignmentVertical": value(1, "1", 0, "authored"),
            "IfcAlignmentCant": value(1, "1", 0, "authored"),
            "IfcAlignmentHorizontalSegment": value(len(H_SEGMENTS) + 1, "1", 0,
                                                  "5 design parameter segments plus the zero-length closing segment"),
            "IfcAlignmentVerticalSegment": value(len(V_SEGMENTS) + 1, "1", 0,
                                                 "3 design parameter segments plus the zero-length closing segment"),
            "IfcAlignmentCantSegment": value(len(CANT_SEGMENTS) + 1, "1", 0,
                                             "5 design parameter segments plus the zero-length closing segment"),
            "IfcAlignmentSegment": value(
                len(H_SEGMENTS) + len(V_SEGMENTS) + len(CANT_SEGMENTS) + 3, "1", 0,
                "one per design segment plus one zero-length closing segment "
                "per layout"),
            "IfcCurveSegment": value(
                len(H_SEGMENTS) + len(V_SEGMENTS) + len(CANT_SEGMENTS) + 3, "1", 0,
                "one per IfcAlignmentSegment"),
            "IfcCompositeCurve": value(3, "1", 0,
                                       "by_type includes subtypes: horizontal "
                                       "basis curve, IfcGradientCurve and "
                                       "IfcSegmentedReferenceCurve; exact-type "
                                       "count is 1"),
            "IfcGradientCurve": value(1, "1", 0,
                                      "vertical representation on the basis curve"),
            "IfcSegmentedReferenceCurve": value(1, "1", 0,
                                                "cant representation on the basis curve"),
            "IfcReferent": value(len(referents), "1", 0,
                                 "%d station referents plus %d key-point "
                                 "referents inserted by the alignment API" %
                                 (len(STATIONS), len(key_points))),
        },
        "referents": {
            "stations": [station_name(s) for s in STATIONS],
            "key_points": sorted(key_points),
        },
        "horizontal": {
            "total_length": value(H_LENGTH, "m", 1e-9,
                                  "120 + 100 + 250 + 100 + 150"),
            "turning_direction": "left (counter-clockwise, heading increases)",
            "segments": hsegs,
        },
        "vertical": {
            "total_length": value(V_LENGTH, "m", 1e-9,
                                  "250 + 200 + 270, equals the horizontal length"),
            "segments": vsegs,
        },
        "cant": {
            "rail_head_distance": value(RAIL_HEAD_DISTANCE, "m", 1e-9,
                                        "IfcAlignmentCant.RailHeadDistance"),
            "total_length": value(CANT_LENGTH, "m", 1e-9,
                                  "220 + 80 + 170 + 80 + 170"),
            "constant_cant": value(CANT_CONSTANT, "m", 1e-9,
                                   "left rail height in the constant section; "
                                   "right rail at 0"),
            "segments": csegs,
        },
        "stations": stations,
    }


def segment_at(station):
    for ptype, start, length, _r0, _r1 in H_SEGMENTS:
        if start <= station < start + length:
            return ptype
    return H_SEGMENTS[-1][0]


# ----------------------------------------------------------------- main ----
def self_check():
    """Compare the closed forms and the model against the independent maths."""
    # Increasing clothoid.
    cx, cy = clothoid_offset(L_SPIRAL)
    mx, my = point(220.0)
    assert abs((mx - 120.0) - cx) < 1e-9, (mx, cx)
    assert abs(my - cy) < 1e-9, (my, cy)
    # Circular arc chord, closed form.
    phi0, phi1 = heading(220.0), heading(469.999999)
    ax = point(220.0)
    chord = (R1 * (math.sin(phi1) - math.sin(phi0)),
             R1 * (math.cos(phi0) - math.cos(phi1)))
    ex = point(470.0)
    assert abs((ex[0] - ax[0]) - chord[0]) < 1e-6
    assert abs((ex[1] - ax[1]) - chord[1]) < 1e-6
    # Final tangent and height.
    assert abs(heading(720.0) - (0.5 + 100.0 / (2.0 * 600.0))) < 1e-15
    assert abs(height(720.0) - (-0.2)) < 1e-12
    # Decreasing (R -> infinity) clothoid: the integral of the rotated
    # increasing-clothoid offsets, closed form.
    cos_end, sin_end = math.cos(heading(570.0)), math.sin(heading(570.0))
    dx = cos_end * cx + sin_end * cy
    dy = sin_end * cx - cos_end * cy
    x470, y470 = point(470.0)
    x570, y570 = point(570.0)
    assert abs((x570 - x470) - dx) < 1e-9, ((x570 - x470), dx)
    assert abs((y570 - y470) - dy) < 1e-9, ((y570 - y470), dy)
    # Cant design closes and matches the alignment length.
    assert abs(CANT_LENGTH - H_LENGTH) < 1e-12
    assert abs(sum(s[2] for s in CANT_SEGMENTS) - CANT_LENGTH) < 1e-12


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?", default=str(Path(__file__).parent))
    args = parser.parse_args(argv)
    directory = Path(args.directory)

    self_check()
    model = build(directory / (NAME + ".ifc"))
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
