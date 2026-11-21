"""Author building-booleans.ifc with Blender 5.0 + IfcOpenShell 0.8.4.

Design (all lengths in metres, project length unit metre):
  building:   10.00 x 8.00 m in plan, two storeys, wall thickness 0.30 m.
              Storey 1 occupies z = 0 .. 3.00, storey 2 z = 3.20 .. 6.20.
              An intermediate slab fills z = 3.00 .. 3.20, the roof
              z = 6.20 .. 6.40 and the ground slab z = -0.20 .. 0.
  walls:      8 IfcWall boxes (4 per storey) forming a closed rectangle.
              South and north walls are 10.00 m long, west and east walls
              7.40 m long between them, so the walls butt without overlap.
  openings:   1 door opening (1.00 x 2.10 m) and 4 window openings
              (1.60 x 1.30 m) cut through the full 0.30 m wall thickness.
              Each opening has an IfcDoor or IfcWindow filling.
  roof:       one IfcSlab cut by IfcBooleanClippingResult with an
              IfcHalfSpaceSolid: a plane through (x=9, z=6.40) and
              (x=10, z=6.20) removes the upper wedge of the last metre,
              so the roof is 15.20 m3 instead of 16.00 m3.
  instances:  one IfcRepresentationMap of a 0.40 x 0.40 x 1.20 m box,
              instanced five times as IfcMappedItem in five
              IfcBuildingElementProxy elements.
  spaces:     two IfcSpace boxes, 9.40 x 7.40 x 3.00 m, one per storey.
  colour:     five materials (brick, concrete, wood, glass, steel), each
              with an IfcSurfaceStyle, assigned both to the material and
              directly to the shape representation.

The expected values in building-booleans.expected.json are closed-form
volumes and bounding boxes of the boxes above, computed in this script
from the design parameters only.  Net wall volumes subtract the opening
volumes (opening width x height x wall thickness).  Nothing here reads
IfcOpenShell geometry; the script only uses the authoring API.
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
import ifcopenshell.api.feature
import ifcopenshell.api.material
import ifcopenshell.api.project
import ifcopenshell.api.root
import ifcopenshell.api.style
import ifcopenshell.api.unit

NAME = "building-booleans"
SCHEMA = "IFC4X3_ADD2"

# ---------------------------------------------------------------- design ----
BUILDING_X = 10.0
BUILDING_Y = 8.0
WALL_T = 0.30
STOREY_H = 3.00
STOREY_2_ELEV = 3.20
ROOF_Z = 6.20
SLAB_T = 0.20

LEVELS = [
    ("guBIM level 1", 0.0),
    ("guBIM level 2", STOREY_2_ELEV),
]

# Walls: name, x0, y0, z0, dx, dy, dz (world coordinates).
WALLS = [
    ("guBIM south wall L1", 0.0, 0.0, 0.0,
     BUILDING_X, WALL_T, STOREY_H),
    ("guBIM north wall L1", 0.0, BUILDING_Y - WALL_T, 0.0,
     BUILDING_X, WALL_T, STOREY_H),
    ("guBIM west wall L1", 0.0, WALL_T, 0.0,
     WALL_T, BUILDING_Y - 2.0 * WALL_T, STOREY_H),
    ("guBIM east wall L1", BUILDING_X - WALL_T, WALL_T, 0.0,
     WALL_T, BUILDING_Y - 2.0 * WALL_T, STOREY_H),
    ("guBIM south wall L2", 0.0, 0.0, STOREY_2_ELEV,
     BUILDING_X, WALL_T, STOREY_H),
    ("guBIM north wall L2", 0.0, BUILDING_Y - WALL_T, STOREY_2_ELEV,
     BUILDING_X, WALL_T, STOREY_H),
    ("guBIM west wall L2", 0.0, WALL_T, STOREY_2_ELEV,
     WALL_T, BUILDING_Y - 2.0 * WALL_T, STOREY_H),
    ("guBIM east wall L2", BUILDING_X - WALL_T, WALL_T, STOREY_2_ELEV,
     WALL_T, BUILDING_Y - 2.0 * WALL_T, STOREY_H),
]

# Openings: name, wall name, x0, y0, z0, width, height, filling class,
# filling name.  The y0 is the outer face of the wall; the opening cuts
# through the full wall thickness.
DOOR_W, DOOR_H = 1.00, 2.10
WIN_W, WIN_H = 1.60, 1.30
OPENINGS = [
    ("guBIM door opening L1", "guBIM south wall L1",
     2.00, 0.0, 0.00, DOOR_W, DOOR_H, "IfcDoor", "guBIM door 1"),
    ("guBIM window opening S1", "guBIM south wall L1",
     5.00, 0.0, 1.00, WIN_W, WIN_H, "IfcWindow", "guBIM window 1"),
    ("guBIM window opening N1", "guBIM north wall L1",
     3.00, BUILDING_Y - WALL_T, 1.00, WIN_W, WIN_H, "IfcWindow",
     "guBIM window 2"),
    ("guBIM window opening S2", "guBIM south wall L2",
     2.00, 0.0, STOREY_2_ELEV + 1.00, WIN_W, WIN_H, "IfcWindow",
     "guBIM window 3"),
    ("guBIM window opening N2", "guBIM north wall L2",
     5.00, BUILDING_Y - WALL_T, STOREY_2_ELEV + 1.00, WIN_W, WIN_H,
     "IfcWindow", "guBIM window 4"),
]

SLABS = [
    # name, x0, y0, z0, dx, dy, dz
    ("guBIM ground slab", 0.0, 0.0, -SLAB_T, BUILDING_X, BUILDING_Y, SLAB_T),
    ("guBIM intermediate slab", 0.0, 0.0, STOREY_H,
     BUILDING_X, BUILDING_Y, SLAB_T),
    ("guBIM roof slab", 0.0, 0.0, ROOF_Z, BUILDING_X, BUILDING_Y, SLAB_T),
]

ROOF_PLANE_X0 = 9.0
ROOF_PLANE_Z0 = ROOF_Z + SLAB_T          # 6.40
ROOF_PLANE_DZ = -SLAB_T                  # plane drops 0.20 m over 1 m
ROOF_REMOVED = 0.5 * 1.0 * SLAB_T * BUILDING_Y  # 0.8 m3 wedge

PROXY_W, PROXY_D, PROXY_H = 0.40, 0.40, 1.20
PROXY_POSITIONS = [
    (1.50, 1.50, 0.0),
    (3.50, 1.50, 0.0),
    (5.50, 1.50, 0.0),
    (7.50, 1.50, 0.0),
    (5.00, 6.00, 0.0),
]

SPACE_X0, SPACE_Y0 = WALL_T, WALL_T
SPACE_X = BUILDING_X - 2.0 * WALL_T      # 9.40
SPACE_Y = BUILDING_Y - 2.0 * WALL_T      # 7.40

MATERIALS = [
    # key, name, category, (red, green, blue), transparency, products
    ("brick", "guBIM brick", "brick", (0.72, 0.29, 0.20), 0.0,
     [w[0] for w in WALLS]),
    ("concrete", "guBIM concrete", "concrete", (0.75, 0.75, 0.73), 0.0,
     [s[0] for s in SLABS]),
    ("wood", "guBIM wood", "wood", (0.55, 0.36, 0.18), 0.0,
     ["guBIM door 1"]),
    ("glass", "guBIM glass", "glass", (0.45, 0.72, 0.85), 0.25,
     ["guBIM window 1", "guBIM window 2", "guBIM window 3",
      "guBIM window 4"]),
    ("steel", "guBIM steel", "steel", (0.35, 0.38, 0.40), 0.0,
     ["guBIM bollard %d" % (i + 1) for i in range(len(PROXY_POSITIONS))]),
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
    # API calls append to unordered collections; fix the order for
    # byte-identical reruns.
    for rel in model.by_type("IfcRelAggregates"):
        rel.RelatedObjects = sorted(rel.RelatedObjects, key=lambda e: e.id())
    for rel in model.by_type("IfcRelContainedInSpatialStructure"):
        rel.RelatedElements = sorted(rel.RelatedElements, key=lambda e: e.id())
    for rel in model.by_type("IfcRelAssociatesMaterial"):
        rel.RelatedObjects = sorted(rel.RelatedObjects, key=lambda e: e.id())


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


def box_solid(model, dx, dy, dz):
    """Extruded rectangle occupying 0..dx, 0..dy, 0..dz in local coordinates."""
    profile = model.create_entity(
        "IfcRectangleProfileDef", ProfileType="AREA",
        Position=model.create_entity(
            "IfcAxis2Placement2D",
            Location=cartesian(model, (0.5 * dx, 0.5 * dy))),
        XDim=float(dx), YDim=float(dy))
    return model.create_entity(
        "IfcExtrudedAreaSolid", SweptArea=profile,
        Position=model.create_entity(
            "IfcAxis2Placement3D",
            Location=cartesian(model, (0.0, 0.0, 0.0))),
        ExtrudedDirection=direction(model, (0.0, 0.0, 1.0)),
        Depth=float(dz))


def add_representation(model, context, product, items, rep_type):
    shape = model.create_entity(
        "IfcShapeRepresentation", ContextOfItems=context,
        RepresentationIdentifier="Body", RepresentationType=rep_type,
        Items=items)
    product.Representation = model.create_entity(
        "IfcProductDefinitionShape", Representations=[shape])
    return shape


def element(model, storey, ifc_class, name, x0, y0, z0, dx, dy, dz,
            context, rep_type="SweptSolid", predefined_type=None):
    product = ifcopenshell.api.root.create_entity(
        model, ifc_class=ifc_class, name=name,
        predefined_type=predefined_type)
    product.ObjectPlacement = local_placement(
        model, storey.ObjectPlacement,
        location=(x0, y0, z0 - storey.Elevation))
    solid = box_solid(model, dx, dy, dz)
    shape = add_representation(model, context, product, [solid], rep_type)
    return product, shape, solid


def create_material(model, name, category, rgb, transparency, context):
    material = ifcopenshell.api.material.add_material(
        model, name=name, category=category)
    style = ifcopenshell.api.style.add_style(
        model, name="guBIM style " + category, ifc_class="IfcSurfaceStyle")
    ifcopenshell.api.style.add_surface_style(
        model, style=style, ifc_class="IfcSurfaceStyleShading",
        attributes={
            "SurfaceColour": {"Name": None,
                              "Red": float(rgb[0]),
                              "Green": float(rgb[1]),
                              "Blue": float(rgb[2])},
            "Transparency": float(transparency),
        })
    ifcopenshell.api.style.assign_material_style(
        model, material=material, style=style, context=context)
    return material, style


def build(path):
    model = ifcopenshell.api.project.create_file(version=SCHEMA)

    project = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcProject", name="guBIM building booleans")
    length_unit = ifcopenshell.api.unit.add_si_unit(
        model, unit_type="LENGTHUNIT")
    area_unit = ifcopenshell.api.unit.add_si_unit(model, unit_type="AREAUNIT")
    volume_unit = ifcopenshell.api.unit.add_si_unit(
        model, unit_type="VOLUMEUNIT")
    angle_unit = ifcopenshell.api.unit.add_si_unit(
        model, unit_type="PLANEANGLEUNIT")
    units = ifcopenshell.api.unit.assign_unit(
        model, units=[length_unit, area_unit, volume_unit, angle_unit])
    # assign_unit iterates an unordered collection; fix the order so the
    # serialised file is byte-identical on every run.
    units.Units = (length_unit, area_unit, volume_unit, angle_unit)

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

    storeys = []
    for name, elevation in LEVELS:
        storey = ifcopenshell.api.root.create_entity(
            model, ifc_class="IfcBuildingStorey", name=name)
        storey.Elevation = float(elevation)
        storey.ObjectPlacement = local_placement(
            model, building.ObjectPlacement, location=(0.0, 0.0, elevation))
        storeys.append(storey)

    # Aggregation is authored explicitly: the API helper recalculates
    # placements and allocates their points in set order, which would make
    # reruns non-identical.  Our placements are already correct.
    relation(model, "IfcRelAggregates",
             RelatingObject=project, RelatedObjects=[site])
    relation(model, "IfcRelAggregates",
             RelatingObject=site, RelatedObjects=[building])
    relation(model, "IfcRelAggregates",
             RelatingObject=building, RelatedObjects=storeys)

    materials = {}
    styles = {}
    for key, name, category, rgb, transparency, _products in MATERIALS:
        materials[key], styles[key] = create_material(
            model, name, category, rgb, transparency, body)

    walls = {}
    for name, x0, y0, z0, dx, dy, dz in WALLS:
        storey = storeys[0] if z0 < STOREY_2_ELEV else storeys[1]
        wall, shape, _solid = element(
            model, storey, "IfcWall", name, x0, y0, z0, dx, dy, dz, body,
            predefined_type="SOLIDWALL")
        walls[name] = wall
        ifcopenshell.api.style.assign_representation_styles(
            model, shape_representation=shape, styles=[styles["brick"]])

    slabs = {}
    for name, x0, y0, z0, dx, dy, dz in SLABS:
        # The intermediate slab sits at the foot of storey 2 although its
        # bottom is 0.2 m below the storey elevation.
        storey = (storeys[1] if name in ("guBIM intermediate slab",
                                        "guBIM roof slab")
                  else storeys[0])
        if name == "guBIM roof slab":
            slab = ifcopenshell.api.root.create_entity(
                model, ifc_class="IfcSlab", name=name,
                predefined_type="ROOF")
            slab.ObjectPlacement = local_placement(
                model, storey.ObjectPlacement,
                location=(x0, y0, z0 - storey.Elevation))
            base = box_solid(model, dx, dy, dz)
            # Plane through (9, 0, 0.20) in local coordinates with normal
            # proportional to (0.2, 0, 1); the upper wedge is removed.
            normal = (ROOF_PLANE_DZ / -1.0, 0.0, 1.0)  # (0.2, 0, 1)
            plane = model.create_entity(
                "IfcPlane",
                Position=model.create_entity(
                    "IfcAxis2Placement3D",
                    Location=cartesian(
                        model, (ROOF_PLANE_X0, 0.0, SLAB_T)),
                    Axis=direction(model, normal),
                    RefDirection=direction(model, (0.0, 1.0, 0.0))))
            half_space = model.create_entity(
                "IfcHalfSpaceSolid", BaseSurface=plane,
                AgreementFlag=False)
            solid = model.create_entity(
                "IfcBooleanClippingResult", Operator="DIFFERENCE",
                FirstOperand=base, SecondOperand=half_space)
            shape = add_representation(
                model, context=body, product=slab, items=[solid],
                rep_type="Clipping")
        else:
            slab, shape, _solid = element(
                model, storey, "IfcSlab", name, x0, y0, z0, dx, dy, dz,
                body, predefined_type="FLOOR")
        slabs[name] = slab
        ifcopenshell.api.style.assign_representation_styles(
            model, shape_representation=shape, styles=[styles["concrete"]])

    # Mapped item: one representation map, five mapped items.  The
    # representation is standalone (no product of its own), so the model has
    # exactly five proxy elements, all instances of the same map.
    bollard_reference = model.create_entity(
        "IfcShapeRepresentation", ContextOfItems=body,
        RepresentationIdentifier="Body", RepresentationType="SweptSolid",
        Items=[box_solid(model, PROXY_W, PROXY_D, PROXY_H)])
    mapping_source = model.create_entity(
        "IfcRepresentationMap",
        MappingOrigin=model.create_entity(
            "IfcAxis2Placement3D",
            Location=cartesian(model, (0.0, 0.0, 0.0))),
        MappedRepresentation=bollard_reference)

    proxies = []
    for index, (x, y, z) in enumerate(PROXY_POSITIONS):
        proxy = ifcopenshell.api.root.create_entity(
            model, ifc_class="IfcBuildingElementProxy",
            name="guBIM bollard %d" % (index + 1))
        proxy.ObjectPlacement = local_placement(
            model, storeys[0].ObjectPlacement,
            location=(x, y, z - storeys[0].Elevation))
        item = model.create_entity(
            "IfcMappedItem", MappingSource=mapping_source,
            MappingTarget=model.create_entity(
                "IfcCartesianTransformationOperator3D",
                Axis1=direction(model, (1.0, 0.0, 0.0)),
                Axis2=direction(model, (0.0, 1.0, 0.0)),
                LocalOrigin=cartesian(model, (0.0, 0.0, 0.0)),
                Scale=None,
                Axis3=direction(model, (0.0, 0.0, 1.0))))
        shape = add_representation(
            model, context=body, product=proxy, items=[item],
            rep_type="MappedRepresentation")
        ifcopenshell.api.style.assign_representation_styles(
            model, shape_representation=shape, styles=[styles["steel"]])
        proxies.append((proxy, shape))

    # Openings, doors and windows.
    opening_products = []
    filling_products = []
    for (name, wall_name, x0, y0, z0, width, height,
         filling_class, filling_name) in OPENINGS:
        wall = walls[wall_name]
        _wall_name, wx, wy, wz, _dx, _dy, _dz = wall_design(wall_name)
        opening = ifcopenshell.api.root.create_entity(
            model, ifc_class="IfcOpeningElement", name=name,
            predefined_type="OPENING")
        opening.ObjectPlacement = local_placement(
            model, wall.ObjectPlacement,
            location=(x0 - wx, y0 - wy, z0 - wz))
        opening_shape = add_representation(
            model, context=body, product=opening,
            items=[box_solid(model, width, WALL_T, height)],
            rep_type="SweptSolid")
        ifcopenshell.api.feature.add_feature(
            model, feature=opening, element=wall)

        filling = ifcopenshell.api.root.create_entity(
            model, ifc_class=filling_class, name=filling_name)
        if filling_class == "IfcDoor":
            filling.PredefinedType = "DOOR"
            filling.OperationType = "SINGLE_SWING_LEFT"
            filling.OverallWidth = float(width)
            filling.OverallHeight = float(height)
        else:
            filling.PredefinedType = "WINDOW"
            filling.PartitioningType = "SINGLE_PANEL"
            filling.OverallWidth = float(width)
            filling.OverallHeight = float(height)
        panel_t = 0.06
        filling.ObjectPlacement = local_placement(
            model, opening.ObjectPlacement,
            location=(0.0, 0.5 * (WALL_T - panel_t), 0.0))
        filling_shape = add_representation(
            model, context=body, product=filling,
            items=[box_solid(model, width, panel_t, height)],
            rep_type="SweptSolid")
        ifcopenshell.api.feature.add_filling(
            model, opening=opening, element=filling)
        key = "wood" if filling_class == "IfcDoor" else "glass"
        ifcopenshell.api.style.assign_representation_styles(
            model, shape_representation=filling_shape,
            styles=[styles[key]])
        opening_products.append(opening)
        filling_products.append(filling)

    # Spaces, one per storey.
    spaces = []
    for index, storey in enumerate(storeys):
        space = ifcopenshell.api.root.create_entity(
            model, ifc_class="IfcSpace", name="guBIM space %d" % (index + 1),
            predefined_type="SPACE")
        space.LongName = "guBIM space %d" % (index + 1)
        space.ElevationWithFlooring = float(storey.Elevation)
        space.ObjectPlacement = local_placement(
            model, storey.ObjectPlacement,
            location=(SPACE_X0, SPACE_Y0, 0.0))
        add_representation(
            model, context=body, product=space,
            items=[box_solid(model, SPACE_X, SPACE_Y, STOREY_H)],
            rep_type="SweptSolid")
        relation(model, "IfcRelAggregates",
                 RelatingObject=storey, RelatedObjects=[space])
        spaces.append(space)

    # Materials on the products.
    for key, _name, _category, _rgb, _transparency, product_names in MATERIALS:
        products = []
        for name in product_names:
            if name in walls:
                products.append(walls[name])
            elif name in slabs:
                products.append(slabs[name])
            else:
                products.extend(p for p, _s in proxies if p.Name == name)
                products.extend(p for p in filling_products if p.Name == name)
        ifcopenshell.api.material.assign_material(
            model, products=products, material=materials[key],
            type="IfcMaterial")

    # Containment: all physical elements in their storey.
    level1 = [walls[w[0]] for w in WALLS if w[3] < STOREY_2_ELEV]
    level2 = [walls[w[0]] for w in WALLS if w[3] >= STOREY_2_ELEV]
    level1 += [slabs["guBIM ground slab"]]
    level2 += [slabs["guBIM intermediate slab"], slabs["guBIM roof slab"]]
    level1 += [p for p, _s in proxies]
    for _name, _wall, _x, _y, z0, _w, _h, _c, _fname in OPENINGS:
        filling = next(
            p for p in filling_products if p.Name == _fname)
        (level1 if z0 < STOREY_2_ELEV else level2).append(filling)
    relation(model, "IfcRelContainedInSpatialStructure",
             RelatedElements=level1, RelatingStructure=storeys[0])
    relation(model, "IfcRelContainedInSpatialStructure",
             RelatedElements=level2, RelatingStructure=storeys[1])

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
    assert len(model.by_type("IfcBuilding")) == 1
    assert len(model.by_type("IfcBuildingStorey")) == 2
    assert len(model.by_type("IfcWall")) == 8
    assert len(model.by_type("IfcSlab")) == 3
    assert len(model.by_type("IfcOpeningElement")) == len(OPENINGS)
    assert len(model.by_type("IfcDoor")) == 1
    assert len(model.by_type("IfcWindow")) == 4
    assert len(model.by_type("IfcSpace")) == 2
    assert len(model.by_type("IfcBuildingElementProxy")) == 5
    assert len(model.by_type("IfcMappedItem")) == 5
    assert len(model.by_type("IfcRepresentationMap")) == 1
    assert len(model.by_type("IfcBooleanClippingResult")) == 1
    assert len(model.by_type("IfcHalfSpaceSolid")) == 1
    assert len(model.by_type("IfcRelVoidsElement")) == len(OPENINGS)
    assert len(model.by_type("IfcRelFillsElement")) == len(OPENINGS)
    assert len(model.by_type("IfcMaterial")) == len(MATERIALS)
    assert len(model.by_type("IfcSurfaceStyle")) == len(MATERIALS)
    mapped_items = model.by_type("IfcMappedItem")
    sources = {item.MappingSource.id() for item in mapped_items}
    assert len(sources) == 1
    roof = next(s for s in model.by_type("IfcSlab") if s.Name ==
                "guBIM roof slab")
    assert roof.Representation.Representations[0].Items[0].is_a(
        "IfcBooleanClippingResult")
    for wall in model.by_type("IfcWall"):
        bbox = wall_bbox(wall)
        assert abs((bbox[1] - bbox[0]) * (bbox[3] - bbox[2])
                   * (bbox[5] - bbox[4]) - wall_gross(wall)) < 1e-9


# ------------------------------------------------------------- expected ----
def value(v, unit, tol, note):
    return {"value": v, "unit": unit, "tolerance": tol, "note": note}


def wall_design(name):
    for w in WALLS:
        if w[0] == name:
            return w
    raise KeyError(name)


def wall_bbox(wall):
    _name, x0, y0, z0, dx, dy, dz = wall_design(wall.Name)
    return (x0, x0 + dx, y0, y0 + dy, z0, z0 + dz)


def wall_gross(wall):
    _name, _x, _y, _z, dx, dy, dz = wall_design(wall.Name)
    return dx * dy * dz


def openings_of(wall_name):
    return [o for o in OPENINGS if o[1] == wall_name]


def opening_volume(opening):
    _name, _wall, _x, _y, _z, width, height, _c, _f = opening
    return width * WALL_T * height


def wall_net(wall_name):
    gross = wall_design(wall_name)[4] * wall_design(wall_name)[5] * \
        wall_design(wall_name)[6]
    return gross - sum(opening_volume(o) for o in openings_of(wall_name))


def bbox_dict(bbox, note):
    keys = ("x_min", "x_max", "y_min", "y_max", "z_min", "z_max")
    return {key: value(val, "m", 1e-6, note)
            for key, val in zip(keys, bbox)}


def expected(model):
    wall_docs = []
    for name, x0, y0, z0, dx, dy, dz in WALLS:
        openings = []
        for (oname, _wall, ox, oy, oz, width, height,
             _c, _fname) in openings_of(name):
            openings.append({
                "name": oname,
                "x0": value(ox, "m", 1e-9, "design parameter"),
                "x1": value(ox + width, "m", 1e-9, "x0 + width"),
                "z0": value(oz, "m", 1e-9, "design parameter"),
                "z1": value(oz + height, "m", 1e-9, "z0 + height"),
                "width": value(width, "m", 1e-9, "design parameter"),
                "height": value(height, "m", 1e-9, "design parameter"),
                "volume": value(opening_volume(
                    (oname, name, ox, oy, oz, width, height, None, None)),
                    "m3", 1e-9,
                    "width x height x 0.30 m wall thickness; the opening "
                    "passes through the whole wall"),
            })
        wall_docs.append({
            "name": name,
            "ifc_class": "IfcWall",
            "gross_volume": value(dx * dy * dz, "m3", 1e-9,
                                  "dx x dy x dz box"),
            "openings": openings,
            "net_volume": value(wall_net(name), "m3", 1e-3,
                                "gross volume minus the volumes of all "
                                "openings in this wall, computed in closed "
                                "form; the 1e-3 m3 tolerance allows for "
                                "32-bit float vertices"),
            "bbox": bbox_dict((x0, x0 + dx, y0, y0 + dy, z0, z0 + dz),
                              "axis-aligned box from the design parameters"),
        })

    slab_docs = []
    for name, x0, y0, z0, dx, dy, dz in SLABS:
        volume = dx * dy * dz
        note = "dx x dy x dz box"
        if name == "guBIM roof slab":
            volume -= ROOF_REMOVED
            note = ("10 x 8 x 0.20 = 16.00 m3 minus the upper wedge cut by "
                    "the clipping plane: 0.5 x 1.00 m x 0.20 m x 8.00 m = "
                    "0.80 m3, so 15.20 m3")
        slab_docs.append({
            "name": name,
            "ifc_class": "IfcSlab",
            "volume": value(volume, "m3", 1e-3, note),
            "bbox": bbox_dict((x0, x0 + dx, y0, y0 + dy, z0, z0 + dz),
                              "the clipping plane passes through the top "
                              "edge at x=9 and the bottom edge at x=10, so "
                              "the axis-aligned bounding box is unchanged"),
        })

    opening_docs = []
    for opening in OPENINGS:
        (name, wall_name, x0, y0, z0, width, height,
         filling_class, filling_name) = opening
        opening_docs.append({
            "name": name,
            "ifc_class": "IfcOpeningElement",
            "voids": wall_name,
            "filling": filling_name,
            "filling_class": filling_class,
            "x0": value(x0, "m", 1e-9, "design parameter"),
            "x1": value(x0 + width, "m", 1e-9, "x0 + width"),
            "y0": value(y0, "m", 1e-9, "outer wall face"),
            "y1": value(y0 + WALL_T, "m", 1e-9, "inner wall face"),
            "z0": value(z0, "m", 1e-9, "design parameter"),
            "z1": value(z0 + height, "m", 1e-9, "z0 + height"),
            "volume": value(width * WALL_T * height, "m3", 1e-9,
                            "width x 0.30 m thickness x height"),
        })

    filling_docs = []
    for (name, wall_name, x0, y0, z0, width, height,
         filling_class, filling_name) in OPENINGS:
        panel_t = 0.06
        y_mid = y0 + 0.5 * WALL_T
        bbox = (x0, x0 + width, y_mid - 0.5 * panel_t,
                y_mid + 0.5 * panel_t, z0, z0 + height)
        filling_docs.append({
            "name": filling_name,
            "ifc_class": filling_class,
            "fills": name,
            "width": value(width, "m", 1e-9, "design parameter"),
            "height": value(height, "m", 1e-9, "design parameter"),
            "thickness": value(panel_t, "m", 1e-9,
                               "0.06 m panel centred in the wall"),
            "volume": value(width * panel_t * height, "m3", 1e-4,
                            "width x 0.06 m panel thickness x height"),
            "bbox": bbox_dict(bbox, "panel centred in the 0.30 m wall"),
        })

    proxy_docs = []
    for index, (x, y, z) in enumerate(PROXY_POSITIONS):
        proxy_docs.append({
            "name": "guBIM bollard %d" % (index + 1),
            "ifc_class": "IfcBuildingElementProxy",
            "instance_of": "standalone bollard representation map",
            "position": {
                "x": value(x, "m", 1e-9, "object placement origin"),
                "y": value(y, "m", 1e-9, "object placement origin"),
                "z": value(z, "m", 1e-9, "object placement origin"),
            },
            "size": {
                "width": value(PROXY_W, "m", 1e-9, "mapped representation"),
                "depth": value(PROXY_D, "m", 1e-9, "mapped representation"),
                "height": value(PROXY_H, "m", 1e-9, "mapped representation"),
            },
            "volume": value(PROXY_W * PROXY_D * PROXY_H, "m3", 1e-6,
                            "0.40 x 0.40 x 1.20 box, identical for all five "
                            "instances of the same representation map"),
            "bbox": bbox_dict((x, x + PROXY_W, y, y + PROXY_D, z,
                               z + PROXY_H),
                              "instance placement plus the mapped source box"),
        })

    space_docs = []
    for index, (_name, elevation) in enumerate(LEVELS):
        space_docs.append({
            "name": "guBIM space %d" % (index + 1),
            "ifc_class": "IfcSpace",
            "storey": _name,
            "area": value(SPACE_X * SPACE_Y, "m2", 1e-6,
                          "9.40 x 7.40 m clear internal rectangle"),
            "volume": value(SPACE_X * SPACE_Y * STOREY_H, "m3", 1e-3,
                            "9.40 x 7.40 x 3.00 m clear internal box"),
            "bbox": bbox_dict((SPACE_X0, SPACE_X0 + SPACE_X,
                               SPACE_Y0, SPACE_Y0 + SPACE_Y,
                               elevation, elevation + STOREY_H),
                              "clear internal box between the wall faces"),
        })

    material_docs = []
    for key, name, category, rgb, transparency, products in MATERIALS:
        material_docs.append({
            "name": name,
            "category": category,
            "r": value(rgb[0], "1", 1e-9, "IfcColourRgb Red"),
            "g": value(rgb[1], "1", 1e-9, "IfcColourRgb Green"),
            "b": value(rgb[2], "1", 1e-9, "IfcColourRgb Blue"),
            "transparency": value(transparency, "1", 1e-9,
                                  "IfcSurfaceStyleShading Transparency"),
            "assigned_to": list(products),
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
                          "Lengths and coordinates are in metres in the IFC "
                          "project coordinate system (no georeferencing). "
                          "Closed-form box volumes are exact to 1e-9 m3; the "
                          "1e-3 m3 tolerance on net wall volumes and space "
                          "volumes allows for 32-bit float vertex positions "
                          "in the viewer. Bounding boxes are exact to 1e-6 m.",
        "computation": {
            "walls": "Each wall is an IfcExtrudedAreaSolid of an "
                     "IfcRectangleProfileDef, so its gross volume is dx x dy "
                     "x dz. Net volume subtracts width x height x 0.30 m for "
                     "every IfcOpeningElement that voids the wall; openings "
                     "pass through the full wall thickness.",
            "slabs": "Ground and intermediate slabs are 10 x 8 x 0.20 m "
                     "boxes. The roof is the same box with an "
                     "IfcBooleanClippingResult against an IfcHalfSpaceSolid "
                     "whose plane runs from (9, z=6.40) to (10, z=6.20): the "
                     "removed wedge is 0.5 x 1.00 x 0.20 x 8.00 = 0.80 m3, "
                     "leaving 15.20 m3.",
            "mapped_items": "One IfcRepresentationMap holds the 0.40 x 0.40 "
                            "x 1.20 m box; five IfcMappedItem entities "
                            "reference it from five IfcBuildingElementProxy "
                            "elements. All instances use an identity mapping "
                            "target, so each instance volume is the source "
                            "box volume.",
            "spaces": "Each IfcSpace is the 9.40 x 7.40 x 3.00 m clear "
                      "volume inside the 0.30 m walls, one per storey.",
            "colours": "Five IfcMaterial entities carry an "
                       "IfcMaterialDefinitionRepresentation with an "
                       "IfcSurfaceStyle; the same style is also assigned "
                       "directly to each shape representation so that both "
                       "material-based and item-based colour readers see it.",
            "counts": "Counts of the entities authored below.",
        },
        "counts": {
            "IfcProject": value(1, "1", 0, "authored"),
            "IfcSite": value(1, "1", 0, "authored"),
            "IfcBuilding": value(1, "1", 0, "two storeys"),
            "IfcBuildingStorey": value(2, "1", 0,
                                       "elevations 0.0 and 3.2 m"),
            "IfcSpace": value(2, "1", 0, "one per storey"),
            "IfcWall": value(8, "1", 0, "four per storey"),
            "IfcSlab": value(3, "1", 0,
                             "ground, intermediate and roof"),
            "IfcOpeningElement": value(len(OPENINGS), "1", 0,
                                       "one door and four windows"),
            "IfcDoor": value(1, "1", 0, "fills the door opening"),
            "IfcWindow": value(4, "1", 0, "fills the four window openings"),
            "IfcBuildingElementProxy": value(5, "1", 0,
                                             "five instances of one map"),
            "IfcMappedItem": value(5, "1", 0,
                                   "all sharing one representation map"),
            "IfcRepresentationMap": value(1, "1", 0,
                                          "the bollard source representation"),
            "IfcBooleanClippingResult": value(1, "1", 0, "the roof"),
            "IfcHalfSpaceSolid": value(1, "1", 0, "the roof clipping plane"),
            "IfcRelVoidsElement": value(len(OPENINGS), "1", 0,
                                        "wall to opening"),
            "IfcRelFillsElement": value(len(OPENINGS), "1", 0,
                                        "opening to door/window"),
            "IfcMaterial": value(len(MATERIALS), "1", 0,
                                 "brick, concrete, wood, glass, steel"),
            "IfcSurfaceStyle": value(len(MATERIALS), "1", 0,
                                     "one colour per material"),
            "IfcRelContainedInSpatialStructure": value(2, "1", 0,
                                                       "one per storey"),
            "IfcRelAggregates": value(5, "1", 0,
                                      "project-site, site-building, "
                                      "building-storeys and storey-space"),
        },
        "levels": [
            {"name": name, "elevation": value(elevation, "m", 1e-9,
                                              "IfcBuildingStorey.Elevation")}
            for name, elevation in LEVELS
        ],
        "elements": {
            "walls": wall_docs,
            "slabs": slab_docs,
            "openings": opening_docs,
            "fillings": filling_docs,
            "proxies": proxy_docs,
            "spaces": space_docs,
        },
        "materials": material_docs,
        "totals": {
            "wall_net_volume": value(
                round(sum(wall_net(w[0]) for w in WALLS), 9), "m3", 1e-3,
                "sum of the eight net wall volumes"),
            "opening_volume": value(
                round(sum(opening_volume(o) for o in OPENINGS), 9), "m3",
                1e-9, "sum of the five opening volumes"),
            "slab_volume": value(
                round(sum(s[4] * s[5] * s[6] for s in SLABS) - ROOF_REMOVED,
                      9), "m3", 1e-3, "16 + 16 + 15.20 m3"),
            "filling_volume": value(
                round(sum(o[5] * 0.06 * o[6] for o in OPENINGS), 9), "m3",
                1e-4, "sum of the door and four window panels"),
            "proxy_volume": value(
                round(len(PROXY_POSITIONS) * PROXY_W * PROXY_D * PROXY_H, 9),
                "m3", 1e-6, "five identical 0.192 m3 boxes"),
            "element_volume": value(
                round(sum(wall_net(w[0]) for w in WALLS)
                      + sum(s[4] * s[5] * s[6] for s in SLABS) - ROOF_REMOVED
                      + sum(o[5] * 0.06 * o[6] for o in OPENINGS)
                      + len(PROXY_POSITIONS) * PROXY_W * PROXY_D * PROXY_H,
                      9),
                "m3", 1e-3,
                "net walls + slabs + door/window panels + five proxies; "
                "IfcSpace volumes are not counted"),
        },
    }


# ----------------------------------------------------------------- main ----
def self_check():
    """Arithmetic identities that the expected values rely on."""
    assert abs(WALL_T * 2.0 + (BUILDING_Y - 2.0 * WALL_T) - BUILDING_Y) < 1e-12
    assert abs(wall_net("guBIM south wall L1") - 7.746) < 1e-12
    assert abs(wall_net("guBIM north wall L1") - 8.376) < 1e-12
    assert abs(wall_net("guBIM west wall L1") - 6.66) < 1e-12
    assert abs(wall_net("guBIM south wall L2") - 8.376) < 1e-12
    assert abs(ROOF_REMOVED - 0.8) < 1e-12
    assert abs(PROXY_W * PROXY_D * PROXY_H - 0.192) < 1e-12
    assert abs(SPACE_X * SPACE_Y * STOREY_H - 208.68) < 1e-9
    # The roof plane passes exactly through the top edge at x=9 and the
    # bottom edge at x=10 in roof-local coordinates.
    assert abs(ROOF_PLANE_Z0 - (ROOF_Z + SLAB_T)) < 1e-12
    assert abs((ROOF_PLANE_Z0 + ROOF_PLANE_DZ) - ROOF_Z) < 1e-12


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
