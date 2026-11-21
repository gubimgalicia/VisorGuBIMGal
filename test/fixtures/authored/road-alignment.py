"""Author road-alignment.ifc with Blender 5.0 + IfcOpenShell 0.8.4.

Design (all lengths in metres, project length unit metre):
  horizontal: line 200, clothoid 0 -> R500 over 120, arc R500 over 300,
              clothoid R500 -> 0 over 120, line 200, left-turning,
              start (0,0) heading east (+X).
  vertical:   +2.0 % from 0 to 400, parabolic arc 400..600 from +2.0 % to
              -1.5 %, constant -1.5 % from 600 to 940, z(0) = 0.
  stationing: IfcReferent every 100 m plus the alignment end.

The expected values in road-alignment.expected.json are computed here from
the design parameters only: heading(s) is integrated with composite 8-point
Gauss-Legendre on intervals of at most 10 m (error well below 1e-9 m for
these analytic integrands). IfcOpenShell is used only to write the file.
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

NAME = "road-alignment"
SCHEMA = "IFC4X3_ADD2"

# ---------------------------------------------------------------- design ----
R1 = 500.0            # circular arc radius
L_SPIRAL = 120.0      # each transition spiral
A2 = R1 * L_SPIRAL    # clothoid constant squared, A = sqrt(60000)

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
    # (predefined type, start station, start height, start gradient,
    #  end gradient, horizontal length)
    ("CONSTANTGRADIENT", 0.0, 0.0, 0.02, 0.02, 400.0),
    ("PARABOLICARC", 400.0, 8.0, 0.02, -0.015, 200.0),
    ("CONSTANTGRADIENT", 600.0, 8.5, -0.015, -0.015, 340.0),
]
V_LENGTH = sum(s[5] for s in V_SEGMENTS)

STATIONS = [0.0, 100.0, 200.0, 300.0, 320.0, 400.0, 500.0,
            600.0, 620.0, 700.0, 740.0, 800.0, 900.0, 940.0]

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


def gradient(s):
    """Longitudinal gradient dh/ds of the vertical alignment at station s."""
    if s <= 400.0:
        return 0.02
    if s <= 600.0:
        return 0.02 + (-0.015 - 0.02) * (s - 400.0) / 200.0
    return -0.015


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
                                        name="guBIM road alignment")
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
        model, name="guBIM road alignment", include_vertical=True,
        include_geometry=True)
    horizontal = alignment_api.get_horizontal_layout(alignment)
    vertical = alignment_api.get_vertical_layout(alignment)

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

    # Stationing: one STATION IfcReferent every 100 m and at the end.
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
    check_referents(model)
    return model


def station_name(station):
    kilometres = int(station // 1000)
    return "STA %d+%07.3f" % (kilometres, station - 1000 * kilometres)


def check_referents(model):
    """Guard the structure the expected values rely on."""
    names = sorted(r.Name for r in model.by_type("IfcReferent"))
    wanted = sorted([station_name(s) for s in STATIONS] + [
        "0+000.000",
        "P.O.B. (0+000.000)",
        "P.O.E. (0+940.000)",
        "T.S. (0+200.000)",
        "S.C. (0+320.000)",
        "C.S. (0+620.000)",
        "S.T. (0+740.000)",
        "V.P.O.B. (0+000.000)",
        "V.P.O.E. (0+940.000)",
        "P.V.C. (0+400.000)",
        "P.V.T. (0+600.000)",
    ])
    assert names == wanted, names


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

    stations = []
    for station in STATIONS:
        x, y = point(station)
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
            "z_note": "z is the alignment elevation from the vertical layout. "
                      "The IfcReferent placements sit on the horizontal basis "
                      "curve, so their placement z is 0; the elevation must be "
                      "taken from the IfcGradientCurve / vertical layout.",
            "counts": "Counts of the entities authored below; key-point "
                      "referents are those IfcOpenShell creates automatically at "
                      "P.O.B./P.O.E./T.S./S.C./C.S./S.T./V.P.O.B./V.P.O.E./"
                      "P.V.C./P.V.T. plus the start-station referent.",
        },
        "counts": {
            "IfcProject": value(1, "1", 0, "authored"),
            "IfcAlignment": value(1, "1", 0,
                                  "one alignment, one vertical layout, no child alignments"),
            "IfcAlignmentHorizontal": value(1, "1", 0, "authored"),
            "IfcAlignmentVertical": value(1, "1", 0, "authored"),
            "IfcAlignmentHorizontalSegment": value(len(H_SEGMENTS) + 1, "1", 0,
                                                  "5 design parameter segments plus the zero-length closing segment"),
            "IfcAlignmentVerticalSegment": value(len(V_SEGMENTS) + 1, "1", 0,
                                                 "3 design parameter segments plus the zero-length closing segment"),
            "IfcAlignmentSegment": value(len(H_SEGMENTS) + 1 + len(V_SEGMENTS) + 1,
                                         "1", 0,
                                         "5 horizontal + 1 zero length + 3 vertical + 1 zero length"),
            "IfcCurveSegment": value(len(H_SEGMENTS) + 1 + len(V_SEGMENTS) + 1,
                                     "1", 0,
                                     "one per IfcAlignmentSegment"),
            "IfcReferent": value(len(STATIONS) + 11, "1", 0,
                                 "14 station referents named STA ... plus 11 key-point referents"),
            "IfcCompositeCurve": value(2, "1", 0,
                                       "by_type includes subtypes: the horizontal basis curve plus the IfcGradientCurve; the exact-type count is 1"),
            "IfcGradientCurve": value(1, "1", 0,
                                      "vertical representation on the basis curve"),
        },
        "horizontal": {
            "total_length": value(H_LENGTH, "m", 1e-9,
                                  "200 + 120 + 300 + 120 + 200"),
            "turning_direction": "left (counter-clockwise, heading increases)",
            "segments": hsegs,
        },
        "vertical": {
            "total_length": value(V_LENGTH, "m", 1e-9,
                                  "400 + 200 + 340, equals the horizontal length"),
            "segments": vsegs,
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
    cx, cy = clothoid_offset(L_SPIRAL)
    mx, my = point(320.0)
    assert abs((mx - 200.0) - cx) < 1e-9, (mx, cx)
    assert abs(my - cy) < 1e-9, (my, cy)
    # Circular arc chord, closed form.
    phi0, phi1 = heading(320.0), heading(619.999999)
    ax = point(320.0)
    chord = (R1 * (math.sin(phi1) - math.sin(phi0)),
             R1 * (math.cos(phi0) - math.cos(phi1)))
    ex = point(620.0)
    assert abs((ex[0] - ax[0]) - chord[0]) < 1e-6
    assert abs((ex[1] - ax[1]) - chord[1]) < 1e-6
    # Final tangent and height.
    assert abs(heading(940.0) - 0.84) < 1e-15
    assert abs(height(940.0) - 3.4) < 1e-12
    # Decreasing (R -> infinity) clothoid: the integral of the rotated
    # increasing-clothoid offsets, closed form.
    cx, cy = clothoid_offset(L_SPIRAL)
    cos_end, sin_end = math.cos(0.84), math.sin(0.84)
    dx = cos_end * cx + sin_end * cy
    dy = sin_end * cx - cos_end * cy
    x620, y620 = point(620.0)
    x740, y740 = point(740.0)
    assert abs((x740 - x620) - dx) < 1e-9, ((x740 - x620), dx)
    assert abs((y740 - y620) - dy) < 1e-9, ((y740 - y620), dy)


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
