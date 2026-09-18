import { Component, type ReactNode } from 'react';

// A failed model download must not take the whole conversation down.
export class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <button className="scene-retry" onClick={() => location.reload()}>
          角色画面暂时没载入，点此重新连接
        </button>
      );
    return this.props.children;
  }
}
