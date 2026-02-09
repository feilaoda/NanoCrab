# NanoCrab

Standalone Feishu RTM (WebSocket) + Codex CLI assistant using the official Feishu SDK. No dependencies on NanoClaw.

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
    # CODEX_BACKEND=cli   # cli | sdk
    # CODEX_SDK_API_KEY=sk-...
    # CODEX_SDK_BASE_URL=https://api.openai.com
    # SAFE_DIRS=/Users/feilaoda/workspace/ai/nanocrab   # comma separated
    # CODEX_CMD_BLOCK=mkfs,shutdown
    # CODEX_CMD_CONFIRM=rm,dd
    # CODEX_CMD_ALLOW=ls,cat,pwd
    # CODEX_TIMEOUT_MS=300000
    # MAX_CONTEXT_MESSAGES=20
    # RESTART_CMD="npm run dev"
   # Optional overrides
   # FEISHU_API_BASE=https://open.feishu.cn
   ```
3. Start (no auto-reload by default):
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
- `/reset`
- `/model`
- `/model set <name>`
- `/model set --global <name>`
- `/cli [--write|--safe]` (switch to Codex CLI backend; `--write` auto-executes, `--safe` exits write mode)
- `/sdk` (switch to Codex SDK backend)
- `/backend` (show current backend)
- `/mode` (show execution mode)
- `/status` (show current directory and session/thread ids)
- `/dir` (show current workspace dir)
- `/dir set <path>` (bind workspace dir)
- `/confirm` (approve pending execution)
- `/confirm --last` (execute the last user request immediately)
- `/cancel` (cancel pending execution or write mode)
- `/restart` (restart the service using RESTART_CMD; will notify “服务已重启。” once connected)
- `/git ci [message]` (stage & commit with auto message; omitted message uses git status summary)
- `/git diff` (list changed files)
- `/git push` (push current branch)
- `/resume <id>` (bind current backend id; SDK thread or CLI session)
- `/resume cli <sessionId>` (bind CLI session id)
- `/resume sdk <threadId>` (bind SDK thread id)
- `/reset --hard` (clear thread binding)
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
- If you don't set `/model`, Codex CLI will use its default from `~/.codex/config.toml`.
- Set `CODEX_BACKEND=sdk` to use the Codex SDK thread-based backend.
- By default, you must enter `/codex` to start using Codex.
- SDK backend will also read `~/.codex/auth.json` (api_key) and `~/.codex/config.toml` (base_url) if env vars are not set.
- SDK threads are bound to workspace directories; switching back to `/sdk` will resume the thread for the same workspace unless you use `/reset --hard`.
- CLI sessions are stored per workspace; use `/resume cli <sessionId>` to continue a CLI session.
- Commands can be controlled via `CODEX_CMD_BLOCK` (forbidden), `CODEX_CMD_CONFIRM` (require confirmation), and `CODEX_CMD_ALLOW` (auto-execute without confirmation).
- `SAFE_DIRS` restricts which directories can be used by `/dir set` and as working roots. When unset, it defaults to the project root.
- `/dir set` 会自动把目标目录加入运行时安全列表（不改动 `.env`）。
- `/confirm` 在无待确认操作时，会切到 CLI 并开启一次性写入模式，下一条消息将自动执行。
- 若看到 `NEEDS_APPROVAL` 但 `/confirm` 仍提示无待确认，通常是输出使用了全角冒号导致解析失败；已兼容 `:` 与 `：`。
- `RESTART_CMD` controls what `/restart` launches (default: `npm run dev`).

## Operations
- Feishu RTM setup and verification: see `docs/operations.md`.
