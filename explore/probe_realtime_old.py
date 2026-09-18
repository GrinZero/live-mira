#!/usr/bin/env python3
"""Check whether DOUBAO_API_KEY also works on the legacy realtime endpoint
(binary protocol). If yes: text-mode session could serve as director LLM
fallback and the key covers the whole speech suite."""
import asyncio, json, os, struct
import websockets

URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"
KEY = os.environ["DOUBAO_API_KEY"]

def frame(msg_type, flags, event, session_id="", payload=b"{}"):
    h = bytes([0x11, (msg_type << 4) | flags, 0x10, 0x00])
    out = h + struct.pack(">i", event)
    if event not in (1, 2, 50, 51, 52):  # session-scoped events carry session id
        out += struct.pack(">I", len(session_id)) + session_id.encode()
    out += struct.pack(">I", len(payload)) + payload
    return out

def parse(data):
    b1, b2 = data[1], data[2]
    off = (data[0] & 0x0F) * 4
    flags = b1 & 0x0F
    if flags in (1, 2, 3): off += 4  # sequence
    event = struct.unpack(">i", data[off:off+4])[0] if flags & 4 else None
    off += 4 if flags & 4 else 0
    if event is not None and event not in (1, 2, 50, 51, 52):
        sl = struct.unpack(">I", data[off:off+4])[0]; off += 4 + sl
    if event in (50, 51, 52):
        cl = struct.unpack(">I", data[off:off+4])[0]; off += 4 + cl
    plen = struct.unpack(">I", data[off:off+4])[0]; off += 4
    return b1 >> 4, event, data[off:off+plen]

async def main():
    async with websockets.connect(URL, additional_headers={
        "X-Api-Key": KEY, "X-Api-Resource-Id": "volc.speech.dialog",
    }, max_size=None) as ws:
        await ws.send(frame(0x1, 0x4, 1))  # StartConnection
        for _ in range(5):
            raw = await asyncio.wait_for(ws.recv(), 8)
            if isinstance(raw, str): raw = raw.encode()
            mt, ev, pl = parse(raw)
            print(f"msg_type={mt:#x} event={ev} payload={pl[:200]}")
            if ev == 50:  # ConnectionStarted -> try a text session
                await ws.send(frame(0x1, 0x4, 100, "sess-1", json.dumps({
                    "tts": {"speaker": "zh_female_vv_jupiter_bigtts",
                            "audio_config": {"format": "pcm_s16le", "sample_rate": 24000, "channel": 1}},
                    "asr": {"audio_info": {"format": "pcm", "sample_rate": 16000, "channel": 1}},
                    "dialog": {"bot_name": "Mira", "system_role": "你是Mira，简短回答",
                               "extra": {"input_mod": "text", "output_modalities": ["text"], "model": "1.2.1.1"}},
                }, ensure_ascii=False).encode()))
            if ev == 150:  # SessionStarted -> send ChatTextQuery (501)
                await ws.send(frame(0x1, 0x4, 501, "sess-1",
                    json.dumps({"content": "用一句话介绍你自己"}, ensure_ascii=False).encode()))
            if ev in (550, 559):  # ChatResponse / ChatEnded
                print("CHAT:", pl.decode("utf-8", "replace"))
            if ev == 559:
                return

asyncio.run(main())
