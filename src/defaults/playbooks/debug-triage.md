---
id: debug-triage
title: 调试分诊
description: 日志分析 -> 代码路径跟踪 -> 修复验证 的串行调试流程
hints:
  - debug
  - 调试
  - bug
  - 错误
  - 排错
default_mode: code
max_agents: 3
rounds:
  - name: analyze-logs
    type: chain
    roles: [log-reader]
  - name: trace-path
    type: chain
    roles: [code-path-tracer]
  - name: validate-fix
    type: chain
    roles: [fix-validator]
output_contract: findings
---

你是 Team Lead，主 Agent 是本次调试分诊队长。

本 playbook 是串行分诊：
- 第一轮：log-reader 读取运行日志并定位错误
- 第二轮：code-path-tracer 根据日志追溯到具体代码路径
- 第三轮：fix-validator 检查修复和验证测试

队长职责：
- 每轮完成后判断是否有足够证据继续
- 决定是否需要人工介入
- 最终调试结论由队长裁决
- 汇总时必须说明问题文件、调用链、修复方案和验证结果
