"""材质库：全部为 PBR (Principled BSDF)，导出后在 three.js 中直接对应
MeshStandardMaterial / MeshPhysicalMaterial。

设计原则：
1. 命名稳定（MAT_xxx），前端需要按名字切换状态材质（如故障红）；
2. 参数取真实工程值：金属 0.9~1.0，喷漆 0.0~0.1，橡胶 0.0；
3. 发光件单独材质，前端可用 emissiveIntensity 做状态脉冲。
"""
from __future__ import annotations

import bpy


def _principled(name: str, **kwargs) -> bpy.types.Material:
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        return mat

    def put(key: str, value) -> None:
        sock = bsdf.inputs.get(key)
        if sock is not None:
            sock.default_value = value

    base = kwargs.get("base", (0.5, 0.5, 0.5))
    put("Base Color", (*base, 1.0))
    put("Metallic", kwargs.get("metallic", 0.0))
    put("Roughness", kwargs.get("roughness", 0.5))
    put("IOR", kwargs.get("ior", 1.45))

    if "emission" in kwargs:
        # 4.x 叫 'Emission Color'，旧版叫 'Emission'
        put("Emission Color", (*kwargs["emission"], 1.0))
        put("Emission", (*kwargs["emission"], 1.0))
        put("Emission Strength", kwargs.get("emission_strength", 1.0))

    if kwargs.get("alpha", 1.0) < 1.0:
        put("Alpha", kwargs["alpha"])
        mat.blend_method = "BLEND"
        if hasattr(mat, "shadow_method"):
            mat.shadow_method = "HASHED"

    if kwargs.get("coat", 0.0) > 0:
        put("Coat Weight", kwargs["coat"])
        put("Coat Roughness", kwargs.get("coat_roughness", 0.08))

    if kwargs.get("transmission", 0.0) > 0:
        put("Transmission Weight", kwargs["transmission"])

    mat.use_backface_culling = False
    mat.use_fake_user = True
    return mat


# ---------------------------------------------------------------- 建筑


def floor_concrete() -> bpy.types.Material:
    return _principled("MAT_FloorConcrete", base=(0.235, 0.238, 0.245), roughness=0.72, metallic=0.0)


def floor_epoxy() -> bpy.types.Material:
    """环氧地坪：车间主地面，带一点清漆光泽。"""
    return _principled(
        "MAT_FloorEpoxy", base=(0.115, 0.132, 0.152), roughness=0.34, metallic=0.05, coat=0.35
    )


def wall_panel() -> bpy.types.Material:
    return _principled("MAT_WallPanel", base=(0.395, 0.415, 0.44), roughness=0.58, metallic=0.28)


def wall_dark() -> bpy.types.Material:
    return _principled("MAT_WallDark", base=(0.16, 0.175, 0.195), roughness=0.62, metallic=0.2)


def steel_structure() -> bpy.types.Material:
    return _principled("MAT_Steel", base=(0.30, 0.32, 0.35), roughness=0.44, metallic=0.92)


def roof_metal() -> bpy.types.Material:
    return _principled("MAT_RoofMetal", base=(0.21, 0.225, 0.245), roughness=0.52, metallic=0.75)


# ---------------------------------------------------------------- 设备


def paint_safety_yellow() -> bpy.types.Material:
    """安全黄：围栏、警示条、机械臂基座。"""
    return _principled("MAT_SafetyYellow", base=(0.72, 0.52, 0.06), roughness=0.42, metallic=0.1)


def paint_machine_white() -> bpy.types.Material:
    return _principled("MAT_MachineWhite", base=(0.78, 0.80, 0.82), roughness=0.38, metallic=0.08)


def paint_machine_dark() -> bpy.types.Material:
    return _principled("MAT_MachineDark", base=(0.085, 0.092, 0.105), roughness=0.44, metallic=0.3)


def paint_robot_orange() -> bpy.types.Material:
    """工业机器人经典橙。"""
    return _principled("MAT_RobotOrange", base=(0.82, 0.31, 0.05), roughness=0.36, metallic=0.12)


