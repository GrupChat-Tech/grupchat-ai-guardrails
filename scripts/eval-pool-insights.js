#!/usr/bin/env node
/**
 * Evaluation set for pool insights (KB 2b). About 30 metric fixtures (on track,
 * behind, reached, closed, tiny, quiet kinds) through the job's prompt and
 * checks. Gates any change of model or prompt.
 *
 *   npm run eval:pool-insights              (dry run: a mock model, checks the harness and the template)
 *   ANTHROPIC_API_KEY=… npm run eval:pool-insights -- --live    (the real model; costs well under a cent)
 *
 * It uses an in-memory Firestore for the AI ledger, so nothing is written anywhere.
 */
import { FakeFirestore } from "./lib/fakeFirebase.js";
import { startMockAnthropic } from "./lib/mockAnthropic.js";

const live = process.argv.includes("--live");
if (live && !process.env.ANTHROPIC_API_KEY) { console.error("--live needs ANTHROPIC_API_KEY"); process.exit(2); }
if (!live) {
  const { state } = await startMockAnthropic(4260);
  state.auto = (req) => {
    const f = JSON.parse(req.prompt.split("\n")[1]);
    return JSON.stringify({ headline: f.targetReached ? "The target is met" : `${f.percentOfTarget}% of the target`, body: `KES ${f.collectedKes.toLocaleString("en-KE")} from ${f.contributors} people.` });
  };
  Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-mock", ANTHROPIC_BASE_URL: "http://127.0.0.1:4260/v1" });
}
process.env.GCLOUD_PROJECT ||= "demo-grupchat";
process.env.FIREBASE_STORAGE_BUCKET ||= "demo-grupchat.appspot.com";
delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
const { firebaseService } = await import("../services/firebaseService.js");
firebaseService.db = new FakeFirestore();
const { factsFor, SYSTEM, checkInsight, templateInsight } = await import("../services/ai/poolInsights.js");
const { runModel, parseJsonObject } = await import("../services/ai/client.js");

const KINDS = ["everyday", "trip", "party", "wedding", "birthday", "condolence", "medical", "community"];
function fixture(i) {
  const target = [5_000, 20_000, 100_000, 750_000][i % 4];
  const ratio = [0.05, 0.3, 0.55, 0.8, 0.92, 1.0, 1.4][i % 7];
  const collected = Math.round(target * ratio);
  const contributors = 5 + ((i * 7) % 40);
  const payments = contributors + (i % 6);
  const daysLeft = [0, 0.4, 2, 6.5, 13][i % 5];
  const pacePerDay = Math.round(collected / (1 + (i % 9)));
  const projectedPct = Math.round(((collected + pacePerDay * daysLeft) / target) * 100);
  return {
    kind: KINDS[i % KINDS.length],
    m: { collected, target, pct: Math.round(ratio * 100), contributors, payments, average: Math.round(collected / payments), daysLeft, pacePerDay, projectedPct, onTrack: projectedPct >= 100, reached: ratio >= 1, peakHour: [7, 12, 18, 21, null][i % 5], peakDow: [0, 5, 6, null][i % 4], bands: {}, last7: Math.round(collected * 0.4), prev7: Math.round(collected * 0.3), closed: daysLeft === 0 },
  };
}

let pass = 0, template = 0, cost = 0, n = 0;
for (let i = 0; i < 30; i += 1) {
  const { m, kind } = fixture(i);
  const facts = factsFor(m, kind);
  const t = templateInsight(m, kind);
  if (checkInsight(t, facts).length === 0) template += 1;
  else console.log(`  template FAIL #${i}:`, checkInsight(t, facts).join("; "), t);
  const r = await runModel({ job: "poolInsights", subject: `eval_${i}`, system: SYSTEM, prompt: `Facts:\n${JSON.stringify(facts)}` });
  n += 1;
  if (!r.ok) { console.log(`  #${i} model call failed: ${r.reason}`); continue; }
  cost += r.costUsd || 0;
  const problems = checkInsight(parseJsonObject(r.text), facts);
  if (!problems.length) pass += 1;
  else console.log(`  #${i} ${kind}: ${problems.join("; ")}\n      ${r.text.slice(0, 200)}`);
}
console.log(`\n${live ? "live" : "dry run"}: ${pass}/${n} model answers passed the checks first time; ${template}/30 templates passed; cost USD ${cost.toFixed(5)} (${(cost / Math.max(n, 1)).toFixed(6)} a case)`);
process.exit(template === 30 && (live ? pass >= 27 : pass === n) ? 0 : 1);
