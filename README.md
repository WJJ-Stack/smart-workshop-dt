# 智能装配车间数字孪生 · Web3D 演示系统

基于 **Three.js + TypeScript** 的工业数字孪生 Web 应用。资产全部由 **Blender 5.2 参数化脚本**生成，覆盖 GLB / 3D Tiles / 点云 / 3DGS 四种空间数据形态。

> 项目起点是「按 JD 技术栈做一个能讲清每一处技术决策的作品」，不是拼凑的 demo。
> 性能数字、踩过的坑、以及哪些地方刻意做了取舍，都记录在 [`PERF.md`](./PERF.md)。

---

## 一、快速开始

```powershell
npm install
npm run dev
```

| 页面 | 地址 | 内容 |
|---|---|---|
| 数字孪生主场景 | http://127.0.0.1:5180/ | 车间、设备、交互、路径规划、实时数据 |
| 资产展示（加分项） | http://127.0.0.1:5180/assets.html | 3D Tiles / 点云 / 3DGS 三种模式 |

加 `?bench` 打开性能 HUD，并在 console 可用 `await window.__bench()` 复现基准数据。

---

## 二、环境要求

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20.19 | Vite 8 要求 |
| Blender | 5.2.x LTS | **仅重建资产时需要**，仓库已包含生成好的资产 |
| 显卡 | 支持 WebGL2 | 本项目在 RTX 3060 Laptop 上开发 |

Blender 便携版安装位置（本项目约定，不占 C 盘）：

```powershell
# 已经装好，路径为：
E:\devtools\blender-5.2.3-windows-x64\blender.exe
```

---

## 三、目录结构

```
├─ src/
│  ├─ core/            渲染内核：Renderer / Viewport / Loop / CameraRig
│  │                   Orbit / Fly / Follow / CameraModeController / PointerInput
│  ├─ assets/          AssetManager（Draco+KTX2+Meshopt+引用计数）/ manifest / 程序化纹理
│  ├─ world/           WorkshopWorld / lighting / postfx / LodManager / presets / hotspots
│  ├─ entities/        EntityRegistry（mesh ↔ 实体 ↔ 部件的唯一映射）
│  ├─ interaction/     Picker（BVH）/ Highlighter / HotspotLayer / InteractionController
│  ├─ systems/         TwinSource（模拟孪生数据）/ TwinBinding / RoadNetwork / Route / bench
│  ├─ workers/         pathfinding.worker.ts（A*）
│  ├─ ui/              TopBar / DeviceList / InfoCard / PerfHud / Dashboard / RoutePanel
│  ├─ pages/           资产展示页：tiles / pointcloud / splat / assetViewer
│  └─ shared/          EventBus / events 契约 / math 工具
├─ tools/
│  ├─ blender/         ★ 资产生产线（Python）
│  │  ├─ lib/          bpy_util / materials / equipment / workshop / optimize
│  │  ├─ build_workshop.py    主模型 + LOD + 单设备导出 + manifest
│  │  ├─ build_tiles.py       3D Tiles 瓦片集
│  │  ├─ export_pointcloud.py PLY 点云
│  │  ├─ export_splat.py      3DGS 高斯
│  │  └─ render_for_splat.py  多视角渲染（供真实 3DGS 训练）
│  ├─ gsplat/train.py  3DGS 训练脚本（需 CUDA toolkit，见下文说明）
│  ├─ inspect_glb.mjs  GLB 结构校验（命名规范 / 动画 / extras）
│  └─ savePerf.mjs     基准结果落盘
├─ assets.html         资产展示页入口
├─ PERF.md             性能优化记录（含实测数据与待改进项）
└─ perf.json           基准原始数据
```

---

## 四、资产生产线（这是本项目的核心差异点）

不走「下载现成模型」的路线，而是用 Blender Python 脚本**参数化生成**全部资产。这样做的实际收益：

- 零版权风险，改一个参数就能重出一版（厂房尺寸、设备数量、工位布局）
- 命名规范由脚本保证，前端可以稳定依赖 `EQ_*` / `P_*` / `ENV_*` 前缀做语义解析
- 元数据（设备类型、工位号、部件角色）写在 Blender 的 `custom properties`，
  导出时通过 `export_extras` 变成 glTF `node.extras`，前端用 `manifest.json` + `userData.dt` 双重消费

### 4.1 重建全部资产

