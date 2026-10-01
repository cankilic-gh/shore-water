import {
  DataTexture, DoubleSide, FloatType, Group, HalfFloatType, LinearFilter, Mesh, NearestFilter, Object3D,
  OrthographicCamera, RedFormat, RGBAFormat, Scene, ShaderMaterial, Texture, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CELL, HALF, SIM_N, params, shared } from './shared';
import { terrainHeight } from './terrain';
import { FULLSCREEN_VERT } from './shaders/common';
import {
  FLUX_FRAG, INIT_FRAG, RENDER_A_FRAG, RENDER_B_FRAG, STAMP_FRAG, STAMP_VERT, STATE_FRAG, WET_FRAG,
} from './shaders/sim';

const N = SIM_N;

const simTarget = () =>
  new WebGLRenderTarget(N, N, {
    type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
    depthBuffer: false, generateMipmaps: false,
  });

const renderTarget = () =>
  new WebGLRenderTarget(N, N, {
    type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter,
    depthBuffer: false, generateMipmaps: false,
  });

export interface CharacterInput {
  x: number;
  z: number;
  vx: number;
  vz: number;
  pressure: number;
  foam: number;
  trail: boolean;
}

export class WaterSim {
  readonly bedData = new Float32Array(N * N);
  readonly bed: DataTexture;
  readonly renderA = renderTarget();
  readonly renderB = renderTarget();
  readonly probe = new Float32Array(4);
  substeps = 0;

  private state = [simTarget(), simTarget()];
  private flux = [simTarget(), simTarget()];
  private wet = [simTarget(), simTarget()];
  private quad = new FullScreenQuad();
  private accumulator = 0;
  private simTime = 0;
  private probePending = false;
  private readonly dt = 1 / 120;

  private fluxMat: ShaderMaterial;
  private stateMat: ShaderMaterial;
  private wetMat: ShaderMaterial;
  private renderAMat: ShaderMaterial;
  private renderBMat: ShaderMaterial;
  private initMat: ShaderMaterial;

