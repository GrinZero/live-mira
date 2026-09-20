import { stripStage } from '../duplex.js';

// Compatibility-only matcher for local mock/unit sessions without a semantic
// judge. Production sessions inject PhotoJudge and never call these rules.
export const legacyPhotoOffer = /(喏|诺|呐)|给(你|您)看|看看?这|这(一)?张|掏出|翻出|拿给|合照|旧照片|照片.{0,8}(给|看)/;

export const legacyPhotoRequest = /(看看|看一下|给我看|展示).*(照片|拍的)|照片.*(看看|给我)/;

export function legacyPhotoDisplayRejected(line: string): boolean {
  const clean = stripStage(line)
    .replace(/[\s，,。！？!?；;：:]+$/g, '')
    .trim();
  if (!clean) return false;
  return (
    /(?:没有|没了|不在|找不到|拿不(?:出|到|来)|不能|无法|不想|不愿|不给|不拿|算了|别|不要).{0,12}(?:照片|这张|给你看|拿出来|掏|翻出|展示)/.test(
      clean,
    ) ||
    /(?:照片|这张).{0,12}(?:没有|没了|不在|找不到|拿不(?:出|到|来)|不能|无法|不想|不愿|不给|不拿|算了)/.test(clean) ||
    /(?:旧|老)照片.{0,6}(?:没有|没了|不在|找不到|拿不(?:出|到|来)|不能|无法|不想|不愿|不给|不拿|算了)$/.test(clean) ||
    /(?:旧|老)照片.{0,4}没有$/.test(clean)
  );
}
