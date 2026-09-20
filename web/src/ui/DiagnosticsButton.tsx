import './DiagnosticsButton.css';
import { useState } from 'react';
import { currentTraceId, diagnosticsRequest } from '../net/diagnostics';

export function DiagnosticsButton() {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<{ id: string; updatedAt: number }[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function show() {
    setOpen(true);
    setBusy(true);
    setError('');
    try {
      const list = (await (await diagnosticsRequest()).json()) as typeof sessions;
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      setSessions(list);
      setSelected(currentTraceId() || list[0]?.id || '');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError('');
    try {
      const response = await diagnosticsRequest(`/${selected}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `mira-session-${selected}.otlp.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="reset-btn"
        onClick={(e) => {
          e.stopPropagation();
          void show();
        }}
      >
        导出诊断
      </button>
      {open && (
        <div
          className="diagnostics-panel"
          role="dialog"
          aria-label="导出 session 诊断"
          style={{
            position: 'fixed',
            top: 70,
            right: 16,
            maxWidth: 'calc(100vw - 32px)',
            padding: 20,
            background: '#211e1b',
            color: '#fff',
            borderRadius: 12,
            zIndex: 1000,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <p>导出整场对话与场景链路</p>
          <select
            aria-label="选择 session"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{ maxWidth: '100%' }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {new Date(s.updatedAt).toLocaleString()} · {s.id.slice(0, 8)}
                {s.id === currentTraceId() ? '（当前）' : ''}
              </option>
            ))}
          </select>
          <p style={{ fontSize: 12 }}>包含对话、模型提示词和决策记录。当前会话导出到点击时为止。</p>
          {!busy && !sessions.length && <p>暂无记录；启用此功能后的会话会自动保存。</p>}
          {error && <p role="alert">{error}</p>}
          <button className="reset-btn" disabled={busy || !selected} onClick={() => void download()}>
            {busy ? '读取中…' : '下载 OTLP JSON'}
          </button>{' '}
          <button className="reset-btn" onClick={() => setOpen(false)}>
            关闭
          </button>
        </div>
      )}
    </>
  );
}
