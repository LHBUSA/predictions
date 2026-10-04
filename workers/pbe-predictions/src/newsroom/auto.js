// The automated newsroom step of the 15-minute engine cron (owner 2026-10-04): runCycle -> runNewsroom -> validate ->
// publish eligible stories -> refresh the Insights read cache (desk, RSS and news sitemap read the same cache).
// Kill switch: NEWSROOM_AUTO_PUBLISH (anything but "true" = detect only, publish nothing).
import { runNewsroom } from './engine.js';
import { autoPublish } from './publish.js';
import { models } from '../api.js';

export async function newsroomCycle(env, store, { cycleAt, engineCompletedAt = null, engineOk = true } = {}) {
  const fams = (await models(store)).families;
  const report = await runNewsroom(store, { familyResolved: Object.fromEntries(fams.map((f) => [f.id, f.resolved])) });
  const summary = { cycle_at: cycleAt, engine_completed_at: engineCompletedAt, engine_ok: engineOk, counts: report.counts, anomalies_held: report.anomalies.length, auto_publish: env.NEWSROOM_AUTO_PUBLISH === 'true' };
  if (env.NEWSROOM_AUTO_PUBLISH !== 'true') return { ...summary, published: [], skipped: [] };
  const pub = await autoPublish(store, report, { cycleAt, engineCompletedAt });
  return { ...summary, considered: pub.considered, published: pub.published, skipped: pub.skipped };
}
