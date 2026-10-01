import {
  BufferAttribute, BufferGeometry, Group, Mesh, PlaneGeometry, ShaderMaterial, Texture, Vector2,
} from 'three';
import { CELL, HALF, SIM_N, WORLD, shared } from './shared';
import { terrainHeight } from './terrain';
import { NOISE_GLSL, SKY_GLSL } from './shaders/common';

export const waterUniforms = {
  ...shared,
  tScene: { value: null as Texture | null },
  uResolution: { value: new Vector2(1, 1) },
  uNear: { value: 0.1 },
  uFar: { value: 200 },
  uRefraction: { value: 1 },
};

const SURFACE_VERT = /* glsl */ `
uniform sampler2D tSimA;
varying vec3 vWPos;
varying vec3 vViewPos;
varying vec2 vSimUv;
void main() {
  vec3 p = position;
  vSimUv = (p.xz + ${HALF.toFixed(1)}) / ${WORLD.toFixed(1)};
  p.y = texture2D(tSimA, vSimUv).r;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWPos = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const SURFACE_FRAG = /* glsl */ `
uniform sampler2D tSimA;
uniform sampler2D tSimB;
uniform sampler2D tScene;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uClarity;
uniform float uRefraction;
varying vec3 vWPos;
varying vec3 vViewPos;
varying vec2 vSimUv;
${NOISE_GLSL}
${SKY_GLSL}

// Sum of small directional waves for surface sparkle (analytic gradient).
vec2 detailGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  float amp = 0.006;
  float k = 3.2;
  float ang = 0.4;
  for (int i = 0; i < 7; i++) {
    vec2 d = vec2(cos(ang), sin(ang));
    float w = sqrt(9.81 * k);
    float ph = dot(d, p) * k - w * t * 0.7 + float(i) * 1.7;
    g += d * k * amp * cos(ph);
    k *= 1.37; amp *= 0.78; ang += 2.1;
  }
  return g;
}

// Layered cellular foam: broad web, mid bubbles and fine froth.
float foamPattern(vec2 p, float t) {
  vec2 a = voronoi(p * 2.6, t * 0.5);
  vec2 b = voronoi(p * 7.0 + 3.1, t * 0.8 + 1.0);
  vec2 c = voronoi(p * 19.0 + 7.7, t * 1.1 + 2.0);
  float wa = 1.0 - smoothstep(0.02, 0.24, a.y - a.x);
  float wb = 1.0 - smoothstep(0.03, 0.3, b.y - b.x);
  float wc = 1.0 - smoothstep(0.05, 0.35, c.y - c.x);
  float bubbles = smoothstep(0.42, 0.18, c.x) * 0.5;
  return wa * 0.55 + wb * 0.45 + max(wc, bubbles) * 0.3;
}

