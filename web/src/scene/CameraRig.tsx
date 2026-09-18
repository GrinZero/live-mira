import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../state/store';

// Match the actor to the fixed cafe matte. Keep the face in the left third;
// reserve the right third for a shared object, never zoom the room like wallpaper.
export function CameraRig() {
  const { camera, size } = useThree();
  const settled = useRef(false);
  useFrame((_, dt) => {
    const portrait = size.width / size.height < 0.9;
    const state = useStore.getState();
    const photo = state.photo;
    const outside = state.bgKey !== 'cafe_interior';
    const moving = state.sceneTransition?.phase === 'departing';
    const distance = portrait ? (outside ? 2.15 : 1.85) + (moving ? 0.18 : 0) : outside ? 1.9 : 1.55;
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(20)) * distance;
    const w = (h * size.width) / size.height;
    const actorX = portrait ? (photo ? 0.27 : outside ? 0.34 : 0.39) : 0.34;
    const targetX = (0.5 - actorX) * w;
    if (!settled.current) {
      settled.current = true;
      camera.position.set(targetX, 1.06, distance);
      camera.lookAt(targetX, 1.06, 0);
      return;
    }
    const d = Math.min(dt, 0.05);
    camera.position.x = THREE.MathUtils.damp(camera.position.x, targetX, 3, d);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, 1.06, 3, d);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, distance, 3, d);
    camera.lookAt(camera.position.x, 1.06, 0);
  });
  return null;
}
