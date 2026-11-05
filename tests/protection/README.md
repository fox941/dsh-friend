# 独立真实模型验收

先安装项目固定依赖。使用项目 Node，设置 `AI_FRIEND_RUN_MODEL_TESTS=1` 后运行 `tests/protection/suite.mjs`。会调用已配置的 DeepSeek 并消耗 API 额度；测试实例、私有日志和报告放在 `.work/protection-acceptance`。只复制配置和依赖，不把实际用户记忆导入测试。测试角色不会导入用户实例。

覆盖真实预演与应用、写前快照、查询原话和报告、停机恢复原 Native ID 与图、保留无关后续 Runtime、重启后查询、拒绝重放已撤销报告。管理启动锁和中断恢复等故障用例由 `protection*.test.mjs` 覆盖。
