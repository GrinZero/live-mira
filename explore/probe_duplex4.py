#!/usr/bin/env python3
"""Probe 4: correct protocol discipline.
- model 1.2.6.1, real-time 20ms pacing, recv concurrent with send
- no early commit: let server VAD decide; keep real-time silence after speech
- mid-response barge-in with second utterance
- instruction mandates stage_directive call before speaking -> check FC event
"""
import asyncio, base64, json, os, time, wave
import websockets

URL = "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue"
KEY = os.environ["DOUBAO_API_KEY"]
def j(x): return json.dumps(x, ensure_ascii=False)

SILENCE = base64.b64encode(bytes(640)).decode()
pcm1 = wave.open("/tmp/probe_q.wav").readframes(10**9)
pcm2 = wave.open("/tmp/probe_q2.wav").readframes(10**9)

st = {"audio_b64": 0, "barged": False, "done1": False, "fc": 0, "t_first_audio": None, "t_send_end": None}

async def stream(ws, pcm, pace=0.02):
    for i in range(0, len(pcm), 640):
        await ws.send(j({"type": "input_audio_buffer.append",
                         "audio": base64.b64encode(pcm[i:i+640]).decode()}))
        await asyncio.sleep(pace)

async def sender(ws):
    await stream(ws, pcm1)
    st["t_send_end"] = time.time()
    while True:
        await ws.send(j({"type": "input_audio_buffer.append", "audio": SILENCE}))
        await asyncio.sleep(0.02)
        if st["audio_b64"] > 80000 and not st["barged"]:
            st["barged"] = True
            print("  >> BARGE: streaming q2 while response plays")
            await stream(ws, pcm2, pace=0.02)

async def main():
    async with websockets.connect(URL, additional_headers={"X-Api-Key": KEY}, max_size=None) as ws:
        await ws.send(j({
            "type": "session.create",
            "session": {
                "model": "1.2.6.1",
                "instructions": ("你是 Mira，26 岁旅行摄影师，琥珀色雨衣。暴雨夜咖啡馆打烊前。"
                    "说话简短口语、带一点防备。"
                    "规则：每轮开口前必须先调用 stage_directive 设置情绪与镜头。"),
                "audio": {
                    "input": {"format": {"type": "pcm", "rate": 16000}},
                    "output": {"format": {"type": "pcm_s16le", "rate": 24000},
                               "voice": "zh_female_vv_jupiter_bigtts"}},
                "tools": [{"type": "function", "name": "stage_directive",
                    "description": "驱动画面演出：情绪/动作/镜头。开口前调用。",
                    "parameters": {"type": "object", "properties": {
                        "emotion": {"type": "string", "enum": ["neutral","soft_smile","wistful","surprised","guarded"]},
                        "camera": {"type": "string", "enum": ["none","idle_drift","slow_push","close_up","pan_door"]}}}}],
            }}))
        send_task = asyncio.create_task(sender(ws))
        end = time.time() + 90
        try:
            while time.time() < end:
                raw = await asyncio.wait_for(ws.recv(), timeout=end - time.time())
                evt = json.loads(raw); t = evt.get("type", "?")
                if t == "response.output_audio.delta":
                    st["audio_b64"] += len(evt.get("delta", ""))
                    if st["t_first_audio"] is None:
                        st["t_first_audio"] = time.time()
                        lat = st["t_first_audio"] - (st["t_send_end"] or st["t_first_audio"])
                        print(f"  < audio.delta (first; ~{lat:.2f}s after speech end)")
                elif t == "response.output_audio.done":
                    print(f"  < audio.done status={evt.get('status_code')} resp={evt.get('response_id')}")
                    if st["barged"]:
                        print("== barge-in produced second response; done")
                        break
                elif t == "response.function_call_arguments.done":
                    st["fc"] += 1
                    print(f"  < FC {json.dumps(evt.get('items'), ensure_ascii=False)}")
                    outs = [{"call_id": c["call_id"], "role": "tool",
                             "content": [{"type": "input_text", "text": "{\"ok\":true}"}]}
                            for c in evt.get("items", [])]
                    await ws.send(j({"type": "conversation.item.create", "items": outs}))
                elif t == "response.output_text.delta":
                    print(f"  < text {evt.get('delta','')!r}")
                else:
                    slim = {k: v for k, v in evt.items() if k != "delta"}
                    print(f"  < {t} {json.dumps(slim, ensure_ascii=False)[:260]}")
        except asyncio.TimeoutError:
            print("== timeout")
        finally:
            send_task.cancel()
        try:
            await ws.send(j({"type": "session.close"})); await asyncio.sleep(1)
        except Exception:
            pass
    print(f"\n== audio_b64={st['audio_b64']} fc_calls={st['fc']} barged={st['barged']}")

asyncio.run(main())
