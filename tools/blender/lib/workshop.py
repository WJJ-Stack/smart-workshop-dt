"""车间建筑：地面、墙体、屋架、立柱、门窗、照明、地面标线。

设计取舍：
- 墙体做成「单面 + 内侧可见」的薄板，不追求内外双面，省一半面数；
- 屋架用重复桁架，导出后前端可用 InstancedMesh 再优化；
- 地面标线用独立的极薄平面（z=0.004），避免 z-fighting；
- 照明灯具做成发光体，配合前端 Bloom 出效果，不依赖实时点光源。
"""
from __future__ import annotations

import math

import bpy

from bpy_util import box, cylinder, empty, parent_local, plane, set_dt


# 建筑尺寸（米）—— 前端 manifest 会读取同一组常量
HALL_LEN = 40.0   # X
HALL_WID = 28.0   # Y
HALL_HGT = 7.6    # Z
WALL_T = 0.28


def build_hall(
    coll: bpy.types.Collection | None,
    mats: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    root = empty("ENV_hall", (0, 0, 0), coll)
    set_dt(root, kind="env", title="车间建筑", group="env")
    parts: list[bpy.types.Object] = []

    hl, hw, hh = HALL_LEN * 0.5, HALL_WID * 0.5, HALL_HGT

    # ---------------- 地面
    floor = plane(
        "ENV_floor",
        (HALL_LEN, HALL_WID),
        (0, 0, 0),
        material=mats.get("MAT_FloorEpoxy"),
        coll=coll,
        uv_scale=(10, 7),
    )
    set_dt(floor, role="floor")
    parts.append(floor)

    # 车间外的场地（一圈更大的暗色地面，避免边缘悬空）
    apron = plane(
        "ENV_apron",
        (HALL_LEN + 26, HALL_WID + 26),
        (0, 0, -0.02),
        material=mats.get("MAT_FloorConcrete"),
        coll=coll,
        uv_scale=(16, 12),
    )
    parts.append(apron)

    # ---------------- 墙体（四面）
    walls = [
        ("S", (0, -hw, hh * 0.5), (HALL_LEN, WALL_T, hh)),
        ("N", (0, hw, hh * 0.5), (HALL_LEN, WALL_T, hh)),
        ("W", (-hl, 0, hh * 0.5), (WALL_T, HALL_WID, hh)),
        ("E", (hl, 0, hh * 0.5), (WALL_T, HALL_WID, hh)),
    ]
    for tag, loc, size in walls:
        w = box(
            f"ENV_wall_{tag}",
            size,
            loc,
            material=mats.get("MAT_WallPanel"),
            bevel=0.01,
            coll=coll,
        )
        parts.append(w)

        # 墙裙（下半段深色，工业厂房惯例）
        skirt = box(
            f"ENV_wall_{tag}_skirt",
            (size[0] + 0.02, size[1] + 0.04, 1.5),
            (loc[0], loc[1], 0.75),
            material=mats.get("MAT_WallDark"),
            bevel=0.006,
            coll=coll,
        )
        parts.append(skirt)

    # ---------------- 屋顶桁架（沿 X 方向每隔 4m 一道）
    truss_y = 4.0
    n_truss = int(HALL_LEN // truss_y) + 1
    for i in range(n_truss):
        x = -hl + 2 + i * truss_y
        if x > hl - 1:
            break
        # 上弦
        top_chord = box(
            f"ENV_truss_{i}_top",
            (0.18, HALL_WID, 0.2),
            (x, 0, hh - 0.35),
            material=mats.get("MAT_Steel"),
            bevel=0.006,
            coll=coll,
        )
        parts.append(top_chord)
        # 下弦
        bot_chord = box(
            f"ENV_truss_{i}_bot",
            (0.14, HALL_WID, 0.16),
            (x, 0, hh - 1.9),
            material=mats.get("MAT_Steel"),
            bevel=0.005,
            coll=coll,
        )
        parts.append(bot_chord)
        # 腹杆（斜撑，简化为竖向 + 两道斜向用 box 近似）
        n_web = 7
        for k in range(n_web):
            y = -hw + 2 + (HALL_WID - 4) * (k / max(1, n_web - 1))
            web = box(
                f"ENV_truss_{i}_web_{k}",
                (0.1, 0.1, 1.5),
                (x, y, hh - 1.12),
                material=mats.get("MAT_Steel"),
                bevel=0.004,
                coll=coll,
            )
            parts.append(web)

    # 檩条（沿 Y 方向，跨在桁架上）
    for k in range(6):
        y = -hw + 2.5 + (HALL_WID - 5) * (k / 5)
        purlin = box(
            f"ENV_purlin_{k}",
            (HALL_LEN, 0.16, 0.18),
            (0, y, hh - 0.3),
            material=mats.get("MAT_Steel"),
            bevel=0.005,
            coll=coll,
        )
        parts.append(purlin)

    # ---------------- 屋面
    roof = plane(
        "ENV_roof",
        (HALL_LEN, HALL_WID),
        (0, 0, hh),
        material=mats.get("MAT_RoofMetal"),
        coll=coll,
        uv_scale=(12, 9),
    )
    parts.append(roof)

    # ---------------- 立柱（沿两侧墙内侧）
    col_step = 8.0
    n_col = int(HALL_LEN // col_step) + 1
    for side, sy in (("S", -(hw - 0.6)), ("N", hw - 0.6)):
        for i in range(n_col):
            x = -hl + 2 + i * col_step
            if x > hl - 1:
                break
            c = box(
                f"ENV_column_{side}_{i}",
                (0.36, 0.36, hh),
                (x, sy, hh * 0.5),
                material=mats.get("MAT_Steel"),
                bevel=0.01,
                coll=coll,
            )
            parts.append(c)

    # ---------------- 高侧窗（采光带，用发光薄板表现）
    for side, sy in (("S", -hw + 0.16), ("N", hw - 0.16)):
        strip_len = HALL_LEN - 8
        win = box(
            f"ENV_window_{side}",
            (strip_len, 0.06, 1.1),
            (0, sy, hh - 2.9),
            material=mats.get("MAT_EmitWhite"),
            bevel=0.004,
            coll=coll,
        )
        parts.append(win)

    # ---------------- 车间照明（吊装灯具，沿产线布置）
    for i in range(5):
        x = -16 + i * 8
        for j, y in enumerate((-4.5, 4.5)):
            housing = box(
                f"ENV_lamp_{i}_{j}_housing",
                (1.5, 0.22, 0.12),
                (x, y, hh - 2.5),
                material=mats.get("MAT_MachineDark"),
                bevel=0.008,
                coll=coll,
            )
            parts.append(housing)
            tube_light = box(
                f"ENV_lamp_{i}_{j}_tube",
                (1.4, 0.14, 0.03),
                (x, y, hh - 2.58),
                material=mats.get("MAT_EmitWhite"),
                bevel=0.002,
                coll=coll,
            )
            parts.append(tube_light)
            # 吊杆
            for hx in (-0.6, 0.6):
                rod = cylinder(
                    f"ENV_lamp_{i}_{j}_rod_{int(hx*10)}",
                    0.014,
                    0.6,
                    (x + hx, y, hh - 2.2),
                    material=mats.get("MAT_Steel"),
                    coll=coll,
                    verts=8,
                    bevel=0.001,
                )
                parts.append(rod)

    # ---------------- 地面标线：产线安全通道
    build_floor_markings(coll, mats, parts)

    for p in parts:
        parent_local(p, root)
    return root, parts


def build_floor_markings(
    coll: bpy.types.Collection | None,
    mats: dict[str, bpy.types.Material],
    sink: list[bpy.types.Object],
) -> None:
    """地面标线：黄色安全区 + 白色通道线 + AGV 行驶带。

    全部用 z=0.004 的薄平面，避免与地面 z-fighting。
    """
    z = 0.004
    hl = HALL_LEN * 0.5

    # 产线安全区（黄色边框，沿产线 Y 方向两侧）
    for side, sy in (("S", 0.0 - 3.4), ("N", 0.0 + 3.4)):
        line = plane(
            f"ENV_mark_line_{side}",
            (HALL_LEN - 6, 0.16),
            (0, sy, z),
            material=mats.get("MAT_MarkYellow"),
            coll=coll,
        )
        sink.append(line)

    # 通道（白色中线）
    for i, y in enumerate((-7.5, 7.5)):
        lane = plane(
            f"ENV_mark_lane_{i}",
            (HALL_LEN - 8, 0.1),
            (0, y, z),
            material=mats.get("MAT_MarkWhite"),
            coll=coll,
        )
        sink.append(lane)

    # AGV 行驶带（虚线：用短平面重复）
    agv_y = -4.5
    seg = 1.2
    gap = 0.9
    x = -hl + 3
    idx = 0
    while x < hl - 3:
        dash = plane(
            f"ENV_mark_agv_{idx}",
            (seg, 0.12),
            (x + seg * 0.5, agv_y, z),
            material=mats.get("MAT_MarkWhite"),
            coll=coll,
        )
        sink.append(dash)
        x += seg + gap
        idx += 1

    # 工位号地贴（小方块，视觉锚点）
    for i, x in enumerate((-15.5, -7.2, 1.0, 12.0)):
        tag = plane(
            f"ENV_mark_station_{i}",
            (1.4, 1.4),
            (x, -1.9, z),
            material=mats.get("MAT_MarkYellow"),
            coll=coll,
        )
        sink.append(tag)


def build_safety_fence(
    coll: bpy.types.Collection | None,
    mats: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """产线安全围栏：立柱 + 横杆 + 网片（网片用半透明发光薄板示意）。"""
    root = empty("ENV_fence", (0, 0, 0), coll)
    set_dt(root, kind="env", title="安全围栏", group="env")
    parts: list[bpy.types.Object] = []

    # 围栏走向：矩形环绕产线 (X: -18..15, Y: -3.0..3.0)
    x0, x1 = -18.0, 15.0
    y0, y1 = -3.05, 3.05
    height = 1.35
    post_step = 1.8

    segs = [
        ((x0, y0), (x1, y0)),
        ((x1, y0), (x1, y1)),
        ((x1, y1), (x0, y1)),
        ((x0, y1), (x0, y0)),
    ]

    idx = 0
    for (a, b) in segs:
        ax, ay = a
        bx, by = b
        length = math.hypot(bx - ax, by - ay)
        n = max(2, int(length / post_step) + 1)
        for i in range(n):
            t = i / (n - 1)
            x = ax + (bx - ax) * t
            y = ay + (by - ay) * t
            post = box(
                f"ENV_fence_post_{idx}",
                (0.07, 0.07, height),
                (x, y, height * 0.5),
                material=mats.get("MAT_SafetyYellow"),
                bevel=0.006,
                coll=coll,
            )
            parts.append(post)
            idx += 1
            # 底座
            foot = box(
                f"ENV_fence_foot_{idx}",
                (0.2, 0.2, 0.03),
                (x, y, 0.015),
                material=mats.get("MAT_MachineDark"),
                bevel=0.004,
                coll=coll,
            )
            parts.append(foot)

        # 横杆（上/中）
        midx = (ax + bx) * 0.5
        midy = (ay + by) * 0.5
        rot_z = math.atan2(by - ay, bx - ax)
        for k, zz in (("top", height - 0.06), ("mid", height * 0.55)):
            rail = box(
                f"ENV_fence_rail_{idx}_{k}",
                (length, 0.05, 0.05),
                (midx, midy, zz),
                rot=(0, 0, rot_z),
                material=mats.get("MAT_SafetyYellow"),
                bevel=0.004,
                coll=coll,
            )
            parts.append(rail)

    for p in parts:
        parent_local(p, root)
    return root, parts


def build_exterior(
    coll: bpy.types.Collection | None,
    mats: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """厂房外部：卷帘门、雨棚、外墙标识、路灯。用于 L0 厂区视角。"""
    root = empty("ENV_exterior", (0, 0, 0), coll)
    set_dt(root, kind="env", title="厂房外部", group="env")
    parts: list[bpy.types.Object] = []

    hl, hw = HALL_LEN * 0.5, HALL_WID * 0.5

    # 南侧卷帘门
    for i, x in enumerate((-11.0, 12.0)):
        frame = box(
            f"ENV_door_{i}_frame",
            (6.2, 0.24, 4.6),
            (x, -hw - 0.02, 2.3),
            material=mats.get("MAT_MachineDark"),
            bevel=0.01,
            coll=coll,
        )
        parts.append(frame)

        door = box(
            f"ENV_door_{i}_leaf",
            (5.8, 0.1, 4.2),
            (x, -hw - 0.16, 2.2),
            material=mats.get("MAT_WallPanel"),
            bevel=0.008,
            coll=coll,
        )
        parts.append(door)

        # 门楣警示条
        stripe = box(
            f"ENV_door_{i}_stripe",
            (6.0, 0.06, 0.22),
            (x, -hw - 0.2, 4.42),
            material=mats.get("MAT_SafetyYellow"),
            bevel=0.006,
            coll=coll,
        )
        parts.append(stripe)

    # 南侧雨棚
    for i, x in enumerate((-11.0, 12.0)):
        canopy = box(
            f"ENV_canopy_{i}",
            (7.0, 2.2, 0.12),
            (x, -hw - 1.2, 4.85),
            material=mats.get("MAT_RoofMetal"),
            bevel=0.01,
            coll=coll,
        )
        parts.append(canopy)
        for j, sx in enumerate((-1, 1)):
            brace = cylinder(
                f"ENV_canopy_{i}_brace_{j}",
                0.03,
                2.1,
                (x + sx * 3.2, -hw - 1.0, 4.0),
                rot=(math.radians(28), 0, 0),
                material=mats.get("MAT_Steel"),
                coll=coll,
                verts=8,
                bevel=0.002,
            )
            parts.append(brace)

    # 外墙腰线
    belt = box(
        "ENV_facade_belt",
        (HALL_LEN + 0.2, 0.1, 0.5),
        (0, -hw - 0.06, 5.6),
        material=mats.get("MAT_MachineWhite"),
        bevel=0.008,
        coll=coll,
    )
    parts.append(belt)

    # 厂区路灯（4 根，做 L0 尺度参考）
    for i, (x, y) in enumerate([(-30, -22), (30, -22), (-30, 22), (30, 22)]):
        pole = cylinder(
            f"ENV_streetlamp_{i}_pole",
            0.09,
            8.0,
            (x, y, 4.0),
            material=mats.get("MAT_Steel"),
            coll=coll,
            verts=12,
            bevel=0.004,
        )
        parts.append(pole)
        head = box(
            f"ENV_streetlamp_{i}_head",
            (1.1, 0.4, 0.16),
            (x, y, 8.05),
            material=mats.get("MAT_MachineDark"),
            bevel=0.02,
            coll=coll,
        )
        parts.append(head)
        glow = box(
            f"ENV_streetlamp_{i}_glow",
            (0.95, 0.3, 0.03),
            (x, y, 7.95),
            material=mats.get("MAT_EmitWhite"),
            bevel=0.004,
            coll=coll,
        )
        parts.append(glow)

    for p in parts:
        parent_local(p, root)
    return root, parts

