import {
  BufferAttribute, BufferGeometry, Group, IcosahedronGeometry, Mesh, MeshStandardMaterial, Vector3,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Noise, mulberry32 } from './noise';
import { coastToWorld, terrainHeight } from './terrain';
import { HALF, WORLD, shared } from './shared';
import { NOISE_GLSL } from './shaders/common';

interface RockSpec {
  d: number;
  t: number;
  size: [number, number, number];
  rot?: number;
  sink?: number;
}

// Placed in coast coordinates: d < 0 is sea, d > 0 is beach/land.
const ROCKS: RockSpec[] = [
  // Reef ridge crossing the shoreline
  { d: -5.6, t: -7.6, size: [1.1, 0.75, 0.8], rot: -0.3 },
  { d: -3.4, t: -7.2, size: [1.5, 1.0, 1.0], rot: -0.35 },
  { d: -1.0, t: -6.8, size: [1.8, 1.25, 1.15], rot: -0.4 },
  { d: 1.4, t: -6.4, size: [1.6, 1.05, 1.2], rot: -0.38 },
  { d: 3.6, t: -6.1, size: [1.3, 0.85, 1.0], rot: -0.3 },
  { d: 5.4, t: -5.8, size: [1.0, 0.6, 0.8], rot: -0.2 },
  // Sea stacks
  { d: -10.0, t: 2.5, size: [1.5, 2.6, 1.4], sink: -0.2 },
  { d: -12.5, t: -9.0, size: [1.2, 2.2, 1.25], sink: -0.2 },
  { d: -7.0, t: 9.5, size: [1.1, 1.8, 1.05], sink: -0.15 },
  // Boulders in the swash zone
  { d: -1.2, t: 1.0, size: [0.5, 0.38, 0.45] },
  { d: 0.6, t: 4.0, size: [0.38, 0.3, 0.42] },
  { d: -2.6, t: 6.2, size: [0.62, 0.5, 0.55] },
  { d: 1.6, t: -1.6, size: [0.32, 0.26, 0.3] },
  { d: -0.4, t: 11.0, size: [0.5, 0.42, 0.5] },
  { d: 2.9, t: 7.6, size: [0.42, 0.32, 0.38] },
  { d: -3.6, t: -2.0, size: [0.58, 0.46, 0.5] },
  { d: 0.2, t: -3.2, size: [0.28, 0.22, 0.3] },
  // Land rocks by the grass line
  { d: 9.2, t: -10.0, size: [1.2, 0.6, 1.3], rot: 0.4 },
  { d: 10.6, t: -8.0, size: [0.8, 0.5, 0.9] },
  { d: 8.4, t: 11.5, size: [0.95, 0.55, 0.85], rot: 1.1 },
];

const tmp = new Vector3();

const rockGeometry = (seed: number, sx: number, sy: number, sz: number) => {
  let geo: BufferGeometry = new IcosahedronGeometry(1, 22);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const pos = geo.attributes.position as BufferAttribute;
  const ao = new Float32Array(pos.count);
  const n = new Noise(seed);
  const rnd = mulberry32(seed * 97 + 3);

  // Random cutting planes give the chunky, fractured granite silhouette.
  const planes: Array<{ n: Vector3; o: number }> = [];
  for (let k = 0; k < 11; k++) {
    const nrm = new Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.7 + (k < 2 ? 0.8 : 0), rnd() * 2 - 1).normalize();
    planes.push({ n: nrm, o: 0.58 + rnd() * 0.3 });
  }

  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i).normalize();
    const px = tmp.x, py = tmp.y, pz = tmp.z;
    const big = n.fbm3(px * 1.1 + 3, py * 1.1, pz * 1.1, 4);
    const ridge = 1 - Math.abs(n.noise3(px * 2.7, py * 2.7 + 7, pz * 2.7));
    const fine = n.noise3(px * 8, py * 8, pz * 8);
    const strata = Math.sin(py * sy * 10 + n.noise3(px * 1.4, py * 1.4, pz * 1.4) * 2.5);
    let r = 1 + 0.24 * big + 0.07 * ridge + 0.02 * fine + 0.02 * strata;
    tmp.multiplyScalar(r);
    for (const pl of planes) {
      const k = tmp.dot(pl.n) - pl.o;
      if (k > 0) tmp.addScaledVector(pl.n, -k * 0.93);
    }
    r = tmp.length();
    ao[i] = Math.min(Math.max((r - 0.72) / 0.5, 0), 1) * 0.7 + (0.3 + 0.3 * fine) * 0.43;
    pos.setXYZ(i, tmp.x * sx, tmp.y * sy, tmp.z * sz);
  }
  geo.setAttribute('aAO', new BufferAttribute(ao, 1));
  geo.computeVertexNormals();
  return geo;
};

