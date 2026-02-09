import fs from "fs";
import path from "path";

import { PLUGIN_REGISTRY_PATH, STORE_DIR } from "../config.js";
import { PluginRegistry } from "./types.js";

export function ensureRegistryFile(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  if (!fs.existsSync(PLUGIN_REGISTRY_PATH)) {
    fs.writeFileSync(PLUGIN_REGISTRY_PATH, JSON.stringify({}, null, 2));
  }
}

export function loadRegistry(): PluginRegistry {
  ensureRegistryFile();
  const raw = fs.readFileSync(PLUGIN_REGISTRY_PATH, "utf-8");
  try {
    const data = JSON.parse(raw) as PluginRegistry;
    return data || {};
  } catch {
    return {};
  }
}

export function saveRegistry(registry: PluginRegistry): void {
  ensureRegistryFile();
  fs.writeFileSync(PLUGIN_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function resolveRegistryPath(): string {
  ensureRegistryFile();
  return path.resolve(PLUGIN_REGISTRY_PATH);
}
