# 雨夜 · Mira

移动端优先的开放式语音相遇。暴雨夜的咖啡馆是起点；故事沿着对话生成，没有固定事件池、预设路线或五分钟强制结局。可以参与新事件、提出选项之外的行动、去新的地方，也可以安静坐着。

基础场景是：用户在雨夜咖啡馆里，遇到刚从雨中进来的 Mira——一名 26 岁的旅行摄影师。她的相机放在桌上，口袋里有一张折过的旧照片；照片是什么、她为什么停在这里，由对话逐步揭示。

当前故事采用成年角色的原创关系设定：用户是 Mira 失忆的恋人，共同过去随对话逐步揭示。视觉暂用 VRoid 官方示例模型，不是定制角色美术。

## 快速开始

环境：Node.js >= 22、pnpm 9（仓库锁定 9.15.9）。仓库包含 VRM、MediaPipe 和 Mock 回放素材。安装依赖后，`pnpm dev` 一条命令同时启动前后端。无密钥可直接走下述 Mock 入口；真实模式再填写服务端 `.env`。

```bash
pnpm install
cp .env.example .env  # 如果还没有 .env；已有 .env 时不要覆盖
pnpm dev
```

打开 http://localhost:5173 。真实语音与剧情需要 `.env` 里的 `DOUBAO_API_KEY`（豆包 Duplex 语音）和 `SEED_API_KEY`（方舟：导演 LLM + Seedream 生图），见 `.env.example`。

**没有 API key 也能体验核心流程**：`pnpm dev` 后访问 `http://localhost:5173/?mock=1`，回放一段真实会话的完整录制——语音、字幕、舞台指令、打断、生图事件按原时间轴重放。它不生成新内容，但完整展示状态机与演出管线。

手机与开发机同一网络时需可访问的 HTTPS 地址（浏览器麦克风要求安全上下文）；localhost 仅指设备自身。

## 交付入口

