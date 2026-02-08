import * as Lark from "@larksuiteoapi/node-sdk";

import { FEISHU_API_BASE, FEISHU_APP_ID, FEISHU_APP_SECRET } from "../config.js";

export function hasFeishuCredentials(): boolean {
  return Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET);
}

export function getSdkBaseConfig(): { appId: string; appSecret: string; appType: Lark.AppType; domain?: string } {
  if (!hasFeishuCredentials()) {
    throw new Error("Feishu credentials not configured");
  }

  const domain = normalizeDomain(FEISHU_API_BASE) ?? Lark.Domain.Feishu;

  return {
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    appType: Lark.AppType.SelfBuild,
    ...(domain ? { domain } : {}),
  };
}

function normalizeDomain(base: string): string | undefined {
  const trimmed = base.trim();
  if (!trimmed) return undefined;

  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return undefined;
  }
}
