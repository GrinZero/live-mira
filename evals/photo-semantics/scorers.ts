import type { PhotoEvalCase, PhotoEvalResult } from './types.js';

export function scorePhotoCase(
  item: PhotoEvalCase,
  actual: PhotoEvalResult['actual'],
  confidence: PhotoEvalResult['confidence'],
  runtimeThreshold: number,
  latencyMs: number,
): PhotoEvalResult {
  const passed = item.expected.request === actual.request && item.expected.response === actual.response;
  return {
    id: item.id,
    title: item.title,
    expected: item.expected,
    actual,
    confidence,
    belowRuntimeThreshold: {
      request: confidence.request < runtimeThreshold,
      response: confidence.response < runtimeThreshold,
    },
    passed,
    latencyMs,
  };
}
