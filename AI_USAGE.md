# AI 使用说明

本项目由 AI 编程助手（Devin / SWE-2）在单一会话内完成主体实现，
人类提供了 PLAN.md 方向、内容层文案基调要求和验收标准。

## AI 参与了什么

- **架构落地**：浏览器 React/R3F 呈现层 ⇄ Node 服务端 ⇄ 豆包 Duplex 的三方编排；
  四队列客户端状态机、epoch 打断守卫、服务端↔客户端双 VAD 打断路径。
- **协议探针**：`explore/probe_duplex*.py` 是 AI 写的试错脚本——先用小探针把
  Duplex 的握手、`speech_text_buffer.commit`、工具调用回传、`input_audio_mute.commit`
  保活、`session.close` 全部实测清楚，再开始写正式代码。
- **内容工程**：`content/` 五个文件（人设卡、导演提示词、事件池、台词、风格模板）
  由 AI 起草并按"留白型秘密"原则设计：只给暗示道具，不给答案。
- **资产管线**：VRM 选型与姿态调校、Seedream 风格模板、ffmpeg 程序化环境音合成、
  MediaPipe FaceLandmarker（`@mediapipe/tasks-vision` + `face_landmarker.task`，
  Google 官方模型，摄像头人脸追踪全部在本地推理，画面不上传）驱动的"对视"视线追踪。
- **观测与回放**：服务端环形日志、录制器（`RECORD=1`）、回放包构建、MockTransport。

## AI 犯的错与人工/实测纠正

> 以下每一条都来自真实测试暴露的问题，不是臆测：

1. **VRM 资产 URL 臆造**：AI 最初猜的 GitHub 路径返回 404（还差点把 107B 的
   错误页当模型用）。纠正：改用 GitHub API 枚举仓库树，定位到
   `vrm-c/vrm-specification/samples/Seed-san` 并校验文件大小。
2. **生图尺寸被 API 拒绝**：`2016x1152` 低于 Seedream 4.5 最小像素数
   （3,686,400）。纠正：实测后改 `2560x1440`，并把尺寸提取为环境变量。
3. **导演输出不可解析**：LLM 偶尔返回非法 JSON、枚举外中文、括号舞台词。
   纠正：`parseDecision` 花括号配对提取 + `parseDirective` 枚举白名单 +
   中文关键词归一表 + `stripStage` 剥离括号文本（含 "a|b" 管道符容错）。
4. **打断"没生效"（最大的一个坑）**：首轮打断测试失败——排查发现 Duplex
   下行音频是**突发式**下发（3.5s 语音 450ms 内发完），`output_audio.done`
   到达时她其实还在"说"。如果按 done 就翻回倾听状态，打断窗口会被提前关闭。
   纠正：客户端按播放缓冲耗尽时刻切换状态；服务端在 done 后保留 6s 打断
   宽限窗。教训：流式协议的"事件完成"≠"用户感知完成"。
5. **npm 依赖地狱**：R3F/Drei 与 React 19.3 的 peer 约束冲突。纠正：锁定
   `react@~19.2` 兼容区间。
6. **ffmpeg 编码器名臆造**：`libvorbis` 在本机 ffmpeg 不存在。纠正：枚举
   `-encoders` 后回退 `libopus`/`vorbis`/`aac`。
7. **剧情节拍不稳定**：事件注入全靠导演 LLM 抽签时，"掏照片"这个关键演示
   节拍经常不发生。纠正：给 `or_user_asks` 加确定性触发通道（关键词命中即
   注入），并加 `photoArmed` 兜底——演员没自发调 `show_photo` 时服务端代触发。
8. **Playwright 参数解析**：`has()` 对 `--flag` 前缀处理错误导致截图参数
   被吞。纠正：统一 `argv.includes('--k')` 与 `arg()` 取值约定。

## 人工仍需注意的边界

- 中文 ASR 对合成 TTS 测试音频偶有丢句；真实人声正常。
- Seed-san 是机械臂设定的示例模型，不是拟人皮；换装/换模只需替换
  `assets/mira.vrm` 并保持骨骼/表情命名兼容（VRM 标准）。
- `.env` 不入库（`.gitignore` 已加），回放包 `web/public/mock/` 可入库。
