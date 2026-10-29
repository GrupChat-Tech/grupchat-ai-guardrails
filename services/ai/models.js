/**
 * Which model does which job (KB 2b). A job names its model here and nowhere
 * else. Changing one is a config change (the env names below) and must pass
 * the job's evaluation set first.
 */
export const JOBS = Object.freeze({
  poolInsights: { model: "claude-haiku-5-5", env: "AI_MODEL_POOL_INSIGHTS" },
  adminReview: { model: "claude-opus-5-5", env: "AI_MODEL_ADMIN_REVIEW" },
});

export function modelFor(job) {
  const j = JOBS[job];
  if (!j) throw new Error(`Unknown AI job: ${job}`);
  return process.env[j.env] || j.model;
}
