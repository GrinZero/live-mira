> 2026-09-16 本轮方向更新：移动端优先，开放随机故事与陪伴；咖啡馆只是起点，不采用预设事件池或固定五分钟结局。旧章节记录历史方案，当前行为以 README.md、server/src/director.ts 和 server/src/story.ts 为准。实现与验证见 output/checks/implementation.md。

# PLAN — 72h 实时互动场景实验（v2，实测定稿）

> 题目：`0912-candidate.pdf`。目标交付一个"小型 Whispers from the Star"：
> 暴雨夜咖啡馆，3D 角色 Mira 叠加在 AI 实时生成的场景图上，中文语音多轮对话、
> 可自然打断；开放剧情由「事件池 + 导演 agent」驱动，场景随故事实时生成。

## 0. 押注轴与评审 60 秒

押注轴：**产品表现力**。所有题目要求包装成叙事情节。

录屏顺序：开 URL → 雨夜咖啡馆 + Mira 待机（呼吸/眨眼/视线）→ 开口说话 →
倾听/思考/说话状态可见 → 说一半时打断 → 剧情节点"她掏出照片"→
生成中 → 新场景切入+运镜 → 一次降级/恢复。

## 1. 技术选型（实测后定稿）

| 层         | 选型                                                                                                                             | 依据                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 语音主链路 | **豆包端到端全双工 Duplex API**（`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`，model `1.2.6.1`，纯 JSON 帧） | 实测通过：VAD/转写/打断/tool call/音频流全通 |
| 导演 agent | 豆包文本 LLM（服务端，走方舟）                                                                                                   | 剧情状态+事件池+生图决策+递词                |
| 角色资产   | **可替换渲染层**：首发开源模型（VRM/GLB 下载即用），Meshy+Blender 自制模型即插即用替换                                           | 资产管线不阻塞主线                           |
| 合成       | 3D 角色叠加 AI 生成场景图，相机推拉=镜头                                                                                         | WftS 式                                      |
| 生图       | 豆包/Seedream，主题×风格模板                                                                                                     | 动态生成+质检+缓存+剧情化降级                |
| 前端       | React + R3F                                                                                                                      |                                              |
| 传输       | 浏览器⇄我们服务端 WebSocket；服务端⇄火山 Duplex WS                                                                               | 密钥不出服务端                               |
| 部署       | D3 定                                                                                                                            |                                              |
| Mock       | MockTransport 回放录制事件脚本                                                                                                   | 无密钥体验+演示保险                          |

### 已实测验证（explore/probe_duplex*.py）

- 仅 `X-Api-Key` 即可握手（无需 App ID）
- `speech_text_buffer.commit`：注入任意文本 → 出声（`tts_type=chat_tts_text`）✅
- 音频流式输入 → `…transcription.started/delta/completed` 正确转写 ✅
- **function call 先于语音触发**：指令"开口前先调 stage_directive"被遵守，
  且模型自选 `emotion:"guarded"` 与人设吻合 ✅
- tool result 回传（`conversation.item.create` role=tool + call_id）后模型续说 ✅
- 响应播放中流式输入新语音 → 旧响应终止 ✅（打断成立）
- `response.create` 不存在；`conversation.item.create` 不触发模型回合
  → **文字输入走"导演写词 → speech_text_buffer 念出"**
- 音频必须严格 20ms 实时节奏；静音保活用 `input_audio_mute/unmute.commit`
- 必须 `session.close` 再断连（否则 ContextCanceled）；`session.id` 可续接历史
- 老版二进制端点（`/api/v3/realtime/dialogue`）同 key 也通，但**决定不用**——
  只走 duplex JSON 协议
- ⚠️ `DOUBAO_API_KEY` 只覆盖语音服务；**方舟（生图/文本 LLM）用 `SEED_API_KEY`** ✅已实测
- `SEED_API_KEY`（方舟）已验证：`/models` 132 个可用——Seedream 3/4/4.5/5.0/5.0-pro
  生图、seed-1-6/1-8/2-0/2-1 文本 LLM、**Seedance 1.0–2.5 视频生成（加分项可选项）**；
  chat/completions 与 images/generations 实测出活；生图右下角带"AI生成"水印（合规标）

## 2. 架构：双 agent（演员 + 导演）

