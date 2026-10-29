"""生成 3D Gaussian Splatting 资产（.splat）。

**方案说明（重要，不做误导）**

标准 3DGS 流程是「多视角照片 → 梯度下降训练 → 高斯」，
需要 CUDA toolkit 编译 gsplat 内核。本机环境不满足（无 CUDA toolkit，
6G 显存训练 640×480×95 帧也有 OOM 风险）。

这里采用**几何驱动的高斯生成**作为替代，但它产出的不是随机假数据：

1. 从 Blender 真实场景按三角面面积采样点（几何真值，非随机分布）；
2. 每个高斯的**尺度由该三角面的局部尺度决定** —— 大面（地面、墙）
   得到扁平大高斯，小面（螺栓、灯管）得到小高斯；
3. **朝向由三角面法线决定**：最短轴沿法线压扁到 18%，
   这正是 3DGS 训练结果的典型形态（面片状 —— 因为法线方向缺乏观测约束）；
4. 颜色 = 材质 base color × Lambert 光照，符合光照一致性；
5. 不透明度按面片尺度给权重（小面更不透明，对应清晰几何）。

产出是一个**几何与颜色都与场景一致、能在浏览器正确渲染**的高斯模型。
它在「生成方式」上与论文不同，但在「数据形态与渲染表现」上同构。
README 会明确区分这两者。

真正的训练脚本见 tools/gsplat/train.py，环境就绪后可直接替换本脚本产物。

用法：
    blender -b -P tools/blender/export_splat.py -- --gaussians 120000
"""
from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(_HERE, "lib"), _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import materials as M  # noqa: E402
import build_workshop as BW  # noqa: E402


def parse_args() -> dict:
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    opts = {
        "out": os.path.join(_HERE, "..", "..", "public", "assets", "splat"),
        "gaussians": 120_000,
    }
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--out" and i + 1 < len(args):
            opts["out"] = args[i + 1]
            i += 2
            continue
        if a == "--gaussians" and i + 1 < len(args):
            opts["gaussians"] = int(args[i + 1])
            i += 2
            continue
        i += 1
    opts["out"] = os.path.abspath(opts["out"])
    return opts


def gather_triangles():
    """收集所有三角面的世界坐标顶点、法线、材质色、局部尺度。"""
    starts, e1s, e2s, normals, colors, scales, areas = [], [], [], [], [], [], []

    light_dir = np.array([0.36, 0.72, 0.42], dtype=np.float64)
    light_dir /= np.linalg.norm(light_dir)

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
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
        valid = area > 1e-8
        if not valid.any():
            continue

        a, b, c = a[valid], b[valid], c[valid]
        e1, e2 = (b - a), (c - a)
        n = n[valid]
        area = area[valid]
        n_unit = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)

        base = np.array([0.62, 0.64, 0.67])
        emissive = None
        if mesh.materials and mesh.materials[0] and mesh.materials[0].use_nodes:
            m0 = mesh.materials[0]
            bsdf = m0.node_tree.nodes.get("Principled BSDF")
            if bsdf:
                bc = bsdf.inputs["Base Color"].default_value
                base = np.array([bc[0], bc[1], bc[2]])
                em = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
                if em is not None:
                    ec = em.default_value
                    strength = 0.0
                    st = bsdf.inputs.get("Emission Strength")
                    if st is not None:
                        strength = st.default_value
                    if strength > 0.5 and (ec[0] + ec[1] + ec[2]) > 0.08:
                        emissive = np.array([ec[0], ec[1], ec[2]]) * min(strength, 3.0) * 0.5

        lambert = np.clip(n_unit @ light_dir, 0.0, 1.0)[:, None]
        shade = 0.42 + 0.72 * lambert
        col = base[None, :] * shade
        if emissive is not None:
            col = np.clip(col + emissive[None, :], 0.0, 1.0)
        col = np.clip(col, 0.02, 1.0)

        # 局部尺度：三角形最长边
        r = np.maximum.reduce(
            [
                np.linalg.norm(b - a, axis=1),
                np.linalg.norm(c - b, axis=1),
                np.linalg.norm(a - c, axis=1),
            ]
        )
        # 高斯半径取三角形尺寸的较小比例：3DGS 里的高斯是"局部覆盖"，
        # 取 0.85 会让相邻高斯严重重叠 → 画面糊成一片、亮度堆叠发白。
        # 0.42 是实测在"看得清结构"与"不漏缝"之间的平衡点。
        scale = np.clip(r * 0.42, 0.008, 0.9)

        starts.append(a)
        e1s.append(e1)
        e2s.append(e2)
        normals.append(n_unit)
        colors.append(col)
        scales.append(scale)
        areas.append(area)

    return (
        np.concatenate(starts),
        np.concatenate(e1s),
        np.concatenate(e2s),
        np.concatenate(normals),
        np.concatenate(colors),
        np.concatenate(scales),
        np.concatenate(areas),
    )


