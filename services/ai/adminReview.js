import { Timestamp } from "firebase-admin/firestore";
import { firebaseService } from "../firebaseService.js";
import { systemMetrics } from "../insights/systemMetrics.js";
import { runModel, parseJsonObject } from "./client.js";
import { recordJob, eatDay } from "./ledger.js";
import { HttpError } from "../providerService.js";

/**
 * The admin review (KB 2b, D-055): a premium model reads the system's totals
 * once a week (Mondays from 07:00 EAT) and on demand at most once a day. It sees
 * totals only, never a member. The result is cached in `adminInsights`.
 */
const JOB = "adminReview";
const col = () => firebaseService.db.collection("adminInsights");

export const SYSTEM = [
  "You review operating totals for GrupChat, a Kenyan product where groups plan things together and pool money by M-Pesa.",
  "You get 30 days of totals as JSON: sign-ups, plans and Quick Pools created, money in and out (KES), payment success, payouts waiting at each stage, refunds, flags (pools over their cap, payments over a members limit, paybill payments that matched no pool) and AI spend (USD).",
  "Write for the founder, plainly. Say what changed in the last 7 days against the 7 before, what looks healthy, what looks risky, and what to do next.",
  "Use only numbers that are in the totals. Don't guess causes you can't see; say what to check instead. No links.",
  'Return only JSON: {"summary": "at most 600 characters", "highlights": ["up to 5, each at most 200 characters"], "risks": ["up to 5"], "actions": ["up to 5 concrete next steps"]}.',
].join("\n");

