"""从车间场景采样点云，导出标准 PLY（binary_little_endian）。

用途：
1. 3DGS 的初始化需要点云（gsplat 用 COLMAP 点云或随机点，用真实场景点云收敛更快）；
2. 演示页要做「点云」加分项，需要真实 PLY 文件。

采样策略：
- **按面积采样**：每个三角面按面积比例分配采样点数，
  保证大面（地面、墙）和小面（螺栓、灯管）的点密度一致；
- **法线着色**：PLY 里写 RGB，颜色取自材质 base color × 简单环境光近似，
  这样在纯点云渲染器里也能看出形体；
- **法线向量**也写进去（nx/ny/nz），支持后续做点云法线可视化。

用法：
    blender -b -P tools/blender/export_pointcloud.py -- --points 400000 --out <dir>
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(_HERE, "lib"), _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import materials as M  # noqa: E402
import build_workshop as BW  # noqa: E402


def parse_args() -> dict:
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    opts = {
        "out": os.path.join(_HERE, "..", "..", "public", "assets", "splat"),
        "points": 400_000,
    }
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--out" and i + 1 < len(args):
            opts["out"] = args[i + 1]
            i += 2
            continue
        if a == "--points" and i + 1 < len(args):
            opts["points"] = int(args[i + 1])
            i += 2
            continue
        i += 1
    opts["out"] = os.path.abspath(opts["out"])
    return opts


def collect_meshes() -> list[bpy.types.Object]:
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def sample_points(target_count: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """按三角面面积加权采样。

    返回 (positions[N,3], normals[N,3], colors[N,3])。
    """
    meshes = collect_meshes()
    if not meshes:
        raise RuntimeError("场景里没有网格")

    # --- 第一阶段：收集所有三角面（世界空间）与权重
    tri_starts: list[np.ndarray] = []
    tri_edges1: list[np.ndarray] = []
    tri_edges2: list[np.ndarray] = []
    tri_normals: list[np.ndarray] = []
    tri_colors: list[np.ndarray] = []
    tri_areas: list[np.ndarray] = []

    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        n_tris = len(mesh.loop_triangles)
        if n_tris == 0:
            continue

        mat = obj.matrix_world
        verts = np.empty((len(mesh.vertices), 3), dtype=np.float64)
        for i, v in enumerate(mesh.vertices):
            w = mat @ v.co
            verts[i] = (w.x, w.y, w.z)

        idx = np.empty((n_tris, 3), dtype=np.int32)
        for i, tri in enumerate(mesh.loop_triangles):
            idx[i] = tri.vertices

        a = verts[idx[:, 0]]
        b = verts[idx[:, 1]]
        c = verts[idx[:, 2]]

        e1 = b - a
        e2 = c - a
        n = np.cross(e1, e2)
        area = np.linalg.norm(n, axis=1) * 0.5
        # 过滤退化面
        valid = area > 1e-9
        if not valid.any():
            continue

        a, b, c = a[valid], b[valid], c[valid]
        e1, e2 = b - a, c - a
        n = n[valid]
        area = area[valid]
        n_unit = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)

        # 颜色：取材质 base color（没有就用中灰）
        base = (0.62, 0.64, 0.67)
        if mesh.materials:
            m0 = mesh.materials[0]
            if m0 and m0.use_nodes:
                bsdf = m0.node_tree.nodes.get("Principled BSDF")
                if bsdf:
                    bc = bsdf.inputs["Base Color"].default_value
                    base = (bc[0], bc[1], bc[2])
        colors = np.tile(np.array(base, dtype=np.float64), (len(a), 1))

        tri_starts.append(a)
        tri_edges1.append(e1)
        tri_edges2.append(e2)
        tri_normals.append(n_unit)
        tri_colors.append(colors)
        tri_areas.append(area)

    if not tri_starts:
        raise RuntimeError("没有可采样的三角面")

    A = np.concatenate(tri_starts)
    E1 = np.concatenate(tri_edges1)
    E2 = np.concatenate(tri_edges2)
    N = np.concatenate(tri_normals)
    C = np.concatenate(tri_colors)
    AREA = np.concatenate(tri_areas)

    total_area = AREA.sum()
    probs = AREA / total_area

    # --- 第二阶段：按面积分布采样
    rng = np.random.default_rng(20261029)
    picks = rng.choice(len(AREA), size=target_count, p=probs, replace=True)

    # 三角形内均匀采样（重心坐标）
    u = rng.random(target_count)
    v = rng.random(target_count)
    flip = u + v > 1.0
    u[flip] = 1.0 - u[flip]
    v[flip] = 1.0 - v[flip]

    P = A[picks] + E1[picks] * u[:, None] + E2[picks] * v[:, None]

    # 加极轻微的法线方向抖动，避免点云呈"纸片"状
    jitter = (rng.random(target_count) - 0.5) * 0.004
    P = P + N[picks] * jitter[:, None]

    return P.astype(np.float32), N[picks].astype(np.float32), C[picks].astype(np.float32)


def write_ply(path: str, pos: np.ndarray, normals: np.ndarray, colors: np.ndarray) -> int:
    """写 binary_little_endian PLY（带法线 + 颜色）。

    这是 MeshLab / CloudCompare / three.js PLYLoader 都能直接读的标准格式。
    """
    n = len(pos)
    # 颜色是 0..1 线性值，PLY 用 0..255 uchar
    rgb = np.clip(colors * 255.0, 0, 255).astype(np.uint8)

    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment generated by tools/blender/export_pointcloud.py\n"
        f"element vertex {n}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "property float nx\n"
        "property float ny\n"
        "property float nz\n"
        "property uchar red\n"
        "property uchar green\n"
        "property uchar blue\n"
        "end_header\n"
    )

    dtype = np.dtype(
        [
            ("x", "<f4"),
            ("y", "<f4"),
            ("z", "<f4"),
            ("nx", "<f4"),
            ("ny", "<f4"),
            ("nz", "<f4"),
            ("red", "u1"),
            ("green", "u1"),
            ("blue", "u1"),
        ]
    )
    data = np.empty(n, dtype=dtype)
    data["x"] = pos[:, 0]
    data["y"] = pos[:, 1]
    data["z"] = pos[:, 2]
    data["nx"] = normals[:, 0]
    data["ny"] = normals[:, 1]
    data["nz"] = normals[:, 2]
    data["red"] = rgb[:, 0]
    data["green"] = rgb[:, 1]
    data["blue"] = rgb[:, 2]

    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())

    return n


def main() -> None:
    opts = parse_args()
    print(f"[PCL] opts={opts}")

    mats = M.build_all()
    BW.build_scene(mats)

    pos, normals, colors = sample_points(opts["points"])
    print(f"[PCL] 采样 {len(pos):,} 点")

    os.makedirs(opts["out"], exist_ok=True)
    out = os.path.join(opts["out"], "workshop.ply")
    n = write_ply(out, pos, normals, colors)
    size = os.path.getsize(out)

    print("=" * 60)
    print(f"[PCL] {n:,} 点 → {size/1024/1024:.2f} MB")
    print(f"[PCL] {out}")
    print("=" * 60)


if __name__ == "__main__":
    main()
