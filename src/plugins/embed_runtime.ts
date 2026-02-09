import path from "path";
import { pathToFileURL } from "url";

import { logger } from "../logger.js";
import { PluginContext, PluginManifest } from "./types.js";

type HostDeps = {
  sendMessage: (chatId: string, text: string) => Promise<void>;
};

type PluginModule = {
  activate?: (ctx: PluginContext) => Promise<void> | void;
  deactivate?: (ctx: PluginContext) => Promise<void> | void;
  onEvent?: (event: string, payload: unknown, ctx: PluginContext) => Promise<unknown> | unknown;
  onCommand?: (cmd: string, args: string[], ctx: PluginContext) => Promise<unknown> | unknown;
};

export class EmbedRuntime {
  private pluginModule: PluginModule | null = null;
  private host: HostDeps;

  constructor(
    private pluginPath: string,
    private manifest: PluginManifest,
    host: HostDeps,
  ) {
    this.host = host;
  }

  setHost(host: HostDeps): void {
    this.host = host;
  }

  async start(context: PluginContext): Promise<void> {
    await this.loadPlugin();
    if (this.pluginModule?.activate) {
      await this.pluginModule.activate(this.buildContext(context));
    }
  }

  async stop(context: PluginContext): Promise<void> {
    if (this.pluginModule?.deactivate) {
      await this.pluginModule.deactivate(this.buildContext(context));
    }
    this.pluginModule = null;
  }

  async onEvent(event: string, payload: unknown, context: PluginContext): Promise<unknown> {
    if (!this.pluginModule?.onEvent) return undefined;
    return this.pluginModule.onEvent(event, payload, this.buildContext(context));
  }

  async onCommand(command: string, args: string[], context: PluginContext): Promise<unknown> {
    if (!this.pluginModule?.onCommand) return undefined;
    return this.pluginModule.onCommand(command, args, this.buildContext(context));
  }

  private async loadPlugin(): Promise<void> {
    const entryPath = path.resolve(this.pluginPath, this.manifest.main);
    const entryUrl = pathToFileURL(entryPath).href;
    try {
      this.pluginModule = (await import(`${entryUrl}?v=${Date.now()}`)) as PluginModule;
    } catch (err) {
      logger.error({ err }, "Embed plugin load failed");
      throw err;
    }
  }

  private buildContext(base: PluginContext): PluginContext {
    return {
      ...base,
      permissions: base.permissions,
      runtime: base.runtime,
      // Keep API surface minimal; host operations are provided explicitly.
      sendMessage: (text: string) => {
        if (!base.chatId) return;
        void this.host.sendMessage(base.chatId, text);
      },
      sendMessageTo: (chatId: string, text: string) => {
        if (!chatId) return;
        void this.host.sendMessage(chatId, text);
      },
      log: (level: string, message: string, data?: unknown) => {
        if (level === "error") {
          logger.error({ data }, message);
        } else if (level === "warn") {
          logger.warn({ data }, message);
        } else if (level === "debug") {
          logger.debug({ data }, message);
        } else {
          logger.info({ data }, message);
        }
      },
    } as PluginContext;
  }
}