/** Week key for the Monday review, e.g. 2026-W42 (ISO week, EAT). */
export function weekKey(nowMs = Date.now()) {
  const d = new Date(nowMs + 3 * 3600_000);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function factsFrom(m) {
  return {
    window: { from: m.from, to: m.to, days: m.days },
    totals: m.totals,
    last7Days: m.last7,
    previous7Days: m.previous7,
    paymentsByProvider: m.byProvider,
    plansCreatedByType: m.plansByType,
    quickPools: m.quickPools,
    ticketSales: m.tickets,
    payoutsWaiting: m.payoutsInFlight,
    flags: m.flags,
    aiSpendByJob: m.ai,
    readsTruncated: m.truncated,
  };
}

export function checkReview(r) {
  const problems = [];
  if (!r || typeof r.summary !== "string") return ["return JSON with summary, highlights, risks and actions"];
  if (r.summary.length > 700) problems.push("the summary is too long");
  for (const k of ["highlights", "risks", "actions"]) {
    if (!Array.isArray(r[k])) { problems.push(`${k} must be a list`); continue; }
    if (r[k].length > 5) problems.push(`${k} has more than 5 items`);
    if (r[k].some((x) => typeof x !== "string" || x.length > 240)) problems.push(`each of ${k} must be a short sentence`);
  }
  if (/https?:|www\./i.test(JSON.stringify(r))) problems.push("no links");
  return problems;
}

/** What the page says without a model: the same totals, in fixed words. */
export function templateReview(m) {
  const kes = (n) => `KES ${Math.round(n).toLocaleString("en-KE")}`;
  const l = m.last7;
  const p = m.previous7;
  const risks = [];
  if (m.flags.unmatchedPayments) risks.push(`${m.flags.unmatchedPayments} paybill payments match no pool.`);
  if (m.flags.overCapPools) risks.push(`${m.flags.overCapPools} Quick Pools are over their cap.`);
  if (m.flags.overLimitMembers) risks.push(`${m.flags.overLimitMembers} payments landed over a members limit.`);
  if (m.payoutsInFlight.review) risks.push(`${m.payoutsInFlight.review} payouts need review.`);
  return {
    summary: `Last 7 days: ${kes(l.moneyIn)} in and ${kes(l.moneyOut)} out (previous 7: ${kes(p.moneyIn)} in, ${kes(p.moneyOut)} out). ${l.signups} sign-ups, ${l.quickPools} Quick Pools created. Payment success over ${m.days} days: ${m.totals.successRate ?? "n/a"}%.`,
    highlights: [`${m.quickPools.active} Quick Pools are open.`, `${m.payoutsInFlight.approval} payouts wait for an admin; ${m.payoutsInFlight.creator} refunds wait for a creator.`],
    risks,
    actions: risks.length ? ["Clear the flags on the Quick Pool flags panel."] : [],
  };
}

export async function latestReview() {
  const snap = await col().orderBy("createdAt", "desc").limit(1).get();
  const d = snap.docs[0]?.data();
  if (!d) return null;
  return { id: d.id, trigger: d.trigger, status: d.status, review: d.review || null, source: d.source || null, model: d.model || null, createdAt: d.createdAt?.toDate?.().toISOString?.() ?? null, basis: d.basis || null };
}

/** Run once: `weekly` (keyed by ISO week) or `manual` (keyed by EAT day, so at most once a day). */
export async function runAdminReview({ trigger = "manual", by = null, nowMs = Date.now() } = {}) {
  const id = trigger === "weekly" ? `weekly-${weekKey(nowMs)}` : `manual-${eatDay(nowMs)}`;
  const now = Timestamp.fromMillis(nowMs);
  try {
    await col().doc(id).create({ id, trigger, by, status: "running", createdAt: now });
  } catch (e) {
    if (e.code === 6 || /already exists/i.test(e.message)) {
      if (trigger === "manual") throw new HttpError(429, "The review was already refreshed today. The weekly one runs on Mondays.");
      return { id, status: "exists" };
    }
    throw e;
  }
  try {
    return await reviewInto(id, { trigger, by, now, nowMs });
  } catch (e) {
    await col().doc(id).set({ status: "failed", error: String(e.message).slice(0, 300), finishedAt: Timestamp.now() }, { merge: true }).catch(() => {});
    await recordJob({ job: JOB, subject: "system", status: "failed", reason: String(e.message).slice(0, 300), meta: { trigger, id } });
    throw e;
  }
}

async function reviewInto(id, { trigger, by, now, nowMs }) {
  const m = await systemMetrics({ days: 30, nowMs, fresh: true });
  const facts = factsFrom(m);
  let review = null;
  let source = "template";
  let status = "skipped";
  let reason = null;
  let model = null;
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await runModel({ job: JOB, subject: "system", system: SYSTEM, prompt: `Totals:\n${JSON.stringify(facts)}${feedback}` });
    if (!r.ok) { status = r.reason === "error" ? "failed" : "refused"; reason = r.reason; break; }
    model = r.model;
    const parsed = parseJsonObject(r.text);
    const problems = checkReview(parsed);
    if (!problems.length) {
      review = { summary: parsed.summary.trim(), highlights: parsed.highlights, risks: parsed.risks, actions: parsed.actions };
      source = "model"; status = "success"; reason = null;
      break;
    }
    status = "partial"; reason = problems.join("; ");
    feedback = `\n\nYour last answer broke these rules: ${problems.join("; ")}. Write it again.`;
  }
  if (!review) review = templateReview(m);
  const basis = { from: m.from, to: m.to, moneyIn: m.totals.moneyIn, moneyOut: m.totals.moneyOut, signups: m.totals.signups };
  await col().doc(id).set({ id, trigger, by, status: "done", review, source, model: source === "model" ? model : null, basis, createdAt: now, finishedAt: Timestamp.now() });
  await recordJob({ job: JOB, subject: "system", status, reason, model, source, meta: { trigger, id } });
  return { id, status, source, review };
}

/** From the reconciliation loop: the Monday review, once per ISO week, from 07:00 EAT. */
export async function maybeWeeklyReview(nowMs = Date.now()) {
  const eat = new Date(nowMs + 3 * 3600_000);
  if (eat.getUTCDay() !== 1 || eat.getUTCHours() < 7) return { status: "not-due" };
  const exists = await col().doc(`weekly-${weekKey(nowMs)}`).get();
  if (exists.exists) return { status: "done-this-week" };
  return runAdminReview({ trigger: "weekly", nowMs });
}
