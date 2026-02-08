# Operations

## Feishu RTM (WebSocket) setup checklist

1. Enable RTM/WebSocket event subscription permissions in your Feishu app.
2. Enable the bot and add it to your target chats.
3. Set `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `.env`.
4. If event encryption is enabled, set `FEISHU_ENCRYPT_KEY`.
5. Set either `FEISHU_BOT_OPEN_ID` (preferred) or `FEISHU_BOT_NAME` for mention detection.
6. Start the service and confirm RTM connection logs.

## Verification scenarios

1. Private chat: send a normal text message; expect a response.
2. Group chat without @: no response.
3. Group chat with @ mention: expect a response.
4. Approval flow: ask for a change; expect an approval prompt, then reply "确认" to execute.
5. Model switching: `/model set gpt-5` then ask a question; confirm the model override is used.

## Common issues

- No responses in group: ensure `FEISHU_BOT_OPEN_ID` or `FEISHU_BOT_NAME` is set and the bot is actually mentioned.
- Codex not found: set `CODEX_BIN` to the full path of your `codex` binary.
