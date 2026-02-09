# Plugin Architecture Spec

本规范定义 NanoCrab 的插件架构。核心目标：默认隔离运行、可动态加载/卸载、内嵌模式需审核、隔离模式可选择 sandbox on/off。插件以“事件/能力扩展”为中心，不以命令为中心（命令仅为可选入口）。

## 1. 目标与非目标

**目标**
- 插件可独立安装/卸载、启用/禁用，且无需重启 Node。
- 默认隔离运行，提升安全与稳定性；内嵌模式必须审核。
- 统一 IPC 协议与生命周期，便于插件开发与宿主管理。
- 最小权限原则：默认无 FS/NET/SHELL 能力。

**非目标（本规范不覆盖）**
- 插件市场/在线更新机制。
- OS 级沙箱（仅定义接口与策略，具体实现可选）。

## 2. 术语
- **Host**：宿主程序（NanoCrab）。
- **Plugin**：插件包，含 manifest 与入口。
- **Registry**：插件注册表，记录安装与运行策略。
- **Runtime**：插件运行时（隔离/内嵌）。
- **Sandbox**：运行时能力限制策略。

## 3. 插件包结构
```
my-plugin/
  plugin.json        # 必需：manifest
  index.js           # 必需：入口
  assets/            # 可选
  README.md          # 可选
```

## 4. Manifest 规范（plugin.json）

### 4.1 必填字段
- `name`: string（唯一标识，小写/中划线）
- `version`: semver
- `main`: string（入口文件相对路径）

### 4.2 可选字段
- `displayName`: string
- `description`: string
- `commands`: string[]（可选命令入口）
- `events`: string[]（订阅事件）
- `permissions`: object（权限声明）
- `runtime`: object（运行建议）
- `compat`: object（兼容性）
- `configSchema`: object（配置 schema）

### 4.3 示例
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "main": "index.js",
  "displayName": "My Plugin",
  "description": "Example plugin",
  "events": ["message_received", "before_run"],
  "commands": ["hello"],
  "permissions": {
    "fs": { "read": true, "write": false, "roots": ["${workspace}"] },
    "net": false,
    "shell": false
  },
  "runtime": {
    "mode": "isolate",
    "sandbox": "optional"
  },
  "compat": { "host": ">=0.6.0", "api": "v1" },
  "configSchema": {
    "foo": { "type": "string", "default": "bar" }
  }
}
```

### 4.4 运行建议（runtime）
- `mode`: `isolate | embed`（仅“建议”，宿主策略可覆盖）
- `sandbox`: `on | off | optional`（隔离模式下生效）

## 5. 运行时与策略

### 5.1 默认规则（必须）
- 默认隔离：除非明确审核通过，否则一律 `isolate`。
- 内嵌审核：只有 Registry 中 `approvedEmbed=true` 的插件才允许 `embed`。
- sandbox 默认 on：隔离模式下默认启用 sandbox；仅 `approvedSandboxOff=true` 才允许 `off`。

### 5.2 运行决策（伪代码）
```
if !registry.enabled: return "disabled"
mode = "isolate"
if registry.approvedEmbed && registry.runtime.mode == "embed":
  mode = "embed"

sandbox = "on"
if mode == "isolate" and registry.runtime.sandbox in ["on", "off"]:
  if registry.runtime.sandbox == "off" and registry.approvedSandboxOff:
    sandbox = "off"
  if registry.runtime.sandbox == "on":
    sandbox = "on"
```

## 6. Sandbox 策略
- sandbox=on：宿主仅暴露安全 API；所有 FS/NET/SHELL 通过权限检查。
- sandbox=off：允许更宽松的能力注入（需审批）。
- 允许未来扩展为 OS 级限制（如 seccomp）。

## 7. 生命周期

插件入口可导出以下函数：
- `activate(ctx)`：加载时调用
- `deactivate(ctx)`：卸载/禁用时调用
- `onEvent(type, payload, ctx)`：事件入口
- `onCommand(cmd, args, ctx)`：命令入口（可选）

**约束**
- 插件必须在 `deactivate` 中释放定时器/监听器/资源。
- Host 在卸载前必须调用 `deactivate` 并等待完成或超时。

## 8. IPC 协议（隔离模式）

### 8.1 消息格式
```
{
  "id": "uuid",
  "type": "init|activate|deactivate|onEvent|onCommand|response|log|error",
  "payload": {}
}
```

### 8.2 必需消息
- `init`：传入 context 与能力清单
- `activate` / `deactivate`
- `onEvent` / `onCommand`
- `response`：对请求的结果与错误

## 9. 命令与事件路由

- 系统命令优先：`/plugin`、`/help` 等。
- 插件命令：`/p <plugin> <cmd>` 或 `/plugin:<name> <cmd>`。
- 直达命令（如 `/hello`）只有在 manifest 明确声明且无冲突时允许。

常见事件：
- `message_received`
- `workspace_changed`
- `before_run`
- `after_run`

## 10. Registry 与状态

### 10.1 Registry（建议路径）
`store/plugins.json`
```json
{
  "my-plugin": {
    "version": "1.0.0",
    "path": ".../plugins/my-plugin/1.0.0",
    "enabled": true,
    "approvedEmbed": false,
    "approvedSandboxOff": false,
    "runtime": { "mode": "isolate", "sandbox": "on" },
    "installedAt": "2026-02-08T00:00:00Z"
  }
}
```

### 10.2 插件状态存储
- Key 维度：`plugin + workspace + conversation`
- API：`getState(key)` / `setState(key, value)`

## 11. 安装/卸载/更新流程

**Install**
1) 校验 manifest（name/version/main/compat）
2) 拷贝到 `plugins/<name>/<version>/`
3) 写入 Registry（enabled=true）
4) `load -> activate`（动态生效）

**Uninstall**
1) `deactivate`（可超时）
2) `kill/stop runtime`
3) 删除插件目录与 Registry 记录

**Update（可选）**
- 安装新版本 -> 切换 Registry 指向 -> 旧版本卸载

## 12. 兼容性与版本
- `compat.host`：宿主版本要求
- `compat.api`：插件 API 版本
- 不兼容则拒绝安装或禁用

## 13. 错误处理与恢复
- 运行时崩溃：宿主应记录错误并将插件标记为 `crashed`（可选自动重启）。
- IPC 超时：按失败处理，不影响宿主主流程。

## 14. 审核与审计
- `/plugin approve <name>` 允许内嵌模式。
- sandbox-off 需单独审批（由 `/plugin sandbox <name> off` 触发）。
- Registry 记录审核人/时间（可选字段 `approvedBy`, `approvedAt`）。

## 15. 动态加载实现建议
- 隔离模式：child_process/worker_thread；卸载即 kill。
- 内嵌模式：ESM `import()` + cache busting（如 `?v=timestamp`）。

## 16. 安全建议
- 默认最小权限；仅为必要功能授予权限。
- 内嵌仅限可信插件；隔离模式优先。
- sandbox=off 需明确审批与审计记录。

## 17. 示例入口（简化）
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
