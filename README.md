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
   # Optional overrides
   # FEISHU_API_BASE=https://open.feishu.cn
   ```
3. Start:
   ```bash
   npm run dev
   ```

## Commands
- `/codex` (enter Codex plugin)
- `/exit` (leave current plugin)
- `/help`
- `/reset`
- `/model`
- `/model set <name>`
- `/model set --global <name>`
- `/cli` (switch to Codex CLI backend)
- `/sdk` (switch to Codex SDK backend)
- `/backend` (show current backend)
- `/mode` (show execution mode)
- `/status` (show current directory and session/thread ids)
- `/dir` (show current workspace dir)
- `/dir set <path>` (bind workspace dir)
- `/git ci [message]` (stage & commit with auto message; omitted message uses git status summary)
- `/git push` (push current branch)
- `/resume <id>` (bind current backend id; SDK thread or CLI session)
- `/resume cli <sessionId>` (bind CLI session id)
- `/resume sdk <threadId>` (bind SDK thread id)
- `/reset --hard` (clear thread binding)

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

## Operations
- Feishu RTM setup and verification: see `docs/operations.md`.
