import { Texture, Vector3 } from 'three';

export const WORLD = 32;
export const HALF = WORLD / 2;
export const SIM_N = 256;
export const CELL = WORLD / SIM_N;
export const BASE_Y = -4.2;

export const params = {
  waveAmp: 0.32,
  wavePeriod: 6.5,
  foamRate: 0.85,
  foamDecay: 0.32,
  clarity: 1.0,
  refraction: 1.0,
  caustics: 1.0,
  dof: true,
  aperture: 1.0,
  renderScale: window.matchMedia('(pointer: coarse)').matches ? 1 : Math.min(window.devicePixelRatio, 1.5),
  sunElevation: 46,
  sunAzimuth: 35,
  exposure: 1.05,
};

const sunDir = new Vector3();

// Uniform objects shared by every material that reads the simulation or the sun.
export const shared = {
  tSimA: { value: null as Texture | null },
  tSimB: { value: null as Texture | null },
  uTime: { value: 0 },
  uSunDir: { value: sunDir },
  uSunColor: { value: new Vector3(1.0, 0.95, 0.87) },
  uSunIntensity: { value: 3.2 },
  uCaustics: { value: 1 },
  uClarity: { value: 1 },
};

export const updateSun = () => {
  const el = (params.sunElevation * Math.PI) / 180;
  const az = (params.sunAzimuth * Math.PI) / 180;
  sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
};
updateSun();
