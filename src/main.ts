import {
  CanvasTexture, Color, DirectionalLight, HemisphereLight, PCFShadowMap, PerspectiveCamera, PMREMGenerator, Scene,
  SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import { CELL, SIM_N, params, shared, updateSun } from './shared';
import { createTerrain, coastToWorld } from './terrain';
import { createRocks } from './rocks';
import { createWater, waterUniforms } from './water';
import { createGrass } from './grass';
import { WaterSim } from './sim';
import { Character } from './character';
import { Pipeline } from './post';
import { setupTouch } from './touch';

const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(params.renderScale);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
document.body.appendChild(renderer.domElement);

const gradientBackground = () => {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#454a53');
  grad.addColorStop(0.55, '#2e3238');
  grad.addColorStop(1, '#1b1d21');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
};

const opaque = new Scene();
opaque.background = gradientBackground();
const pmrem = new PMREMGenerator(renderer);
opaque.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
opaque.environmentIntensity = 0.55;
const waterScene = new Scene();

const sun = new DirectionalLight(new Color(1.0, 0.95, 0.87), shared.uSunIntensity.value);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -24;
sun.shadow.camera.right = 24;
sun.shadow.camera.top = 24;
sun.shadow.camera.bottom = -24;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 90;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 2.5;
opaque.add(sun, sun.target);
opaque.add(new HemisphereLight(0xbcd2ff, 0x8a7656, 0.55));

const placeSun = () => {
  updateSun();
  sun.position.copy(shared.uSunDir.value).multiplyScalar(45);
};
placeSun();

const { group: terrainGroup } = createTerrain();
opaque.add(terrainGroup);
const rocks = createRocks();
opaque.add(rocks);
opaque.add(createGrass());

const sim = new WaterSim(renderer, rocks);
waterScene.add(createWater());

const [startX, startZ] = coastToWorld(1.5, 1.5);
const character = new Character(sim, startX, startZ);
opaque.add(character.mesh);

const camera = new PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(-23, 19, 21);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2.5;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.47;
controls.enablePan = false;
controls.target.set(0, 0, 0);
const followTarget = new Vector3();

const pipeline = new Pipeline(renderer);
const resize = () => {
  renderer.setPixelRatio(params.renderScale);
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  const w = Math.floor(window.innerWidth * params.renderScale);
  const h = Math.floor(window.innerHeight * params.renderScale);
  pipeline.setSize(w, h);
};
window.addEventListener('resize', resize);
resize();

const gui = new GUI({ title: 'Shore water' });
gui.close();
const fWaves = gui.addFolder('Waves');
fWaves.add(params, 'waveAmp', 0, 0.7, 0.01).name('amplitude (m)');
fWaves.add(params, 'wavePeriod', 2.5, 12, 0.1).name('period (s)');
fWaves.add({ reset: () => sim.reset() }, 'reset').name('reset water');
const fWater = gui.addFolder('Water');
fWater.add(params, 'foamRate', 0, 3, 0.05).name('foam rate');
fWater.add(params, 'foamDecay', 0.05, 1.5, 0.01).name('foam decay');
fWater.add(params, 'clarity', 0.3, 2.5, 0.05).name('turbidity').onChange((v: number) => (shared.uClarity.value = v));
fWater.add(params, 'refraction', 0, 2, 0.05).name('refraction').onChange((v: number) => (waterUniforms.uRefraction.value = v));
fWater.add(params, 'caustics', 0, 2, 0.05).name('caustics').onChange((v: number) => (shared.uCaustics.value = v));
const fRender = gui.addFolder('Render');
fRender.add(params, 'dof').name('depth of field');
fRender.add(params, 'aperture', 0.1, 3, 0.05).name('aperture');
fRender.add(params, 'exposure', 0.5, 2, 0.01).name('exposure');
fRender.add(params, 'renderScale', 0.5, 2, 0.25).name('render scale').onFinishChange(resize);
fRender.add(params, 'sunElevation', 10, 85, 1).name('sun elevation').onChange(placeSun);
fRender.add(params, 'sunAzimuth', -180, 180, 1).name('sun azimuth').onChange(placeSun);

setupTouch();
const isTouch = document.documentElement.classList.contains('touch');
const hud = document.getElementById('hud')!;
let fpsFrames = 0;
let fpsTime = 0;
let fps = 0;
let cpuMs = 0;
let elapsed = 0;
let last = performance.now();

const updateHud = () => {
  hud.innerHTML = [
    `${fps.toFixed(0)} fps &nbsp; cpu ${cpuMs.toFixed(2)} ms`,
    `sim ${SIM_N}² @ ${(CELL * 100).toFixed(1)} cm, ${sim.substeps} substep/frame`,
    `immersion ${(character.immersion * 100).toFixed(0)}% &nbsp; eta ${(character.waterSurface - character.bedHere > 0.003 ? character.waterSurface : 0).toFixed(2)} m &nbsp; seabed ${character.bedHere.toFixed(2)} m`,
    isTouch ? 'stick: move &nbsp; JUMP: jump, again mid-air: flap &nbsp; drag: orbit' : `WASD/arrows: move &nbsp; space: jump, again mid-air: flap &nbsp; mouse: orbit`,
  ].join('<br>');
};

const frame = () => {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  elapsed += dt;
  const t0 = performance.now();

  shared.uTime.value = elapsed;
  const input = character.update(dt, camera);
  sim.step(dt, input);

  followTarget.set(character.pos.x, character.pos.y + 0.5, character.pos.z);
  const delta = followTarget.clone().sub(controls.target).multiplyScalar(1 - Math.exp(-dt * 4));
  controls.target.add(delta);
  camera.position.add(delta);
  controls.update();

  const focus = camera.position.distanceTo(followTarget);
  pipeline.render(opaque, waterScene, camera, focus, elapsed);

  cpuMs = cpuMs * 0.9 + (performance.now() - t0) * 0.1;
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime > 0.4) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0;
    fpsTime = 0;
    updateHud();
  }
};
frame();


// Automation hook for screenshot tests: only exposed with ?debug in the URL.
if (new URLSearchParams(window.location.search).has('debug')) {
  (window as unknown as Record<string, unknown>).__shore = { camera, controls, character, sim, params };
}
