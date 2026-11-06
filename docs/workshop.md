# 文件工作间与自制工具

版本：companion-adapter 0.77.1。复用 QuickJS WASM 0.32.0，不修改 DSH、QQ 桥或 B站插件源码，不增加常驻模型或后台调度循环。

## 能做什么

当前主用户 Web／QQ 陪伴会话中，可以自行创建和修改专属目录的 UTF-8 文本、Markdown、JSON、脚本草稿；读取当前文件版本、查询变更历史、把某一文件恢复为原版本。每次修改须匹配刚读取的版本，新文件使用 `absent`。恢复也会形成新回执，保留之后产生的历史，不覆盖整个实例。

可通过 `friend_tool_define → friend_tool_test → friend_tool_publish → friend_tool_run` 创建具名 JavaScript 小工具。工具统一从 `friend_tool_run` 调用，不动态安装 npm 插件，也不不断向模型添加新的顶层工具声明。`friend_tool_read` 查询正式／草稿代码和版本，`friend_tool_run_read` 查询执行、测试及文件回执。注册后可跨会话、重启复用；新草稿不影响旧正式版本。

她是否动手仍由当前模型决定，工具调用处在原主用户会话的调度与取消机制中。第一版不新增空闲时自行编程的后台执行器，也不允许其他好友、群评论或平台内容直接驱动文件工作间。B站后台交流的专用表达模型暂未挂载这些文件工具。

## 代码协议

```js
function main(input, files) {
  const text = input.text ?? files['notes/example.md'] ?? '';
  const result = { characters: text.length };
  return {
    result,
    writes: [{ path: 'output/count.json', content: JSON.stringify(result) }]
  };
}
```

定义时声明 `readFiles` 和 `writeFiles`，各最多8个工作间相对路径。`files` 只含显式允许读取的文件内容。没有文件需求时可只做 JSON 数据计算。必须返回 JSON 对象及 `result`，可附文件写入计划 `writes`，不能调用宿主工具。

试跑提供1–5个 `input`、`expectedResult` 和可选 `expectedWrites`；只比较这些用例，试跑不会保存输出文件。全部通过后使用当前版本及真实成功回执注册。测试通过不证明所有输入都正确，不是独立语义审核。首版不支持异步函数、npm import、Node 文件系统、进程、终端、网络或修改 DSH 插件。

运行默认预览，不写输出文件；`applyWrites=true` 才提交声明中的文件。宿主核对输出路径、内容大小和执行前文件版本，拒绝未声明写入。多文件不是一个文件系统事务：若提交中断，回执会分别记录已提交文件并标为 `partial`，不得宣称全部完成或完全未写。重启核对真实文件哈希，运行中的脚本记为中断，不自动重放。

## 数据与迁移

```text
runtime/dev/workshop/
  files/             实际工作文件
  versions/          内容哈希命名的旧新文件正文、已注册工具版本
  registry.json      当前工具、草稿、测试结果、版本与执行额度
  receipts/          文件变更、试跑与执行回执
```

记忆、画像和人格继续使用原存储及审核入口。工作文件、代码和计算结果是作品或派生资料，不自动成为事实、人格或长期记忆。模型不能使用路径穿越、目录联接、Windows设备名或文件流越过 `workshop/files`。拒绝复制疑似密钥；沙箱只获得本次显式输入和声明的工作文件，没有环境变量、Cookie 或主用户记忆接口。

完整实例备份／迁移包含此目录；代码更新保留原实例目录。空白部署仍不带原实例的文件和自制工具。新引擎依赖固定在插件包及 profile 锁文件中，首次安装需要恢复依赖。没有新增数据库或更改原数据库表结构。

## 初始资源范围

- 单个工作文件128KiB，最多512个文件、当前文件合计32MiB；保留历史会额外占空间，暂不自动清理。
- 最多48个工具名；单个脚本64KiB，输入64KiB，JSON结果32KiB。
- 每个用例／调用独立进程；QuickJS 运行内存16MiB、栈256KiB、CPU中断约2秒，父进程10秒超时。
- 测试用例和正式调用共用每日128次执行额度，失败也计数；北京时间自然日计账，不耗用原夜间整理／B站探索份额。

这些是首版的固定上限，未增加配置界面。纯文件操作不额外调用模型；模型编写代码仍占原会话正常模型用量。

## 实现与验收

QuickJS 官方项目：[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)。只安装 core 和一个 release-sync WASM 变体。用户代码在 WASM 虚拟机运行，不交给 Node eval 或 node:vm；独立子进程负责加载引擎和限制故障影响。

25项工作间测试覆盖路径、链接、并发版本冲突、历史恢复、试跑、发布、未声明写入、进程超时与取消、内存边界、重启核对和主用户鉴权；连同原适配器、记忆、运行保护及实例隔离共106项候选包回归通过（包含这25项，不能相加）。真实 DeepSeek 在独立虚构资料上完成文件创建、自己编写工具、两个用例试跑、注册、调用、保存及读回；未给正式角色植入演练工具。真实 DSH 0.2.1-rc.3 候选启动和工作间健康状态已验证，使用独立身份并关闭全部平台通道。

正式部署结果与备份以 `.work/workshop-release.json` 为准；真实 QQ 用户会话中的自然选择尚未作为以上隔离验收的一部分。