```powershell
$B = "E:\devtools\blender-5.2.3-windows-x64\blender.exe"

# 主模型 + 两级 LOD + 单设备 GLB + manifest.json
& $B -b --factory-startup -P tools/blender/build_workshop.py -- --lod

# 3D Tiles（8 空间单元 × 2 级 LOD = 16 瓦片）
& $B -b --factory-startup -P tools/blender/build_tiles.py

# 点云（40 万点 PLY）
& $B -b --factory-startup -P tools/blender/export_pointcloud.py -- --points 400000

# 3DGS 高斯（20 万个）
& $B -b --factory-startup -P tools/blender/export_splat.py -- --gaussians 200000
```

### 4.2 产物与体积

| 资产 | 文件 | 三角面 | 体积 |
|---|---|---|---|
| 主模型 LOD0 | `workshop.glb` | 59,038 | 593 KB |
| LOD1 | `workshop_lod1.glb` | 26,490 | 550 KB |
| LOD2 | `workshop_lod2.glb` | 8,836 | 320 KB |
| 3D Tiles | `tiles/*.glb` × 16 | 77,846 | 1.09 MB |
| 点云 | `workshop.ply` | 400,000 点 | 10.3 MB |
| 3DGS | `workshop.splat` | 200,000 高斯 | 6.10 MB |
| 单设备 | `equipment/*.glb` × 7 | 0.7k ~ 3k | 13 ~ 43 KB |

几何压缩用 **Draco**（Blender 导出时启用），纹理**全部程序化生成**（Canvas 2D，零网络请求、零体积）。

### 4.3 命名规范（前端强依赖）

| 前缀 | 含义 | 是否参与交互 |
|---|---|---|
| `EQ_<name>` | 设备实体根（Empty） | 是，携带实体级元数据 |
| `P_<entity>__<part>` | 设备部件（Mesh） | 是，最小拾取单元 |
| `ENV_<name>` | 环境件（墙/地/桁架/灯具/标线） | 否，会被静态合批 |
| `MERGED_env_<mat>` | 合批后的环境件 | 只作为遮挡检测目标 |

---

## 五、功能清单 ↔ JD 要求对照

| JD 要求 | 实现位置 | 说明 |
|---|---|---|
| JavaScript / TypeScript / HTML / CSS | 全项目 | TS strict，`noUncheckedIndexedAccess` |
| Three.js / WebGL 实战 | `src/core/`、`src/world/` | 原生 Three.js 操作 GL 资源，非封装库 |
| 模型加载 GLTF/GLB | `assets/AssetManager.ts` | Draco + KTX2 + Meshopt，进度/重试/超时/引用计数 |
| 场景搭建 | `world/lighting.ts`、`world/postfx.ts` | IBL（程序化 RoomEnvironment）+ 阴影 + Bloom |
| 点击拾取 | `interaction/Picker.ts` | BVH 加速，部件级精度 |
| 部件高亮 | `interaction/Highlighter.ts` | 材质克隆 + 发光 + 描边壳，可逆 |
| 3D 动画 | `tools/blender/lib/equipment.py` | glTF 内嵌 5 个 AnimationClip（关节/扫描/轮转） |
| 热点提示 | `interaction/HotspotLayer.ts` | CSS2D + **遮挡剔除**（raycast 每 8 帧） |
| 设备运行模拟 | `systems/TwinSource.ts` | 8Hz 状态机 + 一阶惯性指标 + 偶发故障 |
| 路径规划 | `systems/RoadNetwork.ts`、`workers/pathfinding.worker.ts` | A* 跑在 Web Worker，弧长参数化行驶 |
| 地图融合 / 多层级 | `core/CameraDirector.ts` `LevelManager` | 厂区 ↔ 车间，按相机位置自动掀屋顶 |
| 大模型优化 | 见 `PERF.md` | Draco / 合批 / LOD / BVH / 视锥剔除 / 动态分辨率 |
| 移动端适配 | `src/ui/styles.css`、`core/quality.ts` | 三档画质 + 触摸手势 + 断点布局 |
| **3DGS** | `pages/splat.ts` + `tools/blender/export_splat.py` | 自定义 WebGL2 高斯渲染器（协方差投影 + 索引级深度排序） |
| **点云** | `pages/pointcloud.ts` + `export_pointcloud.py` | 40 万点 PLY，`setDrawRange` 动态采样 |
| **3D Tiles** | `pages/tiles.ts` + `build_tiles.py` | 真实瓦片切分 + 按需流式加载 |
| Blender | `tools/blender/` | 全资产由脚本生成，可一键重建 |
| AI 生成代码验证 | 见本文第八节 | 类型检查 / 结构校验 / 性能基准 |

---

## 六、性能数据摘要

完整记录见 [`PERF.md`](./PERF.md)。核心数字（RTX 3060 Laptop，DPR 1.5，2880×1620）：

