import fs from 'node:fs';
import { DuplexClient } from '../server/src/duplex.js';
import { InjectTts } from '../server/src/inject-tts.js';
import { ClientSession } from '../server/src/session.js';
import { loadContent } from '../server/src/content.js';

const session = new ClientSession('speech-live', { decide: null, photoJudge: null });
const s = session as any;
const events: unknown[] = [];
const pcm: Buffer[] = [];
let upstreamBytes = 0;
let finish!: () => void;
const done = new Promise<void>((resolve) => {
  finish = resolve;
});
const timeout = setTimeout(finish, 35000);
s.ws = {
  readyState: 1,
  bufferedAmount: 0,
  send: (value: string | Buffer) => {
    if (Buffer.isBuffer(value)) pcm.push(value);
    else events.push({ client: JSON.parse(value) });
  },
};
s.preparePhotoForReply = async () => {};
s.director.prepareContinuation = async () => {};
const duplex = new DuplexClient({
  onClose: () => {},
  onEvent: (event) => {
    if (event.type === 'response.output_audio.delta')
      upstreamBytes += Buffer.from(String(event.delta), 'base64').length;
    events.push({
      upstream: {
        ...event,
        ...(event.delta ? { delta: event.type === 'response.output_audio.delta' ? '[PCM]' : event.delta } : {}),
      },
    });
    s.onDuplexEvent(event);
    if (event.type === 'response.done') finish();
  },
});
s.duplex = duplex;
const tts = new InjectTts();
try {
  await duplex.connect({ instructions: loadContent().personaInstructions });
  const audio = await tts.synthesize('你好，今天心情怎么样？请用一句话回答。');
  duplex.injectAudio(audio);
  await done;
  const output = Buffer.concat(pcm);
  fs.mkdirSync('output/checks', { recursive: true });
  fs.writeFileSync(
    'output/checks/speech-live.json',
    JSON.stringify({ upstreamBytes, deliveredBytes: output.length, events }, null, 2),
  );
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(output.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(output.length, 40);
  fs.writeFileSync('output/checks/speech-live.wav', Buffer.concat([header, output]));
  console.log(JSON.stringify({ upstreamBytes, deliveredBytes: output.length }));
  if (!output.length) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await session.destroy();
  await tts.close();
}
