import { isStagedScene, companionFrame, layoutFromUrl } from '../../../shared/scene-layout';
import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../state/store';
import { stagingFor } from './staging';

// Match the actor to the fixed cafe matte. Keep the face in the left third;
// reserve the right third for a shared object, never zoom the room like wallpaper.
// Calibrated destinations use the same close-up crop as the photograph.
export function CameraRig() {
  const { camera, size } = useThree();
  const settled = useRef(false);
  const sceneKey = useRef('');
  const lookY = useRef(1.06);
  useFrame((_, dt) => {
    const portrait = size.width / size.height < 0.9;
    const state = useStore.getState();
    const photo = state.photo;
    const st = stagingFor(state.bgKey, state.bgUrl);
    // A static photograph cannot follow a dolly. Keep its calibrated framing;
    // switch to the destination framing only while the transition covers the cut.
    let distance = portrait ? st.distance.portrait : st.distance.landscape;
    let targetLookY = st.lookY;
    const frame = isStagedScene(state.bgUrl)
      ? companionFrame(size.width, size.height, layoutFromUrl(state.bgUrl))
      : null;
    if (frame) {
      // Standing VRM is approximately 1.65m; feet include the standing root offset.
      const visibleWorldHeight = 1.65 / frame.actorHeight;
      distance = visibleWorldHeight / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
      targetLookY = st.groundY + 0.16 + (frame.footY - 0.5) * visibleWorldHeight;
    }
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(20)) * distance;
    const w = (h * size.width) / size.height;
    const actorX = frame?.actorX ?? (portrait ? (photo ? 0.27 : st.actorX.portrait) : st.actorX.landscape);
    const targetX = (0.5 - actorX) * w;
    const identity = `${state.bgKey}:${state.bgUrl}:${size.width}:${size.height}`;
    if (!settled.current || sceneKey.current !== identity) {
      sceneKey.current = identity;
      settled.current = true;
      lookY.current = targetLookY;
      camera.position.set(targetX, targetLookY, distance);
      camera.lookAt(targetX, targetLookY, 0);
      return;
    }
    const d = Math.min(dt, 0.05);
    lookY.current = THREE.MathUtils.damp(lookY.current, targetLookY, 3, d);
    camera.position.x = THREE.MathUtils.damp(camera.position.x, targetX, 3, d);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, lookY.current, 3, d);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, distance, 3, d);
    camera.lookAt(camera.position.x, lookY.current, 0);
  });
  return null;
}