| 配置 | 中位帧耗时 | 等效 FPS | drawcall |
|---|---|---|---|
| 关闭后处理 | 5.2 ms | 192 | 301 |
| Bloom + SMAA | 5.9 ms | 170 | 320 |
| 画质 low（LOD2 + 无后处理） | 3.8 ms | 263 | 136 |

**最有价值的一个发现**：BVH 加速拾取并非总是更快。

| 目标集 | 朴素 raycast | BVH | 加速比 |
|---|---|---|---|
| 167 个小部件（25.8k 面） | **0.017 ms** | 0.032 ms | 0.5×（更慢） |
| 4 个环境合批件（33.1k 面） | 2.361 ms | **0.005 ms** | **472×** |

原因：three 的 raycast 在进入三角面循环前有包围球预筛。小网格的包围球测试就已经把它们挡掉了，BVH 的树遍历纯属额外开销；而合批后的大网格包围球覆盖全场，必然进入全量三角面测试。**结论：性能优化必须分场景测量，不能套用结论。**

---

## 七、关键实现说明

### 7.1 为什么不用 R3F

需求是「展示对 Three.js / WebGL 的掌握」。R3F 会隐藏渲染循环、资源生命周期与状态同步的细节，而这些恰是 Web3D 项目出问题最多的地方。自建 `Loop + SceneGraph + EventBus` 的组合，可控帧预算、可精确控制 dispose 时机。

### 7.2 高亮为什么用材质克隆

glTF 加载后多个 mesh 可能共享同一材质实例。直接改 `material.emissive` 会导致所有使用该材质的物体一起变色，且无法可靠还原。本实现首次高亮时克隆材质并缓存，恢复时只还原引用、不 dispose 缓存。

### 7.3 热点遮挡剔除

`CSS2DRenderer` 不参与深度测试，被墙挡住的标签仍会显示。这里每 8 帧对每个热点做一次 raycast（用 BVH 的 `firstHitOnly` 短路），射线在到达热点前命中不透明几何则淡出。相比「一直显示」，这是能看出工程细节的地方。

### 7.4 LOD 切换的一个隐蔽坑

模型替换后必须重建 `EntityRegistry`，否则 registry 仍指向已被移出场景的旧 mesh —— 拾取会命中不可见对象、高亮修改的是孤儿材质。这个 bug 在开发中出现过并已修复（见 `WorkshopWorld.rebuildIndexForLevel`）。

### 7.5 3DGS 渲染器的两个关键决策

1. **协方差投影必须在相机空间做**：先用视图矩阵把世界空间协方差转成 `V Σ Vᵀ`，再乘透视雅可比 `J`。最初写成 `J · R · Σ · Rᵀ · Jᵀ`（混用了世界/相机空间），导致高斯完全画不出来。
2. **深度排序只重排索引缓冲**：排序对象是 15~20 万个高斯，但顶点数是它的 6 倍。重排全部顶点属性耗时 76ms；改为只重写索引缓冲（每个高斯 6 个索引）后降到 21ms。

### 7.6 关于 3DGS 资产的诚实说明

**本项目当前的 `workshop.splat` 不是通过梯度下降训练得到的**，而是用「几何采样 + 面法线定向」生成的：从 Blender 真实场景按三角面面积采样点，高斯尺度由三角面局部尺寸决定，最短轴沿法线压扁（这正是训练结果的典型形态），颜色取材质基色 × Lambert 光照。

在**数据形态与渲染表现**上与训练结果同构（能用同一套渲染器正确渲染），但**生成方式**与论文不同。

真实的训练链路已经写好并保留在：

- `tools/blender/render_for_splat.py` —— 渲染 95 个多视角图像 + `transforms.json`（已跑通，产物在 `public/assets/splat/train/`）
- `tools/gsplat/train.py` —— gsplat 训练脚本（含 `DefaultStrategy` 致密化、PSNR 监控、`.splat` 导出）

未能跑通的原因（已实测确认）：

1. **gsplat 的 CUDA 内核需要 CUDA toolkit 编译**，本机 `CUDA_HOME = None`；
2. 用 `winget install --id Nvidia.CUDA --version 12.4 --silent` 尝试安装：
   下载与哈希校验均成功，但**启动安装程序时因缺少管理员权限失败**，
   退出码 `0xE0E00000`（耗时 638 秒）。当前 shell 非 elevated。
3. 机器只有 6GB 显存，训练 640×480×95 帧也有 OOM 风险。
4. gsplat 官方预编译 wheel 源（`docs.gsplat.studio/whl/pt26cu124`）
   对 torch 2.6 + cu124 无可用分发。

