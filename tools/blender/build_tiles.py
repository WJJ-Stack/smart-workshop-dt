"""把车间场景切成 3D Tiles 瓦片集。

这是 JD 加分项「3D Tiles」的真实实现，不是引个库摆样子：

1. **空间切分**：把厂房按 X/Z 方向切成网格单元，每个单元一个瓦片；
2. **层级结构**：根瓦片（整栋厂房轮廓）→ 子瓦片（各区域明细），
   符合 3D Tiles 的 `root.children` 语义；
3. **每瓦片两级 LOD**：`geometricError` 大的是粗瓦片，小的是精瓦片，
   由 `refine: "ADD"`/`"REPLACE"` 控制替换策略；
4. **包围体**用 `box`（OBB），比 `region` 更贴合矩形厂房，且不需要地理坐标。

产出：
    public/assets/tiles/tileset.json
    public/assets/tiles/<cell>_lod0.glb
    public/assets/tiles/<cell>_lod1.glb

前端用 3d-tiles-renderer 加载，网络面板能看到「随相机移动按需请求瓦片」。
"""
from __future__ import annotations

import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(_HERE, "lib")
# 同时把 lib 与脚本目录加入 sys.path：前者供 bpy_util 等模块，
# 后者供导入同目录的 build_workshop（复用其 LAYOUT 与减面逻辑）
for _p in (_LIB, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import bpy  # noqa: E402

import bpy_util as U  # noqa: E402
import materials as M  # noqa: E402
import equipment as EQ  # noqa: E402
import workshop as WS  # noqa: E402
import optimize as OPT  # noqa: E402
import build_workshop as BW  # noqa: E402


# 切分粒度：X 方向 4 段，Z 方向 3 段 → 12 个单元
GRID_X = 4
GRID_Z = 3
# 每单元两级瓦片的减面比例
LOD_RATIOS = [(1.0, 40.0), (0.35, 0.0)]  # (减面比, geometricError)


def parse_args() -> str:
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    out = os.path.join(_HERE, "..", "..", "public", "assets", "tiles")
    for i, a in enumerate(args):
        if a == "--out" and i + 1 < len(args):
            out = args[i + 1]
    return os.path.abspath(out)


def cell_bounds(cx: int, cz: int, hall_len: float, hall_wid: float) -> tuple[float, float, float, float]:
    """返回单元的 (x0, x1, z0, z1)。"""
    x0 = -hall_len * 0.5 + hall_len * (cx / GRID_X)
    x1 = -hall_len * 0.5 + hall_len * ((cx + 1) / GRID_X)
    z0 = -hall_wid * 0.5 + hall_wid * (cz / GRID_Z)
    z1 = -hall_wid * 0.5 + hall_wid * ((cz + 1) / GRID_Z)
    return x0, x1, z0, z1


def cull_to_cell(x0: float, x1: float, z0: float, z1: float) -> int:
    """删除本单元之外的对象，返回保留数量。

    坐标映射（关键，之前写错过）：
        Blender 是 Z-up，glTF 是 Y-up，导出时
            x_gltf =  x_blender
            y_gltf =  z_blender   （高度）
            z_gltf = -y_blender
        所以调用方传进来的 z0/z1 是 **glTF 的水平 Z**，
        在 Blender 里必须用 -y 判定，不能用 z（那是高度）。
        写错的后果：所有瓦片都按高度切，结果只生成几条"横带"。

    判定依据是对象世界包围盒中心点是否落在单元内。
    对跨越边界的对象用「中心点归属」而不是「相交」，
    避免同一对象被多个瓦片重复导出导致重复渲染。

    批量删除后必须 view_layer.update()，
    否则后续操作的 view_layer 里会有失效引用。
    """
    from mathutils import Vector

    kept = 0
    to_remove: list[bpy.types.Object] = []

    for obj in list(bpy.context.scene.objects):
        if obj.type == "EMPTY":
            continue
        if obj.type != "MESH":
            to_remove.append(obj)
            continue

        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        bx = (min(c.x for c in corners) + max(c.x for c in corners)) * 0.5
        by = (min(c.y for c in corners) + max(c.y for c in corners)) * 0.5
        # glTF 水平 Z = -Blender Y
        gz = -by

        if x0 <= bx < x1 and z0 <= gz < z1:
            kept += 1
        else:
            to_remove.append(obj)

    for obj in to_remove:
        try:
            bpy.data.objects.remove(obj, do_unlink=True)
        except ReferenceError:
            pass

    # 删除后强制刷新，清掉 view_layer 里的失效引用
    bpy.context.view_layer.update()
    return kept


def tileset_box(x0: float, x1: float, z0: float, z1: float, y0: float, y1: float) -> list[float]:
    """3D Tiles 的 box 包围体：[cx, cy, cz, hx,0,0, 0,hy,0, 0,0,hz]"""
    cx = (x0 + x1) * 0.5
    cy = (y0 + y1) * 0.5
    cz = (z0 + z1) * 0.5
    hx = (x1 - x0) * 0.5
    hy = (y1 - y0) * 0.5
    hz = (z1 - z0) * 0.5
    return [round(cx, 4), round(cy, 4), round(cz, 4), round(hx, 4), 0, 0, 0, round(hy, 4), 0, 0, 0, round(hz, 4)]


def build_content(cx: int, cz: int, lod_ratio: float, out_dir: str, mats: dict) -> dict:
    """构建并导出一个瓦片，返回元信息。"""
    hall_len = WS.HALL_LEN
    hall_wid = WS.HALL_WID
    x0, x1, z0, z1 = cell_bounds(cx, cz, hall_len, hall_wid)

    BW.build_scene(mats)
    kept = cull_to_cell(x0, x1, z0, z1)

    if lod_ratio < 1.0:
        BW._apply_decimate(lod_ratio)

    name = f"cell_{cx}_{cz}"
    suffix = "lod0" if lod_ratio >= 1.0 else "lod1"
    filename = f"{name}_{suffix}.glb"
    path = os.path.join(out_dir, filename)

    # 空瓦片跳过（有些单元可能没几何）
    mesh_count = len([o for o in bpy.context.scene.objects if o.type == "MESH"])
    if mesh_count == 0:
        return {"empty": True, "kept": kept}

    U.export_glb(path, draco=True)
    size = os.path.getsize(path)

    stats = U.report_scene_stats(f"{name}_{suffix}")
    return {
        "empty": False,
        "file": filename,
        "bytes": size,
        "kept": kept,
        "tris": stats["triangles"],
    }


def main() -> None:
    out_dir = parse_args()
    os.makedirs(out_dir, exist_ok=True)
    print(f"[TILES] 输出目录 {out_dir}")

    mats = M.build_all()

    hall_len = WS.HALL_LEN
    hall_wid = WS.HALL_WID
    hall_hgt = WS.HALL_HGT

    children: list[dict] = []
    total_bytes = 0
    total_tris = 0
    leaf_count = 0

    for cx in range(GRID_X):
        for cz in range(GRID_Z):
            x0, x1, z0, z1 = cell_bounds(cx, cz, hall_len, hall_wid)

            # 每单元构建两级：粗瓦片 + 精瓦片
            detail_tiles: list[dict] = []
            for ratio, err in LOD_RATIOS:
                info = build_content(cx, cz, ratio, out_dir, mats)
                if info.get("empty"):
                    continue
                total_bytes += info["bytes"]
                total_tris += info["tris"]
                leaf_count += 1
                detail_tiles.append(
                    {
                        "boundingVolume": {"box": tileset_box(x0, x1, z0, z1, 0, hall_hgt)},
                        "geometricError": err,
                        "refine": "REPLACE",
                        "content": {"uri": info["file"]},
                        "_stats": {"bytes": info["bytes"], "tris": info["tris"], "kept": info["kept"]},
                    }
                )

            if not detail_tiles:
                continue

            # 单元根：指向最粗的那一级（geometricError 最大）
            detail_tiles.sort(key=lambda t: t["geometricError"], reverse=True)
            cell_root = detail_tiles[0]
            cell_root["children"] = detail_tiles[1:]
            children.append(cell_root)

    # 根瓦片：整栋厂房，geometricError 很大，不挂内容（纯空间索引）
    tileset = {
        "asset": {"version": "1.1", "generator": "tools/blender/build_tiles.py"},
        "geometricError": 200.0,
        "root": {
            "boundingVolume": {
                "box": tileset_box(-hall_len * 0.5, hall_len * 0.5, -hall_wid * 0.5, hall_wid * 0.5, 0, hall_hgt)
            },
            "geometricError": 100.0,
            "refine": "REPLACE",
            "children": children,
        },
        "_meta": {
            "grid": [GRID_X, GRID_Z],
            "tiles": leaf_count,
            "totalBytes": total_bytes,
            "totalTris": total_tris,
            "units": "meter",
            "upAxis": "Y",
        },
    }

    path = os.path.join(out_dir, "tileset.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(tileset, f, ensure_ascii=False, indent=2)

    print("=" * 60)
    print(f"[TILES] {leaf_count} 个瓦片, {total_bytes/1024/1024:.2f} MB, {total_tris:,} 三角面")
    print(f"[TILES] tileset.json -> {path}")
    print("=" * 60)


if __name__ == "__main__":
    main()