void main() {
  vec2 suv = gl_FragCoord.xy / uResolution;
  vec4 A = texture2D(tSimA, vSimUv);
  vec4 B = texture2D(tSimB, vSimUv);
  float h = A.g;
  float foam = A.b;
  vec2 vel = B.rg;

  // Normal from the simulated surface, slopes clamped near the dry extrapolation.
  float e = 1.0 / ${SIM_N.toFixed(1)};
  float sL = texture2D(tSimA, vSimUv - vec2(e, 0.0)).r;
  float sR = texture2D(tSimA, vSimUv + vec2(e, 0.0)).r;
  float sB = texture2D(tSimA, vSimUv - vec2(0.0, e)).r;
  float sT = texture2D(tSimA, vSimUv + vec2(0.0, e)).r;
  vec2 grad = clamp(vec2(sR - sL, sT - sB) / (2.0 * ${CELL.toFixed(4)}), -0.8, 0.8);
  grad *= smoothstep(0.0, 0.03, h);
  vec2 dg = detailGrad(vWPos.xz, uTime) * (0.35 + 0.65 * smoothstep(0.02, 0.4, h));
  vec3 N = normalize(vec3(-(grad.x + dg.x), 1.0, -(grad.y + dg.y)));

  vec3 V = normalize(cameraPosition - vWPos);
  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // Refraction through the scene copy (rgb = colour, a = view depth).
  float waterZ = -vViewPos.z;
  vec3 dN = (viewMatrix * vec4(N - vec3(0.0, 1.0, 0.0), 0.0)).xyz;
  vec4 base = texture2D(tScene, suv);
  float thick0 = max(base.a - waterZ, 0.0);
  vec2 rOff = dN.xy * 0.035 * uRefraction * clamp(thick0 * 1.2, 0.0, 1.0);
  float rLen = length(rOff);
  if (rLen > 0.02) rOff *= 0.02 / rLen;
  vec2 ruv = suv + rOff;
  vec4 refr = texture2D(tScene, ruv);
  if (refr.a < waterZ) refr = base;
  float rayLen = min(max(refr.a - waterZ, 0.0) * length(vViewPos) / waterZ, 8.0);
  float vertThick = max(base.a - waterZ, 0.0) * length(vViewPos) / waterZ * max(V.y, 0.08);

  // Beer-Lambert absorption + in-scattering.
  vec3 absorb = vec3(0.40, 0.085, 0.06) * uClarity;
  vec3 T = exp(-absorb * rayLen);
  float sunLit = max(uSunDir.y, 0.0);
  vec3 scatterCol = vec3(0.02, 0.24, 0.27) * (uSunColor * uSunIntensity * sunLit * 0.32 + vec3(0.32, 0.4, 0.45));
  vec3 col = refr.rgb * T + scatterCol * (1.0 - T) * (1.0 - exp(-rayLen * 0.9));

  // Reflection: sky + sun glints.
  vec3 R = reflect(-V, N);
  vec3 sky = skyColor(R);
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 900.0) * 140.0 + pow(max(dot(N, H), 0.0), 120.0) * 1.2;
  col = mix(col, sky, F);
  col += uSunColor * uSunIntensity * spec * F * 0.25 * max(dot(N, uSunDir), 0.0);

  // Foam, flowing with the water via a two-phase flow map.
  float fAmt = clamp(foam, 0.0, 1.0);
  if (fAmt > 0.015) {
    float phase = fract(uTime * 0.35);
    vec2 flowA = vel * phase * 0.9;
    vec2 flowB = vel * fract(phase + 0.5) * 0.9;
    float blend = abs(1.0 - 2.0 * phase);
    float patA = foamPattern(vWPos.xz - flowA, uTime);
    float patB = foamPattern(vWPos.xz - flowB + 0.37, uTime);
    float pat = mix(patA, patB, 1.0 - blend);
    float breakup = fbm2(vWPos.xz * 0.9 - vel * 0.3 + uTime * 0.03);
    float density = fAmt * (0.25 + 1.25 * breakup * breakup * 1.6);
    float lace = smoothstep(1.08 - density * 0.85, 1.22 - density * 0.85, pat) * smoothstep(0.015, 0.1, fAmt);
    float milky = smoothstep(0.3, 1.0, fAmt) * 0.12 * breakup;
    float foamMask = clamp(lace * 0.92 + milky, 0.0, 0.95);
    float diff = max(dot(N, uSunDir), 0.0);
    vec3 foamCol = vec3(0.92, 0.95, 0.97) * (uSunColor * uSunIntensity * diff * 0.31 + vec3(0.5, 0.56, 0.62));
    col = mix(col, foamCol, foamMask);
  }

  // Feather the waterline into the terrain.
  float edge = smoothstep(0.0, 0.03, vertThick);
  col = mix(base.rgb, col, edge);
  gl_FragColor = vec4(col, 1.0);
}
`;

const SIDE_VERT = /* glsl */ `
uniform sampler2D tSimA;
attribute float aTop;
attribute float aBed;
attribute vec2 aSimUv;
varying vec3 vWPos;
varying float vSurf;
varying float vFoam;
void main() {
  vec4 A = texture2D(tSimA, aSimUv);
  float surf = A.g > 0.003 ? max(A.r, aBed) : aBed;
  vec3 p = position;
  p.y = mix(aBed, surf, aTop);
  vSurf = surf;
  vFoam = A.b;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SIDE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunColor;
uniform float uSunIntensity;
varying vec3 vWPos;
varying float vSurf;
varying float vFoam;
${NOISE_GLSL}
void main() {
  float depth = max(vSurf - vWPos.y, 0.0);
  vec3 shallow = vec3(0.045, 0.30, 0.33);
  vec3 deep = vec3(0.006, 0.06, 0.10);
  vec3 col = mix(shallow, deep, 1.0 - exp(-depth * 0.9));
  float along = vWPos.x + vWPos.z;
  float shafts = fbm2(vec2(along * 1.1 + uTime * 0.12, depth * 0.5 + along * 0.2));
  col += vec3(0.02, 0.09, 0.10) * smoothstep(0.35, 0.8, shafts) * exp(-depth * 0.7);
  col *= uSunIntensity * 0.36;
  float rim = 1.0 - smoothstep(0.0, 0.03, depth);
  col = mix(col, vec3(0.55, 0.75, 0.78), rim * 0.6);
  col = mix(col, vec3(0.9), smoothstep(0.06, 0.0, depth) * clamp(vFoam, 0.0, 1.0) * 0.6);
  gl_FragColor = vec4(col, 1.0);
}
`;

const buildSideGeometry = () => {
  const M = SIM_N;
  const positions: number[] = [];
  const tops: number[] = [];
  const beds: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const inset = 0.5 / SIM_N;
  const edges: Array<{ from: [number, number]; to: [number, number] }> = [
    { from: [-HALF, HALF], to: [HALF, HALF] },
    { from: [HALF, HALF], to: [HALF, -HALF] },
    { from: [HALF, -HALF], to: [-HALF, -HALF] },
    { from: [-HALF, -HALF], to: [-HALF, HALF] },
  ];
  for (const edge of edges) {
    const start = positions.length / 3;
    for (let i = 0; i <= M; i++) {
      const t = i / M;
      const x = edge.from[0] + (edge.to[0] - edge.from[0]) * t;
      const z = edge.from[1] + (edge.to[1] - edge.from[1]) * t;
      const b = terrainHeight(x, z);
      const u = Math.min(Math.max((x + HALF) / WORLD, inset), 1 - inset);
      const v = Math.min(Math.max((z + HALF) / WORLD, inset), 1 - inset);
      for (const top of [1, 0]) {
        positions.push(x, b, z);
        tops.push(top);
        beds.push(b);
        uvs.push(u, v);
      }
    }
    for (let i = 0; i < M; i++) {
      const a = start + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('aTop', new BufferAttribute(new Float32Array(tops), 1));
  geo.setAttribute('aBed', new BufferAttribute(new Float32Array(beds), 1));
  geo.setAttribute('aSimUv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  return geo;
};

export const createWater = () => {
  const group = new Group();
  const surfaceGeo = new PlaneGeometry(WORLD, WORLD, SIM_N, SIM_N);
  surfaceGeo.rotateX(-Math.PI / 2);
  const surface = new Mesh(
    surfaceGeo,
    new ShaderMaterial({ vertexShader: SURFACE_VERT, fragmentShader: SURFACE_FRAG, uniforms: waterUniforms }),
  );
  surface.frustumCulled = false;
  group.add(surface);

  const sides = new Mesh(
    buildSideGeometry(),
    new ShaderMaterial({ vertexShader: SIDE_VERT, fragmentShader: SIDE_FRAG, uniforms: waterUniforms }),
  );
  sides.frustumCulled = false;
  group.add(sides);
  return group;
};