```
浏览器 (React + R3F) —— "执行/呈现"
  ├─ 客户端导演状态机: IDLE⇄LISTENING→THINKING→SPEAKING
  ├─ 四队列调度: 字幕/表情动作/相机特效/媒体（指令随 tool call 到达即入队）
  ├─ 3D Mira (GLB+shape keys) 叠加 AI 背景；振幅→mouthOpen
  └─ 打断: 本地检测/服务端转写信号 → 停音频清队 → 上行 cancel
        ↕ 我方 WS（自有协议：音频/转写/指令/媒体事件）
服务端 —— "导演 agent"
  ├─ 故事引擎: 剧情状态 + 事件池 + 注入时机（自然停顿）
  ├─ 生图管线: 主题×风格模板 → 质检 → 重试 → 降级 → 缓存
  ├─ 文本回合: 用户打字 → TTS 成用户话音注入 → 演员真回合自答（失败退回递词）
  └─ 会话恢复: session.id 续接 / localStorage 存 id
        ↕ 火山 Duplex WS（JSON 事件）
豆包 Duplex 模型 —— "演员"
  ├─ instructions = Mira 人设卡 + 表演规则 + 工具使用规则
  ├─ 原生: server VAD / 附和抗干扰 / 打断 / 情绪声线涌现
  ├─ 转写流（用户字幕）/ 文本流（角色字幕）/ 音频流
  └─ tools = 结构化场景指令通道（见 §3）
```

职责切分：**演员管"怎么说"，导演管"演什么"，客户端管"画什么"。**
声音情绪/音量/声线交给模型涌现（instructions 自然语言控制）；
画面指令走 tools；剧情走向走上下文注入。

## 3. 指令协议 = Function Tools

`session.tools` 声明（`session.update` 可动态增删，全量覆盖）：

```jsonc
stage_directive: {
  emotion:  neutral|soft_smile|wistful|surprised|warm|guarded,   // → blendshape
  action:   none|hug_cup|glance_door|show_photo|tuck_hair|stand_up, // → 骨骼动画
  camera:   none|idle_drift|slow_push|close_up|pull_back|pan_door,  // → 运镜
  fx:       none|rain_heavy|lightning|lights_dim|rain_stop          // → 环境层
}
scene_event: { theme: string }  // 场景转换 → 服务端生图（主题×风格模板）
show_photo:  { subject: string, caption: string } // "掏照片"→ 生图道具
```

- 调用落地：`response.function_call_arguments.done`（可并行多个）→
  服务端按 call_id 回传结果（`role=tool` + `content[].input_text`）→ 模型续说
- 剧情事实/事件注入：`conversation.item.create`（user/assistant 成对、偶数条）
- 递词（开场白/降级圆场保底）：`speech_text_buffer.commit`；
  主动开口/文字回合/静默事件 → TTS 注入输入音频开真回合（协议无 response.create）
- 打断中改口：`speech_text_buffer.replacement.*`

## 4. 状态机与打断（客户端导演）

```
IDLE ⇄ LISTENING → THINKING → SPEAKING ⇄ …（多轮）
         ↑_____________ INTERRUPT ____________|
```

- **打断信号双源**：本地 AnalyserNode（能量>300ms）或下行
  `…transcription.started`（服务端首字，官方注明可用于打断）
- **打断动作**：停所有音频源 + 清四队列 + 上行 `response.cancel` → 回 LISTENING；
  迟到 chunk 按 `response_id`/`question_id` 比对丢弃（epoch 守卫）
- **恢复语义**：硬取消+自然衔接；附和大多被 server VAD 抗干扰滤掉，
  漏网者作为正常输入由模型自然接续
- 生图不阻塞语音；`media.event` 异步下发

## 5. 音频与保活纪律（协议硬约束）

- 上行 PCM16k 单声道，**严格 20ms/640B 实时节奏**，偏离会报错
- 关麦后必须 `input_audio_mute.commit`（开麦 `unmute`），否则超时无响应
- 下行音频默认 ogg_opus；`extension.tts.audio_config` 可配 pcm_s16le 24k
- 下行音频同时喂 AnalyserNode → `mouthOpen`（振幅口型；字级时间戳无必要再查）
- 优雅关闭：先 `session.close` 收到回复再断连；5xx 统一重连
- 限流：60 QPM / 100k TPM；`45000003` = 10min 无交互断连

## 6. 故事引擎（开放剧情，罗盘非轨道）

- **剧情状态**（服务端）：已建立事实/当前地点/情绪基线/已用事件/session.id
- **事件池**：候选事件（门外摔倒/手机响/雨停/打烊铃/猫路过/回忆闪回…），
  自然停顿时经 `conversation.item.create` 注入为"现场事实"
- **主动开口**：静默超阈 → 导演只给旁白 cue → TTS 注入音频 → 她自己开口
  （同样可被 VAD/转写打断）
- **双通道**：池注入 + 演员模型可自主调 `scene_event`/`show_photo` 发明节点
- **秘密=留白**：canon 不写"等谁"；人设卡=身份+说话方式+即兴边界
- **会话恢复**：localStorage 存 session.id → 续接最近 20 轮

### 内容层文件（content/，已落盘）

