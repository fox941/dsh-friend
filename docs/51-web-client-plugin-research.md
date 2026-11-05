# 2026-11-05 更正与落地

原先“rc.3 第三方 bundle 无法接入 webServer，必须等上游”的结论不成立。独立复现表明：bound.get('webServer') 可成功，而未显式 extend 的 connection.rpc.handle 会在内部获取调用方 webServer 时抛该错误；Mnemon 使用 extend({webServer:...})。现已改用已有表情库验证过的 connection.fetch.register，原生 main 与 sidebar.panellist 挂载 B站工作台，不修改 DSH 核心。见 [B站工作台](bilibili-workbench.md)。下方保留旧排查记录供追溯，不再作为当前可行性结论。

# B站面板进 DSH Web 应用内页：客户端插件契约研究笔记

2026-11-01 最终结论：**`webServer` 服务在 rc.3 的插件 inject 中不可达**——这是本轮多版本迭代（0.4.1–0.4.7）的实测结果，修正此前"服务存在但参数传错"的判断：

- `webServer` 由 `super(ctx,'webServer')` 的 Service 类提供（`packages/host/webserver/src/index.ts` 上游源码证实，与 GPT/Codex 调查一致），但这不等于第三方 bundle 的 fiber 能注入它。
- 实测矩阵（均在实际安装并重启的实例上验证）：顶层 `ctx.inject(['connection','webServer',...])` 后，回调内 `bound.webServer` 属性访问与 `bound.get('webServer')` **均抛** `cannot get property "webServer" without inject`；嵌套 inject 则整个回调不触发。安装产物核实无任何 `provide('webServer')` 字符串（Service 类构造器注册绕过字符串检索）。
- 推测（未验证）：cordis 的 Service 类注册可能带作用域/隔离标记，或 web-app 的 fiber 声明了 isolate，使兄弟 bundle 的 inject 无法穿透。**确切语义需向 DSH 维护者确认**（上游 GitHub 本轮持续超时）。
- soul 插件的 webServer 方案在本机未安装验证过，其兼容表也自标 rc.2 为 "unknown"——不能作为 rc.3 可用的证据。
- mnemon 的 UI 数据走 connection.rpc（本机安装代码证实），未依赖 webServer HTTP。

**当前可用形态**：静态控制台 `Bilibili-Console.cmd`（docs/50）。应用内标签的壳已随 0.4.7 安装（settings.section 注册成功），但数据通道因 webServer 不可达而显示"不可用"——这是诚实的降级，不是崩溃。

**后续可行方向**：
1. 向 DSH 维护者/文档确认第三方 bundle 注入 `webServer`/`connection` 的正确方式（或官方 UI 数据通道）。
2. 上游 `packages/client/ui-settings-plugin-inventory` 是官方自带设置页的完整范例（含 tsdown 构建与 Remote 命名空间）——但它属于第一方构建体系，第三方复用方式待确认。
3. 若确认 rc.3 插件无法获得 webServer/connection，则应用内页面在此版本上不可行，升级 DSH 后再评估。

# B站面板进 DSH Web 应用内页：客户端插件契约研究笔记（初版）

2026-10-31：bilibili-tool 0.3.0 时代的调研记录。目标：把静态 HTML 面板升级为 DSH Web 应用内的真实页面（像 dsh-mnemon 的记忆管理页一样）。

## 结论先行

**第三方插件可以在 DSH Web 应用内展示自己的页面——dsh-mnemon 就是活证据。** 契约已基本映射完整：客户端插件 = `dsh.bundle.client` 声明 + ModuleLoader bundle（React）+ `ctx.slots.register` 页面/卡片注册 + `connection.rpc.handle` 数据通道。**rc.3 实测：HTTP 前缀路由（soul 方案）不可用，必须走 connection.rpc。**

## 已证实的契约（来自安装产物与运行实例）

### 服务端（可立即实现）
- 插件注入 `connection` 服务：`ctx.inject(['connection','webServer'], bound=>{...})`（dsh-mnemon/lib/index.js 原样可见）。
- 数据通道：`connection.rpc.handle('/dsh-xxx-read', handler)`，handler 按 endpoint 名分发；每个通道一个 handler，读写通道分离（mnemon：`/dsh-mnemon-read`、`/dsh-mnemon-settings`、`/dsh-mnemon-review`）。
- 通道即 HTTP 路径字符串；远端访问走 API 网关 `/api/<namespace>/<endpoint>`（Typert 体系，第一方服务用装饰器+生成器；第三方插件用 rpc.handle 即可，不走 Typert）。

