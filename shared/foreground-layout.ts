import type { SceneLayout } from './scene-layout.js';

export interface ForegroundPlan {
  kind: 'porch';
  side: 'left' | 'right';
  postX: number;
  postWidth: number;
  eaveY: number;
}

// Conservative opt-in: a place name alone (street, beach, garden) is insufficient.
export function planForeground(theme: string, layout: SceneLayout): ForegroundPlan | null {
  if (/无前景|不要前景|不需要前景|没有近景|无遮挡|no foreground/i.test(theme)) return null;
  if (!/门廊|廊下|廊柱|门框|porch|veranda/i.test(theme)) return null;
  const side = layout.x <= 0.5 ? 'right' : 'left';
  return { kind: 'porch', side, postX: layout.x + (side === 'right' ? 0.15 : -0.15), postWidth: 0.045, eaveY: 0.09 };
}

export function foregroundPlanPrompt(plan: ForegroundPlan | null): string {
  if (!plan) return '';
  return `分层构图：镜头位于门廊内，距离镜头很近的一根木门柱中心在图宽${Math.round(plan.postX * 100)}%，宽约${plan.postWidth * 100}%，从上缘延伸到下缘。门柱连接${plan.side === 'right' ? '右' : '左'}侧上缘的一小段近处屋檐，屋檐只占顶端9%。只有这一根近柱属于前景，其余建筑都在中远景。近柱和屋檐略微失焦，材质与环境光一致，不能遮挡紫红人物净空框。不添加横贯人物腿部的栏杆、桌台、植物或其他近景。青色轮廓表示这些前景物件的预定范围，成品应替换成真实木结构，不留色标。`;
}