  constructor(private renderer: WebGLRenderer, rocks: Group) {
    this.bed = new DataTexture(this.bedData, N, N, RedFormat, FloatType);
    this.bed.minFilter = NearestFilter;
    this.bed.magFilter = NearestFilter;
    this.buildBed(rocks);

    const base = () => ({
      tState: { value: null as Texture | null },
      tFlux: { value: null as Texture | null },
      tBed: { value: this.bed },
      uDt: { value: this.dt },
      uL: { value: CELL },
      uG: { value: 9.81 },
    });
    const make = (fragmentShader: string, extra: Record<string, { value: unknown }> = {}) =>
      new ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader, uniforms: { ...base(), ...extra } });

    this.fluxMat = make(FLUX_FRAG, {
      uChar: { value: [0, 0, 0.3, 0] },
      uCharVel: { value: [0, 0] },
      uCharPush: { value: 5.0 },
      uDamp: { value: 0.9992 },
      uFriction: { value: 0.012 },
    });
    this.stateMat = make(STATE_FRAG, {
      uTime: { value: 0 },
      uWaveAmp: { value: params.waveAmp },
      uWavePeriod: { value: params.wavePeriod },
      uFoamRate: { value: params.foamRate },
      uFoamDecay: { value: params.foamDecay },
      uChar: { value: [0, 0, 0.3, 0] },
      uCharFoam: { value: 0 },
    });
    this.wetMat = make(WET_FRAG, {
      tWet: { value: null },
      uTrail: { value: [0, 0, 0.22, 0] },
      uDryTime: { value: 28 },
    });
    this.renderAMat = make(RENDER_A_FRAG, { tWet: { value: null } });
    this.renderBMat = make(RENDER_B_FRAG, { tWet: { value: null } });
    this.initMat = make(INIT_FRAG);

    shared.tSimA.value = this.renderA.texture;
    shared.tSimB.value = this.renderB.texture;
    this.reset();
  }

  // Terrain heights plus rock tops rendered top-down into one bed heightfield.
  private buildBed(rocks: Group) {
    const stampRT = new WebGLRenderTarget(N, N, { type: FloatType, format: RGBAFormat, depthBuffer: true });
    const stampMat = new ShaderMaterial({ vertexShader: STAMP_VERT, fragmentShader: STAMP_FRAG, side: DoubleSide });
    const stampScene = new Scene();
    rocks.updateMatrixWorld(true);
    rocks.children.forEach((child: Object3D) => {
      const src = child as Mesh;
      const m = new Mesh(src.geometry, stampMat);
      m.matrixAutoUpdate = false;
      m.matrix.copy(src.matrixWorld);
      m.frustumCulled = false;
      stampScene.add(m);
    });
    const r = this.renderer;
    r.setRenderTarget(stampRT);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(stampScene, new OrthographicCamera());
    const pixels = new Float32Array(N * N * 4);
    r.readRenderTargetPixels(stampRT, 0, 0, N, N, pixels);
    r.setRenderTarget(null);

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) * CELL - HALF;
        const z = (j + 0.5) * CELL - HALF;
        const rock = pixels[(j * N + i) * 4] - 100;
        this.bedData[j * N + i] = Math.max(terrainHeight(x, z), rock > -90 ? rock : -100);
      }
    }
    this.bed.needsUpdate = true;
    stampRT.dispose();
    stampMat.dispose();
  }

  bedAt(x: number, z: number) {
    const fx = Math.min(Math.max((x + HALF) / CELL - 0.5, 0), N - 1.001);
    const fz = Math.min(Math.max((z + HALF) / CELL - 0.5, 0), N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const d = this.bedData;
    const a = d[j * N + i], b = d[j * N + i + 1];
    const c = d[(j + 1) * N + i], e = d[(j + 1) * N + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  }

  reset() {
    const r = this.renderer;
    r.setClearColor(0x000000, 0);
    for (const t of [...this.flux, ...this.wet]) {
      r.setRenderTarget(t);
      r.clear();
    }
    this.pass(this.initMat, this.state[0]);
    r.setRenderTarget(null);
  }

  private pass(mat: ShaderMaterial, target: WebGLRenderTarget) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  step(frameDt: number, ch: CharacterInput) {
    const fm = this.fluxMat.uniforms;
    const sm = this.stateMat.uniforms;
    fm.uChar.value = [ch.x, ch.z, 0.3, ch.pressure];
    fm.uCharVel.value = [ch.vx, ch.vz];
    sm.uChar.value = [ch.x, ch.z, 0.3, 0];
    sm.uCharFoam.value = ch.foam;
    sm.uWaveAmp.value = params.waveAmp;
    sm.uWavePeriod.value = params.wavePeriod;
    sm.uFoamRate.value = params.foamRate;
    sm.uFoamDecay.value = params.foamDecay;

    this.accumulator = Math.min(this.accumulator + frameDt, this.dt * 4);
    this.substeps = 0;
    while (this.accumulator >= this.dt) {
      this.accumulator -= this.dt;
      this.simTime += this.dt;
      this.substeps++;

      fm.tState.value = this.state[0].texture;
      fm.tFlux.value = this.flux[0].texture;
      this.pass(this.fluxMat, this.flux[1]);
      this.flux.reverse();

      sm.tState.value = this.state[0].texture;
      sm.tFlux.value = this.flux[0].texture;
      sm.uTime.value = this.simTime;
      this.pass(this.stateMat, this.state[1]);
      this.state.reverse();
    }

    const wm = this.wetMat.uniforms;
    wm.tState.value = this.state[0].texture;
    wm.tWet.value = this.wet[0].texture;
    wm.uDt.value = frameDt;
    wm.uTrail.value = [ch.x, ch.z, 0.15, ch.trail ? 1 : 0];
    this.pass(this.wetMat, this.wet[1]);
    this.wet.reverse();

    for (const mat of [this.renderAMat, this.renderBMat]) {
      mat.uniforms.tState.value = this.state[0].texture;
      mat.uniforms.tWet.value = this.wet[0].texture;
    }
    this.pass(this.renderAMat, this.renderA);
    this.pass(this.renderBMat, this.renderB);
    this.renderer.setRenderTarget(null);

    this.requestProbe(ch.x, ch.z);
  }

  // Async GPU readback of (h, u, v, foam) under the character, one frame late.
  private requestProbe(x: number, z: number) {
    if (this.probePending) return;
    const i = Math.min(Math.max(Math.floor((x + HALF) / CELL), 0), N - 1);
    const j = Math.min(Math.max(Math.floor((z + HALF) / CELL), 0), N - 1);
    this.probePending = true;
    const buf = new Float32Array(4);
    this.renderer
      .readRenderTargetPixelsAsync(this.state[0], i, j, 1, 1, buf)
      .then(() => this.probe.set(buf))
      .catch(() => undefined)
      .finally(() => { this.probePending = false; });
  }
}
