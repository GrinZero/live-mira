#!/usr/bin/env python3
"""Probe 3: pure server-VAD flow — no commit, continuous silence, recv from t=0.
Then barge-in: stream second utterance while response audio is arriving."""
import asyncio, base64, json, os, time, wave
import websockets

URL = "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue"
KEY = os.environ["DOUBAO_API_KEY"]
def j(x): return json.dumps(x, ensure_ascii=False)

pcm1 = wave.open("/tmp/probe_q.wav").readframes(10**9)   # 你也是来躲雨的吗
pcm2 = wave.open("/tmp/probe_q2.wav").readframes(10**9)  # 你可以笑一下吗

state = {"responding": False, "audio_bytes": 0, "barge_sent": False, "fc": []}

async def sender(ws):
    # real-time stream of q1
    for i in range(0, len(pcm1), 640):
        await ws.send(j({"type":"input_audio_buffer.append","audio":base64.b64encode(pcm1[i:i+640]).decode()}))
        await asyncio.sleep(0.02)
    # keep VAD alive with silence; watch for response start to trigger barge-in
    silence = base64.b64encode(bytes(640)).decode()
    while True:
        await ws.send(j({"type":"input_audio_buffer.append","audio":silence}))
        await asyncio.sleep(0.02)
        if state["responding"] and not state["barge_sent"] and state["audio_bytes"] > 60000:
            state["barge_sent"] = True
            print("  >> BARGE-IN: streaming q2 mid-response")
            for i in range(0, len(pcm2), 640):
                await ws.send(j({"type":"input_audio_buffer.append","audio":base64.b64encode(pcm2[i:i+640]).decode()}))
                await asyncio.sleep(0.01)

async def main():
    async with websockets.connect(URL, additional_headers={"X-Api-Key": KEY}, max_size=None) as ws:
        await ws.send(j({
            "type":"session.create",
            "session":{
                "model":"1.2.6.0",
                "instructions":("你是 Mira，26 岁旅行摄影师。暴雨夜咖啡馆。"
                    "规则：每轮开口前必须先调用 stage_directive 设置情绪与镜头。"),
                "audio":{
                    "input":{"format":{"type":"pcm","rate":16000}},
                    "output":{"format":{"type":"pcm_s16le","rate":24000},
                              "voice":"zh_female_vv_jupiter_bigtts"}},
                "tools":[{"type":"function","name":"stage_directive",
                    "description":"驱动画面演出：情绪/动作/镜头。开口前调用。",
                    "parameters":{"type":"object","properties":{
                        "emotion":{"type":"string","enum":["neutral","soft_smile","wistful","surprised","guarded"]},
                        "camera":{"type":"string","enum":["none","idle_drift","slow_push","close_up","pan_door"]}}}}],
            }}))
        send_task = asyncio.create_task(sender(ws))
        end = time.time() + 90
        try:
            while time.time() < end:
                raw = await asyncio.wait_for(ws.recv(), timeout=end-time.time())
                evt = json.loads(raw); t = evt.get("type","?")
                if t == "response.output_audio.delta":
                    state["responding"] = True
                    state["audio_bytes"] += len(evt.get("delta",""))
                elif t == "response.output_audio.done":
                    slim = {k:v for k,v in evt.items() if k!="delta"}
                    print(f"  < audio.done {json.dumps(slim,ensure_ascii=False)[:200]}")
                    if state["barge_sent"]:
                        print("== got second response done; finishing"); break
                elif t == "response.function_call_arguments.done":
                    state["fc"].append(evt); print(f"  < FC {json.dumps(evt.get('items'),ensure_ascii=False)}")
                elif t == "response.output_text.delta":
                    print(f"  < text {evt.get('delta','')!r}")
                else:
                    slim = {k:v for k,v in evt.items() if k!="delta"}
                    print(f"  < {t} {json.dumps(slim,ensure_ascii=False)[:260]}")
        except asyncio.TimeoutError:
            pass
        finally:
            send_task.cancel()
        try: await ws.send(j({"type":"session.close"}))
        except Exception: pass
    print(f"\n== responding_seen={state['responding']} audio_b64={state['audio_bytes']} fc={len(state['fc'])} barge={state['barge_sent']}")

asyncio.run(main())
