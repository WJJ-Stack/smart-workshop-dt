"""Blender 参数化建模工具库。

命名约定（前端强依赖，不可随意改动）：
    EQ_<entity>            实体根节点（Empty），承载实体级元数据
    P_<entity>__<part>     实体部件（Mesh），可被独立拾取/高亮
    ENV_<name>             环境件（墙体/地面/围栏等，不参与业务拾取）

元数据统一写进 object["dt"] 字典（JSON 可序列化），
导出时通过 export_extras=True 变成 glTF node.extras → three.js userData.dt。
"""
from __future__ import annotations

import json
import math
import os
from typing import Iterable, Sequence

import bpy
from mathutils import Euler, Vector

# ---------------------------------------------------------------- 场景重置


def reset_scene(*, purge_materials: bool = False) -> None:
    """清空场景到可预测状态（不依赖 --factory-startup 也安全）。

    注意：默认保留材质（材质带 fake user），因为管线里会反复
    「重置场景 → 重新建模 → 导出」，材质只需创建一次。
    """
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=True, confirm=False)

    for coll in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.actions,
        bpy.data.node_groups,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.images,
    ):
        for block in list(coll):
            if block.users == 0 and not block.use_fake_user:
                coll.remove(block)

    if purge_materials:
        for block in list(bpy.data.materials):
            if not block.use_fake_user:
                bpy.data.materials.remove(block)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 30


# ---------------------------------------------------------------- 集合管理


def get_collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(coll)
    return coll


def move_to_collection(obj: bpy.types.Object, coll: bpy.types.Collection) -> None:
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)


# ---------------------------------------------------------------- 元数据


def set_dt(obj: bpy.types.Object, **kwargs) -> None:
    """写入 dt 元数据。值为 None 的键会被忽略，避免脏数据进 glTF。"""
    current = obj.get("dt")
    data: dict = json.loads(current) if isinstance(current, str) else {}
    for key, value in kwargs.items():
        if value is not None:
            data[key] = value
    obj["dt"] = json.dumps(data, ensure_ascii=False)


def get_dt(obj: bpy.types.Object) -> dict:
    raw = obj.get("dt")
    return json.loads(raw) if isinstance(raw, str) else {}


# ---------------------------------------------------------------- 变换工具


def apply_transform(obj: bpy.types.Object, *, scale: bool = True, rot: bool = True) -> None:
    deselect_all()
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=rot, scale=scale)


def deselect_all() -> None:
    for o in bpy.context.view_layer.objects:
        o.select_set(False)


def join(objects: Sequence[bpy.types.Object], name: str) -> bpy.types.Object:
    """合并多个 mesh，返回合并后的对象（保留第一个对象的材质槽顺序）。"""
    objects = [o for o in objects if o and o.type == "MESH"]
    if not objects:
        raise ValueError(f"join('{name}') 没有可合并的网格")
    deselect_all()
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    result = bpy.context.view_layer.objects.active
    result.name = name
    result.data.name = f"{name}_mesh"
    return result


def add_bevel(obj: bpy.types.Object, width: float = 0.02, segments: int = 2, angle: float = 40) -> None:
    """倒角。工业设备没有绝对锐利的边，这一步对真实感提升最大。"""
    if width <= 0:
        return
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    mod.harden_normals = False
    apply_modifier(obj, "Bevel")


def apply_modifier(obj: bpy.types.Object, name: str) -> None:
    deselect_all()
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=name)


def set_shading(obj: bpy.types.Object, smooth: bool = True, auto_smooth_angle: float = 35) -> None:
    deselect_all()
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if smooth:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(auto_smooth_angle))
    else:
        bpy.ops.object.shade_flat()


# ---------------------------------------------------------------- 基础几何体
# 全部返回新对象，坐标以「中心点」为锚，尺寸为真实米制。


def box(
    name: str,
    size: tuple[float, float, float],
    loc: tuple[float, float, float] = (0, 0, 0),
    rot: tuple[float, float, float] = (0, 0, 0),
    material: bpy.types.Material | None = None,
    bevel: float = 0.015,
    bevel_segments: int = 2,
    coll: bpy.types.Collection | None = None,
    origin_bottom: bool = False,
) -> bpy.types.Object:
    sx, sy, sz = size
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.scale = (sx, sy, sz)
    obj.rotation_euler = Euler(rot, "XYZ")
    apply_transform(obj)
    if origin_bottom:
        shift_origin_to_bottom(obj, sz)
    if bevel > 0:
        add_bevel(obj, min(bevel, min(size) * 0.24), bevel_segments)
    if material:
        assign_material(obj, material)
    if coll:
        move_to_collection(obj, coll)
    return obj


