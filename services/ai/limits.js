/**
 * Ceilings for every AI job (KB 2b). They live in code. Config can lower one
 * (`AI_LIMIT_<JOB>_<KEY>`, e.g. AI_LIMIT_POOL_INSIGHTS_RUNS_PER_DAY=100) but
 * never raise it, so a typo in an env var can't run up a bill. `AI_DISABLED=1`
 * switches every job to its fallback.
 */
const CODE = Object.freeze({
  poolInsights: { maxOutputTokens: 300, runsPerSubjectPerDay: 6, runsPerDay: 300, usdPerDay: 0.5, timeoutMs: 20_000 },
  adminReview: { maxOutputTokens: 1500, runsPerSubjectPerDay: 2, runsPerDay: 2, usdPerDay: 1.0, timeoutMs: 90_000 },
});

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
export const envKey = (job, key) => `AI_LIMIT_${snake(job)}_${snake(key)}`;

export function limit(job, key) {
  const base = CODE[job]?.[key];
  if (base == null) throw new Error(`No AI limit ${job}.${key}`);
  const raw = process.env[envKey(job, key)];
  const env = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(env) && env >= 0 ? Math.min(base, env) : base;
}

export function limitsFor(job) {
  return Object.fromEntries(Object.keys(CODE[job] || {}).map((k) => [k, limit(job, k)]));
}

export const aiDisabled = () => process.env.AI_DISABLED === "1";
