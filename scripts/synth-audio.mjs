// Rebuild from archived sources. Runtime loop.ts bakes seams AFTER codec decoding.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets/audio');
const rain = path.join(out, 'sources/pnw-rain-549909.mp3');
const music = path.join(out, 'sources/after-hours-gemini.mp3');
const jobs = [
  ['rain_loop', rain, [], 'highpass=f=100,lowpass=f=7500,loudnorm=I=-23:TP=-3:LRA=9'],
  ['rain_heavy', rain, [], 'highpass=f=80,lowpass=f=10500,loudnorm=I=-23:TP=-3:LRA=9'],
  ['cafe_bgm', music, ['-ss', '5', '-t', '104'], 'highpass=f=65,lowpass=f=9500,loudnorm=I=-23:TP=-3:LRA=9'],
];
for (const [name, source, trim, filter] of jobs) {
  if (!fs.existsSync(source)) throw new Error(`Missing archived source: ${source}. See assets/audio/SOURCES.md`);
  for (const [ext, codec] of [
    ['ogg', 'libopus'],
    ['m4a', 'aac'],
  ]) {
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-i',
      source,
      ...trim,
      '-af',
      filter,
      '-ar',
      '48000',
      '-c:a',
      codec,
      '-b:a',
      '160k',
      path.join(out, `${name}.${ext}`),
    ]);
  }
  console.log(`[audio] rebuilt ${name}`);
}
