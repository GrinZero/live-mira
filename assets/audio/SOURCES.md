# 雨夜咖啡馆音频 · 2026-09-16

- Rain: **PNW rain perfect loop 114.wav**, deadrobotmusic, Freesound #549909.
  https://freesound.org/people/deadrobotmusic/sounds/549909/
  Author describes a processed iPhone field recording made while sitting in a car.
  License: CC0 1.0, confirmed on source page. Archived HQ MP3 preview (not original WAV):
  https://cdn.freesound.org/previews/549/549909_11532701-hq.mp3
  `sources/pnw-rain-549909.mp3`, 134.736s stereo. Rain is a real recording, not generated noise.
- Music: Gemini / Lyria 3.5, generated on the user's authorized webpage.
  https://gemini.google.com/app/ea2ea6ba84e1e724
  Download name: After_the_Last_Guest.mp3. Archived as `sources/after-hours-gemini.mp3`.
  Requested title: 雨夜·未打烊 / After Hours. 118.88s source; runtime uses seconds 5–109.
  Prompt: original instrumental, intimate rainy-night cafe, sparse felt piano, soft Rhodes,
  warm pad, 60 BPM, gentle jazz harmony, no vocals/drums/rain FX, no dramatic build,
  quiet conversational background with consistent loop-friendly texture.
  AI-generated music; this record does not assign CC0 or assert exclusivity to the output.
Run `node scripts/synth-audio.mjs` to rebuild Opus and AAC assets from these archived sources.
Rain and music are normalized to -23 LUFS / -3 dBTP before runtime gains.
The engine bakes equal-power tail/head overlap **after decoding** (rain 4s, music 8s),
then uses the Web Audio looping clock. No timer-driven restarts or end/start fades to silence.
The heavy layer starts 43s apart from the base to avoid phase-correlated doubling.
Speech ducks music to 35% and rain to 82%, across utterances rather than syllable RMS.
Old rain assets are backed up in `output/audio/original/`.

## Thunder · 2026-09-19

- **Thunder #6**, Joseph SARDIN & Axeline T., BigSoundBank #3179.
  Source: https://bigsoundbank.com/thunder-6-s3179.html
  Download: https://bigsoundbank.com/UPLOAD/mp3/3179.mp3
  Source page identifies a single thunderclap without rain, outdoor recording,
  SoundDevices MixPre-3 + Sennheiser ME66; license CC0.
- Archived MP3 distribution copy: `sources/thunder-3179.mp3` (not original WAV).
  ffprobe: 13.8272 seconds, 48 kHz, mono, MP3; 553293 bytes.
  SHA-256: `1208860d747a32d321e01f7d77995c06f712f9aace11b139e03e804f97d395fd`.
- Runtime: `node scripts/prepare-thunder.mjs` produces `thunder.ogg` and
  `thunder.m4a` with a fixed -3 dB gain. Lightning schedules a non-looping
  thunderclap after 0.8 seconds; duplicate/overlapping events are suppressed.
  It uses the ambience bus and bypasses the speech mouth analyser.
- Decode/metadata checked; subjective listening and in-scene mix acceptance
  remain pending. This adds a real thunder recording; it does not prove the
  previously reported abnormal sound has been isolated.
