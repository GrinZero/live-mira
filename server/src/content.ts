import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// 加载 content/ 下的内容层文件；persona/director 用 ```text 围栏提取正本

function extractFence(md: string): string {
  const m = md.match(/```text\n([\s\S]*?)```/);
  return (m ? m[1] : md).trim();
}

export interface PoolEvent {
  id: string;
  inject: string;
  when: { min_turn?: number; silence_gt?: number; or_user_asks?: string[] };
  tags_hint?: Record<string, string>;
  enables_scene?: string;
  enables_tool?: string;
  // 生成式视觉：触发时生成"当前场景+subject"的变体叠层，ttl 后自动退场
  visual?: { subject: string; ttl_ms?: number };
  once?: boolean;
  note?: string;
}

export interface Content {
  personaInstructions: string;
  directorSystem: string;
  events: PoolEvent[];
  openingLines: string[];
  proactiveLines: string[];
  proactiveCues: string[];
  degradeLines: { genimg_timeout: string; genimg_bad: string; reconnect: string };
  styleTemplate: string;
  sceneBodies: Record<string, string>;
}

function parseLines(md: string): {
  opening: string[];
  proactive: string[];
  cues: string[];
  degrade: { genimg_timeout: string; genimg_bad: string; reconnect: string };
} {
  // 提取所有 ``` 块，按出现顺序归入所在小节
  const sections = md.split(/^## /m);
  const grab = (key: string): string[] => {
    const sec = sections.find((s) => s.startsWith(key));
    if (!sec) return [];
    return [...sec.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1].trim().replace(/\n/g, ''));
  };
  const degrade = grab('降级圆场');
  const d: { genimg_timeout: string; genimg_bad: string; reconnect: string } = {
    genimg_timeout: degrade[0] || '……信号不好，照片传不过来。等它愿意来再看吧。',
    genimg_bad: degrade[1] || '这张洗坏了。算了——有些地方只留在记忆里更清楚。',
    reconnect: degrade[2] || '你刚才说什么？——刚才雨声太大，没听清。',
  };
  return { opening: grab('开场'), proactive: grab('主动开口'), cues: grab('提示池'), degrade: d };
}

function parseStyle(md: string): { template: string; bodies: Record<string, string> } {
  const m = md.match(/```\n([\s\S]*?)```/);
  const template = (m ? m[1] : '{scene_body}').trim();
  const bodies: Record<string, string> = {};
  for (const row of md.matchAll(/\|\s*`(\w+)`（([^）]*)）\s*\|\s*([^|]+)\|/g)) {
    bodies[row[1]] = row[3].trim();
  }
  return { template, bodies };
}

export function loadContent(): Content {
  const dir = config.contentDir;
  const persona = extractFence(fs.readFileSync(path.join(dir, 'persona.mira.md'), 'utf8'));
  const director = extractFence(fs.readFileSync(path.join(dir, 'director.md'), 'utf8'));
  const events = (JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')) as { events: PoolEvent[] }).events;
  const lines = parseLines(fs.readFileSync(path.join(dir, 'lines.md'), 'utf8'));
  const style = parseStyle(fs.readFileSync(path.join(dir, 'style.md'), 'utf8'));
  return {
    personaInstructions: persona,
    directorSystem: director,
    events,
    openingLines: lines.opening,
    proactiveLines: lines.proactive,
    proactiveCues: lines.cues,
    degradeLines: lines.degrade,
    styleTemplate: style.template,
    sceneBodies: style.bodies,
  };
}
