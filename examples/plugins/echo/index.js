export function activate(ctx) {
  ctx?.log?.("info", "echo plugin activated", { plugin: ctx?.pluginName });
}

export function deactivate(ctx) {
  ctx?.log?.("info", "echo plugin deactivated", { plugin: ctx?.pluginName });
}

export function onCommand(cmd, args, ctx) {
  if (cmd !== "echo") {
    ctx?.sendMessage?.("Usage: /p echo echo <text>");
    return;
  }
  const text = args.join(" ").trim();
  ctx?.sendMessage?.(text ? "echo: " + text : "echo: (empty)");
}

export function onEvent(type, payload, ctx) {
  if (type !== "message_received") return;
  ctx?.log?.("debug", "message_received", { payload });
}
