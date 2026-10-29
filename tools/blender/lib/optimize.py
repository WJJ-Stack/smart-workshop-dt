"""静态合批：把环境件按材质合并，把 drawcall 从数百降到数十。

这是 Web3D 项目里最直接有效的优化之一，也是最容易讲清楚的：
    每次 drawcall 都有 CPU 侧的验证、状态切换与 uniform 上传开销，
    几百个 60 三角面的小物件，CPU 开销远大于 GPU。
    合并后顶点数几乎不变，但 drawcall 下降一个数量级。

约束：
- 只合并 ENV_ 前缀的网格（环境件不参与业务拾取/高亮）；
- 必须按材质分组，否则一个 mesh 内多材质仍会拆成多个 drawcall；
- 合并前要应用变换（apply transform），否则 join 会保留各自矩阵。
"""
from __future__ import annotations

import bpy

from bpy_util import apply_transform, deselect_all, set_dt


def merge_static_by_material(prefix: str = "ENV_", name_prefix: str = "MERGED_env") -> dict:
    """按材质合并所有以 prefix 开头的 mesh，返回统计信息。"""
    deselect_all()
    before_meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    targets = [o for o in before_meshes if o.name.startswith(prefix)]

    if not targets:
        return {"merged": 0, "kept": len(before_meshes), "groups": 0}

    # 按「首个材质」分组。多材质对象单独保留（保守策略）。
    groups: dict[str, list[bpy.types.Object]] = {}
    leftovers: list[bpy.types.Object] = []
    for obj in targets:
        mats = [m for m in obj.data.materials if m is not None]
        if len(mats) != 1:
            leftovers.append(obj)
            continue
        key = mats[0].name
        groups.setdefault(key, []).append(obj)

    merged_count = 0
    group_count = 0
    for mat_name, objs in groups.items():
        if len(objs) < 2:
            continue
        group_count += 1
        for o in objs:
            apply_transform(o)
        deselect_all()
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        safe = mat_name.replace("MAT_", "").replace(" ", "_")
        joined.name = f"{name_prefix}_{safe}"
        joined.data.name = f"{joined.name}_mesh"
        set_dt(joined, role="static_merged", material=mat_name)
        merged_count += len(objs)

    after_meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    stats = {
        "before": len(before_meshes),
        "after": len(after_meshes),
        "merged": merged_count,
        "groups": group_count,
        "leftovers": len(leftovers),
    }
    print(
        f"[MERGE] {prefix}: {stats['before']} -> {stats['after']} meshes "
        f"({merged_count} merged into {group_count} groups, {len(leftovers)} left as-is)"
    )
    return stats


def count_draw_call_estimate() -> int:
    """粗估 drawcall 数：每个 mesh 的每个材质槽算一次。"""
    n = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        slots = max(1, len([m for m in obj.data.materials if m is not None]))
        n += slots
    return n
