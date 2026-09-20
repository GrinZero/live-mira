import type { DecisionAnswers, Decide } from '../decisions.js';

export const photoCriteria = {
  photo_request: {
    none: '用户没有提到照片或摄影，也没有请求查看照片；只是聊天、评价、提问或提到其他物件。',
    request: '用户明确希望现在看到、查看或让 Mira 拿出一张具体的照片；单纯问“你拍过吗”“喜欢摄影吗”不算 request。',
    mention: '用户提到照片、摄影、拍摄，或询问 Mira 是否拍过某类内容，但没有请求查看具体照片。',
  },
  photo_response: {
    none: '只判断 assistant_text：Mira 的台词没有展示、收回或谈论照片的行为；即使 user_text 提到照片，也不能把用户的 mention 复制给 Mira。',
    show: '只判断 assistant_text：Mira 明确正在把一张具体照片展示给用户，或确认“这张就是”，而不是只谈照片。user_text 只用于解析“这张”等指代。',
    reject: '只判断 assistant_text：Mira 明确表示照片不存在、找不到、不能展示，或收回了本轮展示。',
    mention:
      '只判断 assistant_text：Mira 只是提到照片、摄影、拍摄经历或评价照片，没有当场展示；user_text 的 mention 不算 Mira 的 response。',
  },
} as const;

export type PhotoRequestLabel = 'none' | 'request' | 'mention';
export type PhotoResponseLabel = 'none' | 'show' | 'reject' | 'mention';
export type PhotoLabel = PhotoRequestLabel | PhotoResponseLabel;

export interface PhotoJudgeInput {
  userText: string;
  assistantText: string;
  source: 'user_turn' | 'assistant_turn' | 'staged_photo_confirmation' | 'eval';
  recentTurns: unknown[];
  scene: string;
}

export interface PhotoJudgment {
  request: { choice: PhotoRequestLabel; confidence: number };
  response: { choice: PhotoResponseLabel; confidence: number };
}

export interface PhotoJudge {
  judge(input: PhotoJudgeInput, signal?: AbortSignal): Promise<PhotoJudgment>;
}

function label<T extends PhotoLabel>(
  answers: DecisionAnswers,
  name: 'photo_request' | 'photo_response',
  allowed: readonly T[],
  fallback: T,
): { choice: T; confidence: number } {
  const answer = answers[name];
  const choice = answer?.choice;
  const confidence = answer?.confidence ?? 0;
  return {
    choice: allowed.includes(choice as T) ? (choice as T) : fallback,
    confidence,
  };
}

export class TypeSafePhotoJudge implements PhotoJudge {
  constructor(private readonly decide: Decide) {}

  async judge(input: PhotoJudgeInput, signal?: AbortSignal): Promise<PhotoJudgment> {
    const answers = await this.decide(
      'media',
      {
        user_text: input.userText,
        assistant_text: input.assistantText,
        source: input.source,
        recent_turns: input.recentTurns,
        scene: input.scene,
      },
      signal,
    );
    return {
      request: label(answers, 'photo_request', ['none', 'request', 'mention'], 'none'),
      response: label(answers, 'photo_response', ['none', 'show', 'reject', 'mention'], 'none'),
    };
  }
}