def metal_brushed() -> bpy.types.Material:
    return _principled("MAT_MetalBrushed", base=(0.62, 0.64, 0.67), roughness=0.32, metallic=0.95)


def metal_chrome() -> bpy.types.Material:
    return _principled("MAT_Chrome", base=(0.85, 0.87, 0.90), roughness=0.14, metallic=1.0)


def rubber_belt() -> bpy.types.Material:
    return _principled("MAT_Belt", base=(0.045, 0.047, 0.052), roughness=0.86, metallic=0.0)


def plastic_crate_blue() -> bpy.types.Material:
    return _principled("MAT_CrateBlue", base=(0.08, 0.24, 0.46), roughness=0.52, metallic=0.0)


def glass_panel() -> bpy.types.Material:
    return _principled(
        "MAT_Glass", base=(0.55, 0.72, 0.82), roughness=0.06, metallic=0.0, alpha=0.22, transmission=0.85
    )


def screen_glass() -> bpy.types.Material:
    return _principled("MAT_ScreenGlass", base=(0.02, 0.03, 0.045), roughness=0.12, metallic=0.4)


# ---------------------------------------------------------------- 发光


def emissive_cyan() -> bpy.types.Material:
    return _principled(
        "MAT_EmitCyan",
        base=(0.05, 0.35, 0.55),
        roughness=0.3,
        emission=(0.12, 0.62, 0.95),
        emission_strength=3.2,
    )


def emissive_green() -> bpy.types.Material:
    """运行中状态灯。"""
    return _principled(
        "MAT_EmitGreen",
        base=(0.05, 0.35, 0.16),
        roughness=0.3,
        emission=(0.16, 0.85, 0.42),
        emission_strength=4.0,
    )


def emissive_amber() -> bpy.types.Material:
    """待机 / 预警。"""
    return _principled(
        "MAT_EmitAmber",
        base=(0.4, 0.26, 0.03),
        roughness=0.3,
        emission=(1.0, 0.62, 0.10),
        emission_strength=4.0,
    )


def emissive_red() -> bpy.types.Material:
    """故障 / 急停。"""
    return _principled(
        "MAT_EmitRed",
        base=(0.4, 0.03, 0.03),
        roughness=0.3,
        emission=(1.0, 0.12, 0.10),
        emission_strength=4.5,
    )


def emissive_white() -> bpy.types.Material:
    """厂房照明灯具。"""
    return _principled(
        "MAT_EmitWhite",
        base=(0.85, 0.9, 1.0),
        roughness=0.4,
        emission=(0.88, 0.94, 1.0),
        emission_strength=6.0,
    )


# ---------------------------------------------------------------- 地面标线


def floor_marking_yellow() -> bpy.types.Material:
    return _principled("MAT_MarkYellow", base=(0.78, 0.58, 0.05), roughness=0.62, metallic=0.0)


def floor_marking_white() -> bpy.types.Material:
    return _principled("MAT_MarkWhite", base=(0.72, 0.74, 0.76), roughness=0.62, metallic=0.0)


# ---------------------------------------------------------------- 汇总


def build_all() -> dict[str, bpy.types.Material]:
    """一次性创建全部材质，返回 name → material。"""
    makers = [
        floor_concrete,
        floor_epoxy,
        wall_panel,
        wall_dark,
        steel_structure,
        roof_metal,
        paint_safety_yellow,
        paint_machine_white,
        paint_machine_dark,
        paint_robot_orange,
        metal_brushed,
        metal_chrome,
        rubber_belt,
        plastic_crate_blue,
        glass_panel,
        screen_glass,
        emissive_cyan,
        emissive_green,
        emissive_amber,
        emissive_red,
        emissive_white,
        floor_marking_yellow,
        floor_marking_white,
    ]
    result: dict[str, bpy.types.Material] = {}
    for maker in makers:
        mat = maker()
        result[mat.name] = mat
    return result
