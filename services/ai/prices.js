/**
 * USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing
 * (read 2026-10-15). A model missing here is recorded with `costUsd: null`
 * (unreported), never as zero, so a missing price shows up instead of hiding.
 */
export const PRICES = Object.freeze({
  // Haiku 5.5 is priced per request by prompt length: over 100k input tokens, every line is 5x.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longContext: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
});

/** Estimated cost of one call, or null when the model has no price. */
export function costUsd(model, usage = {}) {
  const base = PRICES[model];
  if (!base) return null;
  const input = Number(usage.inputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const noCache = usage.noCacheTokens != null ? Number(usage.noCacheTokens) || 0 : Math.max(0, input - cacheRead - cacheWrite);
  const output = Number(usage.outputTokens) || 0;
  const p = base.longContext && input > base.longContext.over ? base.longContext : base;
  const usd = (noCache * p.input + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + output * p.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
