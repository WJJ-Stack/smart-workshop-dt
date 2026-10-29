"""探测 Blender 5.2 的 glTF 导出器参数与关键 API 可用性。

这是管线开发的标准做法：不猜 API，先枚举真实签名。
运行: blender -b -P tools/blender/probe.py
"""
import bpy
import sys
import inspect

print("=" * 70)
print("BLENDER:", bpy.app.version_string)
print("=" * 70)

# --- glTF 导出器参数 ---
props = bpy.ops.export_scene.gltf.get_rna_type().properties
names = sorted(p.identifier for p in props if p.identifier != "rna_type")
print(f"\n[glTF exporter] {len(names)} params")

KEY = [
    "export_format", "export_draco_mesh_compression_enable",
    "export_draco_mesh_compression_level", "export_apply", "export_yup",
    "export_animations", "export_animation_mode", "export_nla_strips",
    "export_extras", "export_cameras", "export_lights", "use_selection",
    "use_visible", "use_active_collection", "export_materials",
    "export_image_format", "export_texture_dir", "export_normals",
    "export_tangents", "export_texcoords", "export_skins",
    "export_def_bones", "export_optimize_animation_size",
    "export_optimize_animation_keep_anim_armature",
    "export_frame_range", "export_current_frame", "export_hierarchy_flatten_objs",
    "export_gn_mesh", "export_try_sparse_sk", "export_gpu_instances",
    "export_use_gltfpack", "export_gltfpack_tc", "export_shared_accessors",
    "export_import_convert_lighting_mode", "will_save_settings",
]
print("\n[关键参数是否存在]")
for k in KEY:
    print(f"  {'OK ' if k in names else 'NO '} {k}")

# --- 导出器的枚举可选值 ---
print("\n[export_format 可选值]")
for p in props:
    if p.identifier == "export_format" and hasattr(p, "enum_items"):
        print("  ", [e.identifier for e in p.enum_items])
    if p.identifier == "export_animation_mode" and hasattr(p, "enum_items"):
        print("  animation_mode:", [e.identifier for e in p.enum_items])

# --- Draco 是否可用 ---
print("\n[Draco]")
try:
    addon = "io_scene_gltf2"
    print("  addon present:", addon in bpy.context.preferences.addons)
except Exception as e:
    print("  err", e)

# --- 关键模块 ---
print("\n[Modules]")
for mod in ("bpy_extras.io_utils", "mathutils", "bmesh"):
    try:
        __import__(mod)
        print(f"  OK  {mod}")
    except Exception as e:
        print(f"  NO  {mod}: {e}")

# --- 可用的网格操作 ---
print("\n[Modifiers available]")
print("  DECIMATE:", "DECIMATE" in [i.identifier for i in bpy.types.Modifier.bl_rna.properties['type'].enum_items])

# --- KTX2 / basis 支持 ---
print("\n[Numpy in blender python]")
try:
    import numpy as np
    print("  numpy", np.__version__)
except Exception as e:
    print("  no numpy:", e)

print("\nDONE")