const rockMaterial = () => {
  const mat = new MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.6 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tSimA = shared.tSimA;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aAO;
        varying float vAO;
        varying vec3 vWPos;
        varying vec3 vWNormal;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vAO = aAO;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tSimA;
        varying float vAO;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        ${NOISE_GLSL}`)
      .replace('#include <map_fragment>', /* glsl */ `
        vec3 q = vWPos;
        vec3 nW = normalize(vWNormal);
        float n1 = fbm3(q * 1.6);
        float n2 = vnoise3(q * 5.5);
        float bands = sin(q.y * 9.0 + fbm3(q * 0.9) * 5.0) * 0.5 + 0.5;
        vec3 cDark = vec3(0.16, 0.065, 0.025);
        vec3 cMid = vec3(0.42, 0.18, 0.06);
        vec3 cLight = vec3(0.62, 0.36, 0.15);
        vec3 col = mix(cMid, cLight, smoothstep(0.35, 0.75, n1));
        col = mix(col, cDark, bands * 0.38);
        col *= mix(0.42, 1.08, vAO);
        col *= 0.8 + 0.35 * n2;
        // Sun bleached tops and dark mineral speckles.
        col = mix(col, vec3(0.62, 0.50, 0.38), smoothstep(0.55, 0.95, nW.y) * 0.28 * n1);
        col *= 1.0 - 0.45 * smoothstep(0.78, 0.86, vnoise3(q * 22.0));
        col += vec3(0.06, 0.05, 0.04) * smoothstep(0.82, 0.9, vnoise3(q * 31.0 + 4.0));

        vec2 simUv = (q.xz + ${HALF.toFixed(1)}) / ${WORLD.toFixed(1)};
        vec4 simA = texture2D(tSimA, simUv);
        float waterTop = max(simA.r, 0.0);
        float wetBand = 1.0 - smoothstep(waterTop + 0.05, waterTop + 0.45, q.y);
        wetBand = max(wetBand, 1.0 - smoothstep(0.1, 0.55, q.y));
        col *= mix(1.0, 0.55, wetBand);
        diffuseColor.rgb = col;
        float rockRough = mix(0.86, 0.38, wetBand);

        float e = 0.02;
        float b0 = fbm3(q * 7.0);
        vec3 bumpGrad = vec3(fbm3((q + vec3(e, 0, 0)) * 7.0) - b0, fbm3((q + vec3(0, e, 0)) * 7.0) - b0, fbm3((q + vec3(0, 0, e)) * 7.0) - b0) / e;
        vec3 rockNormalW = normalize(nW - (bumpGrad - nW * dot(bumpGrad, nW)) * 0.06);
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rockRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(rockNormalW, 0.0)).xyz);');
  };
  return mat;
};

export const createRocks = () => {
  const group = new Group();
  const mat = rockMaterial();
  ROCKS.forEach((spec, i) => {
    const [x, z] = coastToWorld(spec.d, spec.t);
    if (Math.abs(x) > HALF - 0.8 || Math.abs(z) > HALF - 0.8) return;
    const [sx, sy, sz] = spec.size;
    const mesh = new Mesh(rockGeometry(i * 13 + 5, sx, sy, sz), mat);
    const ground = terrainHeight(x, z);
    mesh.position.set(x, ground + sy * (0.25 - (spec.sink ?? 0.0)), z);
    mesh.rotation.y = spec.rot ?? i * 1.7;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  return group;
};
