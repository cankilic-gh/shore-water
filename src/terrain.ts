import {
  BoxGeometry, BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, PlaneGeometry, Group,
} from 'three';
import { Noise } from './noise';
import { BASE_Y, HALF, WORLD, shared } from './shared';
import { NOISE_GLSL } from './shaders/common';

const noise = new Noise(7);
const ANGLE = 0.38;
const CA = Math.cos(ANGLE);
const SA = Math.sin(ANGLE);

const smooth01 = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

export const coastOffset = (t: number) =>
  1.6 * Math.sin(t * 0.21 + 0.6) + 0.7 * Math.sin(t * 0.47 + 2.1) - 3.0 * Math.exp(-(((t - 3.5) / 4.2) ** 2)) - 1.2;

// Signed distance-like coordinate: < 0 sea, > 0 land.
export const shoreDist = (x: number, z: number) => {
  const s = x * CA + z * SA;
  const t = -x * SA + z * CA;
  return s - coastOffset(t);
};

// (d, t) coast coordinates to world xz.
export const coastToWorld = (d: number, t: number): [number, number] => {
  const s = d + coastOffset(t);
  return [s * CA - t * SA, s * SA + t * CA];
};

export const terrainHeight = (x: number, z: number) => {
  const d = shoreDist(x, z);
  let h: number;
  if (d < 0) {
    const u = -d;
    h = -0.05 - 0.05 * u - 2.15 * smooth01((u - 3) / 11);
    h += 0.32 * Math.exp(-(((u - 7.5) / 1.7) ** 2));
    h += 0.18 * noise.fbm2(x * 0.11 + 5.3, z * 0.11 - 2.1) * smooth01(u / 4);
  } else {
    h = -0.05 + 0.052 * Math.min(d, 8) + 1.05 * smooth01((d - 7) / 6) + 0.035 * Math.max(d - 13, 0);
    h += 0.5 * noise.fbm2(x * 0.085 + 11.0, z * 0.085 + 3.0) * smooth01((d - 6) / 8);
  }
  h += 0.045 * noise.fbm2(x * 0.32 - 7.0, z * 0.32 + 1.0) * smooth01((d + 4) / 4);
  return h;
};

export const grassAmount = (x: number, z: number, h: number) => {
  const n = noise.fbm2(x * 0.18 + 40, z * 0.18 - 13) * 0.35 + noise.noise2(x * 0.9, z * 0.9) * 0.08;
  return smooth01((h + n - 0.82) / 0.12);
};

const TERRAIN_SEGMENTS = 512;

const terrainUniforms = {
  ...shared,
};

const buildTerrainMaterial = () => {
  const mat = new MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.55 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, terrainUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        uniform sampler2D tSimB;
        attribute float aGrass;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vGrass;
      `)
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vec2 simUv = (position.xz + ${HALF.toFixed(1)}) / ${WORLD.toFixed(1)};
        float trailV = texture2D(tSimB, simUv).b;
        transformed.y -= trailV * 0.07 * (1.0 - aGrass);
        vGrass = aGrass;
      `)
      .replace('#include <worldpos_vertex>', /* glsl */ `
        #include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        uniform sampler2D tSimA;
        uniform sampler2D tSimB;
        uniform float uTime;
        uniform vec3 uSunColor;
        uniform float uSunIntensity;
        uniform float uCaustics;
        uniform float uClarity;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vGrass;
        ${NOISE_GLSL}
        float sandRipple(vec2 p) {
          float w = (vnoise(p * 0.3) + 0.5 * vnoise(p * 0.62 + 4.0)) * 4.0;
          float ph = dot(p, vec2(0.83, 0.56)) * 7.5 + w;
          float r = sin(ph) * 0.5 + 0.5;
          r = r * r * (3.0 - 2.0 * r);
          return r * (0.55 + 0.45 * vnoise(p * 0.7 + 3.0));
        }
      `)
      .replace('#include <map_fragment>', /* glsl */ `
        vec2 simUv = (vWPos.xz + ${HALF.toFixed(1)}) / ${WORLD.toFixed(1)};
        vec4 simA = texture2D(tSimA, simUv);
        vec4 simB = texture2D(tSimB, simUv);
        float waterH = simA.g;
        float submerged = smoothstep(0.002, 0.02, waterH);
        float wet = max(simA.a, submerged);
        float trail = simB.b;

        vec2 p = vWPos.xz;
        float grassEdge = vGrass + (fbm2(p * 2.1) - 0.5) * 0.55 + (vnoise(p * 9.0) - 0.5) * 0.25;
        float grass = smoothstep(0.42, 0.58, grassEdge);

        // Sand: pale with wind ripples and fine grain.
        float e = 0.012;
        float r0 = sandRipple(p);
        float rx = sandRipple(p + vec2(e, 0.0));
        float rz = sandRipple(p + vec2(0.0, e));
        float rippleAmp = 0.016 * (1.0 - 0.5 * wet);
        vec2 rippleGrad = vec2(rx - r0, rz - r0) / e * rippleAmp;
        float grain = hash12(floor(p * 260.0));
        vec3 sandDry = vec3(0.63, 0.575, 0.49) * (0.93 + 0.1 * vnoise(p * 1.3)) * (0.94 + 0.08 * grain);
        sandDry *= 0.88 + 0.12 * r0;
        sandDry *= mix(vec3(0.93, 0.95, 0.98), vec3(1.04, 1.0, 0.94), fbm2(p * 0.18 + 9.0));
        vec3 sandWet = vec3(0.30, 0.285, 0.25) * (0.92 + 0.1 * grain);
        vec3 sandSub = vec3(0.50, 0.46, 0.385) * (0.92 + 0.1 * grain) * (0.9 + 0.1 * r0);
        vec3 sand = mix(sandDry, sandWet, simA.a * (1.0 - submerged));
        sand = mix(sand, sandSub, submerged);
        // Grooves ploughed by the character read slightly darker.
        sand *= 1.0 - trail * 0.24;

        // Grass: patchy olive with dry tips.
        float gn = fbm2(p * 0.9);
        float gfine = vnoise(p * 38.0);
        vec3 grassCol = mix(vec3(0.085, 0.13, 0.025), vec3(0.20, 0.21, 0.055), gn);
        grassCol = mix(grassCol, vec3(0.28, 0.25, 0.10), smoothstep(0.6, 0.9, vnoise(p * 3.1)) * 0.5);
        grassCol *= 0.7 + 0.5 * gfine;

        vec3 albedo = mix(sand, grassCol, grass);

        // Light reaching the seabed is absorbed on the way down.
        vec3 absorb = vec3(0.42, 0.10, 0.07) * uClarity;
        albedo *= mix(vec3(1.0), exp(-absorb * waterH * 1.1), submerged);
        diffuseColor.rgb = albedo;

        float roughTerrain = mix(mix(0.93, 0.42, wet), 0.96, grass);

        // Detail normal in world space.
        vec3 nW = normalize(vWNormal);
        vec2 trailGrad = vec2(
          texture2D(tSimB, simUv + vec2(1.0 / 256.0, 0.0)).b - texture2D(tSimB, simUv - vec2(1.0 / 256.0, 0.0)).b,
          texture2D(tSimB, simUv + vec2(0.0, 1.0 / 256.0)).b - texture2D(tSimB, simUv - vec2(0.0, 1.0 / 256.0)).b
        ) / (2.0 * ${(WORLD / 256).toFixed(4)}) * -0.07;
        vec2 grassGrad = vec2(vnoise(p * 30.0 + 0.5) - 0.5, vnoise(p * 30.0 + 7.3) - 0.5) * 0.9;
        vec2 grad = mix(rippleGrad + trailGrad * (1.0 - grass), grassGrad, grass);
        vec3 detailNormalW = normalize(nW + vec3(-grad.x, 0.0, -grad.y));
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughTerrain;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(detailNormalW, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        if (waterH > 0.02) {
          float cDepth = smoothstep(0.02, 0.25, waterH) * exp(-waterH * 0.55);
          float c = causticPattern(vWPos.xz * 1.15, uTime * 1.2);
          totalEmissiveRadiance += albedo * c * cDepth * uSunColor * uSunIntensity * 0.16 * uCaustics;
        }
      `);
  };
  return mat;
};

