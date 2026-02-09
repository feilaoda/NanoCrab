import { Worker } from "worker_threads";

import { logger } from "../logger.js";
import { PluginContext, PluginManifest, RuntimeRequest, RuntimeResponse } from "./types.js";

type HostDeps = {
  sendMessage: (chatId: string, text: string) => Promise<void>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class IsolateRuntime {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private host: HostDeps;
  private seq = 0;

  constructor(
    private pluginPath: string,
    private manifest: PluginManifest,
    host: HostDeps,
  ) {
    this.host = host;
    const workerUrl = new URL("./isolate_worker.js", import.meta.url);
    this.worker = new Worker(workerUrl, {
      workerData: { pluginPath: this.pluginPath, manifest: this.manifest },
      execArgv: buildWorkerExecArgv(true),
      type: "module",
    });
    this.worker.on("message", (msg: RuntimeResponse | { type: string; payload: unknown }) => {
      if (msg && typeof msg === "object" && "type" in msg) {
        if (msg.type === "response") {
          const response = msg as RuntimeResponse;
          const entry = this.pending.get(response.id);
          if (!entry) return;
          this.pending.delete(response.id);
          if (response.ok) entry.resolve(response.result);
          else entry.reject(new Error(response.error?.message || "Plugin runtime error"));
          return;
        }
        if (msg.type === "host:sendMessage") {
          const payload = msg.payload as { chatId?: string; text?: string };
          if (payload?.chatId && payload?.text) {
            void this.host.sendMessage(payload.chatId, payload.text);
          }
          return;
        }
        if (msg.type === "host:log") {
          const payload = msg.payload as { level?: string; message?: string; data?: unknown };
          const level = payload?.level || "info";
          const message = payload?.message || "plugin log";
          if (level === "error") {
            logger.error({ data: payload?.data }, message);
          } else if (level === "warn") {
            logger.warn({ data: payload?.data }, message);
          } else if (level === "debug") {
            logger.debug({ data: payload?.data }, message);
          } else {
            logger.info({ data: payload?.data }, message);
          }
          return;
        }
      }
    });
    this.worker.on("error", (err) => {
      logger.error({ err }, "Plugin worker error");
    });
  }

  setHost(host: HostDeps): void {
    this.host = host;
  }

  async start(context: PluginContext): Promise<void> {
    await this.request("init", { context });
    await this.request("activate", { context });
  }

  async stop(context: PluginContext): Promise<void> {
    await this.request("deactivate", { context });
    await this.worker.terminate();
  }

  async onEvent(event: string, payload: unknown, context: PluginContext): Promise<unknown> {
    return this.request("onEvent", { event, payload, context });
  }

  async onCommand(command: string, args: string[], context: PluginContext): Promise<unknown> {
    return this.request("onCommand", { command, args, context });
  }

  private request(type: RuntimeRequest["type"], payload: Record<string, unknown>): Promise<unknown> {
    const id = `req_${Date.now()}_${this.seq++}`;
    const msg: RuntimeRequest = { id, type, payload };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(msg);
    });
  }
}

function buildWorkerExecArgv(needsTsLoader: boolean): string[] {
  let execArgv = [...process.execArgv];
  if (!needsTsLoader) return execArgv;
  execArgv = stripDeprecatedTsxLoader(execArgv);
  if (!hasTsxImport(execArgv)) {
    execArgv.push("--import", "tsx");
  }
  return execArgv;
}

function stripDeprecatedTsxLoader(execArgv: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < execArgv.length; i += 1) {
    const arg = execArgv[i];
    if (arg === "--loader" || arg === "--experimental-loader") {
      const value = execArgv[i + 1];
      if (value && value.includes("tsx")) {
        i += 1;
        continue;
      }
      filtered.push(arg);
      if (value !== undefined) {
        filtered.push(value);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--loader=") || arg.startsWith("--experimental-loader=")) {
      const value = arg.split("=", 2)[1] || "";
      if (value.includes("tsx")) {
        continue;
      }
      filtered.push(arg);
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function hasTsxImport(execArgv: string[]): boolean {
  for (let i = 0; i < execArgv.length; i += 1) {
    const arg = execArgv[i];
    if (arg === "--import") {
      const value = execArgv[i + 1] || "";
      if (value.includes("tsx")) return true;
    }
    if (arg.startsWith("--import=")) {
      const value = arg.split("=", 2)[1] || "";
      if (value.includes("tsx")) return true;
    }
  }
  return false;
}
