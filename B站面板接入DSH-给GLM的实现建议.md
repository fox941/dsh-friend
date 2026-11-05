# B站面板接入 DSH：给 GLM 的实现建议

调查日期：2026-11-01。目标环境：本机 DSH `0.2.1-rc.3`，Mnemon `0.5.36`；调查时 B站插件源码为 `0.4.1`。这是调查与交接文档，不是已部署的修复。当前业务插件、账号、记忆和运行实例均未因本次调查修改。

## 1. 结论与推荐

**可以在 DSH 内实现。优先采用“DSH 官方客户端插件机制＋设置页插槽＋现有 Connection RPC”，以本机已运行的 Mnemon 为参照。** 先做设置页里的最小只读页面，链路验收通过后再扩成完整 B站管理页面；独立侧边栏入口是第二阶段。

没有找到经本机验证、装上就能自动把现有 bilibili-tool 转成 DSH 面板的通用插件。现成且有价值的是界面扩展机制、官方模板和已工作的实现。不要因为没有现成 B站面板，就重建服务器、替换框架或判断“DSH 无法实现”。

| 方案 | 推荐程度 | 适用范围与代价 |
|---|---|---|
| 官方 UI 模板＋settings.section＋Connection RPC | **首选** | 无额外服务；先把设置入口、数据读取跑通。当前版本有明确的本地实现依据 |
| 仿照 Mnemon 的 main＋sidebar.panellist | 第二阶段 | 适合与“记忆系统”并列的 B站工作台；需实现面板选中、打开关闭、卸载与窄屏行为，不能只注册一个图标 |
| Better Sidebar 的第三方扩展 API | 可选 | 项目明确提供第三方侧边栏扩展；增加一套界面依赖，需固定并验证与本机 rc.3 兼容的版本 |
| 独立静态 HTML／另开管理站点 | 保留作诊断入口 | 现有控制台可复用；单独运行不等于已接入 DSH，也不是解决客户端插件装载的必要前提 |