def quat_from_normal(n: np.ndarray) -> np.ndarray:
    """构造把局部 +Z 轴对齐到法线的四元数 (x,y,z,w)。

    3DGS 的高斯是各向异性椭球，训练结果里最短轴通常沿表面法线
    （因为该方向缺乏观测约束）。这里显式复现这一形态。
    """
    z = np.array([0.0, 0.0, 1.0])
    dot = n @ z
    out = np.zeros((len(n), 4), dtype=np.float64)

    parallel = dot > 0.9999
    antiparallel = dot < -0.9999
    out[parallel] = (0.0, 0.0, 0.0, 1.0)
    out[antiparallel] = (1.0, 0.0, 0.0, 0.0)

    other = ~(parallel | antiparallel)
    if other.any():
        nn = n[other]
        d = dot[other]
        axis = np.cross(np.broadcast_to(z, nn.shape), nn)
        s = np.sqrt(np.maximum(0.0, 2.0 * (1.0 + d)))
        q = np.concatenate([axis / np.maximum(s[:, None], 1e-12), (s * 0.5)[:, None]], axis=1)
        nrm = np.linalg.norm(q, axis=1, keepdims=True)
        out[other] = q / np.maximum(nrm, 1e-12)

    nrm = np.linalg.norm(out, axis=1, keepdims=True)
    return out / np.maximum(nrm, 1e-12)


def main() -> None:
    opts = parse_args()
    print(f"[SPLAT] opts={opts}")

    mats = M.build_all()
    BW.build_scene(mats)

    print("[SPLAT] 收集三角面…")
    A, E1, E2, N, C, S, AREA = gather_triangles()
    print(f"[SPLAT] {len(A):,} 个三角面, 总面积 {AREA.sum():.1f} m2")

    target = opts["gaussians"]
    probs = AREA / AREA.sum()

    rng = np.random.default_rng(20261029)
    picks = rng.choice(len(AREA), size=target, p=probs, replace=True)

    u = rng.random(target)
    v = rng.random(target)
    flip = u + v > 1.0
    u[flip] = 1.0 - u[flip]
    v[flip] = 1.0 - v[flip]

    P = A[picks] + E1[picks] * u[:, None] + E2[picks] * v[:, None]

    rng_scale = S[picks]
    sig_plane = rng_scale * (0.55 + 0.5 * rng.random(target))
    sig_normal = sig_plane * 0.12

    # 不透明度：小面更不透明。上限压到 0.85，
    # 避免多层叠加大面积区域因 alpha 累积而过曝发白。
    opacity = np.clip(0.45 + 0.4 * np.clip(1.0 - rng_scale / 0.8, 0.0, 1.0), 0.22, 0.85)
    color = np.clip(C[picks] * (0.88 + 0.24 * rng.random((target, 1))), 0.01, 1.0)
    quat = quat_from_normal(N[picks])

    out_dir = opts["out"]
    os.makedirs(out_dir, exist_ok=True)

    path = os.path.join(out_dir, "workshop.splat")
    pos_f = P.astype(np.float32)
    scale_f = np.stack([sig_plane, sig_plane, sig_normal], axis=1).astype(np.float32)
    rgba = np.concatenate([color, opacity[:, None]], axis=1)
    rgba_u8 = np.clip(rgba * 255.0, 0, 255).astype(np.uint8)
    quat_u8 = np.clip(quat * 128.0 + 128.0, 0, 255).astype(np.uint8)

    with open(path, "wb") as f:
        for i in range(target):
            f.write(pos_f[i].tobytes())
            f.write(scale_f[i].tobytes())
            f.write(rgba_u8[i].tobytes())
            f.write(quat_u8[i].tobytes())

    size = os.path.getsize(path)

    write_ply(
        os.path.join(out_dir, "workshop_gaussians.ply"),
        pos_f,
        scale_f,
        quat,
        color,
        opacity,
    )

    meta = {
        "gaussians": int(target),
        "source": "geometry-sampled",
        "note": "几何采样生成，非常规 3DGS 训练。详见 tools/blender/export_splat.py 顶部说明。",
        "units": "meter",
        "upAxis": "Y",
        "splatBytes": size,
    }
    with open(os.path.join(out_dir, "splat_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print("=" * 60)
    print(f"[SPLAT] {target:,} 个高斯 -> {size/1024/1024:.2f} MB")
    print(f"[SPLAT] {path}")
    print("=" * 60)


def write_ply(
    path: str,
    pos: np.ndarray,
    scale: np.ndarray,
    quat: np.ndarray,
    color: np.ndarray,
    opacity: np.ndarray,
) -> None:
    n = len(pos)
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        "comment 3DGS-style gaussians (geometry sampled)\n"
        f"element vertex {n}\n"
        + "property float x\nproperty float y\nproperty float z\n"
        + "property float scale_x\nproperty float scale_y\nproperty float scale_z\n"
        + "property float qw\nproperty float qx\nproperty float qy\nproperty float qz\n"
        + "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        + "property float opacity\n"
        + "end_header\n"
    )
    dtype = np.dtype(
        [
            ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
            ("scale_x", "<f4"), ("scale_y", "<f4"), ("scale_z", "<f4"),
            ("qw", "<f4"), ("qx", "<f4"), ("qy", "<f4"), ("qz", "<f4"),
            ("red", "u1"), ("green", "u1"), ("blue", "u1"),
            ("opacity", "<f4"),
        ]
    )
    data = np.empty(n, dtype=dtype)
    data["x"], data["y"], data["z"] = pos[:, 0], pos[:, 1], pos[:, 2]
    data["scale_x"], data["scale_y"], data["scale_z"] = scale[:, 0], scale[:, 1], scale[:, 2]
    data["qw"], data["qx"], data["qy"], data["qz"] = quat[:, 3], quat[:, 0], quat[:, 1], quat[:, 2]
    rgb = np.clip(color * 255, 0, 255).astype(np.uint8)
    data["red"], data["green"], data["blue"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    data["opacity"] = opacity.astype(np.float32)

    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())


if __name__ == "__main__":
    main()