补齐环境的正确做法（需要**以管理员身份**打开终端）：

```powershell
winget install --id Nvidia.CUDA --version 12.4 --accept-package-agreements --accept-source-agreements
# 装完确认：
nvcc --version
```

然后执行训练（会覆盖 `workshop.splat`，前端无需改动）：

```powershell
E:\venvs\gsplat\Scripts\python.exe tools/gsplat/train.py --iters 7000 --sh-degree 1
```

训练输入已就绪：`public/assets/splat/train/`（95 张 640×480 图 + `transforms.json`），
可用 `render_for_splat.py` 重新生成（默认不入库，见 `.gitignore`）。

---

## 八、AI 辅助开发的验证方法

项目里有大量代码由 AI 生成，因此建立了三层验证：

### 8.1 静态检查

```powershell
npx tsc --noEmit   # TS strict 零错误
```

`tsconfig` 开启了 `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noImplicitOverride`，能拦住大部分 AI 生成的松散代码。

### 8.2 资产结构校验（`tools/inspect_glb.mjs`）

```powershell
node tools/inspect_glb.mjs public/assets/models/workshop.glb
```

断言项：节点命名符合 `EQ_/P_/ENV_` 规范、`dt` extras 覆盖率、动画数量与轨道数、体积与三角面统计。当前结果：

```
naming    : EQ_=14  P_=167  ENV_=12  bad=0
dt extras : 77 nodes  {"env":3,"agv":2,"cabinet":3,"console":1,"conveyor":3,...}
animations: 5 个（2 机械臂 / 1 检测 / 2 AGV）
```

### 8.3 运行时行为验证

通过浏览器 CDP 直接在页面里断言，而不是「看着像对的」：

```js
// 拾取准确性：投影设备中心 → 拾取 → 校验实体归属
const p = center.clone().project(camera);
interaction.pickAt(p.x, p.y);  // → { entityId: 'EQ_robot_01', partId: 'joint_elbow' }

// 交互闭环：点击 → 高亮 → 信息卡 → 列表同步
interaction.clickAt(-0.4, -0.2);
// 断言：selectedCount=11, cardVisible=true, partsListed=11, activeRow='EQ_robot_01'

// 故障链路：注入故障 → 状态灯 / 告警 / 热点 tone / 信息卡全部联动
twin.injectFault('EQ_robot_01');
// 断言：alerts 出现 bad → warn，hotspotTone 变化，cardStatus='维护'
```

### 8.4 性能回归

```js
await window.__bench()   // 每配置 40 帧采样，readPixels 强制 GPU 同步
```

输出与 `perf.json` 对比，超过阈值即视为回归。

---

## 九、交互速查

| 操作 | 效果 |
|---|---|
| 左键点击设备 | 选中整机 + 部件高亮 + 信息卡 |
| 点击已选中设备 | 取消选中 |
| Shift + 点击 | 叠加选择 |
| 悬停设备 | 部件级高亮预览 |
| 拖拽 / 滚轮 | 旋转 / 缩放（Orbit） |
| `1` ~ `7` | 切换机位预设 |
| 顶栏「漫游」 | 进入 WASD 飞行模式（Shift 加速，Space/C 升降，拖拽转向，Esc 退出） |
| 右侧站点按钮 | 规划 AGV 路径（地面流光带） |
| 「派车」 | 让 AGV 沿路径行驶 |
| 「跟随」 | 相机跟随最近 AGV |
| `X` | 给当前选中设备注入故障（演示告警链路） |
| `L` | 显示/隐藏 AGV 路网调试线 |
| `H` | 隐藏全部 UI（录屏用） |
| `P` | 显隐性能 HUD |
| `F` | 显隐热点 |

---

## 十、已知限制

| 项 | 说明 |
|---|---|
| `medium` 档比 `high` 慢 | 8.8ms vs 6.3ms。SMAA 无法与 Bloom 合并成单 pass，反而多一次全屏采样。**不要假设「降档一定更快」** |
| 3DGS 排序 21ms | CPU 排序。更大规模应换 GPU 基数排序（需 compute shader，WebGL2 下复杂度高一个量级） |
| 3DGS 画面偏软 | 几何采样生成的高斯缺少多视角训练带来的颜色/尺度优化 |
| 资产展示页需窗口聚焦 | 自动化测试时非活跃标签页 rAF 被节流，`update()` 不推进，瓦片数会显示 0 |
| 无后端 | 孪生数据是前端模拟（`MockTwinSource` 接口已隔离，可平替 WebSocket/MQTT） |

---

## 十一、许可

代码用于作品演示与学习。所有 3D 资产由本项目脚本生成，无第三方版权内容。
