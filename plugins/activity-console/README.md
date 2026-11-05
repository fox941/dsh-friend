# 活动中心

`@ai-friend/activity-console` 0.2.0，固定支持 DSH 0.2.1-rc.3。客户端是原生 main 面板，侧边栏入口为「活动中心」。服务通过 `connection.fetch.register` 承载 owner 查询接口与受控配置入口，没有模型、平台登录、调度器或数据库副本。

## 接入已有角色

宿主在 `friendActivityConsole` 注入作用域内注册同一角色的读取器：

```js
ctx.inject(['friendActivityConsole'], child => {
  const service = child.get('friendActivityConsole')
  child.effect(() => service.register('companion', {
    snapshot: options => existingReadView.consoleSnapshot(options),
    detail: (kind, id) => existingReadView.consoleDetail(kind, id),
  }), 'activity reader')
})
```

读取器的生命周期释放只解除自己的注册；同名重复注册拒绝。当前陪伴读取器仍由 companion-adapter 提供，便于复用它对 QQ/B站回执、成长预算和脱敏诊断的解释。新平台继续向同一调度器提供事件，类型会从已有记录自动进入筛选项；无需为每个平台增加全局活动页面。

新增来源可注册 `service.registerSource('forum', '论坛')`，用 effect 管理返回的解除函数。平台适配器为其真实事件提供 `payload.channel: 'forum'`，现有陪伴读取器便能按该来源筛选。来源标识只允许小写英文、数字、下划线和连字符。来源来自适配器结构字段，不按用户消息关键词推断；旧记录无可靠归属时归为「来源未分类」。此接口只增加展示元数据，不增加执行能力或授权。

## HTTP 和跳转

- GET `/api/ai-friend-activity?section=overview|tasks|choices|resources`。
- tasks/choices 支持 `source/kind/status/limit/offset`；先筛选已有数据，再分页。默认24条，最多48条，offset最多10000。
- GET `/api/ai-friend-activity-detail?kind=intent|decision&id=<UUID>`。
- 来源工作台可用 `refKind=run|reading|event&refId=<UUID>` 精确查询关联事项。缺失关联如实显示，不按正文猜测。
- 浏览器事件 `ai-friend:open-activity` 的 detail 可以带 section、source、kind、status、refKind、refId，或 detailKind、id。它只切换 DSH main 面板和读取记录。
- B站原任务返回通过 `ai-friend:open-bilibili` 事件交给 B站插件处理。

接口继承 DSH owner 身份边界，anonymous 401、agent 403；查询使用 GET、配置保存使用独立 POST，响应 no-store，不返回原 payload、模型提示词、凭据或本机路径。刷新不实例化执行控制器，不调用 readiness/tick/signal，不写数据库，不调用模型或平台。数据源未注册时返回503。

页面源文件为 src/client-page.js、src/client.css；运行 `node scripts/build-activity-client.mjs` 生成 src/client.js。安装、迁移和代码更新均沿用项目的版本化本地 tgz 流程。


## 活动设置

GET section=settings 委托现有读取器的 settings()。POST /api/ai-friend-activity-control 委托 configure(command)，要求 owner、同源 Origin、JSON、8KiB上限、UUID请求编号和配置版本。当前只开放B站原有的六项活动字段，不提供人格、调度规则或平台账号操作写入口。配置继续由B站模块持有，使用既存事务、版本与管理回执。普通查看、筛选及刷新仍只读。
