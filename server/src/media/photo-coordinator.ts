import { stripStage } from '../duplex.js';
import type { PhotoJudge, PhotoJudgment } from '../semantic/photo.js';
import { legacyPhotoDisplayRejected, legacyPhotoOffer, legacyPhotoRequest } from '../compat/legacy-photo.js';

export interface PhotoCoordinatorContext {
  recentTurns: unknown[];
  scene: string;
  signal?: AbortSignal;
}

export interface PhotoCoordinatorOptions {
  judge: PhotoJudge | null;
  getRevision: () => number;
  hasPendingMedia: () => boolean;
  newMedia: () => string;
  onImmediatePhoto: (photo: { subject: string; caption: string; contextId: string }) => void;
}

export class PhotoCoordinator {
  private armed = false;
  private subject = '';
  private lastPhotoAt = 0;
  private userText = '';

  constructor(private readonly options: PhotoCoordinatorOptions) {}

  get photoArmed() {
    return this.armed;
  }

  clear() {
    this.armed = false;
  }

  noteUser(utterance: string, fromText: boolean) {
    this.userText = utterance;
    if (this.options.judge) return;

    if (!legacyPhotoRequest.test(utterance) || /(不要|别|不想)/.test(utterance)) return;
    if (Date.now() - this.lastPhotoAt <= 15000) return;
    this.lastPhotoAt = Date.now();
    this.subject = `Mira 手机或钱包里的一张照片，画面内容由这句话指定：${utterance.slice(0, 150)}`;
    this.armed = true;
    if (fromText) {
      const photo = this.consume();
      if (photo) this.options.onImmediatePhoto(photo);
    }
  }

  async armFromSpeech(line = '', force = false, context: PhotoCoordinatorContext): Promise<void> {
    const clean = stripStage(line).trim();
    if (this.options.judge && !force) {
      const revision = this.options.getRevision();
      const answers = await this.options.judge.judge(
        {
          userText: this.userText,
          assistantText: clean,
          source: 'assistant_turn',
          recentTurns: context.recentTurns,
          scene: context.scene,
        },
        context.signal,
      );
      if (revision !== this.options.getRevision()) return;
      this.applyJudgment(answers, clean);
      return;
    }

    if (!this.options.judge && legacyPhotoDisplayRejected(clean)) {
      this.armed = false;
      return;
    }
    const offered = legacyPhotoOffer.test(clean);
    if (this.armed) {
      if (clean && offered) this.subject = `Mira 照片里拍下的内容，画面由她这句台词指定：${clean.slice(0, 150)}`;
      return;
    }
    if (!force && !offered) return;
    if (this.options.hasPendingMedia() || Date.now() - this.lastPhotoAt < 15000) return;
    this.lastPhotoAt = Date.now();
    this.subject = clean
      ? `Mira 照片里拍下的内容，画面由她这句台词指定：${clean.slice(0, 150)}`
      : 'Mira 相机里的一张照片：旅途中拍下的一个瞬间，有故事感';
    this.armed = true;
  }

  private applyJudgment(answers: PhotoJudgment, clean: string) {
    const request = answers.request.confidence >= 0.8 ? answers.request.choice : 'none';
    const response = answers.response.confidence >= 0.8 ? answers.response.choice : 'none';
    if (response === 'reject') {
      this.armed = false;
      return;
    }
    if (this.armed && response !== 'show') return;
    if (request !== 'request' && response !== 'show') return;
    if (this.options.hasPendingMedia() || Date.now() - this.lastPhotoAt < 15000) return;
    this.lastPhotoAt = Date.now();
    this.subject = clean
      ? `Mira 照片里拍下的内容，画面由她这句台词指定：${clean.slice(0, 150)}`
      : `Mira 手机或钱包里的一张照片，画面内容由用户请求指定：${this.userText.slice(0, 150)}`;
    this.armed = true;
  }

  consume(): { subject: string; caption: string; contextId: string } | null {
    if (!this.armed) return null;
    this.armed = false;
    return { subject: this.subject, caption: '今晚，慢慢看。', contextId: this.options.newMedia() };
  }

  photoReplyRejected(reply: string, context: PhotoCoordinatorContext): boolean | Promise<boolean> {
    if (!this.options.judge) return legacyPhotoDisplayRejected(reply);
    return this.options.judge
      .judge(
        {
          userText: this.userText,
          assistantText: stripStage(reply).trim(),
          source: 'staged_photo_confirmation',
          recentTurns: context.recentTurns,
          scene: context.scene,
        },
        context.signal,
      )
      .then((judgment) => judgment.response.confidence >= 0.8 && judgment.response.choice === 'reject');
  }

  notePhotoDispatched() {
    if (this.options.hasPendingMedia() || (!this.armed && Date.now() - this.lastPhotoAt < 15000)) return false;
    this.lastPhotoAt = Date.now();
    this.armed = false;
    return true;
  }
}
