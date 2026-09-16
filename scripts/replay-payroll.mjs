import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { FredAdapter } from '../src/fred.js';
import { KalshiPublicAdapter } from '../src/kalshi.js';
import { replayPayrollHistory } from '../src/replay/payroll-history.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const apiKey = process.env.FRED_API_KEY;
if (!apiKey) {
  console.error('FRED_API_KEY is required.');
  process.exit(1);
}

const registryPath = path.join(root, 'data', 'employment', 'payroll-releases.json');
const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
const requestedLimit = process.env.REPLAY_LIMIT ? Number(process.env.REPLAY_LIMIT) : null;
const releases = Number.isFinite(requestedLimit) && requestedLimit > 0
  ? registry.slice(0, requestedLimit)
  : registry;

const fredAdapter = new FredAdapter({ apiKey });
const kalshiAdapter = process.env.DISABLE_KALSHI_HISTORY === '1'
  ? null
  : new KalshiPublicAdapter();
const result = await replayPayrollHistory({ fredAdapter, kalshiAdapter, releases });

const outDir = path.join(root, '.replay');
await fs.mkdir(outDir, { recursive: true });
const outputPath = process.env.REPLAY_OUTPUT
  ? path.resolve(process.env.REPLAY_OUTPUT)
  : path.join(outDir, `payroll-${result.modelVersion}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

console.log(JSON.stringify({
  recordType: result.recordType,
  replayVersion: result.replayVersion,
  modelId: result.modelId,
  modelVersion: result.modelVersion,
  releaseSampleSize: result.releaseSampleSize,
  comparableReleaseSampleSize: result.comparableReleaseSampleSize,
  comparableContractSampleSize: result.comparableContractSampleSize,
  meanModelBrier: result.meanModelBrier,
  meanKalshiBrier: result.meanMarketBrier,
  meanModelLogLoss: result.meanModelLogLoss,
  meanKalshiLogLoss: result.meanMarketLogLoss,
  meanBrierImprovementVsKalshi: result.meanBrierImprovementVsMarket,
  meanLogLossImprovementVsKalshi: result.meanLogLossImprovementVsMarket,
  outputPath
}, null, 2));
