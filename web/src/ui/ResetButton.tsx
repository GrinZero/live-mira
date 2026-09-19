import { useEffect, useRef, useState } from 'react';

// "重来"：结束这场相遇，回到雨夜开始——服务端旧会话销毁、新会话就位，
// 本地画面/字幕/剧情全部归零。两击确认防误触（故事无法回滚）。
export function ResetButton({ onReset }: { onReset: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm) {
      setConfirm(true);
      timer.current = window.setTimeout(() => setConfirm(false), 3000);
      return;
    }
    window.clearTimeout(timer.current);
    setConfirm(false);
    void onReset();
  };

  return (
    <button
      className={`reset-btn ${confirm ? 'confirm' : ''}`}
      onClick={onClick}
      title="结束这场相遇，回到雨夜开始"
      aria-label="重新开始"
    >
      {confirm ? '确定重来？' : '重来'}
    </button>
  );
}
