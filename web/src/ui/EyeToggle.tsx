import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { eyeContact } from '../vision/eyeContact';

// "对视"开关：摄像头人脸追踪 → 她的眼睛跟着你。
// 画面只在本地推理，不上传不显示；拒绝/不支持时给一句她语气的解释。
export function EyeToggle() {
  const eye = useStore((s) => s.eye);
  const tracking = useStore((s) => s.eyeTracking);
  const toastTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const say = (msg: string) => {
    const set = useStore.getState().set;
    set({ toast: msg });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      if (useStore.getState().toast === msg) set({ toast: '' });
    }, 3200);
  };

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (eye === 'starting') return;
    // 对视默认开：手动关过一次就记住，之后进场不再自动申请摄像头
    if (eye === 'on') {
      eyeContact.disable();
      localStorage.setItem('mira.eye', 'off');
      return;
    }
    try {
      await eyeContact.enable();
      localStorage.setItem('mira.eye', 'on');
      say('摄像头已开启，请让脸进入画面');
    } catch {
      const s = eyeContact.state;
      say(
        s === 'denied'
          ? '摄像头被关上了，她只好想象你的样子'
          : s === 'unsupported'
            ? '这个浏览器开不了摄像头'
            : '没能看见你，再点一次试试',
      );
    }
  };

  return (
    <button
      className={`eye-toggle ${eye}`}
      onClick={toggle}
      title="让她看见你：摄像头画面只在本机做人脸追踪"
      aria-pressed={eye === 'on'}
    >
      {eye === 'on'
        ? tracking
          ? '正在跟随'
          : '寻找人脸…'
        : eye === 'starting'
          ? '开启中…'
          : eye === 'denied'
            ? '摄像头未授权'
            : eye === 'error'
              ? '追踪失败 · 重试'
              : eye === 'unsupported'
                ? '摄像头不可用'
                : '对视'}
    </button>
  );
}
