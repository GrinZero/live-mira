export type PhotoRequestLabel = 'none' | 'request' | 'mention';
export type PhotoResponseLabel = 'none' | 'show' | 'reject' | 'mention';
export type PhotoLabel = PhotoRequestLabel | PhotoResponseLabel;

export interface PhotoExpected {
  request: PhotoRequestLabel;
  response: PhotoResponseLabel;
}

export interface PhotoEvalCase {
  id: string;
  category: 'request' | 'response' | 'false-positive' | 'mention';
  title: string;
  userText: string;
  assistantText: string;
  expected: PhotoExpected;
  tags: string[];
}

export interface PhotoEvalDataset {
  $schema: './cases.schema.json';
  schemaVersion: '1.0.0';
  datasetId: 'mira-photo-semantics-regression-v1';
  datasetVersion: string;
  provenance: {
    kind: 'synthetic';
    statement: string;
    containsPrivateSourceMaterial: false;
  };
  evaluation: {
    mode: 'provider_required';
    confidenceThreshold: number;
    minimumCasePassRate: number;
    registeredScorers: string[];
  };
  cases: PhotoEvalCase[];
}

export interface PhotoEvalResult {
  id: string;
  title: string;
  expected: PhotoExpected;
  actual: PhotoExpected;
  confidence: {
    request: number;
    response: number;
  };
  belowRuntimeThreshold: {
    request: boolean;
    response: boolean;
  };
  passed: boolean;
  latencyMs: number;
}

export interface PhotoEvalReport {
  schemaVersion: '1.0.0';
  datasetId: string;
  datasetVersion: string;
  execution: {
    kind: 'provider_live';
    model: string;
    startedAt: string;
    finishedAt: string;
  };
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  cases: PhotoEvalResult[];
}
