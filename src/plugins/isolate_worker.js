import path from "path";
import { parentPort, workerData } from "worker_threads";
import { pathToFileURL } from "url";

const { pluginPath, manifest } = workerData ?? {};
let pluginModule = null;
let tsxReady = false;

async function ensureTsx() {
  if (tsxReady) return;
  try {
    const { register } = await import("tsx/esm/api");
    register();
    tsxReady = true;
  } catch {
    // tsx is optional in production; ignore if not installed.
  }
}

function respond(id, ok, result, error) {
  const message = {
    id,
    type: "response",
    ok,
    result,
    error: error ? { message: error } : undefined,
  };
  parentPort?.postMessage(message);
}

function buildContext(base) {
  return {
    ...base,
    sendMessage: (text) => {
      parentPort?.postMessage({
        type: "host:sendMessage",
        payload: { chatId: base.chatId, text },
      });
    },
    sendMessageTo: (chatId, text) => {
      parentPort?.postMessage({
        type: "host:sendMessage",
        payload: { chatId, text },
      });
    },
    log: (level, message, data) => {
      parentPort?.postMessage({
        type: "host:log",
        payload: { level, message, data },
      });
    },
  };
}

async function loadPlugin() {
  await ensureTsx();
  if (!pluginPath || !manifest?.main) {
    throw new Error("pluginPath 或 manifest.main 缺失");
  }
  const entryPath = path.resolve(pluginPath, manifest.main);
  const entryUrl = pathToFileURL(entryPath).href;
  pluginModule = await import(`${entryUrl}?v=${Date.now()}`);
}

async function handleRequest(msg) {
  const { id, type, payload } = msg;
  try {
    if (type === "init") {
      await loadPlugin();
      respond(id, true);
      return;
    }

    if (!pluginModule) {
      await loadPlugin();
    }

    if (type === "activate" && typeof pluginModule?.activate === "function") {
      const ctx = buildContext(payload.context);
      await pluginModule.activate(ctx);
      respond(id, true);
      return;
    }

    if (type === "deactivate" && typeof pluginModule?.deactivate === "function") {
      const ctx = buildContext(payload.context);
      await pluginModule.deactivate(ctx);
      respond(id, true);
      return;
    }

    if (type === "onEvent" && typeof pluginModule?.onEvent === "function") {
      const ctx = buildContext(payload.context);
      const result = await pluginModule.onEvent(payload.event, payload.payload, ctx);
      respond(id, true, result);
      return;
    }

    if (type === "onCommand" && typeof pluginModule?.onCommand === "function") {
      const ctx = buildContext(payload.context);
      const result = await pluginModule.onCommand(payload.command, payload.args, ctx);
      respond(id, true, result);
      return;
    }

    respond(id, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    respond(id, false, undefined, message);
  }
}

parentPort?.on("message", (msg) => {
  void handleRequest(msg);
});