- 主演示：[demo-live.mp4](output/showcase/submission/demo-live.mp4)，用户提供的原片，**4:07.550**，1628×1080 / 60fps。原样归档，未剪切或覆盖；包含语音交流、插话改话题、场景探索、足迹地图和返回咖啡馆。
- 错误处理：[api-error-handling.mp4](output/showcase/submission/api-error-handling.mp4)，**2:50.720**，独立补录，不拼接主片。通过明确标注的故障注入展示回应 API 超时、生图 API 503、场景图片 404、语音服务断连及降级/恢复。
- 两段视频应一起提供给评审。主片满足 3–5 分钟时长，失败/降级证据在独立附件中；若接收平台只收一个文件，需要另行调整提交方式。
- 文件校验、镜头定位、录制方法和未确认项见 [交付核对](docs/demo-delivery.md)。视频与原始证据放在被 Git 忽略的 `output/`，不会随源码推送；提交材料时需同时附上两个 MP4。
- 现有部署入口：[雨夜 Mira](https://rainy-night-mira-web-production.up.railway.app/)。本轮未重新验收公网完整语音链路；本地启动说明与 Mock 回放仍是独立可用的交付路径。
- 无密钥演示：启动后打开 `http://localhost:5173/?mock=1`。它回放已录制会话，不生成新剧情，也不代表模型每次都会给出相同回应。

## 系统结构

当前是“演员 + 导演 + 客户端导演 + 持久世界”的分层结构。演员负责自然说话和实时表演，导演负责对话记忆与世界提案，客户端导演负责可见状态和媒体时序，服务端会话负责把它们收敛成一次可恢复的相遇：

```
浏览器（React + R3F）—— 体验与时序层
  ├─ ClientDirector + Zustand: boot / idle / listening / thinking / speaking / reconnecting
  ├─ RealTransport / MockTransport: 真实 WS 或录制时间轴，共用同一套客户端状态机
  ├─ AudioEngine: 麦克风 PCM16k、24k 播放、雨声/雷声、振幅口型驱动
  ├─ Stage + VrmActor: VRM 表情、motion、gesture、视线、相机与环境特效
  ├─ Background + overlay + 默认咖啡馆 foreground: 底图和当前场景事件叠层按 scene_key 对齐；新场景不自动生成前景
  ├─ WorldMap: 已抵达地点、路径、地图图块、回访与出发/取消
  └─ 打断/媒体握手: VAD 或手动打断 → 清播放与 epoch → interrupt；图片预加载成功后才 scene.presented
        ↕ 自有 WS 协议（JSON 消息 + 二进制 PCM 帧，shared/protocol.ts / shared/world.ts）
Node 服务端 —— 会话编排与持久化层
  ├─ HTTP/static/auth + WS: 静态资源、可选口令门禁、心跳、限流、会话接管
  ├─ ClientSession: 浏览器⇄Duplex 桥接、打断仲裁、世界提交、断线宽限/重连、回放录制
  ├─ Director: Ark 对话/世界提案、静默节奏、事实记忆、行动授权与照片编排
  ├─ 可选 Jev 层: reaction / cadence / photo request-response 语义判断，不阻塞主语音链
  ├─ genimg: scene / photo / overlay（以及可选 foreground）→ 质检 → 重试 → 缓存/降级
  ├─ WorldStore + runtime: SQLite 事件幂等、世界资产、地图区域后台生成与重试
  └─ SessionTrace: 本地 OTLP JSON journal，导出当前或历史 session 的诊断链路
        ↕ 火山 Duplex WS（JSON 事件；主会话音频为 PCM，文字注入另有 TTS 连接）
豆包 Duplex —— 演员与语音执行层
  ├─ instructions = Mira 人设卡 + 表演规则（content/persona.mira.md）
  ├─ 原生 ASR/VAD、附和抗干扰、打断、情绪声线与输出音频
  └─ tools = stage_directive / scene_event / show_photo

持久目录
  ├─ data/worlds/worlds.sqlite + WAL: 世界快照、近期 80 条交流、物件和事件唯一键
  ├─ data/worlds/media/: 已提交场景、照片和地图资产
  ├─ cache/media/: 可重建的生成缓存
  └─ recordings/traces/: 按浏览器所有权令牌隔离的 OTLP JSON 诊断
```

主要模块：

| 模块                              | 职责                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/index.ts`             | HTTP 静态资源与 API、可选口令认证、`/ws` 升级门禁、心跳、IP 限流、会话创建/接管/重置                                               |
| `server/src/session.ts`           | 一场戏的编排：打断仲裁、转写流、工具调用、场景准备与 `scene.presented` 提交、世界 checkpoint、断线宽限与 Duplex 重连               |
| `server/src/director.ts`          | Ark 对话/世界提案、对话记忆、静默节奏、用户行动授权、照片与场景调度；不把模型的过去式描述直接写成已发生事实                        |
| `server/src/duplex.ts`            | 主 Duplex 演员连接：20ms PCM16k 节拍、24k 输出、mute 保活、工具回传、旁白/台词注入、取消与 session 续接                            |
| `server/src/inject-tts.ts`        | 第二条 Duplex 连接只把文字合成为 PCM；文字输入因此可以注入主演员会话，失败时才回退到 Ark 文字代答                                  |
| `server/src/genimg.ts`            | `scene` / `photo` / `overlay` / 可选 `foreground`：提示词、参考底图、质检、重试、缓存、降级和 `scene_key` 过期保护                 |
| `server/src/world/store.ts`       | SQLite WAL 事务、事件唯一键、世界/地点/物件/近期记忆、所有者隔离及持久媒体资产                                                     |
| `server/src/world/runtime.ts`     | 已访问地点地图图块的串行后台生成、有限重试和照片占位降级；不重画已经保存的区域                                                     |
| `server/src/decisions.ts`         | 可选 TypeSafe/Jev 语义判断：意图、安静偏好、非语言反应、对话节奏和照片请求/展示；超时或缺 key 时主链仍可运行                       |
| `server/src/telemetry.ts`         | 常驻本地 OTLP JSON journal、span 父子关系、脱敏、按所有权令牌隔离和诊断导出                                                        |
| `web/src/state/directorClient.ts` | 客户端状态机、四类事件调度、epoch 丢迟到包、本地 VAD、重连、图片预加载、转场/世界 ACK 和 Mock/真实传输统一接入                     |
| `web/src/audio/engine.ts`         | 麦克风采集、播放缓冲、雨声/雷声、振幅分析；播放缓冲实测决定“说完”时刻并回报服务端                                                  |
| `web/src/scene/`                  | `VrmActor`/`actor` 的表情、motion、gesture、口型、眨眼、呼吸和视线；`Stage`/`Background`/`SceneJourney` 负责场景、叠层、前景和运镜 |
| `web/src/net/mock.ts`             | 使用录制事件与裸 PCM 的无密钥回放；只在本次回放内模拟发现/返回，不写入 SQLite，也不生成新媒体                                      |
| `content/` + `shared/`            | `content/` 提供人设、导演、风格和兜底台词；`shared/` 提供跨端协议、世界状态、场景站位与空间约束，避免服务端和浏览器各自解释        |

## 题目要求对应

| 题目要求               | 当前实现                                                                                                           | 验证边界                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 场景化页面而非聊天列表 | React/R3F 场景、VRM Mira、背景/前景、字幕区、文字与麦克风入口；移动端优先，桌面端可用                              | 浏览器触摸模拟已覆盖 360/375/390px；实体手机帧率与麦克风体验仍需人工验收                |
| 待机、倾听、思考、说话 | `idle`、`listening`、`thinking`、`speaking` 状态和对应字幕/角色表现                                                | `output/checks/` 与 `output/showcase/` 有回放和录制证据                                 |
| 文字与语音多轮互动     | 文字回合经第二条 Duplex TTS 转成 PCM 后注入主演员会话；真实语音走主 Duplex；两者共用字幕、记忆与世界后果           | 真实服务多轮记录见 `output/checks/live-conversation.json`；合成语音不等于实体麦克风验收 |
| 语音打断               | 本地能量 VAD、服务端转写信号、手动按钮三路入口；清理音频/字幕/指令并用 epoch 丢弃迟到结果                          | 真实服务打断链路已测；嘈杂环境、外放回声和热量表现未充分验证                            |
| 角色与场景驱动         | `stage_directive` 驱动表情、原子姿态、连续动作、运镜和环境特效；导演确认用户行动后生成场景，客户端握手后才提交抵达 | VRM 程序化动作已通过 Chromium/骨骼检查；尚未接入 mocap/VRMA 成品动作库                  |
| 至少一种多模态表现     | VRM 角色动画 + Seedream 照片/场景/当前底图事件叠层；环境音、雷声和对视追踪补充沉浸感                               | 当前交付选择“角色动画 + 生成式图片”；视频生成仅列为后续扩展                             |
| 可运行的前后端闭环     | 浏览器 → Node/WS → Duplex/Ark/Seedream → 状态、音频、媒体和持久世界回到浏览器；无 key 可用 Mock 回放               | 本地启动与无密钥回放入口已给出；本轮未复验公网完整链路                                  |
| 失败与降级             | 生图重试、缓存、原场景/照片占位、转场加载失败留在原地、重连与会话恢复                                              | 独立补录已验证回应超时、生图 503、图片 404 和语音断连后的降级/恢复                      |

题目中的量化表演要求单独核对：协议定义 6 种情绪，客户端有表情映射、视线/手部姿态和连续动作，但“定义了枚举”不等于“观众能清晰辨认”。当前主片可见抬手、站姿变化、转场和地图往返；尚未完成 3 种表情及 2 种非说话动作的逐项镜头验收。对话触发的新场景已在主片中呈现。VRM 动画与生成式场景覆盖多模态选项，无须额外实现视频生成来满足至少一种的要求。

### 本次错误处理证据

补录使用独立浏览器、临时世界与真实服务，在 API/资源/连接边界注入故障；字幕、状态和降级提示来自应用实际处理。片头章节明确标注注入条件，不把它描述成线上自然故障。

- 回应 API 超时：关闭文字转语音辅路，使请求进入 Ark 兜底并超时；Mira 使用角色内台词“刚才你说什么？我没听清。”，解除故障后再次输入可正常回答。该台词是失败圆场，不表示实际 ASR 判断为没听清。
- 生图 API 503：实际请求重试失败后结束加载，保留原地点并提示，仍可继续交流。
- 场景图片 404：加载失败时留在原处；解除故障后通过地图再次进入成功。
- 语音服务断连：上游 WebSocket 关闭后提示重连，建立新连接，后续输入获得语音/字幕回复。

原始 WebM、输出音轨、截图和断言结果位于 `output/playwright/api-errors-1789876571468/`。录制使用静音测试麦克风及一个已保存地点 fixture，不属于实体设备验收；健康请求由真实服务处理。复录脚本为 `scripts/record-error-handling.ts`，启动方式见 [交付核对](docs/demo-delivery.md)。

## 语音交互与打断

- **语音回合**：浏览器 PCM16k 单声道 20ms 帧 → 服务端 → Duplex。服务端 VAD 产出用户转写流（字幕）、角色音频流与文本流（同步字幕）。
- **文字回合**：浏览器把文字送给 `ClientSession`；服务端用第二条 Duplex 连接的 `InjectTts` 将用户文字合成为 PCM，再注入主 Duplex 的演员耳朵，触发和真人说话相同的回应路径。TTS 注入不可用时才回退到 Ark 文字生成；不会把模型代答伪装成用户麦克风音频。协议没有 `response.create`，导演台词使用 `speech_text_buffer.commit`；字幕由服务端直发。
- **流式与动作旁白**：原生 PCM 到达即转发，不再等待整轮文本/音频完成。通过 [豆包全双工 API](https://docs.volcengine.com/docs/DoubaoVoice/endtoend-realtime-voice-full-duplex-version?lang=zh) 的 `extension.tts.extra.max_length_to_filter_parenthesis: 100` 在合成端过滤括号内容；本地 SpeechGate 只增量过滤字幕。超过 100 字的括号内容可能仍被朗读，提示词继续要求动作走工具。整轮只有括号动作时，本地补齐空回复结束，避免上游缺少 audio.done 导致卡住。
- **多轮**：会话内保留最近对话、用户原话事实、Mira 已说经历、未回应话语与已确认事件后果；中断的回答不视为完整告知。

打断选择**自动 VAD（双源）+ 手动按钮**，不用按住说话：

- 场景是"面对面对话"而非对讲机——按住说话会破坏开放陪伴式体验，用户需要随时能开口。
- **本地源**（AnalyserNode 能量 >300ms）快但有噪声误判风险；**服务端源**（`transcription.started`，官方注明可用于打断）准但有网络延迟。双源任一先到即触发，互为兜底。
- 手动"打断"按钮是第三重保险：VAD 全失效或用户不想出声时仍可用。
- 打断语义：停全部音频源 + epoch++ 作废在途指令/字幕/媒体 → 上行 `interrupt` → 服务端 `cancelResponse` + 清注入队列 → 回 listening。迟到音频/文本按 rid/epoch 守卫丢弃，上一轮迟到响应不会覆盖当前状态。
- 关键坑：Duplex 下行音频是**突发式**下发（3.5s 语音约 450ms 内发完），`output_audio.done` ≠ 用户感知的说完。所以播放结束由浏览器音频缓冲实测回报，服务端在 done 后保留 6s 打断宽限窗；打断余波中到达的新响应暂扣 400ms 观察窗，存活才放行——避免半截"嘟"声残片。

## 角色与场景指令

指令走 Duplex function tools，随回复流式到达即入队：

| tool              | 参数                                                                 | 落到                                                                                         |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `stage_directive` | `emotion`(6 种) / `gesture` / `motion` / `camera`(6 种) / `fx`(5 种) | 表情 blendshape、局部姿态、全身动作、运镜和环境层                                            |
| `scene_event`     | `theme`                                                              | 保留在演员工具协议中；服务端不会凭此直接提交地点，实际地点由导演世界提案和用户行动确认后生成 |
| `show_photo`      | `subject`, `caption`                                                 | 台词确认后生图并显示照片浮层，同时持久化为角色物件                                           |

姿态不是枚举动作，是**原子槽位**：手到空间锚点、躯干/头连续量、视线目标、手持物。`{hand_l:'forward_eye', prop:'photo', gaze:'user'}` = 把照片递到你眼前。模型自由组合，服务端按物理规则校正怪组合，并把砍掉的字段随工具回执返给模型——它能看到"被砍了什么"自行收敛。

视觉事件与对话绑定而非计时器：`show_photo` 由演员模型或照片编排器在台词到点时触发，并会等最终回复确认，避免“提到照片”就弹图；若台词递了照片却漏调，`armPhotoFromSpeech` 兜底补生成。`scene_event` 只是兼容工具，服务端会回传 `wait_for_confirmed_world_update`，不让演员自行宣布抵达。实际流程是“用户行动 → Ark 世界提案 → 行动授权 → 生成 → 浏览器预加载 → `scene.presented` → SQLite 事务提交”；失败、取消、超时都留在原地点，已提交地点的资源加载失败会提示重新连接恢复。

### 场景生成慢点与当前策略

新场景是当前体验里最明显的延迟来源。一次未命中的 `scene` 生成通常包含：服务端确定人物站位并生成空间参考图、第一次 Seedream 环境图、第二次以第一张图为输入的清理/重绘、下载与基础质检、JPEG 缓存/持久化，最后还要经过浏览器图片预加载和离场/入场转场。任一生成或质检重试都可能再次拉长等待；地图图块则在抵达后异步生成，不阻塞抵达。

当前的缓解方式是：语音和对话不等待生图；客户端立即展示 `generating` 状态；同 key 的并发请求合并，已生成场景复用缓存；生成失败保留原地点并给出角色内降级台词；浏览器确认图片可显示后才提交世界状态。代价是首次去新地点仍可能等待数秒到更久，不能把“正在准备”说成“已经抵达”。

后续优化优先按可观测性和质量边界推进：先在诊断 trace 中拆出参考图、两次图像请求、下载、质检、持久化和浏览器预加载耗时；再评估对稳定场景复用预热结果、对不需要空间草图的场景走单次生成、对可接受的场景先下发低清预览，以及把清理步骤改为后台增强。任何快路径都必须保留站位/透视约束、失败留在原地和最终 `scene.presented` 提交语义。

## 模型与第三方服务

| 用途                           | 服务                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 语音对话（ASR+LLM+TTS 全双工） | 豆包端到端 Duplex（`openspeech.bytedance.com/api/v3/duplex`，model `1.2.6.1`）                           |
| 导演 LLM（世界决策/文字回应）  | 火山方舟 `doubao-seed-1-6-flash-250828`                                                                  |
| 生图（照片/叠层/新场景/地图）  | 火山方舟 Seedream `doubao-seedream-4-5-251128`                                                           |
| 现场反应/安静偏好（可选）      | TypeSafe AI `jev-latest`；不阻塞语音主链，见 `docs/jev.md`                                               |
| 角色模型                       | VRoid Studio 官方示例 `AvatarSample_A` 的 VRM（`assets/mira.vrm`，可整只替换）                           |
| "对视"人脸追踪                 | MediaPipe FaceLandmarker，全程本地推理，画面不出浏览器                                                   |
| 环境音                         | 雨声与雷声为授权录音，咖啡馆 BGM 为 AI 生成音乐；ffmpeg 负责转码与响度处理，见 `assets/audio/SOURCES.md` |

密钥只在服务端 `.env`，不进仓库、不下发客户端。

### 素材与第三方来源

- 角色模型由 `scripts/fetch-assets.mjs` 从 `madjin/vrm-samples` 获取，来源与再分发条款以 VRoid 官方示例说明为准；替换模型时需保持 VRM 骨骼/表情兼容。
- 雨声来自 Freesound #549909，来源页标注 CC0 1.0；雷声来自 BigSoundBank #3179，来源页标注 CC0。咖啡馆 BGM 是在用户授权的 Gemini 页面生成的原创音乐，不在文档中把它声明为 CC0 或独占素材。
- MediaPipe、React/R3F/Three.js、three-vrm、ffmpeg、Ark/Seedream、豆包 Duplex 等第三方组件与服务均只用于本地/演示链路；完整音频来源、许可证和重建方式见 `assets/audio/SOURCES.md`。
- 仓库不提交 API key、cookie 或个人认证信息；第三方服务不可用时使用 mock、缓存或降级路径。

## 关键技术取舍

- **端到端语音模型而非 STT+LLM+TTS 拼装**：VAD、转写、打断、情绪声线都是模型原生能力，减少了自建多段语音管线的编排环节（未做同条件横向基准）；代价是协议约束硬（20ms 节拍、mute 保活、无 `response.create`）。
- **文字回合注入真实 PCM 而非直接代答**：第二条 Duplex 只负责 TTS，主会话仍由演员自己理解和回应；这样文字和语音共用表演链，但多了一次 TTS 延迟和一个需要回退的连接。
- **振幅口型而非音素级**：下行音频直接喂 AnalyserNode，零成本且够自然；协议无字级时间戳，音素口型留给演进。
- **原子姿态而非枚举动作**：模型自由组合身体槽位，服务端校正；比固定动作库表达面广，比直接暴露骨骼数据安全。
- **生图不阻塞语音，但不牺牲抵达一致性**：`media.event` 异步下发，生成中状态浮层呈现；转场握手与图片预加载降低黑屏及地点状态错乱风险，代价是首次地点切换有明显延迟。两阶段生成的质量/空间约束仍需和速度一起评估。
- **世界提案与世界事实分离**：模型只能提议，用户行动和 `scene.presented` 才能让地点进入 SQLite；避免台词、图片生成或迟到包提前改变世界。
- **实时会话与世界存档分离**：语音连接仍在单实例内存中；地点、背景资产、访问路线、环境状态与最近 80 条交流保存在 SQLite 和持久目录。浏览器凭证用于恢复同一次相遇。

## 验证

```bash
pnpm test            # 离线回归：记忆、过期决策、开放世界、打断、静音、安全边界
pnpm check           # typecheck + lint + format:check
pnpm build           # 前端类型检查及生产构建
pnpm test:e2e        # 本地 WS 客户端端到端回归
pnpm test:conversation                       # 真实服务多轮姓名/纠正/话题连贯性
pnpm test:jev                                # 可选 TypeSafe AI 现场反应探测
pnpm evals:photo:validate                    # 照片语义数据集离线契约校验
pnpm evals:photo:live -- --out tmp/evals/photo-semantics/latest.json # 真实 TypeSafe 照片语义 eval
pnpm exec tsx scripts/verify-voice-live.ts   # 合成输入 → 真实 ASR/语音/打断恢复
pnpm exec tsx scripts/verify-world-live.ts   # 真实模型的事件及自由行动决策
pnpm exec tsx scripts/verify-world-browser.ts # 隔离存档 + 真实浏览器往返/取消/重启恢复（语音使用 fixture）
pnpm exec tsx scripts/verify-scene-live.ts   # 真实语音/生图/地图探索与回访录像（付费 API）
pnpm exec tsx scripts/verify-media-live.ts   # 真实生图和转场链路（调用付费服务）
```

验证记录在 `output/checks/`，手机/桌面截图和录像在 `output/playwright/`、`output/showcase/`。例如 `output/playwright/walk/live/result.json` 记录了真实语音/导演/生图流程中的咖啡馆进入、屋檐下新地点、两块地图生成与返回；`output/checks/world/result.json` 是隔离存档 + fixture 语音的浏览器回归。浏览器触摸模拟不是实体手机验收；合成语音测试不能证明真实环境的回声消除、噪声表现或发热。

## 已知问题

- 交付证据仍需区分实现和验收：3 种表情、2 种非说话动作的可辨识度未逐项确认；实体手机麦克风、帧率、发热与嘈杂环境仍需验收。失败/降级采用单独视频附件，主片本身不含本次补录。

- 中文 ASR 对合成 TTS 测试音频偶有丢句；主片包含真实人声交流，但不足以证明所有口音与噪声环境都正常。
- 回声消除依赖浏览器 AEC；外放 + 嘈杂环境的真机表现未充分验证。
- 新场景首次生成较慢：空间参考图、两次 Seedream 请求、下载、质检、持久化和浏览器预加载串在抵达前；已有缓存或并发合并会快一些，但还没有完成分阶段耗时基线和快路径。
- 角色是 VRoid 官方 `AvatarSample_A` 示例模型，不是定制的拟人 Mira 皮肤；换模只需替换 `assets/mira.vrm` 并保持骨骼/表情命名兼容。
- 二维场景 + 三维人物的透视与画风一致性还需持续调校。
- 自动前景分离/生成已从主流程撤下；默认咖啡馆仍使用已有桌沿前景，新的场景主要依赖底图、事件叠层和程序化角色，不把实验性的前景样例当成通用能力。
- 开放剧情不保证所有长对话无矛盾（有事实记录、过期校验、明确行动检查兜底）。
- 持久恢复依赖同一浏览器的访问凭证和服务端持久盘；清除浏览器数据后暂无账号找回入口。旧相遇会保留，但尚无历史存档选择界面。
- 当前角色动作是程序化 fallback，不是经过动捕清理的 VRMA/Mixamo 成品；生成式图片是 2D 场景板，尚不是可自由走动的完整 3D 空间。
- 可选的 Jev 置信度阈值仍是保守初值，尚未做大样本校准；运行时没有配置 `TYPESAFE_API_KEY` 时自动跳过该层，provider-backed eval 则会明确要求该 key。

## 上线部署

根目录 `Dockerfile` 可直接用于 Railway / Zeabur / Render 等容器平台（自动识别构建）：

- 构建期 `pnpm install --frozen-lockfile && pnpm build`，启动命令 `pnpm start`；平台注入 `PORT`。
- 实例数固定 1（实时连接在进程内存）；`WORLD_DATA_DIR`（默认 `data/worlds`）必须挂持久盘，完整保存 SQLite、WAL 和媒体目录。`cache/` 可用临时盘；需要保留录制时另行持久化 `recordings/`。
- 环境变量：`DOUBAO_API_KEY`、`SEED_API_KEY`；可选 `TYPESAFE_API_KEY` / `TYPESAFE_DEFAULT_MODEL` / `JEV_ENABLED`（语义判断）；`ACCESS_TOKENS`（逗号分隔的访问口令，设置后 `/api/*`、`/media/*`、`/mock/*`、`/ws` 需先凭口令换 cookie）；`WORLD_DATA_DIR`、`MAP_IMAGES`、`MAX_SESSIONS`、`VAD_SMOOTH_MS` 按需调整。
- 平台提供 HTTPS 域名后，手机端麦克风可用。

`GET /api/logs` 与右上角调试入口可查看运行日志；日志含对话内容，仅用于本地开发。

## 投入时间与两周演进

这里把“可核验的日历跨度”和“实际有效工时”分开，不把 AI session 的在线时间冒充连续编码时间：

- 首个 live-demo Devin CLI 工程 session：`2026-09-16 00:26:45`（Asia/Shanghai；原始日志时间为 `2026-09-15T16:26:45Z`）。
- 首次 Git 提交 `ecb9be0`：`2026-09-18 14:50:32`（Asia/Shanghai）。
- 上述两个锚点之间的日历跨度：`62 小时 23 分 47 秒`。其中包含 session 重载、等待、人工反馈和空闲时间，不能表述成 62 小时连续开发。
- 首版实验的原始计划仍是 `72 小时`，对应 `PLAN.md` 的实验预算；它是计划上限，不是实际工时证明。
- 人类/团队实际有效工时：<72h。
- 首版提交之后，`2026-09-18` 至 `2026-09-19` 的历史 session 继续补做部署尝试、工程复核、真实浏览器路线、世界存档和展示录制；这些是后续迭代，不计入“首版 72 小时计划”的实际有效工时。

之后如果继续开发，下面的“两周”是未来 `14 个日历日` 的演进计划，不是已经投入的时间；完整分工和人工纠偏见 `AI_USAGE.md`。

如果继续开发两周：

- **角色**：换拟人 VRM/GLB（Meshy+Blender 管线已验证可插拔）；音素级口型；VRMA/Mixamo 动作库（`motion` 协议层已预留，只换客户端实现）。
- **视频演出**：Seedance/Minimax 来生成关键剧情片段（方舟 key 已实测 1.0–2.5 可用）；全屏片段与常驻角色的衔接、失败降级到现有动画。
- **语音**：回声/噪声真机矩阵测试；附和与真打断的细分策略；首包延迟与关键阶段耗时观测页。
- **场景与媒体**：为新场景建立分阶段耗时基线；预热稳定地点、评估非空间草图场景的单次生成快路径、低清预览/后台清理，并验证不破坏站位和两阶段抵达语义。
- **会话**：在现有 OTLP 诊断导出和世界存档之上增加可分享回放、长期用户事实库和存档选择。
- **工程**：模型/媒体 provider 可替换抽象收拢（目前已走 env 可换）；补齐场景生成阶段 trace、更多端到端自动化测试。
- **评估**：建立分层和分步评估体系，分别评估语音回合、世界提案、照片语义判断、生图质量和客户端可见结果。
- **场景**：探索接入 fal 的 Minimax H3 实时互动，将彻底改写架构。

## 地图与世界存档

进入后打开「足迹」：画布只显示实际到过的地点，可拖动、缩放和选择返回。新地点的地图插画后台生成，失败时用原场景照片占位，不阻塞往返。`MAP_IMAGES=0` 可关闭地图生图调用。当前采用固定坐标的独立区域拼接，尚未实现整张地图的无缝局部重绘。

切换先准备图片，再提交抵达；取消、超时或失败保持原地点。回访读取原背景、前景和环境状态，不重新生成地点。刷新或重启恢复已提交的地点，不恢复半途动作。重新开始创建新世界并保留旧存档。详见 [实现记录](docs/world-implementation.md)。

### Session 诊断导出

页面右上角 **导出诊断** → 选择当前或历史 session → **下载 OTLP JSON**。无需开启 debug 或 `RECORD=1`。从本功能启用后创建的 session 开始常驻记录；不能补回此前未记录的过程。断线重连复用同一 trace，重来创建新 trace，历史记录仍可在原浏览器选择。

导出文件采用 OpenTelemetry 的 [OTLP JSON traces 格式](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)，含 `resourceSpans`、十六进制 trace/span ID、父子关系、纳秒时间戳和状态。实现为本地诊断 journal/exporter，不依赖 OTel SDK，也不自动上传到远端。可直接分析 JSON，或 POST 到 Collector 的 OTLP HTTP `/v1/traces`（`Content-Type: application/json`）。

记录内容：用户输入/ASR、原始 Duplex 文本与工具事件、导演/语义判断的完整输入输出、世界更新接受/拦截原因、过期回合、生成提示词/重试/质检/缓存、媒体下发、浏览器收包/图片加载/转场状态和 ACK。每条 span 的 `mira.data` 属性是 JSON 文本；请求中的 `inProgress: true` 表示导出时尚未结束，错误 span 的 status.code 为 2。通过 context_id、media id、response_id 和父 span 关联异步步骤。`browser.state` 的 bgUrl/sceneTransition 表示客户端状态更新，不等于物理屏幕显示证明。

服务器按所有权令牌的 SHA-256 目录保存到 `recordings/traces/`，不受全局日志 800 条上限影响，重启后仍可读取。当前导出是进行中会话的快照。记录保留完整对话和提示词，但脱敏密钥/所有权令牌/媒体访问参数，省略原始音频与图片二进制（下载结果保存字节数及 SHA-256）。浏览器记录通过 WS 回传，断网期间无法送达的浏览器事件不在服务器记录内。现阶段不自动清理历史目录，需要时手动归档；浏览器清空 mira.ct 后不能再通过页面访问旧令牌的记录。

接口（同时遵循已有站点认证）：`GET /api/diagnostics` 列出本浏览器会话；`GET /api/diagnostics/<traceId>` 导出。两者均需 `x-mira-client-token` 请求头，值为该浏览器的 mira.ct；仅知道 traceId 无权读取。写盘失败时当前导出返回错误，不会把不完整记录声称为完整成功。
