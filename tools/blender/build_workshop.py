"""构建完整车间场景并导出 GLB。

用法：
    blender -b --factory-startup -P tools/blender/build_workshop.py -- [选项]

选项：
    --out <dir>        输出目录（默认 public/assets/models）
    --lod              同时生成 LOD1/LOD2
    --no-draco         关闭 Draco 压缩（便于排查）
    --stats            仅统计不导出

产物：
    workshop.glb        完整场景（含动画、dt 元数据）
    workshop_lod1.glb   减面 50%
    workshop_lod2.glb   减面 82%
    equipment/*.glb     单设备（供按需加载演示）
"""
from __future__ import annotations

import os
import sys
import json
import time

# --- 让 blender 的 python 找到同级 lib 目录
_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(_HERE, "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import bpy  # noqa: E402

import bpy_util as U  # noqa: E402
import materials as M  # noqa: E402
import equipment as EQ  # noqa: E402
import workshop as WS  # noqa: E402
import optimize as OPT  # noqa: E402


def parse_args() -> dict:
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    opts = {"out": None, "lod": False, "draco": True, "stats": False}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--out" and i + 1 < len(args):
            opts["out"] = args[i + 1]
            i += 2
            continue
        if a == "--lod":
            opts["lod"] = True
        elif a == "--no-draco":
            opts["draco"] = False
        elif a == "--stats":
            opts["stats"] = True
        i += 1

    if opts["out"] is None:
        opts["out"] = os.path.join(_HERE, "..", "..", "public", "assets", "models")
    opts["out"] = os.path.abspath(opts["out"])
    return opts


# ------------------------------------------------------------------ 布局

# 产线中心线：沿 X 方向排布，Y=0
LINE_Y = 0.0

LAYOUT = {
    "feeder": (-17.0, LINE_Y),
    "conveyor_a": (-13.0, LINE_Y),
    "robot_a": (-8.6, LINE_Y),
    "conveyor_b": (-4.6, LINE_Y),
    "inspect": (0.6, LINE_Y),
    "robot_b": (5.0, LINE_Y),
    "conveyor_c": (9.0, LINE_Y),
    "packer": (13.4, LINE_Y),
}


def build_scene(mats: dict[str, bpy.types.Material], *, merge_static: bool = True) -> None:
    U.reset_scene()

    coll_env = U.get_collection("COL_ENV")
    coll_line = U.get_collection("COL_LINE")
    coll_mobile = U.get_collection("COL_MOBILE")
    coll_aux = U.get_collection("COL_AUX")

    # ---------------- 建筑与环境
    WS.build_hall(coll_env, mats)
    WS.build_safety_fence(coll_env, mats)
    WS.build_exterior(coll_env, mats)

    # ---------------- 产线设备
    fx, fy = LAYOUT["feeder"]
    EQ.build_feeder("EQ_feeder_01", (fx, fy, 0), coll_line, mats)

    ax, ay = LAYOUT["conveyor_a"]
    EQ.build_conveyor("EQ_conveyor_a", (ax, ay, 0), length=7.2, station=2, coll=coll_line, mats=mats)

    rx, ry = LAYOUT["robot_a"]
    EQ.build_robot_arm("EQ_robot_01", (rx, ry, 0), coll_line, mats, station=3)

    bx, by = LAYOUT["conveyor_b"]
    EQ.build_conveyor("EQ_conveyor_b", (bx, by, 0), length=7.2, station=4, coll=coll_line, mats=mats)

    ix, iy = LAYOUT["inspect"]
    EQ.build_inspection("EQ_inspect_01", (ix, iy, 0), coll_line, mats, station=5)

    r2x, r2y = LAYOUT["robot_b"]
    EQ.build_robot_arm("EQ_robot_02", (r2x, r2y, 0), coll_line, mats, station=6)

    cx, cy = LAYOUT["conveyor_c"]
    EQ.build_conveyor("EQ_conveyor_c", (cx, cy, 0), length=7.0, station=7, coll=coll_line, mats=mats)

    px, py = LAYOUT["packer"]
    EQ.build_packer("EQ_packer_01", (px, py, 0), coll_line, mats, station=8)

    # ---------------- 移动设备
    EQ.build_agv("EQ_agv_01", (-20.0, -4.5, 0), coll_mobile, mats)
    EQ.build_agv("EQ_agv_02", (18.0, 4.5, 0), coll_mobile, mats)

    # ---------------- 辅助设备
    EQ.build_cabinet("EQ_cabinet_01", (-20.0, 6.5, 0), coll_aux, mats)
    EQ.build_cabinet("EQ_cabinet_02", (-18.4, 6.5, 0), coll_aux, mats)
    EQ.build_cabinet("EQ_cabinet_03", (16.5, 6.5, 0), coll_aux, mats)
    EQ.build_control_desk("EQ_console_01", (-14.0, 9.5, 0), coll_aux, mats)

    # ---------------- 电缆桥架（沿产线上方）
    tray_pts = [
        (-20.0, 2.6, 4.6),
        (-12.0, 2.6, 4.6),
        (0.0, 2.6, 4.6),
        (12.0, 2.6, 4.6),
        (20.0, 2.6, 4.6),
    ]
    EQ.add_cable_tray("ENV_cabletray_main", tray_pts, coll_aux, mats)
    for i, x in enumerate((-17.0, -8.6, 0.6, 9.0, 13.4)):
        drop = [
            (x, 2.6, 4.6),
            (x, 2.6, 2.6),
            (x, 1.4, 2.2),
        ]
        EQ.add_cable_tray(f"ENV_cabletray_drop_{i}", drop, coll_aux, mats)

    # ---------------- 静态合批：把环境件按材质合并
    if merge_static:
        OPT.merge_static_by_material("ENV_")
        print(f"[DRAWCALL] 预估 {OPT.count_draw_call_estimate()} 次")


def export_lods(opts: dict, mats: dict[str, bpy.types.Material]) -> list[dict]:
    """导出主模型与两级 LOD。LOD 用 Decimate 修改器按比例减面。"""
    out_dir = opts["out"]
    os.makedirs(out_dir, exist_ok=True)
    results: list[dict] = []

    targets = [
        ("workshop.glb", 1.0, "LOD0"),
        ("workshop_lod1.glb", 0.45, "LOD1"),
        ("workshop_lod2.glb", 0.15, "LOD2"),
    ]
    if not opts["lod"]:
        targets = targets[:1]

    for filename, ratio, label in targets:
        stats = U.report_scene_stats(label)
        if ratio < 1.0:
            _apply_decimate(ratio)
            stats = U.report_scene_stats(f"{label}_decimated")

        path = os.path.join(out_dir, filename)
        t0 = time.time()
        U.export_glb(path, draco=opts["draco"])
        dt = time.time() - t0
        size = os.path.getsize(path)
        results.append(
            {
                "file": filename,
                "lod": label,
                "tris": stats["triangles"],
                "verts": stats["vertices"],
                "bytes": size,
                "exportSec": round(dt, 2),
            }
        )
        print(f"[EXPORT] {filename}  {size/1024/1024:.2f} MB  {stats['triangles']:,} tris  {dt:.1f}s")

        if ratio < 1.0:
            # 撤销减面，为下一档重新构建
            build_scene(mats)

    return results


def _apply_decimate(ratio: float) -> None:
    """对所有 mesh 应用 Decimate。collapsed 模式下 ratio 即保留比例。"""
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for obj in meshes:
        if len(obj.data.polygons) < 20:
            continue
        mod = obj.modifiers.new("LOD", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        U.apply_modifier(obj, "LOD")


def export_individual_equipment(opts: dict, mats: dict[str, bpy.types.Material]) -> list[dict]:
    """单独导出每台设备（用于「按需加载」演示与体积对比）。"""
    out_dir = os.path.join(opts["out"], "equipment")
    os.makedirs(out_dir, exist_ok=True)
    results: list[dict] = []

    specs = [
        ("feeder.glb", lambda c: EQ.build_feeder("EQ_feeder_01", (0, 0, 0), c, mats)),
        ("conveyor.glb", lambda c: EQ.build_conveyor("EQ_conveyor_a", (0, 0, 0), length=7.2, coll=c, mats=mats)),
        ("robot.glb", lambda c: EQ.build_robot_arm("EQ_robot_01", (0, 0, 0), c, mats)),
        ("inspection.glb", lambda c: EQ.build_inspection("EQ_inspect_01", (0, 0, 0), c, mats)),
        ("packer.glb", lambda c: EQ.build_packer("EQ_packer_01", (0, 0, 0), c, mats)),
        ("agv.glb", lambda c: EQ.build_agv("EQ_agv_01", (0, 0, 0), c, mats)),
        ("cabinet.glb", lambda c: EQ.build_cabinet("EQ_cabinet_01", (0, 0, 0), c, mats)),
    ]

    for filename, maker in specs:
        U.reset_scene()
        coll = U.get_collection("TMP")
        maker(coll)
        stats = U.report_scene_stats(filename)
        path = os.path.join(out_dir, filename)
        U.export_glb(path, draco=opts["draco"])
        size = os.path.getsize(path)
        results.append({"file": f"equipment/{filename}", "tris": stats["triangles"], "bytes": size})
        print(f"[EXPORT] equipment/{filename}  {size/1024:.0f} KB  {stats['triangles']:,} tris")

    return results


def write_manifest(opts: dict, exports: list[dict]) -> str:
    """生成前端消费的资产 manifest。

    包含：模型文件、LOD 映射、设备布局（与 Blender 侧同一组常量）、
    动画 clip 名、热点锚点建议位置。
    """
    manifest = {
        "version": 1,
        "generatedBy": "tools/blender/build_workshop.py",
        "units": "meter",
        "upAxis": "Y",
        "hall": {
            "length": WS.HALL_LEN,
            "width": WS.HALL_WID,
            "height": WS.HALL_HGT,
        },
        "models": exports,
        "lods": [
            {"level": 0, "file": "workshop.glb", "maxDistance": 90},
            {"level": 1, "file": "workshop_lod1.glb", "maxDistance": 200},
            {"level": 2, "file": "workshop_lod2.glb", "maxDistance": 600},
        ],
        "layout": {k: {"x": v[0], "y": v[1], "z": 0} for k, v in LAYOUT.items()},
        "animations": {
            "EQ_robot_01": "EQ_robot_01_cycle",
            "EQ_robot_02": "EQ_robot_02_cycle",
            "EQ_inspect_01": "EQ_inspect_01_scan",
            "EQ_agv_01": "EQ_agv_01_wheels",
            "EQ_agv_02": "EQ_agv_02_wheels",
        },
        "equipment": {
            "EQ_feeder_01": {"kind": "feeder", "title": "上料机", "station": 1},
            "EQ_conveyor_a": {"kind": "conveyor", "title": "输送带 A", "station": 2},
            "EQ_robot_01": {"kind": "robot", "title": "装配机械臂 #1", "station": 3},
            "EQ_conveyor_b": {"kind": "conveyor", "title": "输送带 B", "station": 4},
            "EQ_inspect_01": {"kind": "inspection", "title": "视觉检测工位", "station": 5},
            "EQ_robot_02": {"kind": "robot", "title": "装配机械臂 #2", "station": 6},
            "EQ_conveyor_c": {"kind": "conveyor", "title": "输送带 C", "station": 7},
            "EQ_packer_01": {"kind": "packer", "title": "包装码垛工位", "station": 8},
            "EQ_agv_01": {"kind": "agv", "title": "AGV #1", "station": 0},
            "EQ_agv_02": {"kind": "agv", "title": "AGV #2", "station": 0},
        },
    }

    path = os.path.join(opts["out"], "manifest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"[MANIFEST] {path}")
    return path


def main() -> None:
    opts = parse_args()
    print(f"[OPTS] {opts}")

    mats = M.build_all()
    print(f"[MATERIALS] {len(mats)} created")

    build_scene(mats)
    U.report_scene_stats("full_scene")

    if opts["stats"]:
        U.print_done()
        return

    exports = export_lods(opts, mats)

    # 单设备导出（重置场景，所以放在 LOD 之后）
    build_scene(mats)
    single = export_individual_equipment(opts, mats)
    exports.extend(single)

    build_scene(mats)
    write_manifest(opts, exports)

    U.print_done()


if __name__ == "__main__":
    main()