def cylinder(
    name: str,
    radius: float,
    depth: float,
    loc: tuple[float, float, float] = (0, 0, 0),
    rot: tuple[float, float, float] = (0, 0, 0),
    material: bpy.types.Material | None = None,
    verts: int = 32,
    coll: bpy.types.Collection | None = None,
    bevel: float = 0.008,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=verts, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.rotation_euler = Euler(rot, "XYZ")
    apply_transform(obj)
    if bevel > 0:
        add_bevel(obj, min(bevel, radius * 0.3, depth * 0.24), 2)
    set_shading(obj, smooth=True, auto_smooth_angle=32)
    if material:
        assign_material(obj, material)
    if coll:
        move_to_collection(obj, coll)
    return obj


def tube(
    name: str,
    points: Iterable[Sequence[float]],
    radius: float,
    material: bpy.types.Material | None = None,
    coll: bpy.types.Collection | None = None,
    resolution: int = 6,
) -> bpy.types.Object:
    """沿折线生成管道（电缆槽、气管、导轨）。"""
    curve = bpy.data.curves.new(f"{name}_curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = resolution
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    pts = list(points)
    spline.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        spline.points[i].co = (p[0], p[1], p[2], 1.0)
    obj = bpy.data.objects.new(name, curve)
    (coll or bpy.context.scene.collection).objects.link(obj)
    if material:
        assign_material(obj, material)
    return obj


def curve_to_mesh(obj: bpy.types.Object) -> bpy.types.Object:
    deselect_all()
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    return bpy.context.view_layer.objects.active


def plane(
    name: str,
    size: tuple[float, float],
    loc: tuple[float, float, float] = (0, 0, 0),
    material: bpy.types.Material | None = None,
    coll: bpy.types.Collection | None = None,
    uv_scale: tuple[float, float] = (1, 1),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.scale = (size[0], size[1], 1)
    apply_transform(obj)
    if uv_scale != (1, 1):
        scale_uv(obj, uv_scale)
    if material:
        assign_material(obj, material)
    if coll:
        move_to_collection(obj, coll)
    return obj


def scale_uv(obj: bpy.types.Object, factor: tuple[float, float]) -> None:
    """直接缩放 UV（比 Mapping 节点更可控，且不依赖 KHR_texture_transform）。"""
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv = mesh.uv_layers.active
    if uv is None:
        return
    for i in range(len(uv.data)):
        u, v = uv.data[i].uv
        uv.data[i].uv = (u * factor[0], v * factor[1])


def shift_origin_to_bottom(obj: bpy.types.Object, height: float) -> None:
    """把原点移到物体底部中心，便于「放在地面上」这类摆位。"""
    offset = Vector((0, 0, -height * 0.5))
    mesh = obj.data
    for v in mesh.vertices:
        v.co += offset
    obj.location.z += height * 0.5


# ---------------------------------------------------------------- 材质


def assign_material(obj: bpy.types.Object, material: bpy.types.Material) -> None:
    if obj.data and hasattr(obj.data, "materials"):
        if len(obj.data.materials) == 0:
            obj.data.materials.append(material)
        else:
            obj.data.materials[0] = material


def assign_materials(obj: bpy.types.Object, materials: list[bpy.types.Material]) -> None:
    obj.data.materials.clear()
    for m in materials:
        obj.data.materials.append(m)


# ---------------------------------------------------------------- 层级


def empty(
    name: str,
    loc: tuple[float, float, float] = (0, 0, 0),
    coll: bpy.types.Collection | None = None,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 0.4
    obj.empty_display_type = "PLAIN_AXES"
    obj.location = loc
    (coll or bpy.context.scene.collection).objects.link(obj)
    if parent:
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    return obj


def parent_keep_transform(child: bpy.types.Object, parent: bpy.types.Object) -> None:
    """挂父级但保留子对象的世界变换。

    适用场景：子对象已经按**世界坐标**摆好位置（如机械臂各级关节），
    挂接后视觉位置不变。
    """
    world = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()
    child.matrix_world = world


def parent_local(child: bpy.types.Object, parent: bpy.types.Object) -> None:
    """挂父级，子对象坐标解释为**父级局部坐标**（不保留世界变换）。

    适用场景：设备部件是按「相对设备原点」的局部坐标建出来的，
    需要跟随设备根节点的位移/旋转。
    这是默认应该用的那个 —— parent_keep_transform 只在部件已按世界
    坐标定位时才正确，用错会导致所有设备堆在原点。
    """
    child.parent = parent
    child.matrix_parent_inverse.identity()


# ---------------------------------------------------------------- 动画


def ensure_action(obj: bpy.types.Object, action_name: str) -> bpy.types.Action:
    """为对象准备一个指定名字的 action。

    关键：glTF 导出器按 action 名字合并动画。
    同名 action 会合成同一个 AnimationClip，正是我们需要的。
    """
    if obj.animation_data is None:
        obj.animation_data_create()
    action = bpy.data.actions.get(action_name)
    if action is None:
        action = bpy.data.actions.new(action_name)
        action.use_fake_user = True
    obj.animation_data.action = action
    return action


def key_rotation(
    obj: bpy.types.Object,
    frame: int,
    euler_deg: tuple[float, float, float],
    action_name: str | None = None,
) -> None:
    if action_name:
        ensure_action(obj, action_name)
    obj.rotation_mode = "XYZ"
    obj.rotation_euler = Euler([math.radians(a) for a in euler_deg], "XYZ")
    obj.keyframe_insert("rotation_euler", frame=frame)


def key_location(
    obj: bpy.types.Object,
    frame: int,
    loc: tuple[float, float, float],
    action_name: str | None = None,
) -> None:
    if action_name:
        ensure_action(obj, action_name)
    obj.location = loc
    obj.keyframe_insert("location", frame=frame)


def set_interpolation(obj: bpy.types.Object, action_name: str, interpolation: str = "BEZIER") -> None:
    action = bpy.data.actions.get(action_name)
    if action is None:
        return
    curves: list = []
    # Blender 4.4+ 使用 slotted actions，fcurves 可能在 layer/strip 里
    if hasattr(action, "layers") and len(action.layers) > 0:
        for layer in action.layers:
            for strip in layer.strips:
                if hasattr(strip, "channelbags"):
                    for bag in strip.channelbags:
                        curves.extend(bag.fcurves)
    if not curves and hasattr(action, "fcurves"):
        curves = list(action.fcurves)
    for fc in curves:
        for kp in fc.keyframe_points:
            kp.interpolation = interpolation


# ---------------------------------------------------------------- 导出


def export_glb(
    filepath: str,
    *,
    use_selection: bool = False,
    draco: bool = True,
    draco_level: int = 6,
    animations: bool = True,
    extras: bool = True,
) -> str:
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    kwargs = dict(
        filepath=filepath,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_normals=True,
        export_tangents=False,
        export_texcoords=True,
        export_extras=extras,
        export_cameras=False,
        export_lights=False,
        export_animations=animations,
        export_animation_mode="ACTIONS",
        export_optimize_animation_size=True,
        export_frame_range=False,
        export_use_selection=use_selection,
        use_selection=use_selection,
        export_draco_mesh_compression_enable=draco,
        export_draco_mesh_compression_level=draco_level,
        export_def_bones=False,
        export_skins=False,
    )
    # 去掉不存在的键，避免 TypeError
    rna = bpy.ops.export_scene.gltf.get_rna_type().properties
    valid = {p.identifier for p in rna}
    kwargs = {k: v for k, v in kwargs.items() if k in valid}
    bpy.ops.export_scene.gltf(**kwargs)
    return filepath


def report_scene_stats(label: str) -> dict:
    tris = 0
    verts = 0
    meshes = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        meshes += 1
        mesh = obj.data
        verts += len(mesh.vertices)
        mesh.calc_loop_triangles()
        tris += len(mesh.loop_triangles)
    stats = {"label": label, "meshes": meshes, "vertices": verts, "triangles": tris}
    print(
        f"[STATS] {label}: meshes={meshes} verts={verts:,} tris={tris:,}"
    )
    return stats


def print_done() -> None:
    print("=" * 60)
    print("BUILD COMPLETE")
    print("=" * 60)
