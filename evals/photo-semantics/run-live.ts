import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../server/src/config.js';
import { jevDecide } from '../../server/src/decisions.js';
import { TypeSafePhotoJudge } from '../../server/src/semantic/photo.js';
import { loadPhotoEvalDataset } from './validate.js';
import { scorePhotoCase } from './scorers.js';
import type { PhotoEvalReport } from './types.js';

const dataset = loadPhotoEvalDataset();
if (!config.typesafeApiKey) throw new Error('TYPESAFE_API_KEY is required for the provider-backed photo eval');

const outputArgIndex = process.argv.indexOf('--out');
const outputPath = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : undefined;
const startedAt = new Date();
const judge = new TypeSafePhotoJudge(jevDecide);
const results: PhotoEvalReport['cases'] = [];

for (const item of dataset.cases) {
  const started = Date.now();
  const judgment = await judge.judge({
    userText: item.userText,
    assistantText: item.assistantText,
    source: 'eval',
    recentTurns: [],
    scene: '雨夜咖啡馆，窗边的桌子',
  });
  const actual = {
    request: judgment.request.choice,
    response: judgment.response.choice,
  } as const;
  const result = scorePhotoCase(
    item,
    actual,
    { request: judgment.request.confidence, response: judgment.response.confidence },
    0.8,
    Date.now() - started,
  );
  results.push(result);
  console.log(JSON.stringify(result));
}

const finishedAt = new Date();
const passed = results.filter((result) => result.passed).length;
const report: PhotoEvalReport = {
  schemaVersion: '1.0.0',
  datasetId: dataset.datasetId,
  datasetVersion: dataset.datasetVersion,
  execution: {
    kind: 'provider_live',
    model: config.typesafeModel,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  },
  summary: { total: results.length, passed, failed: results.length - passed, passRate: passed / results.length },
  cases: results,
};

const reportJson = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, reportJson, 'utf8');
  console.error(`photo eval report: ${outputPath}`);
}
console.log(JSON.stringify(report.summary));
if (report.summary.passRate < dataset.evaluation.minimumCasePassRate) process.exitCode = 1;
