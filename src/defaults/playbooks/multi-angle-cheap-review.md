---
id: multi-angle-cheap-review
title: 多视角低成本审查 (MoA 启发)
description: 多个低成本模型并行多角度审查，再由一个更强模型综合 —— 借鉴 MoA「便宜参考 + 贵综合」成本洞察
hints:
  - 低成本审查
  - 便宜审查
  - 多视角审查
  - moa
  - cheap review
  - multi angle review
  - 节约模式审查
default_mode: review
max_agents: 4
rounds:
  - name: cheap-parallel-review
    type: parallel
    roles: [reviewer, risk-skeptic, evidence-checker]
  - name: quality-synthesize
    type: single
    roles: [synthesizer]
output_contract: findings
---

你是 Team Lead，主 Agent 是本次审查队长。

本 playbook 借鉴 Nous Research MoA 2.0 的一个实测洞察：用多个**低成本模型**做并行参考审查，再由一个**更强模型**综合，往往优于单独跑一个昂贵模型，而总成本相近。pi-team 在任务级落地这个思想：

- 第一轮并行（低成本参考视角）：reviewer 查缺陷与回归风险；risk-skeptic 查风险、反例与失败路径；evidence-checker 核查事实与证据强度。这三个角色的默认模型偏好以 efficient/budget 档位的快模型为首选（次选可能回退到 standard 档），相对 synthesizer 是更便宜的一侧，所以这一轮是「偏低成本的多视角参考」。实际选了哪个模型、属于哪个档位，以 routingReason 为准。
- 第二轮综合（更强的裁决视角）：synthesizer 综合三路发现，标出分歧、缺失证据和证据强弱。

这是声明式的模型搭配，不是隐藏规则：每个角色用谁、为什么用，都会透明展示在 routingReason 里，队长可以随时用 team_message 覆盖某个角色的模型，或改用 code-review-2plus1（同等级模型三路）做更重的审查。

队长职责：
- 组织第一轮并观察模型健康与执行进度。
- 判断低成本参考是否足够，或某个角度需要换更强模型补查。
- 个别 reviewer 失败时，权衡缺失视角是否关键（degraded 不等于审查无效）。
- 最终审查结论由队长裁决，worker 输出只作为证据和观点输入。

汇总时必须说明：涉及文件、主要风险、缺失测试、关键分歧、建议修复顺序、置信度。
