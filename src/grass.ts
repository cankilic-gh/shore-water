import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion,
  Vector3,
} from 'three';
import { mulberry32 } from './noise';
import { HALF, WORLD, shared } from './shared';
import { grassAmount, terrainHeight } from './terrain';

const BLADES = 110000;

const bladeGeometry = () => {
  const w = 0.028;
  const pos = new Float32Array([
    -w / 2, 0, 0, w / 2, 0, 0,
    -w * 0.38, 0.45, 0, w * 0.38, 0.45, 0,
    -w * 0.18, 0.78, 0, w * 0.18, 0.78, 0,
    0, 1, 0,
  ]);
  const normals = new Float32Array(pos.length);
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6]);
  return geo;
};

export const createGrass = () => {
  const mat = new MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: DoubleSide, envMapIntensity: 0.4 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vBladeY;')
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vBladeY = position.y;
        vec3 root = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float gust = sin(uTime * 1.3 + root.x * 0.35 + root.z * 0.2) * 0.5 + 0.5;
        float sway = sin(uTime * 2.6 + root.x * 1.7 + root.z * 1.3) * 0.25 + gust * 0.55;
        transformed.x += sway * position.y * position.y * 0.32;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBladeY;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= mix(0.35, 1.15, smoothstep(0.0, 1.0, vBladeY));`);
  };

  const mesh = new InstancedMesh(bladeGeometry(), mat, BLADES);
  const rnd = mulberry32(42);
  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const up = new Vector3(0, 1, 0);
  const c = new Color();
  const dark = new Color(0.07, 0.11, 0.02);
  const light = new Color(0.24, 0.24, 0.07);
  const dry = new Color(0.34, 0.29, 0.12);
  let n = 0;
  let guard = 0;
  while (n < BLADES && guard < BLADES * 12) {
    guard++;
    const x = (rnd() - 0.5) * (WORLD - 0.1);
    const z = (rnd() - 0.5) * (WORLD - 0.1);
    if (Math.abs(x) > HALF - 0.05 || Math.abs(z) > HALF - 0.05) continue;
    const h = terrainHeight(x, z);
    const g = grassAmount(x, z, h);
    if (g < 0.35 || rnd() > g * g) continue;
    const height = (0.08 + rnd() * 0.16) * (0.55 + 0.45 * g);
    p.set(x, h - 0.01, z);
    q.setFromAxisAngle(up, rnd() * Math.PI * 2);
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (rnd() - 0.5) * 0.5);
    q.multiply(tilt);
    s.set(0.8 + rnd() * 0.6, height, 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(n, m);
    c.copy(dark).lerp(light, rnd());
    if (rnd() < 0.18) c.lerp(dry, 0.4 + rnd() * 0.5);
    mesh.setColorAt(n, c);
    n++;
  }
  mesh.count = n;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
};
