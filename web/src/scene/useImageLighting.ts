import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';

// Four broad, linear-light image samples. The shader uses view-space normals,
// so left/right/up/down stay registered to the photograph as Mira turns.
const DECLARATIONS = `
uniform vec3 miraImageLeft;
uniform vec3 miraImageRight;
uniform vec3 miraImageUp;
uniform vec3 miraImageDown;
uniform float miraImageStrength;
`;
const ANCHOR = '// -- MToon: Emission';
const LIGHTING = `
#ifndef OUTLINE
  vec3 imageNormal = normalize(normal);
  vec4 imageWeights = vec4(
    max(0.0, -imageNormal.x), max(0.0, imageNormal.x),
    max(0.0, imageNormal.y), max(0.0, -imageNormal.y)
  ) + vec4(0.25);
  imageWeights /= dot(imageWeights, vec4(1.0));
  vec3 imageLight = miraImageLeft * imageWeights.x
    + miraImageRight * imageWeights.y
    + miraImageUp * imageWeights.z + miraImageDown * imageWeights.w;
  float imageLuma = dot(imageLight, vec3(0.2126, 0.7152, 0.0722));
  vec3 imageTint = clamp(imageLight / max(imageLuma, 0.025), vec3(0.55), vec3(1.6));
  // Preserve albedo and the existing toon shading; limit exposure adaptation.
  float imageExposure = mix(0.78, 1.10, smoothstep(0.025, 0.5, imageLuma));
  col *= mix(vec3(1.0), mix(vec3(1.0), imageTint, 0.22) * imageExposure, miraImageStrength);
  float imageEdge = pow(1.0 - clamp(abs(dot(imageNormal, normalize(vViewPosition))), 0.0, 1.0), 4.0);
  // At most 2.5% linear-light wrap. Dark surroundings cannot create a halo.
  col += imageLight * imageEdge * (0.025 * miraImageStrength);
#endif
`;
const GRID = 64;
type ImageGrid = { pixels: Float32Array; rect: DOMRect; opacity: number };

function pixelsFor(image: HTMLImageElement): Float32Array | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = GRID;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(image, 0, 0, GRID, GRID);
    const rgba = ctx.getImageData(0, 0, GRID, GRID).data;
    const pixels = new Float32Array(GRID * GRID * 3);
    const color = new THREE.Color();
    for (let i = 0; i < GRID * GRID; i++) {
      color.setRGB(rgba[i * 4] / 255, rgba[i * 4 + 1] / 255, rgba[i * 4 + 2] / 255, THREE.SRGBColorSpace);
      pixels.set([color.r, color.g, color.b], i * 3);
    }
    return pixels;
  } catch {
    // Missing/CORS-protected imagery keeps the original lighting usable.
    return null;
  }
}

function sample(grid: ImageGrid, x: number, y: number, result: THREE.Color) {
  const u = ((x - grid.rect.left) / grid.rect.width) * (GRID - 1);
  const v = ((y - grid.rect.top) / grid.rect.height) * (GRID - 1);
  result.setRGB(0, 0, 0);
  // A broad box blur in source-image coordinates removes furniture/texture detail.
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const ix = THREE.MathUtils.clamp(Math.round(u + dx), 0, GRID - 1);
      const iy = THREE.MathUtils.clamp(Math.round(v + dy), 0, GRID - 1);
      const i = (iy * GRID + ix) * 3;
      result.r += grid.pixels[i];
      result.g += grid.pixels[i + 1];
      result.b += grid.pixels[i + 2];
    }
  }
  result.multiplyScalar(1 / 121);
}

