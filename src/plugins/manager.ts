import fs from "fs";
import path from "path";

import { DATA_DIR, PLUGINS_DIR } from "../config.js";
import { logger } from "../logger.js";
import { EmbedRuntime } from "./embed_runtime.js";
import { IsolateRuntime } from "./isolate_runtime.js";
import { ensureRegistryFile, loadRegistry, saveRegistry } from "./registry.js";
import {
  PluginContext,
  PluginManifest,
  PluginPermissions,
  PluginRegistry,
  PluginRegistryEntry,
  PluginRuntimeInfo,
} from "./types.js";

type HostDeps = {
  sendMessage: (chatId: string, text: string) => Promise<void>;
};

type RuntimeHandle = {
  runtime: EmbedRuntime | IsolateRuntime;
  manifest: PluginManifest;
  entry: PluginRegistryEntry;
  runtimeInfo: PluginRuntimeInfo;
  permissions: PluginPermissions;
};

export class PluginManager {
  private registry: PluginRegistry;
  private runtimes = new Map<string, RuntimeHandle>();
  private host: HostDeps;

  constructor(host: HostDeps) {
    this.host = host;
    ensureRegistryFile();
    this.registry = loadRegistry();
  }

  setHost(host: HostDeps): void {
    this.host = host;
    for (const handle of this.runtimes.values()) {
      handle.runtime.setHost(host);
    }
  }

  list(): PluginRegistryEntry[] {
    return Object.values(this.registry);
  }

  get(name: string): PluginRegistryEntry | undefined {
    return this.registry[name];
  }

  isInstalled(name: string): boolean {
    return Boolean(this.registry[name]);
  }

  isEnabled(name: string): boolean {
    return Boolean(this.registry[name]?.enabled);
  }

  getEnabledNames(): string[] {
    return Object.values(this.registry)
      .filter((entry) => entry.enabled)
      .map((entry) => entry.name);
  }

  async installFromPath(sourcePath: string): Promise<PluginRegistryEntry> {
    const manifest = readManifest(sourcePath);
    const destPath = path.join(PLUGINS_DIR, manifest.name, manifest.version);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.rmSync(destPath, { recursive: true, force: true });
    fs.cpSync(sourcePath, destPath, { recursive: true });

    const entry: PluginRegistryEntry = {
      name: manifest.name,
      version: manifest.version,
      path: destPath,
      enabled: true,
      approvedEmbed: false,
      approvedSandboxOff: false,
      runtime: {
        mode: "isolate",
        sandbox: manifest.runtime?.sandbox === "off" ? "off" : "on",
      },
      installedAt: new Date().toISOString(),
    };

    this.registry[manifest.name] = entry;
    saveRegistry(this.registry);
    await this.load(manifest.name);
    return entry;
  }

  async uninstall(name: string): Promise<void> {
    const entry = this.registry[name];
    if (!entry) {
      throw new Error(`插件 ${name} 未安装`);
    }
    await this.unload(name);
    delete this.registry[name];
    saveRegistry(this.registry);
    fs.rmSync(entry.path, { recursive: true, force: true });
  }

  async enable(name: string): Promise<void> {
    const entry = this.registry[name];
    if (!entry) throw new Error(`插件 ${name} 未安装`);
    entry.enabled = true;
    saveRegistry(this.registry);
    await this.load(name);
  }

  async disable(name: string): Promise<void> {
    const entry = this.registry[name];
    if (!entry) throw new Error(`插件 ${name} 未安装`);
    entry.enabled = false;
    saveRegistry(this.registry);
    await this.unload(name);
  }

  async load(name: string): Promise<void> {
    const entry = this.registry[name];
    if (!entry || !entry.enabled) return;
    const existing = this.runtimes.get(name);
    const manifest = readManifest(entry.path);
    const runtimeInfo = resolveRuntimeInfo(entry);

    if (existing && sameRuntime(existing.runtimeInfo, runtimeInfo)) {
      return;
    }

    if (existing) {
      const systemContext = buildSystemContext(name, existing.runtimeInfo, existing.permissions);
      await existing.runtime.stop(systemContext);
      this.runtimes.delete(name);
    }

    const handle = this.buildRuntimeHandle(entry, manifest, runtimeInfo);
    this.runtimes.set(name, handle);
    const context = buildSystemContext(name, handle.runtimeInfo, handle.permissions);
    await handle.runtime.start(context);
  }

  async unload(name: string): Promise<void> {
    const handle = this.runtimes.get(name);
    if (!handle) return;
    const context = buildSystemContext(name, handle.runtimeInfo, handle.permissions);
    await handle.runtime.stop(context);
    this.runtimes.delete(name);
  }

  async handleEvent(
    name: string,
    event: string,
    payload: unknown,
    context: Omit<PluginContext, "runtime" | "permissions" | "pluginName">,
  ): Promise<void> {
    const handle = await this.ensureRuntime(name);
    if (!handle) return;
    const fullContext = buildContext(name, context, handle.runtimeInfo, handle.permissions);
    await handle.runtime.onEvent(event, payload, fullContext);
  }

  async handleCommand(
    name: string,
    command: string,
    args: string[],
    context: Omit<PluginContext, "runtime" | "permissions" | "pluginName">,
  ): Promise<void> {
    const handle = await this.ensureRuntime(name);
    if (!handle) return;
    const fullContext = buildContext(name, context, handle.runtimeInfo, handle.permissions);
    await handle.runtime.onCommand(command, args, fullContext);
  }

