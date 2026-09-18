import { useStore } from '../state/store';

export function SceneJourney() {
  const transition = useStore((s) => s.sceneTransition);
  if (!transition || transition.phase === 'preparing') return null;
  return (
    <div
      key={`${transition.id}-${transition.phase}`}
      className={`scene-journey ${transition.phase}`}
      aria-hidden="true"
    />
  );
}
