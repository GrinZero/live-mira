import { Suspense, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../state/store';

// GPU 雨幕：两层着色器实现
// 1) RainStreaks — InstancedBufferGeometry 雨丝，顶点着色器驱动下落/风斜/景深衰减，零 CPU 逐帧更新
// 2) RainGlass  — "雨打玻璃"折射层：网格雨滴滑落扭曲背景（Heartfelt 式），附凝雾
// 密度/强度统一随 fx.rain（0.12 雨停 / 1 常态 / 1.6 暴雨）

const STREAKS = 3600;
const BOX = { minX: -3.4, minY: -0.35, minZ: -2.35, w: 6.8, h: 3.1, d: 3.75 };

const streakVert = /* glsl */ `
  attribute vec4 aInfo; // x,y,z 随机种子 + w 密度阈值
  uniform float uTime;
  uniform float uIntensity;
  uniform float uWind;
  varying vec2 vUv;
  varying float vFade;
  const vec3 BMIN = vec3(${BOX.minX}, ${BOX.minY}, ${BOX.minZ});
  const vec3 BSZ  = vec3(${BOX.w}, ${BOX.h}, ${BOX.d});

  void main() {
    float speed = mix(2.2, 5.6, aInfo.y);
    float len = mix(0.10, 0.34, aInfo.y) * (0.75 + speed * 0.06);
    float w = mix(0.0028, 0.0085, aInfo.w);
    // 下落 wrap + 随风横向漂移（远层漂移小，近层大）
    float y = mod(aInfo.y * BSZ.y - uTime * speed, BSZ.y) + BMIN.y;
    float depth = aInfo.z;
    float drift = uWind * (BSZ.y - (y - BMIN.y)) * (0.10 + depth * 0.22);
    float x = BMIN.x + mod(aInfo.x * BSZ.x + drift, BSZ.x);
    float z = BMIN.z + depth * BSZ.z;

    vec3 dir = normalize(vec3(uWind * 0.30, -1.0, 0.0));
    vec3 base = vec3(x, y, z);
    // 竖直轴向公告板：streak 始终绕下落方向面向相机
    vec3 toCam = cameraPosition - base;
    toCam.y = 0.0;
    vec3 right = normalize(cross(dir, normalize(toCam + vec3(1e-4))));
    vec3 pos = base + right * (position.x * w) + dir * (position.y * len);

    vUv = uv;
    float depthK = smoothstep(0.0, 1.0, depth);
    vFade = mix(0.22, 1.0, depthK);
    // 密度软门限：强度升高时更多实例淡入
    vFade *= smoothstep(aInfo.w - 0.02, aInfo.w + 0.06, uIntensity);
    // 盒顶/底软裁切
    vFade *= smoothstep(0.0, 0.12, y - BMIN.y) * smoothstep(0.0, 0.25, BMIN.y + BSZ.y - y);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const streakFrag = /* glsl */ `
  precision highp float;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    float ax = 1.0 - abs(vUv.x - 0.5) * 2.0;
    // 头亮尾淡：vUv.y=1 为下落前端
    float taper = smoothstep(0.0, 0.5, vUv.y) * (0.35 + 0.65 * vUv.y);
    float a = ax * ax * taper * vFade * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vec3(0.62, 0.72, 0.90), a);
  }
