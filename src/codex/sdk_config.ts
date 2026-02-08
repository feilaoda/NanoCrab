import fs from "fs";
import os from "os";
import path from "path";

import { CODEX_SDK_API_KEY, CODEX_SDK_BASE_URL } from "../config.js";

type SdkConfig = {
  apiKey?: string;
  baseURL?: string;
};

export function loadCodexSdkConfig(): SdkConfig {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  const configPath = path.join(os.homedir(), ".codex", "config.toml");

  const configText = readTextIfExists(configPath);
  const authJson = readJsonIfExists(authPath);

  const apiKey =
    CODEX_SDK_API_KEY ||
    extractApiKey(authJson) ||
    extractTomlValue(configText, [
      "api_key",
      "openai_api_key",
      "openaiApiKey",
      "apiKey",
    ]);

  const baseURL =
    CODEX_SDK_BASE_URL ||
    extractTomlValue(configText, [
      "base_url",
      "api_base_url",
      "api_base",
      "openai_base_url",
      "openaiBaseUrl",
      "baseUrl",
    ]);

  return {
    apiKey: apiKey || undefined,
    baseURL: baseURL || undefined,
  };
}

function readTextIfExists(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractApiKey(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const candidates = ["api_key", "apiKey", "openai_api_key", "openaiApiKey", "key"];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function extractTomlValue(source: string, keys: string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `^\\s*${escaped}\\s*=\\s*([\"'])(.*?)\\1\\s*$`,
      "m",
    );
    const match = source.match(regex);
    if (match && match[2]) {
      return match[2].trim();
    }
  }
  return "";
}
