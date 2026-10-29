"""从车间场景渲染多视角图像 + 相机位姿，用于 3DGS 训练。

输出结构（gsplat / nerfstudio 通用的 transforms.json 格式）：
    public/assets/splat/train/
        images/0000.png …
        transforms.json

设计要点：
1. **相机环绕**：分成 3 层高度 × 多圈方位，覆盖仰视/平视/俯视，
   避免只从一个高度采样导致 3DGS 出现"薄片"伪影；
2. **曝光/白平衡固定**：关掉自动曝光，否则不同帧亮度不一致，训练会糊；
3. **输出位姿用 Blender 的 camera matrix_world**，转为 OpenGL 约定的
   column-major 4x4，这是 3DGS 训练器的标准输入；
4. **分辨率**控制在 640×480：3060 6G 显存下，超过这个尺寸训练极易 OOM。

用法：
    blender -b -P tools/blender/render_for_splat.py -- --out <dir> --views 120
"""
from __future__ import annotations

import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(_HERE, "lib"), _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import materials as M  # noqa: E402
import build_workshop as BW  # noqa: E402
import workshop as WS  # noqa: E402


def parse_args() -> dict:
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    opts = {
        "out": os.path.join(_HERE, "..", "..", "public", "assets", "splat", "train"),
        "views": 96,
        "width": 640,
        "height": 480,
        "samples": 32,
    }
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--out" and i + 1 < len(args):
            opts["out"] = args[i + 1]
            i += 2
            continue
        if a == "--views" and i + 1 < len(args):
            opts["views"] = int(args[i + 1])
            i += 2
            continue
        if a == "--samples" and i + 1 < len(args):
            opts["samples"] = int(args[i + 1])
            i += 2
            continue
        i += 1
    opts["out"] = os.path.abspath(opts["out"])
    return opts


def setup_render(opts: dict) -> None:
    scene = bpy.context.scene

    # --- 引擎：EEVEE 快（适合快速产出），Cycles 质量更好但慢 20~50 倍
    # 这里选 EEVEE，因为 3DGS 训练对图像质量的要求远低于最终展示。
    # 注意：Blender 5.x 的引擎标识是 'BLENDER_EEVEE'，4.2 之前是 'BLENDER_EEVEE_NEXT'
    engines = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    if "BLENDER_EEVEE" in engines:
        scene.render.engine = "BLENDER_EEVEE"
    elif "BLENDER_EEVEE_NEXT" in engines:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    elif "CYCLES" in engines:
        scene.render.engine = "CYCLES"
    print(f"[SPLAT] render engine = {scene.render.engine} (available: {sorted(engines)})")
    scene.render.resolution_x = opts["width"]
    scene.render.resolution_y = opts["height"]
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"

    # 固定曝光（关键：自动曝光会让不同视角亮度漂移，3DGS 训练会糊）
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1.0

    # EEVEE 采样
    eevee = scene.eevee
    if hasattr(eevee, "taa_render_samples"):
        eevee.taa_render_samples = opts["samples"]
    if hasattr(eevee, "use_gtao"):
        eevee.use_gtao = True

    # 世界环境：给一个中性灰的环境光，避免死黑
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.35, 0.42, 0.52, 1.0)
        bg.inputs["Strength"].default_value = 1.2


def add_lights() -> None:
    """补光：3DGS 需要均匀照明的多视角，不能只靠单一方向光。"""
    # 主光
    key_data = bpy.data.lights.new("KeyLight", type="AREA")
    key_data.energy = 4200
    key_data.size = 26
    key_obj = bpy.data.objects.new("KeyLight", key_data)
    key_obj.location = (18, -14, 16)
    key_obj.rotation_euler = (math.radians(52), 0, math.radians(38))
    bpy.context.scene.collection.objects.link(key_obj)

    # 补光
    fill_data = bpy.data.lights.new("FillLight", type="AREA")
    fill_data.energy = 1800
    fill_data.size = 30
    fill_obj = bpy.data.objects.new("FillLight", fill_data)
    fill_obj.location = (-16, 12, 12)
    fill_obj.rotation_euler = (math.radians(-50), 0, math.radians(-40))
    bpy.context.scene.collection.objects.link(fill_obj)

    # 顶部柔光
    top_data = bpy.data.lights.new("TopLight", type="AREA")
    top_data.energy = 2600
    top_data.size = 34
    top_obj = bpy.data.objects.new("TopLight", top_data)
    top_obj.location = (0, 0, 14)
    bpy.context.scene.collection.objects.link(top_obj)