| 文件                      | 内容                                                    |
| ------------------------- | ------------------------------------------------------- |
| `content/persona.mira.md` | 演员 instructions 正本：人设/说话方式/表演规则/世界规则 |
| `content/director.md`     | 导演 agent 系统提示 + I/O 契约（单行 JSON 决策）        |
| `content/events.json`     | 事件池 8 个：注入旁白+触发条件+tags_hint，once 用过即废 |
| `content/style.md`        | 生图风格模板：内容开放风格锁死，5 个场景 body           |
| `content/lines.md`        | 台词库：开场/主动开口/降级圆场（兜底+风格基准）         |

## 7. 生图管线（全实时+不损开放度的兜底）

主题(LLM/事件池) → 套固定风格模板（雨夜电影感/统一色调/16:9）
→ 生图 API → 质检（分辨率+像素方差防废图）→ 失败重试 1 次
→ 仍败 → 剧情化降级（噪点闪回/角色圆场，永不黑屏）
→ 成功 → 按 scene_key 缓存 → crossfade 切入

"照片"类内容由对话驱动 subject → 真·动态生成。

## 8. 口型与表情（可替换角色渲染层）

`CharacterActor` 接口：`setEmotion(e)` / `playAction(a)` / `setMouthOpen(v)` /
`setState(待机|倾听|思考|说话)` / `tick(dt)`（idle 呼吸·眨眼·视线）。

| 实现               | 资产                                             | 表情/口型能力                                                     |
| ------------------ | ------------------------------------------------ | ----------------------------------------------------------------- |
| `VrmActor`（首发） | VRoid/开源 VRM 下载即用                          | three-vrm 自带情绪 expression + **viseme 口型** + 眨眼/视线——白送 |
| `GlbActor`（升级） | Meshy 生成 + Blender 补 shape keys + Mixamo 动作 | 自建 mouthOpen/smile/frown/browUp/eyeBlink                        |

指令映射：`stage_directive.emotion`→`setEmotion`，`action`→`playAction`；
口型 = 下行音频振幅→`setMouthOpen`（VRM 可升级音素级）。
Meshy 路线只补 Blender 键；两条路产出的模型随时互换。

## 9. 移动端注意项

- AudioContext 手势解锁 + iOS 权限 → 开场"轻触进入"
- 角色居中偏上、字幕下三分之一、输入条贴底
- GLB 压纹理、背景渐进加载、低端机降粒子

## 10. 72h 时间线（60h+）

| 阶段  | 内容                                                                                          | 验收                   |
| ----- | --------------------------------------------------------------------------------------------- | ---------------------- |
| D0 ✅ | 协议探针已通（explore/）；剩余：定 voice 音色                                                 | —                      |
| D1    | CharacterActor 抽象 + VrmActor 首发（开源模型占位）；我方 WS 骨架+Mock 回放；Meshy 线并行推进 | 角色呼吸眨眼可换模型   |
| D2    | 浏览器⇄服务端⇄Duplex 三通；字幕同步；打断（cancel+清队）；tools→四队列；事件池+主动开口       | 完整语音回合+打断+演出 |
| D3a   | 生图管线全链；场景转换；环境音；会话恢复                                                      | 剧情弧可演             |
| D3b   | 部署公网；录屏（多录选优）；README+AI_USAGE；4h buffer                                        | 交付齐                 |

## 11. 交付自查 vs 题目

必选项全覆盖；扩展项兑现：附和抗干扰（server VAD）、振幅口型+眨眼待机、
生图质检重生、缓存复用、开放剧情分支、会话恢复、事件日志观测、
主动开口（超出题目清单的表现力点）。
README 写明：打断选择服务端信号+本地检测双源的理由；振幅口型取舍。

## 12. README/AI_USAGE 骨架

README：架构图（双 agent 三通道）→ 启动 → 语音与打断流程 →
指令设计（tools schema + 注入通道）→ 模型与三方服务 → 取舍 →
已知问题 → 投入时间 → 两周演进（多场景资产/回放导出/音素口型）。

AI_USAGE：Codex 设定图 / Meshy / Claude·Codex 写码 / 人工验证点 /
一个 AI 出错被人工修正的实例（预留）。

## 13. 未决项

- [x] ~~方舟 key~~：`SEED_API_KEY` 已提供并实测全通（生图+文本+视频）
- [ ] 待用户提供（可选）：开源角色模型（VRM/GLB，license 允许公开 demo）
- [ ] 部署目标（D3 前）
- [ ] voice 音色定案：试听 vv/xiaohe 等 + instructions 里声线描述
- [ ] 打断后第二回合是否自动接续（probe4 早退未验，D2 验）
- [ ] `tts_prompt` 字段能否按句控制语气（speech_text 上）
- [ ] 事件池首版清单（≥5，含"门外摔倒"）
- [ ] 英文边界：中文主线；英文 stretch