  approveEmbed(name: string): void {
    const entry = this.registry[name];
    if (!entry) throw new Error(`插件 ${name} 未安装`);
    entry.approvedEmbed = true;
    saveRegistry(this.registry);
  }

  approveSandboxOff(name: string): void {
    const entry = this.registry[name];
    if (!entry) throw new Error(`插件 ${name} 未安装`);
    entry.approvedSandboxOff = true;
    saveRegistry(this.registry);
  }

  getEffectiveRuntime(entry: PluginRegistryEntry): PluginRuntimeInfo {
    return resolveRuntimeInfo(entry);
  }

  async setRuntimeMode(name: string, mode: "isolate" | "embed", force = false): Promise<void> {
    const entry = this.registry[name];
    if (!entry) throw new Error(`插件 ${name} 未安装`);
    if (mode === "embed" && !entry.approvedEmbed && !force) {
      throw new Error("插件未通过内嵌审批");
    }
    entry.runtime.mode = mode;
    saveRegistry(this.registry);
    await this.reload(name);
  }

  async setSandboxMode(name: string, sandbox: "on" | "off", force = false): Promise<void> {
    const entry = this.registry[name];
    if (!entry) throw new Error(`插件 ${name} 未安装`);
    if (sandbox === "off" && !entry.approvedSandboxOff && !force) {
      throw new Error("插件未通过 sandbox-off 审批");
    }
    entry.runtime.sandbox = sandbox;
    saveRegistry(this.registry);
    await this.reload(name);
  }

  private async reload(name: string): Promise<void> {
    const entry = this.registry[name];
    if (!entry || !entry.enabled) return;
    if (this.runtimes.has(name)) {
      await this.unload(name);
    }
    await this.load(name);
  }

  private async ensureRuntime(name: string): Promise<RuntimeHandle | null> {
    const entry = this.registry[name];
    if (!entry || !entry.enabled) return null;
    let handle = this.runtimes.get(name);
    const runtimeInfo = resolveRuntimeInfo(entry);
    if (handle && sameRuntime(handle.runtimeInfo, runtimeInfo)) {
      return handle;
    }

    if (handle) {
      const systemContext = buildSystemContext(name, handle.runtimeInfo, handle.permissions);
      await handle.runtime.stop(systemContext);
      this.runtimes.delete(name);
    }

    const manifest = readManifest(entry.path);
    handle = this.buildRuntimeHandle(entry, manifest, runtimeInfo);
    this.runtimes.set(name, handle);
    const systemContext = buildSystemContext(name, runtimeInfo, handle.permissions);
    await handle.runtime.start(systemContext);
    return handle;
  }

  private buildRuntimeHandle(
    entry: PluginRegistryEntry,
    manifest: PluginManifest,
    runtimeInfo: PluginRuntimeInfo,
  ): RuntimeHandle {
    const permissions = manifest.permissions || {};
    const runtime =
      runtimeInfo.mode === "embed"
        ? new EmbedRuntime(entry.path, manifest, this.host)
        : new IsolateRuntime(entry.path, manifest, this.host);
    return { runtime, manifest, entry, runtimeInfo, permissions };
  }
}

function readManifest(pluginPath: string): PluginManifest {
  const manifestPath = path.join(pluginPath, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`plugin.json 不存在：${manifestPath}`);
  }
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as PluginManifest;
  if (!manifest.name || !manifest.version || !manifest.main) {
    throw new Error("plugin.json 缺少必要字段 name/version/main");
  }
  return manifest;
}

function buildSystemContext(
  pluginName: string,
  runtime: PluginRuntimeInfo,
  permissions: PluginPermissions,
): PluginContext {
  return {
    conversationId: "system",
    chatId: "",
    workspaceDir: path.join(DATA_DIR, "plugins"),
    pluginName,
    runtime,
    permissions,
  };
}

function buildContext(
  pluginName: string,
  base: Omit<PluginContext, "runtime" | "permissions" | "pluginName">,
  runtime: PluginRuntimeInfo,
  permissions: PluginPermissions,
): PluginContext {
  return {
    ...base,
    pluginName,
    runtime,
    permissions,
  };
}

function resolveRuntimeInfo(entry: PluginRegistryEntry): PluginRuntimeInfo {
  const mode =
    entry.runtime.mode === "embed" && entry.approvedEmbed ? "embed" : "isolate";
  const sandbox =
    mode === "isolate" && entry.runtime.sandbox === "off" && entry.approvedSandboxOff
      ? "off"
      : "on";
  return { mode, sandbox };
}

function sameRuntime(a: PluginRuntimeInfo, b: PluginRuntimeInfo): boolean {
  return a.mode === b.mode && a.sandbox === b.sandbox;
}

export function resolvePluginDir(name: string, version: string): string {
  return path.join(PLUGINS_DIR, name, version);
}

export function ensurePluginDir(): void {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

export function safePluginName(name: string): string {
  if (!/^[a-z0-9._-]+$/.test(name)) {
    logger.warn({ name }, "Invalid plugin name");
    throw new Error("插件名只能包含 a-z, 0-9, . _ -");
  }
  return name;
}