`;

function RainStreaks() {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const geo = useMemo(() => {
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.attributes.position = quad.attributes.position;
    g.attributes.uv = quad.attributes.uv;
    const info = new Float32Array(STREAKS * 4);
    for (let i = 0; i < STREAKS; i++) {
      info[i * 4] = Math.random();
      info[i * 4 + 1] = Math.random();
      info[i * 4 + 2] = Math.pow(Math.random(), 0.62); // 密度偏向远层
      info[i * 4 + 3] = Math.random();
    }
    g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
    g.instanceCount = STREAKS;
    return g;
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 0.6 },
      uWind: { value: 0.6 },
      uOpacity: { value: 0.55 },
    }),
    [],
  );

  const rain = useStore((s) => s.fx.rain);
  useFrame((_, dt) => {
    const u = uniforms;
    u.uTime.value += Math.min(dt, 0.05);
    const t = u.uTime.value;
    const target = Math.min(1, Math.max(0, rain / 1.6));
    u.uIntensity.value = THREE.MathUtils.damp(u.uIntensity.value, target, 4, dt);
    // 阵风：慢起伏
    u.uWind.value = 0.45 + Math.sin(t * 0.23) * 0.2 + Math.sin(t * 0.61 + 2.0) * 0.12;
    u.uOpacity.value = THREE.MathUtils.damp(u.uOpacity.value, 0.34 + target * 0.34, 4, dt);
  });

  return (
    <mesh geometry={geo} renderOrder={4} frustumCulled={false}>
      <shaderMaterial
        ref={mat}
        vertexShader={streakVert}
        fragmentShader={streakFrag}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </mesh>
  );
}

// ---- 雨打玻璃：网格化滑落雨滴折射背景（灵感源自 Heartfelt 雨窗） ----
const glassVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const glassFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uBg;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uAspect;
  uniform float uDim;
  varying vec2 vUv;

  float hashN(float t) { return fract(sin(t * 3456.78) * 7412.35); }
  float saw(float b, float t) { return smoothstep(0.0, b, t) * smoothstep(1.0, b, t); }

  // 单层：主雨滴 + 尾迹 + 静态小滴
  vec2 dropLayer(vec2 uv, float t) {
    vec2 UV = uv;
    uv.y += t * 0.72;
    vec2 grid = vec2(6.0, 1.0) * 2.0;
    vec2 id = floor(uv * grid);
    uv.y += hashN(id.x);
    id = floor(uv * grid);
    vec3 n = fract(sin(vec3(id.x * 35.2, id.y * 376.1, (id.x + id.y) * 54.7)) * vec3(3476.45, 2365.42, 2214.63));
    vec2 st = fract(uv * grid) - vec2(0.5, 0.0);

    float x = n.x - 0.5;
    float yy = UV.y * 20.0;
    float wiggle = sin(yy + sin(yy));
    x += wiggle * (0.5 - abs(x)) * (n.z - 0.5);
    x *= 0.7;
    float ti = fract(t + n.z);
    yy = (saw(0.85, ti) - 0.5) * 0.9 + 0.5;
    vec2 p = vec2(x, yy);
    float d = length((st - p) * vec2(1.0, 2.0));
    float mainDrop = smoothstep(0.32, 0.0, d);

    float r = sqrt(smoothstep(1.0, yy, st.y));
    float cd = abs(st.x - x);
    float trail = smoothstep(0.23 * r, 0.15 * r * r, cd);
    float trailFront = smoothstep(-0.02, 0.02, st.y - yy);
    trail *= trailFront * r * r;

    float dd = length(st - vec2(x, fract(UV.y * 10.0) + (st.y - 0.5)));
    float droplets = smoothstep(0.28, 0.0, dd) * trailFront * n.z;
    float m = mainDrop + droplets * r * trailFront;
    return vec2(m, trail);
  }

  // 静态凝雾小滴
  float staticDrops(vec2 uv, float t) {
    vec2 id = floor(uv * vec2(30.0, 60.0));
    float n = fract(sin(id.x * 71.3 + id.y * 311.7) * 43758.5);
    vec2 st = fract(uv * vec2(30.0, 60.0)) - 0.5;
    float d = length(st * (1.0 + n));
    float blink = 0.75 + 0.25 * sin(t * 0.5 + n * 40.0);
    return smoothstep(0.28 * n, 0.0, d) * step(0.82, n) * blink;
  }

  void main() {
    vec2 uv = vUv;
    uv.x *= uAspect;
    float t = uTime * 0.24;
    vec2 d1 = dropLayer(uv * 1.0, t);
    vec2 d2 = dropLayer(uv * 1.85 + 6.7, -t * 1.3);
    float drops = d1.x + d2.x;
    float trails = d1.y + d2.y;
    float micro = staticDrops(uv, uTime);
    float c = smoothstep(0.25, 1.2, drops + micro * 0.8);

    // 折射偏移：尾迹把背景向下拖，滴体局部放大
    vec2 off = vec2(trails * 0.012, trails * 0.03 + c * 0.015);
    vec3 col = texture2D(uBg, vUv + off).rgb;
    // 凝雾：非滴区域轻微失焦泛白
    float fog = (1.0 - c) * 0.10 * uIntensity;
    col = mix(col, vec3(dot(col, vec3(0.33))) * vec3(0.75, 0.85, 1.05) + 0.06, fog);
    // 滴体高光
    col += c * vec3(0.10, 0.14, 0.20) + micro * vec3(0.10, 0.13, 0.18);
    col *= 1.0 - uDim * 0.55;
    gl_FragColor = vec4(col, 1.0);
  }
`;

function RainGlass() {
  const bgUrl = useStore((s) => s.bgUrl);
  const overlay = useStore((s) => s.overlay);
  // 折射采样当前可见画面：overlay（生成变体）存在时透过它看
  const tex = useLoader(THREE.TextureLoader, overlay?.url ?? bgUrl);
  const { size } = useThree();
  useMemo(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
  }, [tex]);

  const uniforms = useMemo(
    () => ({
      uBg: { value: tex },
      uTime: { value: 0 },
      uIntensity: { value: 0.6 },
      uAspect: { value: 1 },
      uDim: { value: 0 },
    }),
    [],
  );
  uniforms.uBg.value = tex;

  const fx = useStore((s) => s.fx);
  useFrame((_, dt) => {
    const u = uniforms;
    u.uTime.value += Math.min(dt, 0.05);
    u.uIntensity.value = THREE.MathUtils.damp(u.uIntensity.value, Math.min(1, fx.rain / 1.6), 4, dt);
    u.uAspect.value = size.width / size.height;
    u.uDim.value = THREE.MathUtils.damp(u.uDim.value, fx.dim, 4, dt);
  });

  // 与背景 cover 尺寸一致（z=-1.1 位于角色与背景之间）
  const dist = 4.6,
    fov = 40;
  const h = 2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)) * dist;
  const w = h * (size.width / size.height);

  return (
    <mesh position={[0, 1.45, -1.1]} renderOrder={3}>
      <planeGeometry args={[w * 1.12, h * 1.12]} />
      <shaderMaterial
        vertexShader={glassVert}
        fragmentShader={glassFrag}
        uniforms={uniforms}
        transparent={false}
        depthWrite={false}
      />
    </mesh>
  );
}

export function Rain() {
  return (
    <>
      <Suspense fallback={null}>
        <RainGlass />
      </Suspense>
      <RainStreaks />
    </>
  );
}
