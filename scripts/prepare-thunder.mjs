// Convert only the archived CC0 outdoor thunder recording; see assets/audio/SOURCES.md.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../assets/audio/sources/thunder-3179.mp3', import.meta.url));
for (const [extension, codec] of [
  ['ogg', 'libopus'],
  ['m4a', 'aac'],
]) {
  execFileSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    source,
    '-vn',
    // Fixed attenuation preserves dynamics; no normalization, compression, loop or trimming.
    '-af',
    'volume=-3dB',
    '-ar',
    '48000',
    '-c:a',
    codec,
    '-b:a',
    '160k',
    ...(extension === 'm4a' ? ['-movflags', '+faststart'] : []),
    fileURLToPath(new URL(`../assets/audio/thunder.${extension}`, import.meta.url)),
  ]);
  console.log(`[audio] prepared thunder.${extension}`);
}
