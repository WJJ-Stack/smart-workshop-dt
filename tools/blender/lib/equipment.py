"""产线设备建模。

每台设备的构建函数返回 (root_empty, parts)。

约定：
- 根节点是 Empty，命名 EQ_xxx，带 dt 元数据（设备类型、显示名、产线工位序号）；
- 每个可拾取部件是 Mesh，命名 P_<entity>__<part>；
- 部件原点位于其运动铰点（关节/轴心），这样旋转动画天然正确，
  不需要额外 pivot 空物体，也不会在 glTF 里多一层无意义节点；
- 动画通过同名 action 合并成单个 clip（见 bpy_util.ensure_action）。
"""
from __future__ import annotations

import math

import bpy

from bpy_util import (
    box,
    cylinder,
    empty,
    key_location,
    key_rotation,
    parent_local,
    plane,
    set_dt,
    set_interpolation,
    tube,
)
import materials as M  # noqa: F401  (供调用方复用材质入口)


# ================================================================ 上料机


def build_feeder(
    name: str = "EQ_feeder_01",
    loc: tuple[float, float, float] = (0, 0, 0),
    coll: bpy.types.Collection | None = None,
    mats: dict[str, bpy.types.Material] | None = None,
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """料仓 + 上料机构。料位由 hopper_z 的高度驱动。"""
    mats = mats or {}
    root = empty(name, loc, coll)
    set_dt(root, kind="feeder", title="上料机", station=1, group="line")
    parts: list[bpy.types.Object] = []

    base = box(
        f"P_{name}__base",
        (2.4, 1.8, 0.55),
        (0, 0, 0.275),
        material=mats.get("MAT_MachineDark"),
        bevel=0.02,
        coll=coll,
    )
    parts.append(base)

    for i, (sx, sy) in enumerate([(-1, -1), (1, -1), (-1, 1), (1, 1)]):
        leg = box(
            f"P_{name}__leg_{i}",
            (0.14, 0.14, 0.72),
            (sx * 1.05, sy * 0.77, 0.36),
            material=mats.get("MAT_Steel"),
            bevel=0.01,
            coll=coll,
        )
        parts.append(leg)

    hopper = _frustum(
        f"P_{name}__hopper",
        bottom=(1.7, 1.25),
        top=(2.3, 1.7),
        height=1.5,
        z=0.55,
        material=mats.get("MAT_MachineWhite"),
        coll=coll,
    )
    parts.append(hopper)

    hopper_level = box(
        f"P_{name}__hopper_level",
        (1.55, 1.1, 0.1),
        (0, 0, 1.05),
        material=mats.get("MAT_CrateBlue"),
        bevel=0.01,
        coll=coll,
    )
    set_dt(hopper_level, role="level_indicator")
    parts.append(hopper_level)

    chute = box(
        f"P_{name}__chute",
        (1.1, 0.9, 0.12),
        (1.75, 0, 0.72),
        rot=(0, math.radians(-22), 0),
        material=mats.get("MAT_MetalBrushed"),
        bevel=0.012,
        coll=coll,
    )
    parts.append(chute)

    motor = cylinder(
        f"P_{name}__motor",
        0.17,
        0.42,
        (1.35, 0.6, 0.95),
        rot=(0, math.radians(90), 0),
        material=mats.get("MAT_MachineDark"),
        coll=coll,
    )
    parts.append(motor)

    lamp = cylinder(
        f"P_{name}__status_lamp",
        0.075,
        0.24,
        (-1.0, 0.75, 1.62),
        material=mats.get("MAT_EmitGreen"),
        coll=coll,
        bevel=0.01,
    )
    set_dt(lamp, role="status_lamp")
    parts.append(lamp)

    panel = box(
        f"P_{name}__panel",
        (0.42, 0.12, 0.5),
        (-1.0, 0.86, 1.15),
        material=mats.get("MAT_MachineWhite"),
        bevel=0.012,
        coll=coll,
    )
    parts.append(panel)

    screen = box(
        f"P_{name}__panel_screen",
        (0.3, 0.03, 0.26),
        (-1.0, 0.93, 1.22),
        material=mats.get("MAT_EmitCyan"),
        bevel=0.004,
        coll=coll,
    )
    parts.append(screen)

    for p in parts:
        parent_local(p, root)
    return root, parts


# ================================================================ 传送带


def build_conveyor(
    name: str,
    loc: tuple[float, float, float] = (0, 0, 0),
    length: float = 6.0,
    width: float = 0.72,
    height: float = 0.82,
    station: int = 2,
    coll: bpy.types.Collection | None = None,
    mats: dict[str, bpy.types.Material] | None = None,
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """皮带输送机。belt 部件带 uv_scroll 标记，前端做纹理流动。"""
    mats = mats or {}
    root = empty(name, loc, coll)
    set_dt(root, kind="conveyor", title="输送带", station=station, group="line", length=length)
    parts: list[bpy.types.Object] = []

    hl = length * 0.5

    belt = box(
        f"P_{name}__belt",
        (length, width, 0.05),
        (0, 0, height),
        material=mats.get("MAT_Belt"),
        bevel=0.008,
        coll=coll,
    )
    set_dt(belt, role="belt", uv_scroll=True)
    parts.append(belt)

    for side, sy in (("L", -1), ("R", 1)):
        rail = box(
            f"P_{name}__rail_{side}",
            (length, 0.05, 0.16),
            (0, sy * (width * 0.5 + 0.025), height + 0.075),
            material=mats.get("MAT_MetalBrushed"),
            bevel=0.008,
            coll=coll,
        )
        parts.append(rail)

    roller_count = max(3, int(length // 1.2))
    for i in range(roller_count):
        x = -hl + 0.18 + (length - 0.36) * (i / max(1, roller_count - 1))
        roller = cylinder(
            f"P_{name}__roller_{i}",
            0.062,
            width + 0.02,
            (x, 0, height - 0.06),
            rot=(math.radians(90), 0, 0),
            material=mats.get("MAT_Chrome"),
            coll=coll,
            verts=16,
            bevel=0.004,
        )
        parts.append(roller)

    frame = box(
        f"P_{name}__frame",
        (length, width - 0.06, 0.1),
        (0, 0, height - 0.11),
        material=mats.get("MAT_Steel"),
        bevel=0.01,
        coll=coll,
    )
    parts.append(frame)

    leg_count = max(2, int(length // 2.2) + 1)
    for i in range(leg_count):
        x = -hl + 0.4 + (length - 0.8) * (i / max(1, leg_count - 1))
        leg = box(
            f"P_{name}__leg_{i}",
            (0.09, 0.09, height - 0.16),
            (x, 0, (height - 0.16) * 0.5),
            material=mats.get("MAT_Steel"),
            bevel=0.006,
            coll=coll,
        )
        parts.append(leg)
        foot = box(
            f"P_{name}__foot_{i}",
            (0.2, 0.2, 0.02),
            (x, 0, 0.01),
            material=mats.get("MAT_Steel"),
            bevel=0.004,
            coll=coll,
        )
        parts.append(foot)

    motor = cylinder(
        f"P_{name}__motor",
        0.11,
        0.34,
        (-hl + 0.35, width * 0.5 + 0.2, height - 0.12),
        rot=(math.radians(90), 0, 0),
        material=mats.get("MAT_MachineDark"),
        coll=coll,
    )
    parts.append(motor)

    for side, sy in (("L", -1), ("R", 1)):
        strip = box(
            f"P_{name}__guard_{side}",
            (length, 0.02, 0.05),
            (0, sy * (width * 0.5 + 0.06), height - 0.02),
            material=mats.get("MAT_SafetyYellow"),
            bevel=0.004,
            coll=coll,
        )
        parts.append(strip)

    for p in parts:
        parent_local(p, root)
    return root, parts


# ================================================================ 六轴机械臂


def build_robot_arm(
    name: str = "EQ_robot_01",
    loc: tuple[float, float, float] = (0, 0, 0),
    coll: bpy.types.Collection | None = None,
    mats: dict[str, bpy.types.Material] | None = None,
    station: int = 3,
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """六轴机械臂，简化为 4 级关节：肩 / 肘 / 腕 / 夹爪。

    层级：
        root
        └─ base,base_ring,turret  (固定)
           └─ shoulder_joint
              └─ upper_arm        原点在肩关节，绕 Y 俯仰
                 └─ elbow_joint
                    └─ fore_arm   原点在肘关节，绕 Y 俯仰
                       └─ wrist   绕 Z 旋转
                          └─ gripper_L/R  沿 X 开合

    这样在 glTF 里只需对节点写 rotation / translation 轨道即可，
    前端用 AnimationMixer 直接播放，无需任何运行时重建层级。
    """
    mats = mats or {}
    root = empty(name, loc, coll)
    set_dt(root, kind="robot", title="六轴机械臂", station=station, group="line")
    parts: list[bpy.types.Object] = []

    base = cylinder(
        f"P_{name}__base",
        0.46,
        0.3,
        (0, 0, 0.15),
        material=mats.get("MAT_MachineDark"),
        coll=coll,
    )
    set_dt(base, joint="fixed")
    parts.append(base)

    base_ring = cylinder(
        f"P_{name}__base_ring",
        0.5,
        0.1,
        (0, 0, 0.05),
        material=mats.get("MAT_SafetyYellow"),
        coll=coll,
    )
    set_dt(base_ring, joint="fixed")
    parts.append(base_ring)

    turret = cylinder(
        f"P_{name}__turret",
        0.34,
        0.42,
        (0, 0, 0.51),
        material=mats.get("MAT_RobotOrange"),
        coll=coll,
    )
    set_dt(turret, joint="base_yaw")
    parts.append(turret)

    shoulder_z = 0.72
    upper_len = 1.05
    fore_len = 0.88

    shoulder_joint = cylinder(
        f"P_{name}__joint_shoulder",
        0.2,
        0.44,
        (0, 0, shoulder_z),
        rot=(math.radians(90), 0, 0),
        material=mats.get("MAT_MachineDark"),
        coll=coll,
    )
    set_dt(shoulder_joint, joint="shoulder")
    parts.append(shoulder_joint)

    upper = _arm_segment(
        f"P_{name}__upper_arm",
        length=upper_len,
        r0=0.19,
        r1=0.145,
        material=mats.get("MAT_RobotOrange"),
        coll=coll,
    )
    upper.location = (0, 0, shoulder_z)
    set_dt(upper, joint="shoulder")
    parts.append(upper)

    elbow_joint = cylinder(
        f"P_{name}__joint_elbow",
        0.15,
        0.33,
        (0, 0, upper_len),
        rot=(math.radians(90), 0, 0),
        material=mats.get("MAT_MachineDark"),
        coll=coll,
    )
    set_dt(elbow_joint, joint="elbow")
    parts.append(elbow_joint)

    fore = _arm_segment(
        f"P_{name}__fore_arm",
        length=fore_len,
        r0=0.135,
        r1=0.095,
        material=mats.get("MAT_RobotOrange"),
        coll=coll,
    )
    fore.location = (0, 0, 0)
    set_dt(fore, joint="elbow")
    parts.append(fore)

    wrist = cylinder(
        f"P_{name}__wrist",
        0.095,
        0.24,
        (0, 0, fore_len + 0.12),
        material=mats.get("MAT_MetalBrushed"),
        coll=coll,
    )
    set_dt(wrist, joint="wrist_roll")
    parts.append(wrist)

    flange = box(
        f"P_{name}__flange",
        (0.2, 0.16, 0.05),
        (0, 0, fore_len + 0.26),
        material=mats.get("MAT_MachineDark"),
        bevel=0.006,
        coll=coll,
    )
    set_dt(flange, joint="wrist_roll")
    parts.append(flange)

    gripper_l = box(
        f"P_{name}__gripper_L",
        (0.035, 0.09, 0.26),
        (-0.075, 0, fore_len + 0.38),
        material=mats.get("MAT_MetalBrushed"),
        bevel=0.006,
        coll=coll,
    )
    set_dt(gripper_l, joint="gripper")
    parts.append(gripper_l)

    gripper_r = box(
        f"P_{name}__gripper_R",
        (0.035, 0.09, 0.26),
        (0.075, 0, fore_len + 0.38),
        material=mats.get("MAT_MetalBrushed"),
        bevel=0.006,
        coll=coll,
    )
    set_dt(gripper_r, joint="gripper")
    parts.append(gripper_r)

    # --- 组装层级（先挂父级再保持世界变换）
    for p in (base, base_ring, turret, shoulder_joint):
        parent_local(p, root)

    parent_local(upper, shoulder_joint)
    # upper 的原点应当落在肩关节处
    upper.location = (0, 0, 0)

    parent_local(elbow_joint, upper)
    parent_local(fore, elbow_joint)
    fore.location = (0, 0, 0)

    for p in (wrist, flange, gripper_l, gripper_r):
        parent_local(p, fore)

    _animate_robot(name, shoulder_joint, upper, elbow_joint, fore, wrist, flange, gripper_l, gripper_r)

    return root, parts


def _arm_segment(
    name: str,
    length: float,
    r0: float,
    r1: float,
    material: bpy.types.Material | None,
    coll: bpy.types.Collection | None,
) -> bpy.types.Object:
    """沿 +Z 的锥形臂段，原点在底端（关节处）。"""
    import bmesh

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    obj = bpy.data.objects.new(name, mesh)
    (coll or bpy.context.scene.collection).objects.link(obj)

    bm = bmesh.new()
    ring_bottom = []
    ring_top = []
    seg = 20
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring_bottom.append(bm.verts.new((math.cos(a) * r0, math.sin(a) * r0, 0)))
        ring_top.append(bm.verts.new((math.cos(a) * r1, math.sin(a) * r1, length)))
    bm.verts.ensure_lookup_table()

    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((ring_bottom[i], ring_bottom[j], ring_top[j], ring_top[i]))
    bm.faces.new(ring_bottom[::-1])
    bm.faces.new(ring_top)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()

    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    if material:
        mesh.materials.append(material)
    for poly in mesh.polygons:
        poly.use_smooth = True
    return obj


def _animate_robot(
    name: str,
    shoulder_joint: bpy.types.Object,
    upper: bpy.types.Object,
    elbow_joint: bpy.types.Object,
    fore: bpy.types.Object,
    wrist: bpy.types.Object,
    flange: bpy.types.Object,
    gripper_l: bpy.types.Object,
    gripper_r: bpy.types.Object,
) -> None:
    """120 帧抓放循环，首尾帧一致保证无缝。"""
    action = f"{name}_cycle"

    def key(frame: int, shoulder_deg: float, elbow_deg: float, roll_deg: float, grip: float) -> None:
        rot = (0, math.radians(shoulder_deg), 0)
        key_rotation(shoulder_joint, frame, (0, shoulder_deg, 0), action)
        key_rotation(upper, frame, (0, 0, 0), action)
        key_rotation(elbow_joint, frame, (0, elbow_deg, 0), action)
        key_rotation(fore, frame, (0, 0, 0), action)
        key_rotation(wrist, frame, (0, 0, roll_deg), action)
        key_rotation(flange, frame, (0, 0, 0), action)
        key_location(gripper_l, frame, (-grip, 0, gripper_l.location.z), action)
        key_location(gripper_r, frame, (grip, 0, gripper_r.location.z), action)
        del rot

    key(0, 0, 0, 0, 0.075)
    key(18, -42, 28, 0, 0.075)
    key(30, -42, 28, 0, 0.02)
    key(42, -18, 14, 0, 0.02)
    key(60, -18, 14, 92, 0.02)
    key(74, -30, 22, 92, 0.02)
    key(84, -30, 22, 92, 0.075)
    key(100, 0, 0, 0, 0.075)
    key(120, 0, 0, 0, 0.075)

    for obj in (shoulder_joint, upper, elbow_joint, fore, wrist, flange, gripper_l, gripper_r):
        set_interpolation(obj, action, "BEZIER")


# ================================================================ 视觉检测工位


def build_inspection(
    name: str = "EQ_inspect_01",
    loc: tuple[float, float, float] = (0, 0, 0),
    coll: bpy.types.Collection | None = None,
    mats: dict[str, bpy.types.Material] | None = None,
    station: int = 5,
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """视觉检测：龙门 + 相机 + 扫描光幕，做 Y 向往返扫描动画。"""
    mats = mats or {}
    root = empty(name, loc, coll)
    set_dt(root, kind="inspection", title="视觉检测工位", station=station, group="line")
    parts: list[bpy.types.Object] = []

    for side, sx in (("L", -1), ("R", 1)):
        col = box(
            f"P_{name}__column_{side}",
            (0.14, 0.16, 2.25),
            (sx * 0.78, 0, 1.125),
            material=mats.get("MAT_MachineWhite"),
            bevel=0.012,
            coll=coll,
        )
        parts.append(col)

    beam = box(
        f"P_{name}__beam",
        (1.8, 0.2, 0.18),
        (0, 0, 2.2),
        material=mats.get("MAT_MachineWhite"),
        bevel=0.014,
        coll=coll,
    )
    parts.append(beam)

    cam_body = box(
        f"P_{name}__camera",
        (0.26, 0.2, 0.24),
        (-0.35, 0, 1.98),
        material=mats.get("MAT_MachineDark"),
        bevel=0.012,
        coll=coll,
    )
    set_dt(cam_body, role="scanner")
    parts.append(cam_body)

    lens = cylinder(
        f"P_{name}__camera_lens",
        0.062,
        0.1,
        (-0.35, 0, 1.83),
        material=mats.get("MAT_Chrome"),
        coll=coll,
    )
    set_dt(lens, role="scanner")
    parts.append(lens)

    curtain = plane(
        f"P_{name}__scan_curtain",
        (1.5, 1.1),
        (-0.35, 0, 0.95),
        material=mats.get("MAT_EmitCyan"),
        coll=coll,
    )
    curtain.rotation_euler = (math.radians(90), 0, 0)
    set_dt(curtain, role="scanner")
    parts.append(curtain)

    for side, sx in (("L", -1), ("R", 1)):
        light = box(
            f"P_{name}__lamplight_{side}",
            (0.06, 0.06, 1.4),
            (sx * 0.78, 0.1, 1.2),
            material=mats.get("MAT_EmitWhite"),
            bevel=0.004,
            coll=coll,
        )
        parts.append(light)

    mon = box(
        f"P_{name}__monitor",
        (0.7, 0.05, 0.42),
        (0.15, -0.55, 1.75),
        rot=(math.radians(12), 0, 0),
        material=mats.get("MAT_ScreenGlass"),
        bevel=0.008,
        coll=coll,
    )
    parts.append(mon)

    mon_glow = box(
        f"P_{name}__monitor_glow",
        (0.64, 0.01, 0.36),
        (0.15, -0.575, 1.75),
        rot=(math.radians(12), 0, 0),
        material=mats.get("MAT_EmitCyan"),
        bevel=0.002,
        coll=coll,
    )
    parts.append(mon_glow)

    for p in parts:
        parent_local(p, root)

    action = f"{name}_scan"
    cx, _, cz = cam_body.location
    lz = lens.location.z
    for f, y in ((0, -0.34), (40, 0.34), (80, -0.34), (120, -0.34)):
        key_location(cam_body, f, (cx, y, cz), action)
        key_location(lens, f, (cx, y, lz), action)
        key_location(curtain, f, (cx, y, 0.95), action)
    for obj in (cam_body, lens, curtain):
        set_interpolation(obj, action, "BEZIER")

    return root, parts


# ================================================================ 包装/码垛


def build_packer(
    name: str = "EQ_packer_01",
    loc: tuple[float, float, float] = (0, 0, 0),
    coll: bpy.types.Collection | None = None,
    mats: dict[str, bpy.types.Material] | None = None,
    station: int = 6,
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """包装台 + 码垛成品。"""
    mats = mats or {}
    root = empty(name, loc, coll)
    set_dt(root, kind="packer", title="包装码垛工位", station=station, group="line")
    parts: list[bpy.types.Object] = []

    table = box(
        f"P_{name}__table",
        (2.6, 1.6, 0.12),
        (0, 0, 0.88),
        material=mats.get("MAT_MachineWhite"),
        bevel=0.014,
        coll=coll,
    )
    parts.append(table)

    for i, (sx, sy) in enumerate([(-1, -1), (1, -1), (-1, 1), (1, 1)]):
        leg = box(
            f"P_{name}__tableleg_{i}",
            (0.1, 0.1, 0.82),
            (sx * 1.15, sy * 0.68, 0.41),
            material=mats.get("MAT_Steel"),
            bevel=0.006,
            coll=coll,
        )
        parts.append(leg)

    sealer = box(
        f"P_{name}__sealer",
        (1.2, 0.5, 0.42),
        (-0.4, 0, 1.15),
        material=mats.get("MAT_MachineDark"),
        bevel=0.014,
        coll=coll,
    )
    parts.append(sealer)

    tape = box(
        f"P_{name}__tape_roll",
        (0.12, 0.34, 0.12),
        (-0.4, 0, 1.45),
        material=mats.get("MAT_SafetyYellow"),
        bevel=0.012,
        coll=coll,
    )
    parts.append(tape)

    for layer in range(3):
        for i in range(2 if layer < 2 else 1):
            for j in range(2):
                if layer == 2 and (i + j) == 1:
                    continue
                crate = box(
                    f"P_{name}__crate_{layer}_{i}_{j}",
                    (0.42, 0.42, 0.3),
                    (
                        0.72 + (i - 0.5) * 0.46,
                        (j - 0.5) * 0.46,
                        0.2 + layer * 0.33,
                    ),
                    material=mats.get("MAT_CrateBlue"),
                    bevel=0.008,
                    coll=coll,
                )
                set_dt(crate, role="product")
                parts.append(crate)

    status = cylinder(
        f"P_{name}__status_lamp",
        0.07,
        0.22,
        (1.15, -0.6, 1.55),
        material=mats.get("MAT_EmitGreen"),
        coll=coll,
    )
    set_dt(status, role="status_lamp")
    parts.append(status)

    pole = cylinder(
        f"P_{name}__lamp_pole",
        0.022,
        0.55,
        (1.15, -0.6, 1.19),
        material=mats.get("MAT_Steel"),
        coll=coll,
        bevel=0.002,
    )
    parts.append(pole)

    for p in parts:
        parent_local(p, root)
    return root, parts


# ================================================================ AGV


def build_agv(
    name: str = "EQ_agv_01",
    loc: tuple[float, float, float] = (0, 0, 0),
    coll: bpy.types.Collection | None = None,
    mats: dict[str, bpy.types.Material] | None = None,
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """潜伏式 AGV。轮子旋转动画，位移由前端路径驱动。"""
    mats = mats or {}
    root = empty(name, loc, coll)
    set_dt(root, kind="agv", title="AGV 搬运车", group="mobile")
    parts: list[bpy.types.Object] = []

    body = box(
        f"P_{name}__body",
        (1.15, 0.72, 0.26),
        (0, 0, 0.19),
        material=mats.get("MAT_MachineDark"),
        bevel=0.035,
        coll=coll,
    )
    parts.append(body)

    top = box(
        f"P_{name}__top_plate",
        (1.0, 0.62, 0.06),
        (0, 0, 0.35),
        material=mats.get("MAT_SafetyYellow"),
        bevel=0.018,
        coll=coll,
    )
    parts.append(top)

    lift = box(
        f"P_{name}__lift",
        (1.05, 0.66, 0.05),
        (0, 0, 0.42),
        material=mats.get("MAT_MetalBrushed"),
        bevel=0.01,
        coll=coll,
    )
    set_dt(lift, role="lift")
    parts.append(lift)

    wheels = []
    for i, (sx, sy) in enumerate([(-1, -1), (1, -1), (-1, 1), (1, 1)]):
        w = cylinder(
            f"P_{name}__wheel_{i}",
            0.1,
            0.07,
            (sx * 0.38, sy * 0.33, 0.1),
            rot=(math.radians(90), 0, 0),
            material=mats.get("MAT_MachineDark"),
            coll=coll,
            verts=20,
            bevel=0.006,
        )
        set_dt(w, role="wheel")
        parts.append(w)
        wheels.append(w)

    for side, sy in (("L", -1), ("R", 1)):
        band = box(
            f"P_{name}__lightband_{side}",
            (1.0, 0.02, 0.03),
            (0, sy * 0.365, 0.28),
            material=mats.get("MAT_EmitCyan"),
            bevel=0.004,
            coll=coll,
        )
        parts.append(band)

    for p in parts:
        parent_local(p, root)

    action = f"{name}_wheels"
    for w in wheels:
        key_rotation(w, 0, (0, 0, 0), action)
    for w in wheels:
        key_rotation(w, 30, (360, 0, 0), action)
        set_interpolation(w, action, "LINEAR")

    return root, parts


# ================================================================ 电控柜 / 中控台


def build_cabinet(
    name: str,
    loc: tuple[float, float, float] = (0, 0, 0),
    coll: bpy.types.Collection | None = None,
    mats: dict[str, bpy.types.Material] | None = None,
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    mats = mats or {}
    root = empty(name, loc, coll)
    set_dt(root, kind="cabinet", title="电控柜", group="aux")
    parts: list[bpy.types.Object] = []

    cab = box(
        f"P_{name}__cabinet",
        (1.2, 0.6, 2.0),
        (0, 0, 1.0),
        material=mats.get("MAT_MachineWhite"),
        bevel=0.02,
        coll=coll,
    )
    parts.append(cab)

    door = box(
        f"P_{name}__door",
        (0.56, 0.03, 1.86),
        (-0.29, -0.31, 1.0),
        material=mats.get("MAT_WallPanel"),
        bevel=0.008,
        coll=coll,
    )
    parts.append(door)

    hmi = box(
        f"P_{name}__hmi",
        (0.3, 0.03, 0.22),
        (-0.29, -0.335, 1.62),
        material=mats.get("MAT_EmitCyan"),
        bevel=0.004,
        coll=coll,
    )
    parts.append(hmi)

    for i in range(3):
        ind = cylinder(
            f"P_{name}__indicator_{i}",
            0.026,
            0.03,
            (-0.44 + i * 0.11, -0.335, 1.36),
            rot=(math.radians(90), 0, 0),
            material=mats.get("MAT_EmitGreen" if i == 0 else "MAT_EmitAmber"),
            coll=coll,
            verts=12,
            bevel=0.002,
        )
        parts.append(ind)

    for p in parts:
        parent_local(p, root)
    return root, parts


def build_control_desk(
    name: str,
    loc: tuple[float, float, float] = (0, 0, 0),
    coll: bpy.types.Collection | None = None,
    mats: dict[str, bpy.types.Material] | None = None,
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """中控台：三块大屏，作为车间总览的热点锚点。"""
    mats = mats or {}
    root = empty(name, loc, coll)
    set_dt(root, kind="console", title="中控台", group="aux")
    parts: list[bpy.types.Object] = []

    desk = box(
        f"P_{name}__desk",
        (2.6, 0.8, 0.75),
        (0, 0, 0.375),
        material=mats.get("MAT_MachineWhite"),
        bevel=0.02,
        coll=coll,
    )
    parts.append(desk)

    for i, sx in enumerate((-0.85, 0, 0.85)):
        bezel = box(
            f"P_{name}__bezel_{i}",
            (0.84, 0.03, 0.52),
            (sx, -0.315, 1.18),
            rot=(math.radians(8), 0, 0),
            material=mats.get("MAT_MachineDark"),
            bevel=0.006,
            coll=coll,
        )
        parts.append(bezel)

        screen = box(
            f"P_{name}__screen_{i}",
            (0.78, 0.04, 0.46),
            (sx, -0.34, 1.18),
            rot=(math.radians(8), 0, 0),
            material=mats.get("MAT_EmitCyan"),
            bevel=0.006,
            coll=coll,
        )
        parts.append(screen)

    for p in parts:
        parent_local(p, root)
    return root, parts


# ================================================================ 几何工具


def _frustum(
    name: str,
    bottom: tuple[float, float],
    top: tuple[float, float],
    height: float,
    z: float,
    material: bpy.types.Material | None,
    coll: bpy.types.Collection | None,
) -> bpy.types.Object:
    """棱台（料斗）。原点在底面中心。"""
    import bmesh

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    obj = bpy.data.objects.new(name, mesh)
    (coll or bpy.context.scene.collection).objects.link(obj)
    obj.location.z = z

    bm = bmesh.new()
    bx, by = bottom[0] * 0.5, bottom[1] * 0.5
    tx, ty = top[0] * 0.5, top[1] * 0.5
    b = [
        bm.verts.new((-bx, -by, 0)),
        bm.verts.new((bx, -by, 0)),
        bm.verts.new((bx, by, 0)),
        bm.verts.new((-bx, by, 0)),
    ]
    t = [
        bm.verts.new((-tx, -ty, height)),
        bm.verts.new((tx, -ty, height)),
        bm.verts.new((tx, ty, height)),
        bm.verts.new((-tx, ty, height)),
    ]
    bm.verts.ensure_lookup_table()
    bm.faces.new(b[::-1])
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((b[i], b[j], t[j], t[i]))
    bm.faces.new(t)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()

    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    if material:
        mesh.materials.append(material)
    return obj


def add_cable_tray(
    name: str,
    points: list[tuple[float, float, float]],
    coll: bpy.types.Collection | None,
    mats: dict[str, bpy.types.Material],
) -> bpy.types.Object:
    return tube(name, points, 0.06, material=mats.get("MAT_Steel"), coll=coll)

