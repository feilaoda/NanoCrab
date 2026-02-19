# NanoCrab

Feishu + Codex = NanoCrab

## Requirements
- Node.js 20+
- `codex` CLI installed (you have `codex-cli 0.98.0`)
- Feishu app with RTM (WebSocket) permissions

## Setup
1. Install deps:
   ```bash
   npm install
   ```
2. Create `.env` in project root:
   ```env
    FEISHU_APP_ID=cli_xxx
    FEISHU_APP_SECRET=xxxx
    FEISHU_BOT_NAME=NanoCrab
    FEISHU_RTM_ENABLED=true
    # Optional: use bot open_id for mention detection
    # FEISHU_BOT_OPEN_ID=ou_xxx
    # Optional: if you enabled event encryption in Feishu console
    # FEISHU_ENCRYPT_KEY=xxxx
    # Optional: SDK log level (debug|info|warn|error)
    # FEISHU_SDK_LOG_LEVEL=debug
    # Optional: Codex
    # CODEX_BIN=codex
    # SAFE_DIRS=/Users/feilaoda/workspace/ai/nanocrab   # comma separated
    # CODEX_CMD_BLOCK=mkfs,shutdown,dd,reboot,poweroff,halt
    # CODEX_COMMIT_MESSAGE_MAX_CHARS=10000
    # CODEX_TIMEOUT_MS=300000
    # MAX_CONTEXT_MESSAGES=20
    # RESTART_CMD="npm run dev"
    # WATCHDOG_CMD="npm run dev"
    # WATCHDOG_BACKOFF_MS=1000
    # WATCHDOG_MAX_BACKOFF_MS=30000
    # WATCHDOG_STABLE_MS=15000
    # Optional: Market
    # MARKET_ALPHA_VANTAGE_API_KEY=xxxx
    # MARKET_REQUEST_GAP_MS=15000
    # MARKET_CACHE_TTL_MS=55000
   # Optional overrides
   # FEISHU_API_BASE=https://open.feishu.cn
   ```
3. Start (recommended for `/restart` auto-relaunch):
   ```bash
   npm run watchdog
   ```
   Direct dev run (no watchdog):
   ```bash
   npm run dev
   ```
   If you want auto-reload, use:
   ```bash
   npm run dev:watch
   ```
   Or the tsx watcher:
   ```bash
   npm run dev:tsx
   ```

## Commands
- `/codex` (enter Codex plugin)
- `/exit` (leave current plugin)
- `/help`
- `/show <symbol>`
- `/market show <symbol>`
- `/market watch add <symbol> --interval 1m|5m|15m`
- `/market watch list`
- `/market watch remove <symbol> [--interval 1m|5m|15m]`
- `/reset`
- `/model`
- `/model set <name>`
- `/model set --global <name>`
- `/write` (switch to Codex CLI backend and enter write mode)
- `/backend` (show current backend)
- `/mode` (show execution mode)
- `/status` (show current directory, session/thread ids, and runner origin)
- `/dir` (show current workspace dir)
- `/dir set <path>` (bind workspace dir)
- `/confirm` (approve pending execution)
- `/confirm --last` (execute the last user request immediately)
- `/cancel` (cancel pending execution or write mode)
- `/restart` (restart the service using RESTART_CMD; will notify “服务已重启。” once connected)
- `/git ci [message]` (stage & commit; omitted message优先使用`.codex_last_message.txt`，否则回退到变更摘要)
- `/git diff` (list changed files with stats)
- `/git push` (push current branch)
- `/resume <id>` (bind CLI session id)
- `/reset --hard` (clear session binding)
- `/plugin list` (list installed plugins)
- `/plugin info <name>` (show plugin info)
- `/plugin install <path>` (install plugin from local path)
- `/plugin uninstall <name>` (uninstall plugin)
- `/plugin enable|disable <name>` (toggle plugin)
- `/plugin approve <name>` (approve embed runtime)
- `/plugin runtime <name> isolate|embed` (set runtime mode)
- `/plugin sandbox <name> on|off` (set sandbox mode)
- `/plugin use <name>` (enter plugin)
- `/p <name> <cmd> [args...]` (invoke plugin command)

## Notes
- Group chats require @ mention to trigger.
- Private chats always trigger.
- Text messages only (MVP).
- Runner origin in `/status` comes from `NANOCRAB_RUNNER`:
  - `NANOCRAB_RUNNER=codex` -> 由 Codex 启动
  - `NANOCRAB_RUNNER=shell` -> 由本机 Shell 启动
  - unset -> 默认显示为“由本机 Shell 启动”

## HTTP API (local push)
Optional HTTP API to push messages to Feishu:

```
HTTP_API_ENABLED=true
HTTP_API_HOST=127.0.0.1
HTTP_API_PORT=8787
HTTP_API_TOKEN=your_token_here
```

Endpoints:
- `GET /health`
- `POST /api/push` body: `{"chatId":"oc_xxx","text":"hello"}` with `Authorization: Bearer <token>`
- If you don't set `/model`, Codex CLI will use its default from `~/.codex/config.toml`.
- By default, you must enter `/codex` to start using Codex.
- CLI sessions are stored per workspace; use `/resume <id>` to continue a CLI session.
- Dangerous commands are blocked via `CODEX_CMD_BLOCK` (e.g. `mkfs,shutdown,dd,reboot,poweroff,halt`).
- Confirmation is only required when deleting files outside `SAFE_DIRS`; other non-forbidden commands execute automatically.
- `/git ci` 在未传 message 时优先使用 `.codex_last_message.txt`，超长会按 `CODEX_COMMIT_MESSAGE_MAX_CHARS` 截断（默认 `10000`）。
- `SAFE_DIRS` restricts which directories can be used by `/dir set` and as working roots. When unset, it defaults to the project root.
- `/dir set` 会自动把目标目录加入运行时安全列表（不改动 `.env`）。
- `/confirm` 在无待确认操作时会提示使用 `/confirm --last`，不再进入一次性写入模式。
- 若看到 `NEEDS_APPROVAL` 但 `/confirm` 仍提示无待确认，通常是输出使用了全角冒号导致解析失败；已兼容 `:` 与 `：`。
- `RESTART_CMD` controls what `/restart` launches (default: `npm run dev`).
- 若希望 `/restart` 后自动拉起，请用 `npm run watchdog` 启动主进程。
- Watchdog uses `WATCHDOG_CMD`/`WATCHDOG_BACKOFF_MS`/`WATCHDOG_MAX_BACKOFF_MS`/`WATCHDOG_STABLE_MS`.
- 行情标的会自动规范化：A 股 6 位代码补 `.SS/.SZ`，港股数字代码补 `.HK`。

## Operations
- Feishu RTM setup and verification: see `docs/operations.md`.
