import { Timestamp } from "firebase-admin/firestore";
import { firebaseService } from "../firebaseService.js";
import { LIMITS, QUIET_KINDS, metricsFor, signoffFor } from "../quickPool/shared.js";
import { runModel, parseJsonObject } from "./client.js";
import { recordJob } from "./ledger.js";

/**
 * Pool insights (KB 2b, D-054). Numbers are code; words are the model's.
 * The model sees the pool's totals and nothing else: no name, phone number,
 * email or text anyone typed, not even the pool's name. Its two lines are
 * checked before they are shown; if they fail twice, a template says it.
 */
const JOB = "poolInsights";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;
const kes = (n) => `KES ${Math.round(Number(n) || 0).toLocaleString("en-KE")}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const HEADLINE_MAX = 60;
export const BODY_MAX = 220;

/** The only things the model is told. */
export function factsFor(m, kind) {
  return {
    collectedKes: m.collected,
    targetKes: m.target,
    percentOfTarget: m.pct,
    remainingKes: Math.max(0, m.target - m.collected),
    contributors: m.contributors,
    payments: m.payments,
    averageKes: m.average,
    daysLeft: m.closed ? 0 : Math.ceil(m.daysLeft),
    pacePerDayKes: m.pacePerDay,
    projectedPercentByClose: m.projectedPct,
    onTrack: m.onTrack,
    targetReached: m.reached,
    closed: m.closed,
    busiestHour: m.peakHour == null ? null : hourLabel(m.peakHour),
    busiestDay: m.peakDow == null ? null : DAYS[m.peakDow],
    last7DaysKes: m.last7,
    previous7DaysKes: m.prev7,
    tone: QUIET_KINDS.has(kind) ? "quiet" : "warm",
  };
}

export const SYSTEM = [
  "You write one short insight about a group's shared money pool. It is shown on the pool's page to everyone who pools into it.",
  "You get the pool's totals as JSON facts. Rules:",
  "- Use only numbers that appear in the facts. You may write thousands with commas and add KES or %. Never estimate or work out a new number.",
  "- Never name, describe or single out any one person. Talk about the group.",
  "- Never pressure, rush, guilt or shame anyone. No exclamation marks.",
  "- Plain, warm, everyday English. When tone is \"quiet\", the group is supporting someone through loss or illness: be gentle and brief, and don't celebrate.",
  "- No Swahili, emoji, links, hashtags or @.",
  `Return only JSON: {"headline": "...", "body": "..."}. The headline is at most ${HEADLINE_MAX} characters; the body at most ${BODY_MAX} characters, one or two sentences.`,
].join("\n");

const PRESSURE = /\b(hurry|rush|urgent|last chance|don'?t let|shame|ashamed|lagging|slacking|disappoint|must|guilt|only you|why haven'?t|step up|come on)\b/i;

/** Numbers the text may contain: the facts, as written, and the hours of the busiest-hour label. */
function allowedNumbers(facts) {
  const ok = new Set([7, 14]);
  for (const v of Object.values(facts)) {
    if (typeof v === "number" && Number.isFinite(v)) ok.add(Math.round(v * 100) / 100);
    if (typeof v === "string") for (const n of v.match(/\d+/g) || []) ok.add(Number(n));
  }
  return ok;
}

/** What is wrong with a model's answer; an empty list means it can be shown. */
export function checkInsight(answer, facts) {
  const problems = [];
  if (!answer || typeof answer.headline !== "string" || typeof answer.body !== "string") return ["the answer must be JSON with a headline and a body"];
  const headline = answer.headline.trim();
  const body = answer.body.trim();
  if (!headline || !body) problems.push("the headline and the body must not be empty");
  if (headline.length > HEADLINE_MAX) problems.push(`the headline is ${headline.length} characters; the most is ${HEADLINE_MAX}`);
  if (body.length > BODY_MAX) problems.push(`the body is ${body.length} characters; the most is ${BODY_MAX}`);
  const text = `${headline} ${body}`;
  if (/https?:|www\.|\.(com|net|org|ke)\b|@|#/i.test(text)) problems.push("no links, @ or #");
  if (/\+?254[17]\d{8}|\b0[17]\d{8}\b/.test(text.replace(/(\d)[\s-](?=\d)/g, "$1"))) problems.push("no phone-like numbers");
  if (/!/.test(text)) problems.push("no exclamation marks");
  if (PRESSURE.test(text)) problems.push("no pressure, rushing or shaming words");
  const ok = allowedNumbers(facts);
  const used = (text.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/,/g, "")));
  const stray = used.filter((n) => !ok.has(Math.round(n * 100) / 100));
  if (stray.length) problems.push(`these numbers are not in the facts: ${[...new Set(stray)].join(", ")}`);
  return problems;
}

/** What the page says when the model can't or shouldn't: the same facts, in fixed words. */
export function templateInsight(m, kind) {
  const quiet = QUIET_KINDS.has(kind);
  const remaining = Math.max(0, m.target - m.collected);
  const headline = m.reached ? (quiet ? "The target has been met" : "Target reached") : `${m.pct}% of the target`;
  let body = `${kes(m.collected)} from ${plural(m.contributors, "person", "people")}.`;
  if (m.closed) body += " The pool has closed.";
  else if (m.reached) body += quiet ? " Thank you, everyone." : "";
  else if (m.onTrack) body += " At this pace the pool reaches its target before it closes.";
  else if (m.daysLeft > 0) body += ` ${kes(remaining)} to go, with ${plural(Math.ceil(m.daysLeft), "day")} left.`;
  return { headline, body: body.trim() };
}

/** Run the job for one pool and cache the result on the pool. Never throws. */
export async function runPoolInsights(planId, { now = Date.now() } = {}) {
  const db = firebaseService.db;
  const ref = db.collection("plans").doc(planId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().planType !== "quick") return { status: "skipped", reason: "not-a-quick-pool" };
  const plan = snap.data();
  const q = plan.quickPool || {};
  const kind = q.theme?.kind || "everyday";
  const m = metricsFor(plan, now);

  if (m.contributors < LIMITS.insightsMinContributors) {
    await ref.update({ "quickPool.insightsDueAt": null });
    await recordJob({ job: JOB, subject: planId, status: "skipped", reason: `fewer-than-${LIMITS.insightsMinContributors}-contributors` });
    return { status: "skipped", reason: "gate" };
  }

  const facts = factsFor(m, kind);
  let answer = null;
  let source = "template";
  let status = "skipped";
  let reason = null;
  let model = null;
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = `Facts:\n${JSON.stringify(facts)}${feedback}`;
    const r = await runModel({ job: JOB, subject: planId, system: SYSTEM, prompt });
    if (!r.ok) {
      status = r.reason === "error" ? "failed" : "refused";
      reason = r.reason;
      break;
    }
    model = r.model;
    const parsed = parseJsonObject(r.text);
    const problems = checkInsight(parsed, facts);
    if (problems.length === 0) {
      answer = { headline: parsed.headline.trim(), body: parsed.body.trim() };
      source = "model";
      status = "success";
      reason = attempt === 2 ? "passed-on-retry" : null;
      break;
    }
    status = "partial";
    reason = problems.join("; ").slice(0, 300);
    feedback = `\n\nYour last answer broke these rules: ${problems.join("; ")}. Write it again.`;
  }
  if (!answer) answer = templateInsight(m, kind);

  const signoff = signoffFor(m, kind, q.theme?.seed || 0);
  const insights = {
    headline: answer.headline,
    body: answer.body,
    signoff: signoff?.text ?? null,
    mood: signoff?.mood ?? null,
    generatedAt: Timestamp.fromMillis(now),
    basis: { payments: m.payments, collected: m.collected, pct: m.pct, contributors: m.contributors },
    model: source === "model" ? model : null,
    source,
  };
  // A payment that landed while this ran asks for the next run; don't clear its request.
  await db.runTransaction(async (t) => {
    const fresh = (await t.get(ref)).data() || {};
    const sameMoney = (fresh.quickPool?.stats?.count || 0) === (q.stats?.count || 0);
    t.update(ref, { "quickPool.insights": insights, "quickPool.insightsLastRunAt": Timestamp.fromMillis(now), ...(sameMoney ? { "quickPool.insightsDueAt": null } : {}) });
  });
  await recordJob({ job: JOB, subject: planId, status, reason, model, source });
  return { status, source, insights };
}

/** The stale pools the reconciliation loop works through, at most 10 a run. */
export async function runDuePoolInsights({ max = 10, now = Date.now() } = {}) {
  const snap = await firebaseService.db.collection("plans").where("quickPool.insightsDueAt", "<=", Timestamp.fromMillis(now)).limit(max).get();
  const tally = {};
  for (const d of snap.docs) {
    try {
      const r = await runPoolInsights(d.id, { now });
      tally[r.source || r.status] = (tally[r.source || r.status] || 0) + 1;
    } catch (e) {
      console.error(`[ai] pool insights ${d.id}:`, e.message);
    }
  }
  return { checked: snap.size, ...tally };
}
