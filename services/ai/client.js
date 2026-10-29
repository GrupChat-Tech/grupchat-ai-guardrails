import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { modelFor } from "./models.js";
import { limit, aiDisabled } from "./limits.js";
import { costUsd } from "./prices.js";
import { reserve, recordUsage } from "./ledger.js";

/**
 * The one way to call a model (KB 2b). No route calls a provider directly.
 * A call is reserved against the job's limits first, priced and written to
 * the ledger after, and never throws: the caller gets `{ ok: false, reason }`
 * and falls back to its deterministic text.
 */
let provider = null;
let providerKey = null;
function anthropic() {
  const key = `${process.env.ANTHROPIC_API_KEY}|${process.env.ANTHROPIC_BASE_URL || ""}`;
  if (!provider || providerKey !== key) {
    provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY, ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}) });
    providerKey = key;
  }
  return provider;
}

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY) && !aiDisabled();

function normalizeUsage(u = {}) {
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    noCacheTokens: u.inputTokenDetails?.noCacheTokens ?? null,
    cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0,
    cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

export async function runModel({ job, subject, system, prompt, jobId = null }) {
  if (!aiConfigured()) return { ok: false, reason: "not-configured" };
  const gate = await reserve(job, subject).catch((e) => ({ ok: false, reason: `ledger: ${e.message}` }));
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const model = modelFor(job);
  try {
    const result = await generateText({
      model: anthropic()(model),
      system,
      prompt,
      maxOutputTokens: limit(job, "maxOutputTokens"),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(limit(job, "timeoutMs")),
    });
    const usage = normalizeUsage(result.usage);
    const cost = costUsd(model, usage);
    await recordUsage({ job, subject, jobId, model, usage, costUsd: cost, outcome: "success" });
    return { ok: true, text: result.text || "", model, usage, costUsd: cost };
  } catch (e) {
    // A failed call may still have been billed; we can't know how much, so it is unpriced.
    await recordUsage({ job, subject, jobId, model, usage: {}, costUsd: null, outcome: "error" });
    console.error(`[ai] ${job} call failed:`, e.message);
    return { ok: false, reason: "error", error: e.message, model };
  }
}

/** The first JSON object in a model's text, or null. Tolerates code fences and stray prose. */
export function parseJsonObject(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