export function useImageLighting(vrm: VRM) {
  const state = useMemo(
    () => ({
      uniforms: {
        miraImageLeft: { value: new THREE.Color() },
        miraImageRight: { value: new THREE.Color() },
        miraImageUp: { value: new THREE.Color() },
        miraImageDown: { value: new THREE.Color() },
        miraImageStrength: { value: 0 },
      },
      targets: Array.from({ length: 4 }, () => new THREE.Color()),
      materials: new Set<THREE.ShaderMaterial>(),
      cache: new WeakMap<HTMLImageElement, { src: string; pixels: Float32Array | null }>(),
      head: new THREE.Vector3(),
      hips: new THREE.Vector3(),
      scratch: new THREE.Color(),
      elapsed: 1,
      available: false,
      enabled: true,
    }),
    [],
  );

  useEffect(() => {
    const materials = new Set<THREE.Material>();
    vrm.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if ((material as THREE.Material & { isMToonMaterial?: boolean }).isMToonMaterial) materials.add(material);
        }
      }
    });
    const restore = [...materials].map((material) => {
      state.materials.add(material as THREE.ShaderMaterial);
      const compile = material.onBeforeCompile;
      const cacheKey = material.customProgramCacheKey;
      material.onBeforeCompile = (shader, renderer) => {
        compile.call(material, shader, renderer);
        if (!shader.fragmentShader.includes(ANCHOR)) {
          console.warn('Mira image lighting: unsupported MToon shader; keeping original material.');
          return;
        }
        Object.assign(shader.uniforms, state.uniforms);
        shader.fragmentShader = DECLARATIONS + shader.fragmentShader.replace(ANCHOR, LIGHTING + '\n' + ANCHOR);
      };
      material.customProgramCacheKey = () => cacheKey.call(material) + ':mira-image-lighting-v1';
      material.needsUpdate = true;
      return () => {
        state.materials.delete(material as THREE.ShaderMaterial);
        material.onBeforeCompile = compile;
        material.customProgramCacheKey = cacheKey;
        material.needsUpdate = true;
      };
    });
    return () => restore.forEach((fn) => fn());
  }, [vrm, state]);

  useFrame(({ camera, gl }, dt) => {
    state.elapsed += dt;
    if (state.elapsed >= 0.1) {
      state.elapsed = 0;
      state.enabled = new URLSearchParams(location.search).get('imageLighting') !== 'off';
      const images = [...document.querySelectorAll<HTMLImageElement>('.room-matte > img')];
      const grids: ImageGrid[] = [];
      for (const image of images) {
        if (!image.complete || !image.naturalWidth) continue;
        let cached = state.cache.get(image);
        if (!cached || cached.src !== image.currentSrc) {
          cached = { src: image.currentSrc, pixels: pixelsFor(image) };
          state.cache.set(image, cached);
        }
        const rect = image.getBoundingClientRect();
        if (cached.pixels && rect.width > 0 && rect.height > 0) {
          grids.push({ pixels: cached.pixels, rect, opacity: Number(getComputedStyle(image).opacity) });
        }
      }
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      const hips = vrm.humanoid.getNormalizedBoneNode('hips');
      state.available = grids.length > 0 && !!head && !!hips;
      if (state.available && head && hips) {
        head.getWorldPosition(state.head).project(camera);
        hips.getWorldPosition(state.hips).project(camera);
        const viewport = gl.domElement.getBoundingClientRect();
        const x = viewport.left + ((state.head.x + state.hips.x) * 0.25 + 0.5) * viewport.width;
        const y = viewport.top + (0.5 - (state.head.y + state.hips.y) * 0.25) * viewport.height;
        const radius = Math.max(24, Math.abs(state.head.y - state.hips.y) * viewport.height * 0.5);
        const offsets = [
          [-radius * 0.65, 0],
          [radius * 0.65, 0],
          [0, -radius * 0.7],
          [0, radius * 0.7],
        ];
        offsets.forEach(([dx, dy], index) => {
          grids.forEach((grid, layer) => {
            sample(grid, x + dx, y + dy, state.scratch);
            if (layer === 0) state.targets[index].copy(state.scratch);
            else state.targets[index].lerp(state.scratch, grid.opacity);
          });
        });
      }
    }
    const blend = 1 - Math.exp(-Math.min(dt, 0.05) * 3);
    const uniforms = state.uniforms;
    [uniforms.miraImageLeft, uniforms.miraImageRight, uniforms.miraImageUp, uniforms.miraImageDown].forEach(
      (uniform, index) => uniform.value.lerp(state.targets[index], blend),
    );
    // Query switch supports same-view comparisons without changing scene settings.
    uniforms.miraImageStrength.value = THREE.MathUtils.lerp(
      uniforms.miraImageStrength.value,
      state.available && state.enabled ? 1 : 0,
      blend,
    );
    // MToon shares GPU programs between submeshes. Upload even when bone/UV
    // animation is paused; lighting is independent of the actor's animation tick.
    state.materials.forEach((material) => (material.uniformsNeedUpdate = true));
  });
}
