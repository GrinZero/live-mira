#!/usr/bin/env python3
"""Probe 2: full audio round-trip + function call + response.create guess."""
import asyncio, json, os, time, wave
import websockets

URL = "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue"
KEY = os.environ["DOUBAO_API_KEY"]

def j(x): return json.dumps(x, ensure_ascii=False)

async def pump_silence(ws, seconds):
    chunk = bytes(640)
    end = time.time() + seconds
    while time.time() < end:
        await ws.send(j({"type": "input_audio_buffer.append",
                         "audio": __import__('base64').b64encode(chunk).decode()}))
        await asyncio.sleep(0.02)

async def recv_for(ws, seconds, sink, ws_send_silence=False):
    end = time.time() + seconds
    got = {"fc": None}
    while time.time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=min(1.0, end - time.time()))
        except asyncio.TimeoutError:
            if ws_send_silence:
                await ws.send(j({"type": "input_audio_buffer.append",
                                 "audio": __import__('base64').b64encode(bytes(640)).decode()}))
            continue
        try:
            evt = json.loads(raw)
        except Exception:
            continue
        t = evt.get("type", "?")
        sink.append(evt)
        if t == "response.output_audio.delta":
            print(f"  < audio.delta {len(evt.get('delta',''))}b64")
        elif t == "response.function_call_arguments.done":
            got["fc"] = evt
            print(f"  < FC-DONE {json.dumps(evt.get('items'), ensure_ascii=False)}")
        elif t == "response.output_text.delta":
            print(f"  < text.delta {evt.get('delta','')!r}")
        else:
            slim = {k: v for k, v in evt.items() if k != "delta"}
            print(f"  < {t} {json.dumps(slim, ensure_ascii=False)[:280]}")
        if t == "response.done":
            break
    return got

async def main():
    events = []
    pcm = wave.open("/tmp/probe_q.wav").readframes(10**9)

    async with websockets.connect(URL, additional_headers={"X-Api-Key": KEY}, max_size=None) as ws:
        print("== connected")
        await ws.send(j({
            "type": "session.create",
            "session": {
                "model": "1.2.6.0",
                "instructions": (
                    "你是 Mira，26 岁旅行摄影师，琥珀色雨衣，银星星发夹。暴雨夜在即将打烊的咖啡馆等人。"
                    "说话简短口语、带一点防备。"
                    "重要规则：每轮开口说话前，必须先调用 stage_directive 工具设置当前情绪与镜头。"
                ),
                "audio": {
                    "input": {"format": {"type": "pcm", "rate": 16000}},
                    "output": {"format": {"type": "pcm_s16le", "rate": 24000},
                               "voice": "zh_female_vv_jupiter_bigtts"},
                },
                "tools": [{
                    "type": "function", "name": "stage_directive",
                    "description": "驱动画面演出：情绪/动作/镜头/场景。开口前或需要画面变化时调用。",
                    "parameters": {"type": "object", "properties": {
                        "emotion": {"type": "string", "enum": ["neutral","soft_smile","wistful","surprised","warm","guarded"]},
                        "camera": {"type": "string", "enum": ["none","idle_drift","slow_push","close_up","pull_back","pan_door"]},
                    }},
                }],
            },
        }))
        await recv_for(ws, 8, events)

        print("== phase A: stream mic audio + commit")
        import base64
        for i in range(0, len(pcm), 640):
            await ws.send(j({"type": "input_audio_buffer.append",
                             "audio": base64.b64encode(pcm[i:i+640]).decode()}))
            await asyncio.sleep(0.008)
        await ws.send(j({"type": "input_audio_buffer.commit"}))
        got = await recv_for(ws, 35, events, ws_send_silence=True)

        if got["fc"]:
            print("== phase B: return tool output")
            outs = [{"call_id": c["call_id"], "role": "tool",
                     "content": [{"type": "input_text", "text": "{\"ok\":true}"}]}
                    for c in got["fc"].get("items", [])]
            await ws.send(j({"type": "conversation.item.create", "items": outs}))
            await recv_for(ws, 20, events, ws_send_silence=True)

        print("== phase C: conversation.item.create + response.create (guess)")
        await ws.send(j({"type": "conversation.item.create", "items": [{
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "（用文字）你在等谁？"}]}]}))
        await ws.send(j({"type": "response.create"}))
        await recv_for(ws, 20, events, ws_send_silence=True)

        await ws.send(j({"type": "session.close"}))
        await asyncio.sleep(1)

    summary = {}
    for e in events:
        if isinstance(e, dict):
            summary[e.get("type","?")] = summary.get(e.get("type","?"),0)+1
    print("\n== summary ==")
    for k,v in summary.items(): print(f"  {k}: {v}")

asyncio.run(main())