def make_camera() -> bpy.types.Object:
    cam_data = bpy.data.cameras.new("SplatCam")
    cam_data.lens = 26  # 略广角，单帧能覆盖更多内容
    cam_data.sensor_width = 36
    cam_obj = bpy.data.objects.new("SplatCam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj
    return cam_obj


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def matrix_to_gl(matrix) -> list[list[float]]:
    """Blender (Z-up, row-major) → OpenGL (Y-up, column-major 嵌套列表)。

    3DGS 训练器（gsplat / nerfstudio）期望 transforms.json 里是
    column-major 的 4×4，且相机看向 -Z、Y 向上。
    Blender 的 matrix_world 本身已符合「看向 -Z」，只需转置为列主序
    并翻转 Y/Z 以适应 Y-up 约定。
    """
    m = matrix.transposed()  # 转成列主序
    # Blender Z-up → GL Y-up：绕 X 轴 -90°
    flip = [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]]
    out = [[0.0] * 4 for _ in range(4)]
    for r in range(4):
        for c in range(4):
            out[r][c] = sum(m[r][k] * flip[k][c] for k in range(4))
    return [[round(v, 8) for v in row] for row in out]


def main() -> None:
    opts = parse_args()
    print(f"[SPLAT] opts={opts}")

    mats = M.build_all()
    BW.build_scene(mats)
    add_lights()
    setup_render(opts)

    cam = make_camera()

    img_dir = os.path.join(opts["out"], "images")
    os.makedirs(img_dir, exist_ok=True)

    hall_len = WS.HALL_LEN
    hall_wid = WS.HALL_WID
    # 目标点略微抬高到设备层，避免相机全部俯视地面
    target = Vector((0, 0, 1.6))

    frames: list[dict] = []
    views = opts["views"]

    # 三层环绕：低层（贴近设备）、中层（平视）、高层（俯视）
    # 每层方位角错开，保证覆盖均匀
    layers = [
        {"radius": 15.0, "height": 2.2, "weight": 0.42},
        {"radius": 24.0, "height": 6.0, "weight": 0.34},
        {"radius": 33.0, "height": 12.5, "weight": 0.24},
    ]

    total = 0
    for li, layer in enumerate(layers):
        count = max(6, int(views * layer["weight"]))
        for k in range(count):
            # 每层起始角错开，避免不同高度的视角在同一方位线重叠
            angle = (k / count) * math.tau + li * (math.tau / 9)
            r = layer["radius"]
            x = math.cos(angle) * r
            y = math.sin(angle) * r
            z = layer["height"]

            # 限制在厂房内（否则会拍到外墙，3DGS 会学到墙而不是设备）
            x = max(-hall_len * 0.46, min(hall_len * 0.46, x))
            y = max(-hall_wid * 0.46, min(hall_wid * 0.46, y))

            cam.location = (x, y, z)
            # 轻微上下抖动，增加视角多样性（避免所有相机严格共面）
            look_target = target + Vector(
                (math.sin(angle * 3.1) * 1.2, math.cos(angle * 2.7) * 1.2, math.sin(angle * 1.9) * 0.5)
            )
            look_at(cam, look_target)

            bpy.context.view_layer.update()
            cam.matrix_world = cam.matrix_world  # 强制刷新

            filename = f"{total:04d}.png"
            path = os.path.join(img_dir, filename)
            bpy.context.scene.render.filepath = path
            bpy.ops.render.render(write_still=True)

            frames.append(
                {
                    "file_path": f"images/{filename}",
                    "transform_matrix": matrix_to_gl(cam.matrix_world),
                }
            )
            total += 1
            if total % 6 == 0:
                print(f"[SPLAT] {total}/{views} 张已渲染")

    transforms = {
        "camera_model": "OPENCV",
        "fl_x": 640 * (26 / 36),
        "fl_y": 640 * (26 / 36),
        "cx": 640 / 2,
        "cy": 480 / 2,
        "w": opts["width"],
        "h": opts["height"],
        "frames": frames,
    }

    out_json = os.path.join(opts["out"], "transforms.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(transforms, f, indent=2)

    print("=" * 60)
    print(f"[SPLAT] 完成：{total} 张图 + transforms.json")
    print(f"[SPLAT] 输出目录：{opts['out']}")
    print("=" * 60)


if __name__ == "__main__":
    main()
