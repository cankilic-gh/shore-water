import {
  DepthTexture, FloatType, HalfFloatType, LinearFilter, NearestFilter, PerspectiveCamera, RGBAFormat, Scene,
  ShaderMaterial, Vector2, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FULLSCREEN_VERT } from './shaders/common';
import { params } from './shared';
import { waterUniforms } from './water';

const COPY_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).r;
  gl_FragColor = vec4(texture2D(tColor, vUv).rgb, -perspectiveDepthToViewZ(d, uNear, uFar));
}
`;

const COC_GLSL = /* glsl */ `
uniform float uNear;
uniform float uFar;
uniform float uFocus;
uniform float uAperture;
uniform float uResY;
float viewDepth(float d) { return -perspectiveDepthToViewZ(d, uNear, uFar); }
// Circle of confusion in full-resolution pixels.
float cocPx(float z) {
  return clamp(uAperture * abs(z - uFocus) / max(z, 0.01) * uResY * 0.022, 0.0, 30.0);
}
`;

// Half-res prepass: colour + signed CoC (negative = in front of focus).
const PREP_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
${COC_GLSL}
varying vec2 vUv;
void main() {
  float z = viewDepth(texture2D(tDepth, vUv).r);
  float coc = cocPx(z) * 0.5;
  gl_FragColor = vec4(texture2D(tColor, vUv).rgb, z < uFocus ? -coc : coc);
}
`;

// Single-pass gather bokeh (golden-angle spiral) at half resolution.
const DOF_FRAG = /* glsl */ `
uniform sampler2D tPrep;
uniform vec2 uTexel;
varying vec2 vUv;
const float GOLDEN = 2.39996323;
const float MAX_BLUR = 13.0;
const float RAD_SCALE = 1.0;
void main() {
  vec4 center = texture2D(tPrep, vUv);
  float cSigned = center.a;
  float cSize = abs(cSigned);
  vec3 color = center.rgb;
  float tot = 1.0;
  float radius = RAD_SCALE;
  for (float ang = 0.0; radius < MAX_BLUR; ang += GOLDEN) {
    vec4 s = texture2D(tPrep, vUv + vec2(cos(ang), sin(ang)) * uTexel * radius);
    float sSize = abs(s.a);
    if (s.a > cSigned) sSize = clamp(sSize, 0.0, cSize * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, sSize);
    color += mix(color / tot, s.rgb, m);
    tot += 1.0;
    radius += RAD_SCALE / radius;
  }
  gl_FragColor = vec4(color / tot, 1.0);
}
`;

const FINAL_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tDof;
uniform float uDofOn;
uniform float uExposure;
uniform float uTime;
${COC_GLSL}
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 sharp = texture2D(tColor, vUv).rgb;
  vec3 col = sharp;
  if (uDofOn > 0.5) {
    float z = viewDepth(texture2D(tDepth, vUv).r);
    float m = smoothstep(0.8, 3.0, cocPx(z));
    col = mix(sharp, texture2D(tDof, vUv).rgb, m);
  }
  col *= uExposure;
  col = aces(col * 1.1);
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 1.08);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.38;
  col = toSRGB(clamp(col, 0.0, 1.0));
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Pipeline {
  private main: WebGLRenderTarget;
  private refr: WebGLRenderTarget;
  private dof: WebGLRenderTarget;
  private prep: WebGLRenderTarget;
  private quad = new FullScreenQuad();
  private copyMat: ShaderMaterial;
  private dofMat: ShaderMaterial;
  private prepMat: ShaderMaterial;
  private finalMat: ShaderMaterial;
  private size = new Vector2();

  constructor(private renderer: WebGLRenderer) {
    this.main = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat });
    this.main.depthTexture = new DepthTexture(1, 1);
    this.main.depthTexture.type = FloatType;
    this.refr = new WebGLRenderTarget(1, 1, {
      type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false,
    });
    this.dof = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false,
    });
    this.prep = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false,
    });

    const cocUniforms = () => ({
      uNear: { value: 0.1 },
      uFar: { value: 200 },
      uFocus: { value: 10 },
      uAperture: { value: 1 },
      uResY: { value: 1 },
    });
    this.copyMat = new ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COPY_FRAG,
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 200 } },
    });
    this.prepMat = new ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: PREP_FRAG,
      uniforms: { tColor: { value: null }, tDepth: { value: null }, ...cocUniforms() },
    });
    this.dofMat = new ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: DOF_FRAG,
      uniforms: { tPrep: { value: null }, uTexel: { value: new Vector2() } },
    });
    this.finalMat = new ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: FINAL_FRAG,
      uniforms: {
        tColor: { value: null }, tDepth: { value: null }, tDof: { value: null },
        uDofOn: { value: 1 }, uExposure: { value: 1 }, uTime: { value: 0 }, ...cocUniforms(),
      },
    });
  }

  setSize(width: number, height: number) {
    this.size.set(width, height);
    this.main.setSize(width, height);
    this.refr.setSize(width, height);
    const hw = Math.max(1, Math.floor(width / 2));
    const hh = Math.max(1, Math.floor(height / 2));
    this.dof.setSize(hw, hh);
    this.prep.setSize(hw, hh);
    this.dofMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    waterUniforms.uResolution.value.set(width, height);
  }

  render(opaque: Scene, water: Scene, camera: PerspectiveCamera, focus: number, time: number) {
    const r = this.renderer;
    const depth = this.main.depthTexture!;

    r.setRenderTarget(this.main);
    r.clear();
    r.render(opaque, camera);

    this.copyMat.uniforms.tColor.value = this.main.texture;
    this.copyMat.uniforms.tDepth.value = depth;
    this.copyMat.uniforms.uNear.value = camera.near;
    this.copyMat.uniforms.uFar.value = camera.far;
    this.quad.material = this.copyMat;
    r.setRenderTarget(this.refr);
    this.quad.render(r);

    waterUniforms.tScene.value = this.refr.texture;
    r.setRenderTarget(this.main);
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.render(water, camera);
    r.autoClear = autoClear;

    for (const mat of [this.prepMat, this.finalMat]) {
      const u = mat.uniforms;
      u.tColor.value = this.main.texture;
      u.tDepth.value = depth;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uFocus.value = focus;
      u.uAperture.value = params.aperture;
      u.uResY.value = this.size.y;
    }

    if (params.dof) {
      this.quad.material = this.prepMat;
      r.setRenderTarget(this.prep);
      this.quad.render(r);
      this.dofMat.uniforms.tPrep.value = this.prep.texture;
      this.quad.material = this.dofMat;
      r.setRenderTarget(this.dof);
      this.quad.render(r);
    }

    const fu = this.finalMat.uniforms;
    fu.tDof.value = this.dof.texture;
    fu.uDofOn.value = params.dof ? 1 : 0;
    fu.uExposure.value = params.exposure;
    fu.uTime.value = time;
    this.quad.material = this.finalMat;
    r.setRenderTarget(null);
    this.quad.render(r);
  }
}
