# NanoCrab 插件指南

本文档面向插件使用者与开发者，提供 NanoCrab 插件架构的可操作说明。完整规范请参考 `docs/spec.md`。

## 1. 设计原则
- 默认隔离运行，提升安全与稳定性
- 支持动态加载与卸载，无需重启 Node
- 内嵌模式需审核，降低宿主风险
- 最小权限原则，默认无 FS/NET/SHELL 能力

## 2. 插件包结构
```
my-plugin/
  plugin.json
  index.js
  assets/
  README.md
```

## 3. Manifest 概览
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "main": "index.js",
  "events": ["message_received", "before_run"],
  "commands": ["hello"],
  "permissions": {
    "fs": { "read": true, "write": false, "roots": ["${workspace}"] },
    "net": false,
    "shell": false
  },
  "runtime": { "mode": "isolate", "sandbox": "optional" },
  "compat": { "host": ">=0.6.0", "api": "v1" }
}
```

## 4. 运行模式
- 默认 `isolate`，隔离进程或 worker 运行
- `embed` 仅在审核通过后允许
- sandbox 在隔离模式下默认 on，可按插件覆盖为 off（需要审批）

## 5. 生命周期
- `activate(ctx)` 加载时调用
- `deactivate(ctx)` 卸载或禁用时调用
- `onEvent(type, payload, ctx)` 事件入口
- `onCommand(cmd, args, ctx)` 命令入口（可选）

**要求**
- 插件必须在 `deactivate` 中释放定时器与监听器
- 宿主在卸载时调用 `deactivate` 并等待完成或超时

## 6. IPC 与事件
隔离模式下通过 IPC/RPC 传递消息。常用事件包括：
- `message_received`
- `workspace_changed`
- `before_run`
- `after_run`

## 7. 命令与路由
- 系统命令优先：`/plugin`、`/help`
- 插件命令：`/p <plugin> <cmd>` 或 `/plugin:<name> <cmd>`
- 直达命令需在 manifest 明确声明且不冲突

## 8. 管理命令
```
/plugin list
/plugin info <name>
/plugin install <src>
/plugin uninstall <name>
/plugin enable|disable <name>
/plugin approve <name>
/plugin runtime <name> isolate|embed
/plugin sandbox <name> on|off
```
说明：
- `/plugin runtime <name> embed` 会触发审批，确认后生效
- `/plugin sandbox <name> off` 会触发审批，确认后生效
- `/plugin approve <name>` 仅用于“内嵌”审批（sandbox-off 走独立审批）

## 9. Registry 与状态
- Registry 建议路径：`store/plugins.json`
- 插件状态按 `plugin + workspace + conversation` 维度存储

## 10. 快速示例

**index.js**
```js
export function activate(ctx) {
  ctx.registerCommand("hello", () => ctx.sendMessage("hi"));
}

export function onEvent(type, payload, ctx) {
  if (type === "message_received") {
    // ...
  }
}

export function deactivate(ctx) {
  // cleanup
}
```

## 11. 与 openclaw 的差异
- 插件以事件与能力扩展为中心
- 默认隔离运行并支持动态加载
- 内嵌模式需要审核与审计

## 12. 参考
- 完整规范：`docs/spec.md`
