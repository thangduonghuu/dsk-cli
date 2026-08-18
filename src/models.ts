import type { EffectiveSettings } from "./config.js";

export interface ModelInfo {
  id: string;
  description?: string;
}

/** Static fallback lineup (docs: Models & Pricing). */
export const KNOWN_MODELS: ModelInfo[] = [
  { id: "deepseek-v4-flash", description: "fast & cheap (default)" },
  { id: "deepseek-v4-pro", description: "stronger reasoning, higher cost" },
];

/**
 * Fetch the live model list from GET /models. Falls back to the known lineup
 * on any failure so /model always has something to show.
 */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) throw new Error("empty model list");
    return ids.map((id) => {
      const known = KNOWN_MODELS.find((k) => k.id === id);
      return { id, description: known?.description };
    });
  } catch {
    return KNOWN_MODELS;
  }
}

export type KeyCheck = "ok" | "invalid" | "unverified";

/** Verify a key with a cheap GET /models call (used by first-run setup). */
export async function checkApiKey(baseUrl: string, apiKey: string): Promise<KeyCheck> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "unverified";
  } catch {
    return "unverified"; // network problem — don't blame the key
  }
}
