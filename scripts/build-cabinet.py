#!/usr/bin/env python3
"""Author and verify Critpusher's Blender cabinet from the TypeScript-exported spec."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("build", "check"), required=True)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--blend", type=Path, required=True)
    parser.add_argument("--glb", type=Path, required=True)
    return parser.parse_args(argv)


def runtime_to_blender(value: tuple[float, float, float] | list[float]) -> tuple[float, float, float]:
    return (float(value[0]), -float(value[2]), float(value[1]))


def blender_to_runtime(value: Vector) -> Vector:
    return Vector((value.x, value.z, -value.y))


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        if block.users == 0:
            bpy.data.materials.remove(block)


def create_material(name: str, color: str, metallic: float, roughness: float, alpha: float = 1.0) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    rgb = tuple(int(color[index : index + 2], 16) / 255 for index in (1, 3, 5))
    material.diffuse_color = (*rgb, alpha)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (*rgb, 1.0)
    principled.inputs["Metallic"].default_value = metallic
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Alpha"].default_value = alpha
    if alpha < 1:
        material.surface_render_method = "DITHERED"
        material.use_transparency_overlap = False
    return material


def create_empty(name: str, parent: bpy.types.Object | None = None) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.empty_display_type = "PLAIN_AXES"
    if parent is not None:
        obj.parent = parent
    return obj


def apply_scale(obj: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)


def create_box(
    parent: bpy.types.Object,
    name: str,
    size: tuple[float, float, float] | list[float],
    position: tuple[float, float, float] | list[float],
    material: bpy.types.Material,
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1, location=runtime_to_blender(position))
    obj = bpy.context.object
    obj.name = name
    obj.scale = (float(size[0]), float(size[2]), float(size[1]))
    apply_scale(obj)
    obj.parent = parent
    obj.data.materials.append(material)
    if bevel > 0:
        modifier = obj.modifiers.new("restrained_edge_round", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
        modifier.limit_method = "ANGLE"
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    return obj


def create_arrow(parent: bpy.types.Object, material: bpy.types.Material) -> bpy.types.Object:
    outline = [(-0.18, -0.03), (-0.07, -0.03), (-0.07, -0.19), (0.07, -0.19), (0.07, -0.03), (0.18, -0.03), (0.0, 0.17)]
    half_thickness = 0.012
    runtime_vertices = [(x, y, z) for y in (-half_thickness, half_thickness) for x, z in outline]
    vertices = [runtime_to_blender(vertex) for vertex in runtime_vertices]
    count = len(outline)
    faces = [tuple(range(count)), tuple(range(count, 2 * count))[::-1]]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, next_index + count, index + count))
    mesh = bpy.data.meshes.new("feed_arrow_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("feed_arrow", mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    obj.data.materials.append(material)
    return obj


def create_bell(parent: bpy.types.Object, brass: bpy.types.Material, dark: bpy.types.Material) -> None:
    profile = [
        (0.09, -0.30),
        (0.25, -0.27),
        (0.34, -0.18),
        (0.38, -0.05),
        (0.31, 0.10),
        (0.21, 0.22),
        (0.12, 0.28),
        (0.10, 0.34),
    ]
    segments = 24
    runtime_vertices: list[tuple[float, float, float]] = []
    for segment in range(segments):
        angle = segment * 2 * math.pi / segments
        for radius, y in profile:
            runtime_vertices.append((radius * math.cos(angle), y, radius * math.sin(angle)))
    faces: list[tuple[int, ...]] = []
    rings = len(profile)
    for segment in range(segments):
        next_segment = (segment + 1) % segments
        for ring in range(rings - 1):
            a = segment * rings + ring
            b = next_segment * rings + ring
            faces.append((a, b, b + 1, a + 1))
    mesh = bpy.data.meshes.new("combo_bell_mesh")
    mesh.from_pydata([runtime_to_blender(vertex) for vertex in runtime_vertices], [], faces)
    mesh.update()
    bell = bpy.data.objects.new("combo_bell_body", mesh)
    bpy.context.collection.objects.link(bell)
    bell.parent = parent
    bell.data.materials.append(brass)
    create_box(parent, "combo_bell_clapper", (0.12, 0.18, 0.12), (0, -0.28, 0), dark, 0.025)
    create_box(parent, "combo_bell_crown", (0.16, 0.12, 0.16), (0, 0.39, 0), brass, 0.035)


def author(spec: dict, blend_path: Path, glb_path: Path) -> None:
    clear_scene()
    palette = spec["materials"]
    materials = {
        "teal": create_material("teal_enamel", palette["teal"], 0.16, 0.42),
        "teal_dark": create_material("teal_shadow_enamel", palette["tealDark"], 0.12, 0.54),
        "teal_edge": create_material("teal_edge_enamel", palette["tealEdge"], 0.14, 0.38),
        "recess": create_material("dark_neutral_recess", palette["recess"], 0.08, 0.64),
        "brass": create_material("brass_hardware", palette["brass"], 0.68, 0.29),
        "brass_bright": create_material("brass_face", palette["brassBright"], 0.62, 0.25),
        "steel": create_material("readable_steel", palette["steel"], 0.76, 0.28),
        "steel_dark": create_material("dark_steel", palette["steelDark"], 0.70, 0.38),
        "glass": create_material("tinted_guard", palette["glass"], 0.05, 0.18, 0.18),
    }
    machine = spec["machine"]
    shelf = spec["shelf"]
    shell_spec = spec["shell"]
    tray = spec["tray"]
    collection = spec["collection"]

    root = create_empty("critpusher_cabinet")
    root["coordinate_contract"] = spec["coordinates"]
    root["asset_spec_version"] = spec["version"]

    shell = create_empty("cabinet_shell", root)
    post_depth = shell_spec["frontZ"] - shell_spec["rearZ"]
    post_y = (shell_spec["postBottom"] + shell_spec["postTop"]) / 2
    post_height = shell_spec["postTop"] - shell_spec["postBottom"]
    post_z = (shell_spec["frontZ"] + shell_spec["rearZ"]) / 2
    for side, sign in (("left", -1), ("right", 1)):
        create_box(
            shell,
            f"cabinet_{side}_post",
            (shell_spec["postWidth"], post_height, post_depth),
            (sign * shell_spec["postCenterX"], post_y, post_z),
            materials["teal"],
            0.07,
        )
    create_box(shell, "cabinet_base", shell_spec["baseSize"], shell_spec["basePosition"], materials["teal_dark"], 0.08)
    create_box(shell, "cabinet_rear_recess", (10.4, 2.55, 0.34), (0, 1.275, machine["physicalRearWallZ"] - 0.23), materials["recess"], 0.035)
    create_box(shell, "cabinet_header", (11.8, 0.4, 1.1), (0, 4.45, machine["physicalRearWallZ"] - 0.35), materials["teal"], 0.08)
    create_box(shell, "cabinet_header_inlay", (8.8, 0.13, 0.05), (0, 4.44, machine["physicalRearWallZ"] + 0.22), materials["brass"], 0.02)
    for index, x in enumerate((-3.35, 0.0, 3.35), start=1):
        mount = create_empty(f"sticker_mount_{index}", shell)
        mount.location = runtime_to_blender((x, 4.45, machine["physicalRearWallZ"] + 0.31))

    playfield = create_empty("playfield", root)
    create_box(playfield, "playfield_shelf", (machine["shelfHalfWidth"] * 2, machine["shelfThickness"], shelf["depth"]), (0, machine["shelfCenterY"], shelf["centerZ"]), materials["teal_dark"])
    create_box(playfield, "playfield_surface", (machine["shelfHalfWidth"] * 2 - 0.16, 0.012, shelf["surfaceDepth"]), (0, 0.006, shelf["surfaceCenterZ"]), materials["brass_bright"])
    create_box(playfield, "playfield_left_guard", (machine["sideWallThickness"], machine["wallHeight"], shelf["depth"]), (-machine["sideWallX"], machine["wallCenterY"], shelf["centerZ"]), materials["glass"])
    create_box(playfield, "playfield_right_guard", (machine["sideWallThickness"], machine["wallHeight"], shelf["depth"]), (machine["sideWallX"], machine["wallCenterY"], shelf["centerZ"]), materials["glass"])
    create_box(playfield, "playfield_rear_guard", (machine["shelfHalfWidth"] * 2 + machine["sideWallThickness"], machine["wallHeight"], machine["rearWallThickness"]), (0, machine["wallCenterY"], machine["physicalRearWallZ"]), materials["glass"])

    pusher = create_empty("pusher", root)
    create_box(pusher, "pusher_body", (machine["pusherWidth"], machine["pusherHeight"], machine["pusherDepth"]), (0, machine["pusherCenterY"], machine["pusherCenterZ"]), materials["steel"])
    create_box(pusher, "pusher_leading_edge", (machine["pusherWidth"], 0.10, 0.08), (0, machine["pusherTop"] - 0.08, machine["pusherFrontOffset"] - 0.04), materials["steel_dark"], 0.015)

    collection_module = create_empty("collection_tray", root)
    create_box(collection_module, "collection_body", collection["bodySize"], collection["bodyPosition"], materials["recess"], 0.06)
    create_box(collection_module, "collection_bed", collection["bedSize"], collection["bedPosition"], materials["teal_edge"], 0.03)
    create_box(collection_module, "collection_rear_lip", collection["rearLipSize"], collection["rearLipPosition"], materials["brass"], 0.025)
    create_box(collection_module, "collection_front_apron", collection["frontApronSize"], collection["frontApronPosition"], materials["teal"], 0.05)
    for side, sign in (("left", -1), ("right", 1)):
        create_box(collection_module, f"collection_{side}_rail", collection["sideSize"], (sign * 5.06, -1.26, collection["sideZ"]), materials["brass"], 0.035)

    rail = create_empty("feed_rail", root)
    create_box(rail, "feed_rear_floor", (tray["width"], tray["floorThickness"], tray["rearFloorLength"]), (0, tray["localBaseY"], tray["rearFloorCenterZ"]), materials["steel_dark"])
    create_box(rail, "feed_front_floor", (tray["width"], tray["floorThickness"], tray["frontFloorLength"]), (0, tray["localBaseY"], tray["frontFloorCenterZ"]), materials["steel_dark"])
    front_floor_open = create_box(rail, "feed_front_floor_open_reference", (tray["width"], tray["floorThickness"], tray["frontFloorLength"]), tray["open"]["frontFloorPosition"], materials["steel_dark"])
    front_floor_open.rotation_euler.x = -tray["open"]["frontFloorRotationX"]
    wall_depth = tray["localFrontZ"] - tray["localRearZ"]
    create_box(rail, "feed_left_rail", (tray["wallThickness"], tray["lipHeight"], wall_depth), (-tray["sideWallCenterX"], tray["wallCenterY"], tray["localCenterZ"]), materials["brass"])
    create_box(rail, "feed_right_rail", (tray["wallThickness"], tray["lipHeight"], wall_depth), (tray["sideWallCenterX"], tray["wallCenterY"], tray["localCenterZ"]), materials["brass"])
    create_box(rail, "feed_rear_stop", (tray["width"], tray["lipHeight"], tray["wallThickness"]), (0, tray["wallCenterY"], tray["localRearZ"] + tray["wallThickness"] / 2), materials["brass"])
    arrow = create_arrow(rail, materials["brass_bright"])
    arrow.location = runtime_to_blender((0, tray["localBaseY"] + 0.038, tray["localArrowZ"]))

    gate = create_empty("feed_gate", root)
    create_box(gate, "feed_trapdoor", (tray["width"], tray["floorThickness"], tray["trapdoorLength"]), (0, tray["localBaseY"], tray["trapdoorCenterZ"]), materials["steel_dark"])
    create_box(gate, "feed_front_stop", (tray["width"], tray["lipHeight"], tray["wallThickness"]), (0, tray["wallCenterY"], tray["frontStopZ"]), materials["brass"])
    trap_open = create_box(gate, "feed_trapdoor_open_reference", (tray["width"], tray["floorThickness"], tray["trapdoorLength"]), tray["open"]["trapdoorPosition"], materials["steel_dark"])
    trap_open.rotation_euler.x = -tray["open"]["trapdoorRotationX"]
    stop_open = create_box(gate, "feed_front_stop_open_reference", (tray["width"], tray["lipHeight"], tray["wallThickness"]), tray["open"]["frontStopPosition"], materials["brass"])
    stop_open.rotation_euler.x = -tray["open"]["frontStopRotationX"]
    create_box(gate, "feed_gate_hinge", (tray["width"] + 0.10, 0.07, 0.07), (0, tray["localBaseY"] - 0.03, tray["trapRearZ"]), materials["brass"], 0.02)
    create_box(gate, "feed_gate_actuator", (0.10, 0.19, 0.14), (tray["sideWallCenterX"] + 0.08, tray["localBaseY"] - 0.08, tray["trapRearZ"] + 0.06), materials["brass"], 0.02)
    for holdback in tray["holdbacks"]:
        slot = holdback["slot"]
        create_box(
            gate,
            f"feed_upper_stop_{slot}",
            holdback["size"],
            holdback["position"],
            materials["brass"],
        )
        holdback_open = create_box(
            gate,
            f"feed_upper_stop_{slot}_open_reference",
            holdback["size"],
            holdback["openPosition"],
            materials["brass"],
        )
        holdback_open["runtime_pose_reference"] = True

    cover = create_empty("feed_cover", root)
    create_box(cover, "feed_cover_plate", (tray["width"], tray["coverThickness"], tray["coverDepth"]), (0, tray["coverY"], tray["coverCenterZ"]), materials["glass"])
    create_box(cover, "feed_cover_rear_mount", (tray["width"] + 0.08, 0.08, 0.08), (0, tray["coverY"] + 0.015, tray["localRearZ"] + 0.04), materials["brass"], 0.02)

    bell_module = create_empty("combo_bell", root)
    create_bell(bell_module, materials["brass_bright"], materials["steel_dark"])

    for module_name in ("feed_rail", "feed_gate", "feed_cover", "combo_bell"):
        bpy.data.objects[module_name]["runtime_prototype"] = True

    blend_path.parent.mkdir(parents=True, exist_ok=True)
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), check_existing=False)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    print(f"Authored {blend_path}")
    print(f"Exported {glb_path} ({glb_path.stat().st_size} bytes)")


def hierarchy_has(module: bpy.types.Object, child_name: str) -> bool:
    return any(child.name == child_name for child in module.children_recursive)


def runtime_bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    points = [blender_to_runtime(obj.matrix_world @ vertex.co) for vertex in obj.data.vertices]
    return (
        Vector(tuple(min(point[index] for point in points) for index in range(3))),
        Vector(tuple(max(point[index] for point in points) for index in range(3))),
    )


def assert_near(actual: float, expected: float, tolerance: float, label: str) -> None:
    if abs(actual - expected) > tolerance:
        raise RuntimeError(f"{label}: expected {expected:.5f}, got {actual:.5f}")


def assert_box(name: str, size: list[float] | tuple[float, float, float], center: list[float] | tuple[float, float, float], tolerance: float) -> None:
    obj = bpy.data.objects.get(name)
    if obj is None or obj.type != "MESH":
        raise RuntimeError(f"Missing mesh node: {name}")
    minimum, maximum = runtime_bounds(obj)
    actual_size = maximum - minimum
    actual_center = (maximum + minimum) * 0.5
    for axis, axis_name in enumerate("xyz"):
        assert_near(actual_size[axis], float(size[axis]), tolerance, f"{name} {axis_name} size")
        assert_near(actual_center[axis], float(center[axis]), tolerance, f"{name} {axis_name} center")


def validate_names(spec: dict) -> None:
    for name in spec["requiredModules"]:
        if bpy.data.objects.get(name) is None:
            raise RuntimeError(f"Missing required module: {name}")
    expected_children = {
        "feed_rail": ("feed_rear_floor", "feed_front_floor", "feed_front_floor_open_reference", "feed_left_rail", "feed_right_rail", "feed_rear_stop", "feed_arrow"),
        "feed_gate": (
            "feed_trapdoor",
            "feed_front_stop",
            "feed_trapdoor_open_reference",
            "feed_front_stop_open_reference",
            "feed_upper_stop_1",
            "feed_upper_stop_1_open_reference",
            "feed_upper_stop_2",
            "feed_upper_stop_2_open_reference",
            "feed_upper_stop_3",
            "feed_upper_stop_3_open_reference",
            "feed_upper_stop_4",
            "feed_upper_stop_4_open_reference",
        ),
        "feed_cover": ("feed_cover_plate",),
        "combo_bell": ("combo_bell_body",),
    }
    for module_name, children in expected_children.items():
        module = bpy.data.objects[module_name]
        for child_name in children:
            if not hierarchy_has(module, child_name):
                raise RuntimeError(f"{child_name} is not nested under {module_name}")


def validate_glb(spec: dict, glb_path: Path) -> None:
    tolerance = float(spec["budgets"]["tolerance"])
    if glb_path.stat().st_size > int(spec["budgets"]["glbBytes"]):
        raise RuntimeError(f"GLB exceeds {spec['budgets']['glbBytes']} byte budget")
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    validate_names(spec)

    triangles = 0
    for obj in bpy.data.objects:
        matrix_values = [value for row in obj.matrix_world for value in row]
        if not all(math.isfinite(value) for value in matrix_values):
            raise RuntimeError(f"Nonfinite transform on {obj.name}")
        for value in obj.scale:
            assert_near(value, 1.0, 1e-5, f"{obj.name} unit scale")
        if obj.type == "MESH":
            triangles += sum(max(1, len(polygon.vertices) - 2) for polygon in obj.data.polygons)
    if triangles > int(spec["budgets"]["triangles"]):
        raise RuntimeError(f"Asset has {triangles} triangles, budget is {spec['budgets']['triangles']}")

    machine = spec["machine"]
    shelf = spec["shelf"]
    tray = spec["tray"]
    assert_box("playfield_shelf", [machine["shelfHalfWidth"] * 2, machine["shelfThickness"], shelf["depth"]], [0, machine["shelfCenterY"], shelf["centerZ"]], tolerance)
    assert_box("playfield_left_guard", [machine["sideWallThickness"], machine["wallHeight"], shelf["depth"]], [-machine["sideWallX"], machine["wallCenterY"], shelf["centerZ"]], tolerance)
    assert_box("playfield_right_guard", [machine["sideWallThickness"], machine["wallHeight"], shelf["depth"]], [machine["sideWallX"], machine["wallCenterY"], shelf["centerZ"]], tolerance)
    assert_box("playfield_rear_guard", [machine["shelfHalfWidth"] * 2 + machine["sideWallThickness"], machine["wallHeight"], machine["rearWallThickness"]], [0, machine["wallCenterY"], machine["physicalRearWallZ"]], tolerance)
    assert_box("pusher_body", [machine["pusherWidth"], machine["pusherHeight"], machine["pusherDepth"]], [0, machine["pusherCenterY"], machine["pusherCenterZ"]], tolerance)
    assert_box("feed_trapdoor", [tray["width"], tray["floorThickness"], tray["trapdoorLength"]], [0, tray["localBaseY"], tray["trapdoorCenterZ"]], tolerance)
    assert_box("feed_front_stop", [tray["width"], tray["lipHeight"], tray["wallThickness"]], [0, tray["wallCenterY"], tray["frontStopZ"]], tolerance)
    assert_box(
        "feed_front_floor",
        [tray["width"], tray["floorThickness"], tray["frontFloorLength"]],
        [0, tray["localBaseY"], tray["frontFloorCenterZ"]],
        tolerance,
    )
    for holdback in tray["holdbacks"]:
        assert_box(
            f"feed_upper_stop_{holdback['slot']}",
            holdback["size"],
            holdback["position"],
            tolerance,
        )

    collection_meshes = [obj for obj in bpy.data.objects if obj.type == "MESH" and obj.name.startswith("collection_")]
    collection_top = max(runtime_bounds(obj)[1].y for obj in collection_meshes)
    if collection_top >= machine["collectionY"] - tolerance:
        raise RuntimeError(f"Collection tray top {collection_top:.4f} reaches catch detector {machine['collectionY']:.4f}")

    trap_open = bpy.data.objects["feed_trapdoor_open_reference"]
    stop_open = bpy.data.objects["feed_front_stop_open_reference"]
    trap_open_bounds = runtime_bounds(trap_open)
    stop_open_bounds = runtime_bounds(stop_open)
    if trap_open_bounds[1].y >= tray["localBaseY"] - tolerance:
        raise RuntimeError("Open trapdoor still occupies the closed floor plane")
    if stop_open_bounds[1].y >= tray["wallCenterY"] - tolerance:
        raise RuntimeError("Open front stop still occupies the closed outlet height")
    assert_box("feed_trapdoor_open_reference", [tray["width"], tray["trapdoorLength"], tray["floorThickness"]], tray["open"]["trapdoorPosition"], tolerance)
    assert_box("feed_front_stop_open_reference", [tray["width"], tray["wallThickness"], tray["lipHeight"]], tray["open"]["frontStopPosition"], tolerance)
    assert_box("feed_front_floor_open_reference", [tray["width"], tray["frontFloorLength"], tray["floorThickness"]], tray["open"]["frontFloorPosition"], tolerance)
    if runtime_bounds(bpy.data.objects["feed_front_floor_open_reference"])[1].y >= tray["localBaseY"] - tolerance:
        raise RuntimeError("Open front floor still occupies the outlet plane")
    for holdback in tray["holdbacks"]:
        open_bounds = runtime_bounds(bpy.data.objects[f"feed_upper_stop_{holdback['slot']}_open_reference"])
        if open_bounds[0].x <= tray["width"] / 2 + tolerance:
            raise RuntimeError(f"Open upper stop {holdback['slot']} still occupies the rail corridor")

    if any(image.source == "FILE" and image.filepath for image in bpy.data.images):
        raise RuntimeError("Cabinet GLB must not depend on external textures")

    all_meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    all_bounds = [runtime_bounds(obj) for obj in all_meshes]
    minimum = Vector(tuple(min(bounds[0][axis] for bounds in all_bounds) for axis in range(3)))
    maximum = Vector(tuple(max(bounds[1][axis] for bounds in all_bounds) for axis in range(3)))
    print(f"Cabinet check passed: {triangles} triangles, {glb_path.stat().st_size} bytes")
    print(f"Runtime envelope: min={tuple(round(value, 4) for value in minimum)}, max={tuple(round(value, 4) for value in maximum)}")


def check(spec: dict, blend_path: Path, glb_path: Path) -> None:
    if not blend_path.is_file():
        raise RuntimeError(f"Missing authored Blender file: {blend_path}")
    if not glb_path.is_file():
        raise RuntimeError(f"Missing exported GLB: {glb_path}")
    bpy.ops.wm.open_mainfile(filepath=str(blend_path))
    validate_names(spec)
    validate_glb(spec, glb_path)


def main() -> None:
    args = parse_args()
    with args.spec.open("r", encoding="utf-8") as handle:
        spec = json.load(handle)
    if args.mode == "build":
        author(spec, args.blend, args.glb)
    else:
        check(spec, args.blend, args.glb)


if __name__ == "__main__":
    main()
