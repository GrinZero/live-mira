import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { authStatus, authLogin } from '../net/auth';

// 进场页：标题 + 口令（服务端开启 ACCESS_TOKENS 时）+ 轻触进入（同时解锁 AudioContext / 麦克风）
export function EnterOverlay({
  onEnter,
  ready,
  starting,
  mock,
}: {
  onEnter: (freshWorld: boolean) => void;
  ready: boolean;
  starting: boolean;
  mock: boolean;
}) {
  const sessionId = useStore((s) => s.sessionId);
  const [hasSavedStory, setHasSavedStory] = useState(false);
  const [checkingStory, setCheckingStory] = useState(true);
  const [storyError, setStoryError] = useState(false);
  const [retry, setRetry] = useState(0);
  const toast = useStore((s) => s.toast);
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void authStatus().then((s) => setNeedCode(s.required && !s.ok));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCheckingStory(true);
    setStoryError(false);
    const check = async () => {
      const token = localStorage.getItem('mira.ct');
      if (mock || !token) return false;
      const response = await fetch('/api/story', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_token: token }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('story unavailable');
      return Boolean((await response.json()).exists);
    };
    void check()
      .then((exists) => {
        if (!cancelled) setHasSavedStory(exists);
      })
      .catch(() => {
        if (!cancelled) setStoryError(true);
      })
      .finally(() => {
        if (!cancelled) setCheckingStory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mock, sessionId, needCode, retry]);

  const submit = async () => {
    const t = code.trim();
    if (!t || checking) return;
    setChecking(true);
    setErr('');
    const ok = await authLogin(t);
    setChecking(false);
    if (!ok) {
      setErr('口令不对，再试一次');
      return;
    }
    setNeedCode(false); // 回到"轻触进入"：audio 解锁需要真实点击手势，不能隔着 await 自动进入
  };

  return (
    <div className="enter-overlay">
      <div className="enter-rain" />
      <div className="enter-card">
        <div className="enter-title">雨夜 · 咖啡馆</div>
        <div className="enter-sub">一张空椅子，一场没约好的相遇。</div>
        {needCode ? (
          <>
            <input
              className="enter-code"
              type="password"
              placeholder="口令"
              value={code}
              autoFocus
              autoComplete="off"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            <div>
              <button className="enter-btn" onClick={() => void submit()} disabled={!code.trim() || checking}>
                {checking ? '验证中…' : '进 门'}
              </button>
            </div>
            {err && <div className="enter-toast">{err}</div>}
          </>
        ) : (
          <div className="enter-actions">
            <button
              className="enter-btn"
              onClick={() => onEnter(!hasSavedStory)}
              disabled={!ready || checkingStory || storyError}
            >
              {starting
                ? '连接中…'
                : checkingStory
                  ? '读取进度…'
                  : !ready
                    ? '加载中…'
                    : hasSavedStory
                      ? '继续上次'
                      : '开始新故事'}
            </button>
            {storyError && (
              <button className="enter-new" onClick={() => setRetry((n) => n + 1)}>
                进度读取失败，点击重试
              </button>
            )}
            {hasSavedStory && (
              <>
                <button
                  className="enter-new"
                  onClick={() => onEnter(true)}
                  disabled={!ready || checkingStory || storyError}
                >
                  开始新故事
                </button>
                <div className="enter-new-hint">从咖啡馆重新开始，重置本次对话与足迹</div>
              </>
            )}
          </div>
        )}
        <div className="enter-hint">
          {needCode
            ? '这间咖啡馆需要口令'
            : mock
              ? '回放模式 · 录制事件流'
              : '戴上耳机 · 允许麦克风和摄像头 · 她会看见你（右上角可关）'}
        </div>
        {toast && <div className="enter-toast">{toast}</div>}
      </div>
    </div>
  );
}
