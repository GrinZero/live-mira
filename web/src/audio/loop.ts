/** Bake the overlap after decoding, so encoder padding cannot reopen the seam.
 * The middle is untouched; the tail blends into the head at constant power.
 * AudioBufferSourceNode then loops on the audio clock, without JS timers.
 */
export function seamlessLoop(ctx: BaseAudioContext, input: AudioBuffer, seconds = 4): AudioBuffer {
  const fade = Math.min(Math.round(seconds * input.sampleRate), Math.floor(input.length / 4));
  if (fade < 2) return input;
  const length = input.length - fade;
  const middle = input.length - 2 * fade;
  const out = ctx.createBuffer(input.numberOfChannels, length, input.sampleRate);
  for (let ch = 0; ch < input.numberOfChannels; ch++) {
    const src = input.getChannelData(ch),
      dst = out.getChannelData(ch);
    dst.set(src.subarray(fade, input.length - fade));
    for (let i = 0; i < fade; i++) {
      const angle = ((i / (fade - 1)) * Math.PI) / 2;
      dst[middle + i] = src[length + i] * Math.cos(angle) + src[i] * Math.sin(angle);
    }
  }
  return out;
}
