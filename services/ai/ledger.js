import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { firebaseService } from "../firebaseService.js";
import { limit } from "./limits.js";

/**
 * The AI ledger (KB 2b). Every run writes `aiJobs/{id}`; every model call
 * writes `aiUsage/{id}`. Limits count from `aiDaily/{day}_{job}`, a counter kept
 * beside them so a check is one read: a call is reserved there (runs, per
 * subject) before it is made, and its cost is added after.
 */
const db = () => firebaseService.db;

/** Today in East Africa Time, YYYY-MM-DD. */
export function eatDay(ms = Date.now()) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const dailyRef = (job, day = eatDay()) => db().collection("aiDaily").doc(`${day}_${job}`);
const subjectKey = (subject) => String(subject || "none").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80);

/** Reserve one model call for `job` about `subject`, or say which limit stops it. */
export async function reserve(job, subject) {
  const ref = dailyRef(job);
  const key = subjectKey(subject);
  return db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    const d = snap.data() || {};
    if ((Number(d.runs) || 0) >= limit(job, "runsPerDay")) return { ok: false, reason: "runs-per-day" };
    if ((Number(d.subjects?.[key]) || 0) >= limit(job, "runsPerSubjectPerDay")) return { ok: false, reason: "runs-per-subject" };
    if ((Number(d.costUsd) || 0) >= limit(job, "usdPerDay")) return { ok: false, reason: "spend-per-day" };
    const now = Timestamp.now();
    if (snap.exists) t.update(ref, { runs: FieldValue.increment(1), [`subjects.${key}`]: FieldValue.increment(1), updatedAt: now });
    else t.set(ref, { job, day: eatDay(), runs: 1, subjects: { [key]: 1 }, costUsd: 0, unpricedCalls: 0, inputTokens: 0, outputTokens: 0, createdAt: now, updatedAt: now });
    return { ok: true };
  });
}

/** One model call, priced (or `costUsd: null` when the model has no price). */
export async function recordUsage({ job, subject, jobId = null, provider = "anthropic", model, usage = {}, costUsd = null, outcome }) {
  const now = Timestamp.now();
  const row = {
    job, subject: subject ?? null, jobId, provider, model,
    inputTokens: Number(usage.inputTokens) || 0, outputTokens: Number(usage.outputTokens) || 0,
    cacheReadTokens: Number(usage.cacheReadTokens) || 0, cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
    costUsd, outcome, day: eatDay(), at: now,
  };
  try {
    const ref = db().collection("aiUsage").doc();
    await ref.set({ id: ref.id, ...row });
    await dailyRef(job).set({
      costUsd: FieldValue.increment(costUsd ?? 0), unpricedCalls: FieldValue.increment(costUsd == null ? 1 : 0),
      inputTokens: FieldValue.increment(row.inputTokens), outputTokens: FieldValue.increment(row.outputTokens), updatedAt: now,
    }, { merge: true });
    return ref.id;
  } catch (e) {
    console.error("[ai] usage write failed:", e.message);
    return null;
  }
}

/** One run of a job: success | partial | failed | refused | skipped, and why. */
export async function recordJob({ job, subject, status, reason = null, model = null, source = null, meta = {} }) {
  try {
    const ref = db().collection("aiJobs").doc();
    await ref.set({ id: ref.id, job, subject: subject ?? null, status, reason, model, source, meta, day: eatDay(), at: Timestamp.now() });
    return ref.id;
  } catch (e) {
    console.error("[ai] job write failed:", e.message);
    return null;
  }
}

/** Spend and runs per job over the last `days` days, for the admin page. */
export async function spendSince(days = 30) {
  const since = eatDay(Date.now() - (days - 1) * 86_400_000);
  const snap = await db().collection("aiDaily").where("day", ">=", since).get();
  return snap.docs.map((d) => d.data()).map((d) => ({ day: d.day, job: d.job, runs: d.runs || 0, costUsd: d.costUsd || 0, unpricedCalls: d.unpricedCalls || 0, inputTokens: d.inputTokens || 0, outputTokens: d.outputTokens || 0 }));
}
