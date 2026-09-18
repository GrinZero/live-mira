import type { ClientPhase, Emotion, Gesture } from '../../../shared/protocol';

// CharacterActor：可替换角色渲染层接口（VrmActor / GlbActor 实现）
export interface CharacterActor {
  setEmotion(e: Emotion): void;
  playGesture(g: Gesture): void;
  clearGesture(): void;
  setMouthOpen(v: number): void;
  setSpeech?(s: { level: number; beat: number; beatId: number; strength: number }): void;
  setState(s: ClientPhase): void;
  tick(dt: number, t: number): void;
}

// 情绪 → VRM expression 权重映射
export const EMOTION_MAP: Record<Emotion, Record<string, number>> = {
  neutral: { neutral: 0.6, relaxed: 0.2 },
  soft_smile: { happy: 0.5, relaxed: 0.4 },
  wistful: { sad: 0.38, relaxed: 0.35 },
  surprised: { surprised: 0.85 },
  warm: { happy: 0.72, relaxed: 0.5 },
  guarded: { angry: 0.16, sad: 0.14 },
};

export const EXPRESSION_PRESETS = ['happy', 'sad', 'angry', 'relaxed', 'surprised', 'neutral'] as const;