官方同版本 UI 指南：[rc.3 ui-plugin.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md)。官方设置页说明：[ui-settings](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings/README.md)。第三方参照：[Mnemon](https://github.com/omdsh-dev/dsh-mnemon)、[Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)。master/main 只用来了解设计，落地参数以本机安装产物及 rc.3 对应源码为准。

## 2. 当前代码中已经定位的问题

### 2.1 Context 被误当作 webServer 服务

`D:/ai friend/plugins/bilibili-tool/src/index.js` 当前调用：

```js
ctx.inject(['webServer'], child => {
  registerConsoleRoutes(child, controller);
});
```

而 `src/console-web.js` 的函数签名是 `registerConsoleRoutes(webServer, controller)`，内部直接调用 `webServer.register(...)`。`child` 是 Cordis Context，不是 webServer 服务实例。应先取得服务，例如 `child.webServer` 或 `child.get('webServer')`，再传入。

**本次已用内存替身复现：传 Context 形态对象得到 `register is not a function`，传具备 register 的服务实例成功登记相同前缀。没有启动 HTTP 服务器、访问数据库或发网络请求。** 这证明了此处参数契约错误，不代表改这一行就完成所有 UI 接入。

### 2.2 “rc.3 没有 webServer”不能作为结论

`docs/51-web-client-plugin-research.md` 通过搜索 `provide('webServer')` 推断服务不存在，这种检索会漏掉继承 Service 的注册方式。

本机实际安装的 `@deepseek-ai/dsh-host-webserver/lib/index.js` 中可以找到：

```js
super(ctx, "webServer");
register(route) { /* ... */ }
```

官方 rc.3 也包含对应实现：[WebServer 源码](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/host/webserver/src/index.ts)。本机 Mnemon Host 还明确注入了 `['connection', 'webServer']`。这推翻“rc.3 根本没有这个服务”的版本层判断；具体插件作用域有没有成功取得服务，仍需看实际装配与日志。

**404 也不能单独证明某服务不存在**：插件未装载、依赖未满足、作用域错误、注册失败、请求路径不符、客户端清单未更新，都可能造成相同结果。

### 2.3 修好 HTTP 注册，也不能假定它自动继承鉴权

WebServer 是底层 HTTP 路由注册服务，不能仅凭“同源”就认定新前缀已经受 DSH 浏览器身份、Host/Origin 校验保护。现有 `console-web.js` 注释中的“鉴权由 DSH Web 会话统一承担”需要由调用链和负向测试证明。

因此首版推荐复用 Connection RPC 通道，沿用 DSH 的浏览器连接和请求信任校验。仍需限制读写端点、目标实例、参数和可见数据；前端传来的 `source:'web-ui'` 只是字符串，不能当成授权凭证。

### 2.4 客户端还缺少数据通道依赖与调用

当前 `src/client.js` 的数据请求仍是 `fetch('/dsh-bilibili-tool/api/...')`，package 的 `dsh.client.inject` 只列了设置页提供者。若采用 RPC，需要补入客户端连接模块依赖，并在 Client apply 中注入 `connection` 服务。

本机 Mnemon 客户端的确切调用形状是：

```js
connection.rpc.call(channel, endpoint, payload, signal);
```

Host 端匹配形状是：

```js
connection.rpc.handle(channel, async (endpoint, payload, signal) => { /* ... */ });
```

这是已核对的本地代码，不是猜测的 `rpc.request`、WebSocket 消息格式或自行拼接的 `/api/...` 路由。RPC 的 channel 看起来像路径，但由 Connection 决定承载方式，不要据此重新实现请求协议。远程配对／局域网场景可能另有网关限制，先验收本机浏览器，不宣称自动支持远程管理。

### 2.5 useApi 的 fetcher 依赖有循环请求风险

当前有 `useApi(() => call(API + '/state'))` 这种写法；内部 reload 又依赖 fetcher，effect 依赖 reload。每次组件重渲染都会生成新的 fetcher，可能造成 effect 反复执行和持续请求。

这是静态代码分析结论，尚未做真实浏览器复现。修复时用稳定的 `useCallback`，并为组件卸载／新请求替换旧请求设置 AbortController。配置表单建议改为 React 受控值或组件 ref 范围内读取，避免全局 `document.querySelectorAll` 混入其他面板的字段。

## 3. 推荐实施顺序

### 第一步：先出现一个完全不联网的页面

先暂时把复杂面板换成“B站面板已加载”的静态 React 文本。保留包级 ModuleLoader factory、正确的 `./client` 导出、客户端声明和设置页插槽。此时不读取 Cookie、不调用 B站、不写配置。

现有包的下述组合方向正确，不必先引入 Vite 或新装一份 React：

```json
{
  "exports": { ".": "./src/index.js", "./client": "./src/client.js" },
  "files": ["src", "vendor", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-connection"
      ]
    }
  }
}
```

这是需要合并进完整 manifest 的节选，不能覆盖原有依赖、导出和分发文件。ModuleLoader 的 id 必须与包名完全相同。React 由 DSH 浏览器模块表提供，避免重复 React 引发 Hooks 错误。简单 JS 客户端可直接沿用官方手写 factory；复杂 TSX 再参照官方 `clientBundle` 构建配置。编译不是当前最小实现的前置条件。

验证包是在**当前 Web profile** 安装且启用；检查实际安装目录的 package.json、客户端导出文件和打包文件，而不只检查 `plugins/` 源码。通过 DSH 插件安装／装载流程更新客户端清单，不手改 node_modules。浏览器 Network 使用实际启动清单给出的客户端资源 URL，不再枚举猜测 `/plugins/??...` 的变体。

### 第二步：先通一个只读 state RPC

以下为自行编写的最小设计骨架，展示已核对的契约，不是完整可部署模块：

```js
// Host：注册应放在当前插件所属的可释放 Context 内。
ctx.inject(['connection'], scope => {
  const connection = scope.connection ?? scope.get('connection');
  connection.rpc.handle('/ai-friend-bili-console', async (endpoint, payload, signal) => {
    if (endpoint !== 'state') {
      return { ok: false, error: { code: 'unknown-endpoint', message: '未知端点' } };
    }
    signal?.throwIfAborted();
    const controller = service.current();
    if (!controller) {
      return { ok: false, error: { code: 'not-ready', message: 'B站控制器尚未就绪' } };
    }
    return { ok: true, value: consoleSnapshot(controller.instance) };
  });
});
```

`consoleSnapshot` 从既有 console.js 导入；`service.current()` 按每次调用解析控制器，避免首次注册时 controller 为空就永久跳过。不能接受浏览器传入任意 instance 路径。RPC 的处理函数应依附本插件生命周期；卸载／重载时要测试旧处理器是否已释放、是否出现重复 channel。

Client 侧，factory 返回的插件声明 `inject: ['slots', 'connection']`；在 apply 中通过插槽的 inject 给组件提供连接：

```js
// 放在现有 ModuleLoader factory / apply 内；Panel 仍用宿主 React 渲染。
const connection = ctx.connection ?? ctx.get('connection');
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'ai-friend-bili-console',
  order: 26,
  label: () => 'B站面板',
  inject: () => ({ connection })
}, Panel));
```

Panel 的 useEffect 中发起 `connection.rpc.call('/ai-friend-bili-console', 'state', {}, signal)`，按 `ok/value/error` 渲染成功、未就绪和错误；卸载时 abort。不要在渲染函数里请求数据。先手动刷新，不一开始就做高频自动轮询。

### 第三步：复用现有数据与业务校验

- 状态、观看、私信、评论、账号操作：复用 `consoleSnapshot` 的白名单字段和明确的回执状态。
- 关注列表：单独的读取按钮和端点，超时可取消；不要跟随每次页面重渲染调用 B站接口。
- 字段描述：复用 `configFields`。
- 配置变更：另开写通道或明确写端点，复用 `applyConfigRequest`，保留字段／数值校验、审计、结果和错误。不要提供任意 SQL、任意文件或通用 NapCat/B站 API。
- 写操作必须限制为已鉴权的本机管理会话；增加陈旧页面写入的版本／冲突检查。若现有 API 没有该能力，单独设计后再实现，不假定它已具备。
- 不把 SESSDATA、CSRF、QQ 令牌、模型密钥或系统提示放到响应、浏览器 storage、console.log 或 HTML。

先把只读链路验收通过，再开放配置写入；不必为了复用官方设置表单而修改 DSH 内部 namespace 白名单。历史上确有第三方设置 namespace 的兼容讨论，但不代表当前版本只能打补丁才能显示自定义 React 页面：[讨论 #1196](https://github.com/deepseek-ai/deepseek-harness/discussions/1196)。

### 第四步：再做独立侧边栏工作台

本机 Mnemon 0.5.36 的客户端明确注册了 `main` 与 `sidebar.panellist`：主面板用 key，侧栏条目用 id，还配有打开关闭与选中协调。需要连同导航机制一起参考，不能直接复制自己的命名空间页面插槽名，也不能只注册图标就期待主区域自动切换。

可选的 Better Sidebar 提供第三方侧边栏扩展 API：[仓库](https://github.com/omdsh-dev/DSH-better-sidebar)。若用户明确需要它的编辑器式侧栏，可基于一个固定且通过 rc.3 实测的版本接入；本轮未安装和验证它，不能承诺最新版直接兼容。本项目只有一个 B站工作台时，先用原生设置页入口更轻。

不要复用 Mnemon 的 DOM 点击截获／备用导航实现作为首版；那是其兼容层，不是所有插件都需要的前提。不要用 DOM 注入或替换 DSH 根节点来实现侧栏。

## 4. 本机可以立即阅读的依据

| 依据 | 本地路径／关键位置 |
|---|---|
| 官方同版本 UI 指南 | `D:/ai friend/upstream/deepseek-harness/packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md` |
| 官方最小 factory 示例 | 上述目录相邻的 `templates/decoration/client.js` 和 `package.json` |
| 官方设置页 slot 类型 | `D:/ai friend/upstream/deepseek-harness/packages/client/ui-settings/src/client/contract/slots.ts` |
| 官方插件设置页示例 | `.../packages/client/ui-settings-plugin-inventory/src/client/index.ts`，示范 settings.plugins.tab、inject 和清理；不直接照搬其内部 Remote 命名空间 |
| 官方构建入口 | `.../packages/client/ui-settings-plugin-inventory/tsdown.config.ts` 及 `.../packages/client/tsdown.client.ts` |
| 客户端导出与路由解析 | `.../packages/client/modules/src/index.ts`，搜索 clientExportOf、PLUGIN_ROUTE、fetchBundle |
| 服务注册方式 | `.../packages/host/webserver/src/index.ts`，搜索 WebServer、super、register |
| RPC 与浏览器信任 | `.../packages/client/connection/src/rpc-host.ts`、`rpc.ts`、`api-request-trust.ts` |
| **本机已运行 Mnemon Host** | `D:/ai friend/runtime/dev/dsh-home/profiles/web/node_modules/dsh-mnemon/lib/index.js`，搜索 registerRpc、createReadHandler、connection.rpc.handle |
| **本机已运行 Mnemon Client** | 同目录 `lib/client.js`，搜索 callMnemonRpc、settings.section、sidebar.panellist、main |

`upstream` 工作树可能继续演进，路径有文件不等于与当前安装字节完全相同。遇到冲突以固定发布 tag 和实际安装包的运行契约为准；本次同时核对了安装版 WebServer、Mnemon Host/Client 的对应关键点。

可用项目专用 Node 通过 `createRequire(realpath('D:/ai friend/node_modules/@deepseek-ai/dsh/package.json'))` 解析 `@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-client-modules`、`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-connection`。pnpm 路径经过联接，不能只在 node_modules 顶层找同名目录，找不到就认定没安装。

## 5. 最小验收与交付要求

1. **装载**：隔离 profile 的客户端清单包含该包；实际资源 200，factory 被调用，浏览器无模块／插槽错误。
2. **挂载**：设置页能看到静态“B站面板”，关闭重开正常，重载没有重复条目。
3. **通信**：state 经 Connection 返回；控制器未就绪、断线和取消能显示真实状态，没有持续循环请求。
4. **数据**：真实实例只读查询得到的条数、时间、回执与本地数据一致；API 受理不能显示成对方已读、公开可见或完整看完视频。
5. **写入**：白名单修改可用；未知字段、越界值、陈旧版本和未鉴权请求失败，不改变无关配置。刷新和重启后保持同值。
6. **隐私与卸载**：响应和日志没有凭据；关闭插件后 RPC／插槽／定时器撤销。不能声称“同源所以安全”。
7. **部署**：先在隔离 profile 跑通，再与主实例的其他改动合并和串行部署。不要覆盖 `.work/qq-social-lifecycle-prepared` 和 `.work/qq-account-actions-prepared` 中的待合并 QQ 成果。

本次只完成源码调查、官方／社区方案检索和路由传参的内存复现，**没有完成新的真实浏览器端到端验收**。交付时请列出以上哪几步实际通过，不用“源码写了”替代“页面已经能用”。

## 6. 可直接复制给 GLM 的任务说明

> 请基于当前固定 DSH rc.3 和实际安装产物继续开发。先纠正“没有 webServer”的判断及 Context／服务实例混用问题，但首版数据通信推荐 Connection RPC。沿用官方最小 ModuleLoader factory，把 settings.section 静态页实际显示出来，再用明确的 rpc.handle(channel, handler)／rpc.call(channel, endpoint, payload, signal) 契约接 consoleSnapshot。界面先只读，配置写入之后接既有白名单和审计。修复 useApi 的不稳定 fetcher 依赖，避免循环请求。当前阶段无需另装 React、替换 DSH、重建业务后台，也不要先纠缠独立侧边栏。请先交付“设置页可见＋一次状态读取成功”的真实浏览器证据，再扩展完整工作台。
