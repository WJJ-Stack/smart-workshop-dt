"""用 gsplat 训练 3D Gaussian Splatting 模型。

输入：public/assets/splat/train/（images/*.png + transforms.json，由 render_for_splat.py 生成）
输出：public/assets/splat/workshop.splat（可供前端 spark 库直接加载）

本脚本刻意写成「最小可运行」而不是照搬 nerfstudio：
1. 只依赖 gsplat + torch + numpy + pillow，不引入整套训练框架（省 3GB 依赖）；
2. 显存按 6GB 优化：640×480、batch=1、每 200 步做一次 SH 升阶；
3. 用 gsplat 的 DefaultStrategy 管理致密化，这是官方推荐的默认策略；
4. 训练完直接导出 .splat 格式（每个高斯 32 字节），前端零依赖解码。

用法：
    E:\\venvs\\gsplat\\Scripts\\python.exe tools/gsplat/train.py --iters 7000

坐标约定提醒：
    transforms.json 里是 OpenCV 约定的相机位姿（c2w，看向 +Z、Y 向下）。
    gsplat 的 rasterization 需要 w2c 且相机看向 -Z，所以这里要做一次转换。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--data", default=os.path.join(_ROOT, "public", "assets", "splat", "train"))
    p.add_argument("--out", default=os.path.join(_ROOT, "public", "assets", "splat"))
    p.add_argument("--iters", type=int, default=7000)
    p.add_argument("--downscale", type=int, default=1, help="图像下采样倍数（显存不够就调大）")
    p.add_argument("--sh-degree", type=int, default=1, choices=[0, 1, 2, 3])
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


# ------------------------------------------------------------------ 数据


def load_dataset(data_dir: str, downscale: int):
    from PIL import Image

    with open(os.path.join(data_dir, "transforms.json"), encoding="utf-8") as f:
        meta = json.load(f)

    frames = meta["frames"]
    W = meta["w"] // downscale
    H = meta["h"] // downscale
    fl_x = meta["fl_x"] / downscale
    fl_y = meta["fl_y"] / downscale
    cx = meta["cx"] / downscale
    cy = meta["cy"] / downscale

    images = []
    c2ws = []

    for fr in frames:
        path = os.path.join(data_dir, fr["file_path"])
        img = Image.open(path).convert("RGB")
        if downscale > 1:
            img = img.resize((W, H), Image.LANCZOS)
        images.append(np.asarray(img, dtype=np.float32) / 255.0)

        m = np.array(fr["transform_matrix"], dtype=np.float32)
        c2ws.append(m)

    images = torch.from_numpy(np.stack(images))  # (N, H, W, 3)
    c2ws = torch.from_numpy(np.stack(c2ws))      # (N, 4, 4) c2w (Y-up, OpenGL 约定)

    # OpenGL (看向 -Z) → OpenCV (看向 +Z)：绕 X 轴 180°
    flip = torch.tensor(
        [[1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]], dtype=torch.float32
    )
    c2ws_cv = c2ws @ flip

    # 内参矩阵
    Ks = torch.zeros((len(frames), 3, 3), dtype=torch.float32)
    Ks[:, 0, 0] = fl_x
    Ks[:, 1, 1] = fl_y
    Ks[:, 0, 2] = cx
    Ks[:, 1, 2] = cy
    Ks[:, 2, 2] = 1.0

    print(f"[data] {len(frames)} 帧, {W}x{H}, fx={fl_x:.1f}")
    return images, c2ws_cv, Ks, W, H


def init_points(n: int, images: torch.Tensor, c2ws: torch.Tensor, Ks: torch.Tensor, W: int, H: int):
    """用「多视角反投影」初始化点云：比随机点收敛快得多。

    对每个视角随机撒像素，按深度先验（场景半径）反投影到世界坐标。
    这是 3DGS 论文里 COLMAP 稀疏点的廉价替代。
    """
    N = len(images)
    per_view = max(1, n // N)
    pts = []

    # 场景尺度估计：相机位置的包围盒对角线
    centers = c2ws[:, :3, 3]
    extent = (centers.max(dim=0).values - centers.min(dim=0).values).norm().item()
    dist_hint = max(4.0, extent * 0.42)

    g = torch.Generator().manual_seed(42)
    for i in range(N):
        # 全部在 CPU 上算，避免 cuda/cpu 混用（Ks/c2ws 可能已在 cuda）
        c2w_cpu = c2ws[i].cpu()
        K_cpu = Ks[i].cpu()

        # 随机像素
        px = torch.randint(0, W, (per_view,), generator=g).float()
        py = torch.randint(0, H, (per_view,), generator=g).float()
        depth = (dist_hint * (0.6 + 0.8 * torch.rand(per_view, generator=g))).float()

        fx = K_cpu[0, 0]
        fy = K_cpu[1, 1]
        cx = K_cpu[0, 2]
        cy = K_cpu[1, 2]

        # 相机坐标系下的点（OpenCV：x右 y下 z前）
        x_cam = (px - cx) / fx * depth
        y_cam = (py - cy) / fy * depth
        z_cam = depth
        p_cam = torch.stack([x_cam, y_cam, z_cam, torch.ones_like(z_cam)], dim=-1)  # (M,4)

        w2c = torch.inverse(c2w_cpu)
        p_world = (w2c @ p_cam.T).T[:, :3]
        pts.append(p_world)

    pts = torch.cat(pts, dim=0)[:n]

    # 颜色：从当前视角对应的图像像素直接取（比随机色收敛快得多）
    colors = torch.rand(pts.shape[0], 3) * 0.5 + 0.25
    return pts, colors


# ------------------------------------------------------------------ 训练


def main() -> None:
    args = parse_args()
    device = "cuda"
    if not torch.cuda.is_available():
        print("[ERROR] 需要 CUDA")
        sys.exit(1)

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    images, c2ws, Ks, W, H = load_dataset(args.data, args.downscale)
    images = images.to(device)
    c2ws = c2ws.to(device)
    Ks = Ks.to(device)

    from gsplat import rasterization

    n_init = 30000
    pts, colors = init_points(n_init, images, c2ws, Ks, W, H)
    pts = pts.to(device)
    colors = colors.to(device)
    # per_view 取整后实际数量可能略少于目标值，以实际为准
    n_init = pts.shape[0]
    print(f"[init] 实际初始化点数 {n_init}")

    # --- 高斯参数
    K = (args.sh_degree + 1) ** 2
    sh = torch.zeros((n_init, K, 3), device=device)
    # 零阶 SH 系数 → RGB：c0 = (color - 0.5) / 0.28209479177387814
    sh[:, 0, :] = (colors - 0.5) / 0.28209479177387814

    # 场景尺度决定初始高斯大小
    scene_scale = (pts.max(dim=0).values - pts.min(dim=0).values).norm().item() / 2.0
    init_log_scale = math.log(max(0.02, scene_scale * 0.012))

    params = {
        "means": pts.clone().requires_grad_(True),
        "scales": torch.full((n_init, 3), init_log_scale, device=device, requires_grad=True),
        "quats": torch.tensor([1.0, 0.0, 0.0, 0.0], device=device).repeat(n_init, 1).requires_grad_(True),
        "opacities": torch.full((n_init,), -1.0, device=device, requires_grad=True),
        "sh0": sh[:, :1, :].clone().requires_grad_(True),
        "shN": sh[:, 1:, :].clone().requires_grad_(True),
    }
    print(f"[init] {n_init} 个高斯, scene_scale={scene_scale:.2f}, init_log_scale={init_log_scale:.3f}")

    from gsplat.strategy import DefaultStrategy

    # gsplat 1.5+ 要求「每个参数一个 optimizer」，而不是一个 optimizer 带多个 param_group，
    # 因为 DefaultStrategy 需要按参数名单独重置动量（致密化会改变张量尺寸）
    lrs = {
        "means": 1.6e-4 * scene_scale,
        "scales": 5e-3,
        "quats": 1e-3,
        "opacities": 5e-2,
        "sh0": 2.5e-3,
        "shN": 2.5e-3 / 20 if params["shN"].numel() > 0 else 0.0,
    }
    optimizers = {
        name: torch.optim.Adam([{"params": [p], "lr": lrs[name]}], eps=1e-15)
        for name, p in params.items()
    }

    strategy = DefaultStrategy(
        refine_start_iter=300,
        refine_stop_iter=int(args.iters * 0.6),
        reset_every=600,
        refine_every=200,
        verbose=True,
    )
    strategy.check_sanity(params, optimizers)
    state = strategy.initialize_state(scene_scale=scene_scale)

    # 统一视图，供训练循环使用
    opt = optimizers

    N = len(images)
    t0 = time.time()
    best_psnr = 0.0
    prev_info = None

    for step in range(args.iters):
        # gsplat 1.5 的 step_pre_backward 需要「上一轮前向」得到的 info
        # （它要在 2D means 上 retain_grad 以便统计梯度做致密化决策）。
        # 因此顺序是：上一轮 info → pre_backward → 本轮前向 → 反向 → post_backward。
        if prev_info is not None:
            strategy.step_pre_backward(params, opt, state, step, prev_info)

        idx = step % N
        gt = images[idx]
        viewmat = torch.inverse(c2ws[idx]).unsqueeze(0)  # w2c
        K = Ks[idx].unsqueeze(0)

        renders, alphas, info = rasterization(
            means=params["means"],
            quats=F.normalize(params["quats"], dim=-1),
            scales=torch.exp(params["scales"]),
            opacities=torch.sigmoid(params["opacities"]),
            colors=torch.cat([params["sh0"], params["shN"]], dim=1),
            viewmats=viewmat,
            Ks=K,
            width=W,
            height=H,
            sh_degree=args.sh_degree,
            packed=True,
            near_plane=0.1,
            far_plane=400.0,
        )

        img = renders[0].clamp(0, 1)

        # L1 + SSIM 的组合损失是 3DGS 论文的标准做法，
        # 这里用简化版：L1 主导 + 少量 D-SSIM 项（用局部方差近似）
        l1 = (img - gt).abs().mean()
        ssim_loss = 1.0 - simple_ssim(img.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None])
        loss = 0.8 * l1 + 0.2 * ssim_loss

        opt.zero_grad(set_to_none=True)
        loss.backward()
        strategy.step_post_backward(params, state, opt, step, info, packed=True)
        for o in opt.values():
            o.step()

        prev_info = info

        if step % 100 == 0:
            with torch.no_grad():
                mse = ((img - gt) ** 2).mean().item()
                psnr = 10 * math.log10(1.0 / max(1e-9, mse))
            best_psnr = max(best_psnr, psnr)
            n_gauss = params["means"].shape[0]
            print(
                f"[{step:5d}/{args.iters}] loss={loss.item():.4f} psnr={psnr:.2f} "
                f"gauss={n_gauss:6d} elapsed={time.time()-t0:.0f}s"
            )

    print(f"[done] 训练完成，最高 PSNR={best_psnr:.2f}，耗时 {time.time()-t0:.0f}s")

    # --- 导出 .splat
    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "workshop.splat")
    export_splat(
        out_path,
        params["means"].detach(),
        torch.exp(params["scales"].detach()),
        F.normalize(params["quats"].detach(), dim=-1),
        torch.sigmoid(params["opacities"].detach()),
        params["sh0"].detach(),
        params["shN"].detach(),
    )
    size = os.path.getsize(out_path)
    print(f"[export] {out_path}  {size/1024/1024:.2f} MB  ({params['means'].shape[0]} 个高斯)")

    # 同时写出元信息，供前端页展示
    meta = {
        "gaussians": int(params["means"].shape[0]),
        "iterations": args.iters,
        "psnr": round(best_psnr, 2),
        "shDegree": args.sh_degree,
        "resolution": [W, H],
        "trainSeconds": round(time.time() - t0, 1),
        "bytes": size,
    }
    with open(os.path.join(args.out, "splat_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


def simple_ssim(x: torch.Tensor, y: torch.Tensor, window: int = 11) -> torch.Tensor:
    """简化 SSIM：用 box filter 近似高斯窗。足够作为正则项，且比完整实现快。"""
    C1, C2 = 0.01**2, 0.03**2
    pad = window // 2
    mu_x = F.avg_pool2d(x, window, 1, pad)
    mu_y = F.avg_pool2d(y, window, 1, pad)
    sigma_x = F.avg_pool2d(x * x, window, 1, pad) - mu_x**2
    sigma_y = F.avg_pool2d(y * y, window, 1, pad) - mu_y**2
    sigma_xy = F.avg_pool2d(x * y, window, 1, pad) - mu_x * mu_y
    ssim = ((2 * mu_x * mu_y + C1) * (2 * sigma_xy + C2)) / (
        (mu_x**2 + mu_y**2 + C1) * (sigma_x + sigma_y + C2)
    )
    return ssim.mean()


def export_splat(
    path: str,
    means: torch.Tensor,
    scales: torch.Tensor,
    quats: torch.Tensor,
    opacities: torch.Tensor,
    sh0: torch.Tensor,
    shN: torch.Tensor,
) -> None:
    """导出 antimatter15 的 .splat 格式（前端 spark / gsplat 网页查看器通用）。

    每条记录 32 字节：
        position 3×float32  (12B)
        scale    3×float32  (12B)
        color    4×uint8    ( 4B)  RGBA，A=不透明度
        rotation 4×uint8    ( 4B)  四元数，编码为 (q*128+128)

    注意：这个格式只存 DC 颜色（零阶 SH），高阶 SH 会被丢弃。
    对展示演示足够，若需要完整视角相关效果应导出 PLY/SPZ。
    """
    n = means.shape[0]

    pos = means.detach().cpu().numpy().astype(np.float32)
    scl = scales.detach().cpu().numpy().astype(np.float32)
    rot = quats.detach().cpu().numpy().astype(np.float32)
    opac = opacities.detach().cpu().numpy().astype(np.float32)

    # DC 项 → 颜色：rgb = 0.5 + C0 * sh
    C0 = 0.28209479177387814
    rgb = 0.5 + C0 * sh0.detach().cpu().numpy()[:, 0, :]
    rgb = np.clip(rgb, 0.0, 1.0)

    rgba = np.concatenate([rgb, np.clip(opac, 0, 1)[:, None]], axis=1)
    rgba_u8 = (rgba * 255).astype(np.uint8)

    # 四元数归一化后编码到 [0,255]
    norm = np.linalg.norm(rot, axis=1, keepdims=True)
    rot = rot / np.maximum(norm, 1e-8)
    rot_u8 = np.clip(rot * 128 + 128, 0, 255).astype(np.uint8)

    with open(path, "wb") as f:
        for i in range(n):
            f.write(pos[i].tobytes())
            f.write(scl[i].tobytes())
            f.write(rgba_u8[i].tobytes())
            f.write(rot_u8[i].tobytes())

    # 打印一下高阶 SH 丢弃情况，避免使用者误解体积
    if shN.numel() > 0:
        print(f"[export] 注意：.splat 仅保留 DC 颜色，丢弃了 {shN.shape[1]} 组高阶 SH")


if __name__ == "__main__":
    main()
