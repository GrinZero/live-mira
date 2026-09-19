import { isStagedScene } from '../../../shared/scene-layout';
import { Suspense, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { VrmActor } from './VrmActor';
import { CameraRig } from './CameraRig';
import { useStore } from '../state/store';
import type { CharacterActor } from './actor';

// 灯光随剧情联动：暖琥珀主光（室内）+ 冷蓝轮廓光（窗外雨夜）
const _lightColor = new THREE.Color();
function Lights() {
  const warm = useRef<THREE.PointLight>(null);
  const cool = useRef<THREE.DirectionalLight>(null);
  const amb = useRef<THREE.AmbientLight>(null);
  const fx = useStore((s) => s.fx);
  const outside = useStore((s) => s.bgKey !== 'cafe_interior');
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    const dim = 1 - fx.dim * 0.72;
    // 室外没有咖啡馆那盏琥珀灯：主光换成冷调月色/街灯，她才不会像被室内光贴着
    if (warm.current) {
      warm.current.intensity = THREE.MathUtils.damp(warm.current.intensity, (outside ? 1.1 : 4.5) * dim, 4, d);
      warm.current.color.lerp(_lightColor.set(outside ? '#8d9cc4' : '#ffb35c'), Math.min(1, 4 * d));
    }
    if (amb.current) {
      amb.current.intensity = THREE.MathUtils.damp(amb.current.intensity, 0.5 * (1 - fx.dim * 0.5), 4, d);
      amb.current.color.lerp(_lightColor.set(outside ? '#48587c' : '#5a6a8c'), Math.min(1, 4 * d));
    }
    if (cool.current) {
      cool.current.intensity = THREE.MathUtils.damp(
        cool.current.intensity,
        (outside ? 2.6 : 1.6) + fx.rain * 0.5,
        4,
        d,
      );
      cool.current.color.lerp(_lightColor.set(outside ? '#6f9fd8' : '#4a6db3'), Math.min(1, 4 * d));
    }
  });
  return (
    <>
      <ambientLight ref={amb} intensity={0.5} color="#5a6a8c" />
      <pointLight ref={warm} position={[0.6, 2.2, 1.3]} intensity={4.5} color="#ffb35c" distance={7} decay={2} />
      <directionalLight ref={cool} position={[-1.4, 1.6, -1.5]} intensity={1.8} color="#4a6db3" />
      <directionalLight position={[0.9, 1.2, 1.8]} intensity={0.3} color="#ffe0b8" />
    </>
  );
}

// 闪电：lightning flag → 环境光短促爆闪
function LightningLight() {
  const flash = useRef<THREE.PointLight>(null);
  const fx = useStore((s) => s.fx);
  const tRef = useRef(-1);
  useFrame((_, dt) => {
    if (!flash.current) return;
    if (fx.lightning > 0 && tRef.current < 0) tRef.current = 0;
    if (tRef.current >= 0) {
      tRef.current += dt;
      const t = tRef.current;
      const pulse =
        t < 0.12 ? t / 0.12 : t < 0.3 ? 0.25 : t < 0.45 ? (t - 0.3) / 0.15 : Math.max(0, 1 - (t - 0.45) / 0.5);
      flash.current.intensity = pulse * 60;
      if (t > 1) {
        tRef.current = -1;
        flash.current.intensity = 0;
        useStore.setState((s) => ({ fx: { ...s.fx, lightning: 0 } }));
      }
    }
  });
  return <pointLight ref={flash} position={[0, 2.5, -2]} intensity={0} color="#cfe0ff" distance={12} />;
}

export const actorRef: { current: CharacterActor | null } = { current: null };

export function Stage() {
  const staged = useStore((s) => isStagedScene(s.bgUrl));
  const ready = useStore((s) => s.modelReady);
  return (
    <Canvas
      camera={{ position: [0.1, 1.35, 2.05], fov: 40, near: 0.05, far: 30 }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.0;
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        opacity: ready ? 1 : 0,
        transition: 'opacity 0.8s ease',
        filter: staged ? 'none' : 'drop-shadow(0 10px 16px rgba(4,8,14,.30)) drop-shadow(2px 2px 2px rgba(3,6,10,.18))',
      }}
    >
      <CameraRig />
      <Lights />
      <LightningLight />
      <Suspense fallback={null}>
        <VrmActor actorRef={actorRef} />
      </Suspense>
    </Canvas>
  );
}