const buildTerrainGeometry = () => {
  const geo = new PlaneGeometry(WORLD, WORLD, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as BufferAttribute;
  const grass = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);
    grass[i] = grassAmount(x, z, h);
  }
  geo.setAttribute('aGrass', new BufferAttribute(grass, 1));
  geo.computeVertexNormals();
  return geo;
};

// Vertical soil cross-section around the diorama.
const buildSkirtGeometry = () => {
  const M = 384;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const edges: Array<{ from: [number, number]; to: [number, number]; n: [number, number] }> = [
    { from: [-HALF, HALF], to: [HALF, HALF], n: [0, 1] },
    { from: [HALF, HALF], to: [HALF, -HALF], n: [1, 0] },
    { from: [HALF, -HALF], to: [-HALF, -HALF], n: [0, -1] },
    { from: [-HALF, -HALF], to: [-HALF, HALF], n: [-1, 0] },
  ];
  for (const edge of edges) {
    const base = positions.length / 3;
    for (let i = 0; i <= M; i++) {
      const t = i / M;
      const x = edge.from[0] + (edge.to[0] - edge.from[0]) * t;
      const z = edge.from[1] + (edge.to[1] - edge.from[1]) * t;
      positions.push(x, terrainHeight(x, z), z, x, BASE_Y, z);
      normals.push(edge.n[0], 0, edge.n[1], edge.n[0], 0, edge.n[1]);
    }
    for (let i = 0; i < M; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setIndex(indices);
  return geo;
};

const buildSkirtMaterial = () => {
  const mat = new MeshStandardMaterial({ roughness: 0.95, metalness: 0, envMapIntensity: 0.4 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying float vTop;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\n${NOISE_GLSL}`)
      .replace('#include <map_fragment>', /* glsl */ `
        vec3 q = vWPos;
        float along = q.x + q.z;
        float strata = fbm2(vec2(along * 0.6, q.y * 5.0));
        vec3 soil = mix(vec3(0.085, 0.05, 0.028), vec3(0.20, 0.12, 0.06), strata);
        soil *= 0.75 + 0.5 * vnoise(vec2(along * 9.0, q.y * 14.0));
        soil = mix(soil, vec3(0.05, 0.03, 0.02), smoothstep(-1.5, -4.0, q.y) * 0.6);
        float pebble = step(0.82, vnoise(vec2(along * 12.0, q.y * 12.0)));
        soil = mix(soil, vec3(0.32, 0.22, 0.13), pebble * 0.6);
        diffuseColor.rgb = soil;
      `);
  };
  return mat;
};

export const createTerrain = () => {
  const group = new Group();
  const terrain = new Mesh(buildTerrainGeometry(), buildTerrainMaterial());
  terrain.receiveShadow = true;
  group.add(terrain);

  const skirt = new Mesh(buildSkirtGeometry(), buildSkirtMaterial());
  skirt.receiveShadow = true;
  group.add(skirt);

  const base = new Mesh(
    new BoxGeometry(WORLD + 0.02, 0.35, WORLD + 0.02),
    new MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.6, metalness: 0 }),
  );
  base.position.y = BASE_Y - 0.175;
  group.add(base);
  return { group, terrain };
};
