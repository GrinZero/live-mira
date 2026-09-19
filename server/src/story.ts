import type { StoryView } from '../../shared/protocol.js';

export interface WorldUpdate {
  action: 'offer' | 'resolve' | 'dismiss' | 'none';
  title?: string;
  event?: string;
  choices?: { id: string; label: string; text: string }[];
  consequence?: string;
  evidence?: string;
  scene_prompt?: string;
  visual_prompt?: string;
}

// Persistent consequences, not a pool of scripts. Events and options are authored from
// the live conversation, and resolving one never chooses the next event in advance.
export class Story {
  phase: StoryView['phase'] = 'arrival';
  title = '';
  event = '';
  consequence = '';
  quiet = false;
  revision = 0;
  choices: { id: string; label: string; text: string }[] = [];
  history: { event: string; consequence: string; evidence: string }[] = [];
  lastEventAt = 0;
  hear(text: string) {
    if (/^(再见|拜拜|晚安|我(要|得|先)?走(了|啦)?|我要离开了)[。！!，,\s]*$/.test(text.trim())) {
      this.phase = 'farewell';
      this.title = '';
      this.event = '';
      this.consequence = '';
      this.choices = [];
      this.revision++;
      return;
    }
    if (this.phase === 'farewell') this.phase = 'together';
    this.quiet =
      /(安静[一地的]*会|安静陪|别说话|不用说话|只.*听雨|陪我听雨|不想说话|让我缓一缓|让我歇一会|先缓一缓|先歇一会)/.test(
        text,
      ) && !/(不要安静|不想安静)/.test(text);
  }
  offer(update: WorldUpdate, continueUnanswered = false) {
    if (
      (!continueUnanswered && this.phase === 'invitation') ||
      this.phase === 'farewell' ||
      typeof update.event !== 'string' ||
      !update.event.trim() ||
      typeof update.title !== 'string' ||
      !update.title.trim()
    )
      return false;
    this.title = update.title.slice(0, 50);
    this.event = update.event.slice(0, 400);
    this.phase = 'invitation';
    this.consequence = '';
    const options = Array.isArray(update.choices) ? update.choices : [];
    this.choices = options
      .filter((c) => typeof c?.label === 'string' && typeof c.text === 'string')
      .slice(0, 2)
      .map((c, i) => ({ id: `${this.revision + 1}_${i}`, label: c.label.slice(0, 32), text: c.text.slice(0, 160) }));
    this.lastEventAt = Date.now();
    this.revision++;
    return true;
  }
  resolve(update: WorldUpdate, userText: string) {
    // Only a model result tied to this exact utterance can establish a consequence.
    // Hypotheticals/questions and refusals are classified as none by the world prompt.
    if (
      !isWorldAction(userText) ||
      update.evidence !== userText ||
      typeof update.consequence !== 'string' ||
      !update.consequence.trim() ||
      /[“”「」"]|(Mira|她).{0,16}(说|笑道|问道|回答|声音)|声音带着/.test(update.consequence) ||
      (update.scene_prompt !== undefined && typeof update.scene_prompt !== 'string') ||
      (update.visual_prompt !== undefined && typeof update.visual_prompt !== 'string')
    )
      return false;
    if (sceneDescription(update.scene_prompt) && !isTravelAction(userText)) return false;
    this.consequence = update.consequence.slice(0, 500);
    this.title = update.scene_prompt ? '准备出发' : '此刻的变化';
    this.history.push({ event: this.event || '自由交流', consequence: this.consequence, evidence: userText });
    this.history = this.history.slice(-24);
    this.phase = 'together';
    this.choices = [];
    this.revision++;
    this.lastEventAt = Date.now();
    return true;
  }
  dismiss() {
    this.phase = 'together';
    this.choices = [];
    this.lastEventAt = Date.now();
    this.revision++;
  }
  choice(id: string) {
    return this.choices.find((c) => c.id === id)?.text ?? null;
  }
  view(): StoryView {
    return {
      revision: this.revision,
      phase: this.phase,
      title: this.title,
      prop: '',
      event: this.event,
      consequence: this.consequence,
      choices: this.choices.map(({ id, label }) => ({ id, label })),
    };
  }
  context() {
    return {
      phase: this.phase,
      event: this.event || '还没有环境事件',
      confirmed_consequences: this.history,
      choices: this.choices,
      quiet_requested: this.quiet,
    };
  }
}

// 门禁只做"否决"，意图判断交给 world 模型（consequence/evidence 锚定原话）。
// 窄白名单曾把自然说法挡在外面（"带我去你说的那个地方"不命中动词表就被丢成 none）。
// “……的很好”这类评价/感叹不是意图；疑问、假设、拒绝、将来时同理否决
const ACTION_VETO =
  /(如果|假如|假设|以后|改天|吗|么|为何|为什么|怎么|多少|哪[个里儿]|[？?]|不要|不想|不愿|别|不去|[得的](很|真|太|挺|好))/;
export function isWorldAction(text: string) {
  if (ACTION_VETO.test(text)) return false;
  return (
    /^(好[的啊呀]?|行|可以|嗯|同意|随便|听你的)[，。！!\s]*$/.test(text.trim()) ||
    /(我们|咱们|一起|现在|我|你|帮我|让它|把|陪|带|想|要|试|看|听|点|写|拿|放|唱|哼|坐|递|端|捡|接|关|开|拍|摸|喂|去|走|来|回|逛)/.test(
      text,
    )
  );
}

export function isTravelAction(text: string) {
  return (
    isWorldAction(text) &&
    !/(回忆|想起|记得|上次|去年|小时候|照片里)/.test(text) &&
    /(去|走|出门|出去|出发|到|回|离开|过来|陪你|带我|看看|走走|逛逛|散个步|溜达|启程|动身)/.test(text)
  );
}

export function sceneDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (!clean || /^(无|无变化|不变|没有|没有变化|无需转场|不转场|省略|none|null|undefined|n\/a)[。.!！]?$/i.test(clean))
    return undefined;
  return clean;
}

export function environmentOnly(value: unknown): string | undefined {
  const scene = sceneDescription(value);
  if (!scene) return undefined;
  return (
    scene
      .split(/[，,。；;\n]/)
      .filter((part) => !/(Mira|米拉|用户|两人|二人|我们|你们|她|他|并肩|撑伞|雨衣)/i.test(part))
      .join('，')
      .trim() || undefined
  );
}