### 客户端（结构已证实，两个 API 待确认）
- package.json 声明：`"dsh": {"bundle": {"patch": "./cordis.patch.yml"}, "client": {"inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-session", "@deepseek-ai/dsh-client-locale"], "platform": "web"}}`（dsh-mnemon 原样）。
- 产物形态：`lib/client.js` 是 **ModuleLoader bundle**：`window.__ModuleLoader__.load({id:'包名', factory:(require)=>{...return module.exports}})`，可 `require('react')`、`@deepseek-ai/dsh-client-ui-primitives`、`react-dom`。由 **tsdown 的 Client 预设**构建（`dsh-client-hmr` README 提及"Client tsdown 预设"，chunk 完成后标记 `lib/client.js`）。
- 装载：Web 应用运行时（SPA 内 `RZ` 类）经 `globalThis.__ModuleLoader__.create({boot:__DSH_BOOT__, staticModules:OZ(), ...seams})` 创建 Client Modules；`manifest.plugins` 描述各插件客户端条目（分 tier 预取）；HTML 里可见 `plugins/??<包名>/client.js&rev=<hash>` 形态的 script 地址（本地实例实测多种变体均 404——**确切路由待确认**，可能需特定 rev/签名或仅登录会话可达）。
- 页面/卡片注册（mnemon 客户端源码内可见的真实调用）：
  - 卡片：`ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({name: SLOT_NAME, key: 包名, order}, props => createElement(Component, props)))`
  - 页面：`ctx.slots.register({name: PAGE_SLOT, id, order, label}, Object.assign(props=>createElement(page.component, props), {mnemonNavigation: page.navigation}))`
  - 区域渲染：`renderComponentRegion(ctx, region, packageName, props)` 按 key 找 `ctx.slots.entriesOfSlot(region)` 的 entry。
- **待确认 API**：Web 应用自己拥有的页面/侧边栏 slot 名称（mnemon 只注册自己命名空间下的 slot，由 mnemon starter 消费）；客户端 ctx 上调用服务端通道的方法名（`ctx.connection.rpc.call(...)` 形态）；Client 预设的 tsdown 配置。

### 构建与开发
- `@deepseek-ai/dsh-client-hmr`：开发时 bundle watcher + 浏览器热替换（`pnpm run dev:web`），生产构建产物即 `lib/client.js`；插件随包分发（files 含 lib）。
- React 状态在热替换时丢弃；会话/工作区/连接保留。

## 下一步实现路径（建议顺序）

1. **问上游**（成本最低）：deepseek-harness 仓库 `docs/cordis-tutorial/`、`docs/subsystems/`、`docs/development.md`，或直接问维护者"第三方插件如何注册 Web UI 页面"；dsh-mnemon 仓库 `src/client/` 源码（本地只有打包产物，源码里有页面注册的原始写法）。GitHub 本轮多次超时，未完成。
2. **服务端先行**（无依赖，可先做）：在 bilibili-tool 内加 `connection.rpc.handle('/dsh-bilibili-view', handler)`，数据层直接复用 `console.js` 的 `consoleSnapshot`；这步无论客户端方案如何都需要。
3. **客户端 bundle**：tsdown + Client 预设搭最小 bundle（一个页面组件 + slots.register 到确认的页面 slot），随 bilibili-tool 0.4.0 分发。
4. **配置编辑**：把 0.3.0 的"请求文件+cmd 应用"替换/并存为 settings 卡片（对齐 mnemon 的 settings region 模式），写路径仍走 `applyConfigRequest` 白名单校验。

## 本轮已排除的路径

- `/plugins/?<包名>/client.js`、`/plugins/??...` 等 URL 变体在本地实例均 404（带登录 cookie 复测过）；bundle 服务路由另有其形式。
- Typert API 网关（`/api/<namespace>/<method>`）是第一方服务的声明式体系（装饰器 + tsdown 构建期生成），不适合第三方插件直接使用。
- 静态 HTML 面板（docs/50，已上线）在应用内页落地前继续作为正式入口。
