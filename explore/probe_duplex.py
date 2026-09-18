#!/usr/bin/env python3
"""Probe Doubao Realtime Duplex (Seeduplex) API.

Phases:
  0. session.create -> session.created?
  1. speech_text_buffer.commit -> audio out? (direct TTS injection)
  2. conversation.item.create(user text) -> model turn? (no response.create exists)
  3. tools: does model emit response.function_call_arguments.done mid-turn?
"""
import asyncio, base64, json, os, sys, time

import websockets

URL = "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue"
KEY = os.environ["DOUBAO_API_KEY"]

def j(x): return json.dumps(x, ensure_ascii=False)

async def recv_for(ws, seconds, sink):
    end = time.time() + seconds
    while time.time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=end - time.time())
        except asyncio.TimeoutError:
            break
        try:
            evt = json.loads(raw)
        except Exception:
            sink.append(("RAW", len(raw))); continue
        t = evt.get("type", "?")
        sink.append(evt)
        if t == "response.output_audio.delta":
            print(f"  < {t} audio={len(evt.get('delta',''))}b64")
        elif t == "response.output_text.delta":
            print(f"  < {t} {evt.get('delta','')!r}")
        else:
            slim = {k: v for k, v in evt.items() if k != "delta"}
            print(f"  < {t} {json.dumps(slim, ensure_ascii=False)[:300]}")

async def main():
    events = []
    async with websockets.connect(URL, additional_headers={"X-Api-Key": KEY}, max_size=None) as ws:
        print("== ws connected")

        # Phase 0: session.create
        await ws.send(j({
            "type": "session.create",
            "session": {
                "model": "1.2.6.0",
                "instructions": "你是 Mira，26 岁旅行摄影师，琥珀色雨衣，银星星发夹。暴雨夜在即将打烊的咖啡馆等人，等谁不肯直说。说话简短、口语、带点防备。",
                "audio": {
                    "input": {"format": {"type": "pcm", "rate": 16000}},
                    "output": {"format": {"type": "pcm_s16le", "rate": 24000},
                               "voice": "zh_female_vv_jupiter_bigtts"},
                },
                "tools": [{
                    "type": "function",
                    "name": "stage_directive",
                    "description": "驱动画面演出：情绪/动作/镜头/场景/生成图片。当需要画面变化时调用。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "emotion": {"type": "string", "enum": ["neutral","soft_smile","wistful","surprised","warm","guarded"]},
                            "action": {"type": "string", "enum": ["none","hug_cup","glance_door","show_photo","tuck_hair","stand_up"]},
                            "camera": {"type": "string", "enum": ["none","idle_drift","slow_push","close_up","pull_back","pan_door"]},
                            "fx": {"type": "string", "enum": ["none","rain_heavy","lightning","lights_dim","rain_stop"]},
                            "scene": {"type": "string"},
                            "genimg": {"type": "string", "description": "要生成的场景/照片主题"},
                        },
                    },
                }],
            },
        }))
        print("== sent session.create, waiting 8s")
        await recv_for(ws, 8, events)

        # Phase 1: direct TTS injection
        print("== phase1: speech_text_buffer.commit")
        await ws.send(j({"type": "speech_text_buffer.commit",
                         "text": "外面雨好大……你也是进来躲雨的吗？"}))
        await recv_for(ws, 15, events)

        # Phase 2: text user turn via conversation.item.create
        print("== phase2: conversation.item.create user text")
        await ws.send(j({"type": "conversation.item.create", "items": [{
            "type": "message", "role": "user",
            "content": [{"type": "input_text",
                         "text": "是啊，雨太大了。你在等人吗？——说这句话时请表现出一点警惕，并把镜头慢慢推近。"}],
        }]}))
        await recv_for(ws, 25, events)

        # Phase 3: cancel test (only meaningful if a response is in flight; harmless otherwise)
        print("== phase3: response.cancel")
        await ws.send(j({"type": "response.cancel"}))
        await recv_for(ws, 5, events)

        await ws.send(j({"type": "session.close"}))
        await asyncio.sleep(1)

    summary = {}
    for e in events:
        t = e.get("type", "RAW") if isinstance(e, dict) else e[0]
        summary[t] = summary.get(t, 0) + 1
    print("\n== event summary ==")
    for k, v in summary.items(): print(f"  {k}: {v}")

asyncio.run(main())
