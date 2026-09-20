import datasetJson from './cases.v1.json';
import type { PhotoEvalCase, PhotoEvalDataset, PhotoLabel } from './types.js';

const requestLabels = new Set<PhotoLabel>(['none', 'request', 'mention']);
const responseLabels = new Set<PhotoLabel>(['none', 'show', 'reject', 'mention']);

function fail(message: string): never {
  throw new Error(`photo eval dataset: ${message}`);
}

function validateCase(record: PhotoEvalCase, index: number) {
  const expectedId = `mira-photo-v1-${String(index + 1).padStart(3, '0')}`;
  if (record.id !== expectedId) fail(`cases[${index}].id must be ${expectedId}`);
  if (!record.userText.trim()) fail(`${record.id} has empty userText`);
  if (!requestLabels.has(record.expected.request)) fail(`${record.id} has invalid request label`);
  if (!responseLabels.has(record.expected.response)) fail(`${record.id} has invalid response label`);
  if (new Set(record.tags).size !== record.tags.length) fail(`${record.id} has duplicate tags`);
}

export function loadPhotoEvalDataset(): PhotoEvalDataset {
  const dataset = datasetJson as PhotoEvalDataset;
  if (dataset.$schema !== './cases.schema.json') fail('schema reference mismatch');
  if (dataset.datasetId !== 'mira-photo-semantics-regression-v1') fail('dataset id mismatch');
  if (dataset.provenance.kind !== 'synthetic' || dataset.provenance.containsPrivateSourceMaterial)
    fail('dataset must be synthetic and contain no private source material');
  if (dataset.evaluation.mode !== 'provider_required') fail('dataset must require a provider-backed run');
  if (dataset.cases.length < 8 || dataset.cases.length > 25) fail('case count must be between 8 and 25');
  const ids = new Set<string>();
  dataset.cases.forEach((record, index) => {
    if (ids.has(record.id)) fail(`duplicate case id ${record.id}`);
    ids.add(record.id);
    validateCase(record, index);
  });
  return dataset;
}

export function validatePhotoEvalCase(record: PhotoEvalCase) {
  validateCase(record, Number(record.id.slice(-3)) - 1);
}

if (process.argv[1]?.endsWith('/validate.ts')) {
  const dataset = loadPhotoEvalDataset();
  console.log(`PASS photo eval dataset: ${dataset.cases.length} cases, ${dataset.datasetVersion}`);
}
