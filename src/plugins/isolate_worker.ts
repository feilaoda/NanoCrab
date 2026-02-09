import path from "path";
import { parentPort, workerData } from "worker_threads";
import { pathToFileURL } from "url";

import { PluginContext, PluginManifest, RuntimeRequest, RuntimeResponse } from "./types.js";

type WorkerData = { pluginPath: string; manifest: PluginManifest };

const { pluginPath, manifest } = workerData as WorkerData;
let pluginModule: Record<string, unknown> | null = null;

function respond(id: string, ok: boolean, result?: unknown, error?: string): void {
  const message: RuntimeResponse = {
    id,
    type: "response",
    ok,
    result,
    error: error ? { message: error } : undefined,
  };
  parentPort?.postMessage(message);
}

function buildContext(base: PluginContext): PluginContext & {
  sendMessage: (text: string) => void;
  sendMessageTo: (chatId: string, text: string) => void;
  log: (level: string, message: string, data?: unknown) => void;
} {
  return {
    ...base,
    sendMessage: (text: string) => {
      parentPort?.postMessage({
        type: "host:sendMessage",
        payload: { chatId: base.chatId, text },
      });
    },
    sendMessageTo: (chatId: string, text: string) => {
      parentPort?.postMessage({
        type: "host:sendMessage",
        payload: { chatId, text },
      });
    },
    log: (level: string, message: string, data?: unknown) => {
      parentPort?.postMessage({
        type: "host:log",
        payload: { level, message, data },
      });
    },
  };
}

async function loadPlugin(): Promise<void> {
  const entryPath = path.resolve(pluginPath, manifest.main);
  const entryUrl = pathToFileURL(entryPath).href;
  pluginModule = await import(`${entryUrl}?v=${Date.now()}`);
}

async function handleRequest(msg: RuntimeRequest): Promise<void> {
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
      const ctx = buildContext(payload.context as PluginContext);
      await (pluginModule.activate as (ctx: PluginContext) => Promise<void> | void)(ctx);
      respond(id, true);
      return;
    }

    if (type === "deactivate" && typeof pluginModule?.deactivate === "function") {
      const ctx = buildContext(payload.context as PluginContext);
      await (pluginModule.deactivate as (ctx: PluginContext) => Promise<void> | void)(ctx);
      respond(id, true);
      return;
    }

    if (type === "onEvent" && typeof pluginModule?.onEvent === "function") {
      const ctx = buildContext(payload.context as PluginContext);
      const result = await (pluginModule.onEvent as (
        event: string,
        eventPayload: unknown,
        ctx: PluginContext,
      ) => Promise<unknown> | unknown)(payload.event as string, payload.payload, ctx);
      respond(id, true, result);
      return;
    }

    if (type === "onCommand" && typeof pluginModule?.onCommand === "function") {
      const ctx = buildContext(payload.context as PluginContext);
      const result = await (pluginModule.onCommand as (
        cmd: string,
        args: string[],
        ctx: PluginContext,
      ) => Promise<unknown> | unknown)(payload.command as string, payload.args as string[], ctx);
      respond(id, true, result);
      return;
    }

    respond(id, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    respond(id, false, undefined, message);
  }
}

parentPort?.on("message", (msg: RuntimeRequest) => {
  void handleRequest(msg);
});
