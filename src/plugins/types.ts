export type PluginRuntimeMode = "isolate" | "embed";
export type PluginSandboxMode = "on" | "off" | "optional";

export interface PluginRuntimeConfig {
  mode?: PluginRuntimeMode;
  sandbox?: PluginSandboxMode;
}

export interface PluginRuntimeInfo {
  mode: PluginRuntimeMode;
  sandbox: "on" | "off";
}

export interface PluginPermissions {
  fs?: {
    read?: boolean;
    write?: boolean;
    roots?: string[];
  };
  net?: boolean;
  shell?: boolean;
}

export interface PluginCompat {
  host?: string;
  api?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  main: string;
  displayName?: string;
  description?: string;
  commands?: string[];
  events?: string[];
  permissions?: PluginPermissions;
  runtime?: PluginRuntimeConfig;
  compat?: PluginCompat;
  configSchema?: Record<string, unknown>;
}

export interface PluginRegistryEntry {
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  approvedEmbed: boolean;
  approvedSandboxOff?: boolean;
  runtime: {
    mode: PluginRuntimeMode;
    sandbox: "on" | "off";
  };
  installedAt: string;
}

export type PluginRegistry = Record<string, PluginRegistryEntry>;

export interface PluginContext {
  conversationId: string;
  chatId: string;
  workspaceDir: string;
  pluginName: string;
  runtime: PluginRuntimeInfo;
  permissions: PluginPermissions;
  sendMessage?: (text: string) => void;
  log?: (level: string, message: string, data?: unknown) => void;
}

export interface RuntimeRequest {
  id: string;
  type: "init" | "activate" | "deactivate" | "onEvent" | "onCommand";
  payload: Record<string, unknown>;
}

export interface RuntimeResponse {
  id: string;
  type: "response";
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

export interface HostMessage {
  type: "host:sendMessage" | "host:log";
  payload: Record<string, unknown>;
}
