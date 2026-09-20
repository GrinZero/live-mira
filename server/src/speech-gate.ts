import { stripStage } from '../../shared/spoken-text.js';

type Event = Record<string, unknown>;

// Audio is filtered before synthesis by Doubao's TTS extension and streams unchanged.
// This gate only removes stage directions from incremental subtitles; it never holds PCM.
export class SpeechGate {
  private responses = new Map<string, { text: string; emitted: string }>();
  private audioId = '';
  private silent = new Set<string>();
  clear() {
    this.responses.clear();
    this.silent.clear();
    this.audioId = '';
  }
  accept(event: Event): { events: Event[] } {
    const type = String(event.type);
    if (type === 'response.output_audio.started') this.audioId = String(event.response_id ?? event.id ?? '');
    const id = String(event.response_id ?? this.audioId);
    if (!/^response\.output_(audio|text)\./.test(type) && type !== 'response.done') return { events: [event] };
    if (id) event = { ...event, response_id: id };
    if (type === 'response.done') {
      this.responses.delete(id);
      return { events: [event] };
    }
    if (!type.startsWith('response.output_text.')) {
      return { events: this.silent.has(id) ? [] : [event] };
    }
    const response = this.responses.get(id) ?? { text: '', emitted: '' };
    if (type === 'response.output_text.delta') {
      response.text += String(event.delta ?? '');
      const clean = stripStage(response.text);
      const delta = clean.slice(response.emitted.length);
      response.emitted = clean;
      this.responses.set(id, response);
      return { events: delta ? [{ ...event, delta }] : [] };
    }
    if (type === 'response.output_text.done') {
      this.responses.delete(id);
      const text = stripStage(String(event.text ?? response.text));
      if (!text) {
        this.silent.add(id);
        if (this.silent.size > 64) this.silent.delete(this.silent.values().next().value!);
        // Provider can send started but no done/PCM when the whole reply is filtered.
        return {
          events: [
            { ...event, text },
            { type: 'response.output_audio.done', response_id: id, stage_filtered_empty: true },
          ],
        };
      }
      return { events: [{ ...event, text }] };
    }
    return { events: [event] };
  }
}
