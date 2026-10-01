import { HALF, SIM_N } from '../shared';

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tState;
uniform sampler2D tFlux;
uniform sampler2D tBed;
uniform float uDt;
uniform float uL;
uniform float uG;
const int N = ${SIM_N};

bool inside(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < N && c.y < N; }
ivec2 clampC(ivec2 c) { return clamp(c, ivec2(0), ivec2(N - 1)); }
vec2 cellWorld(ivec2 c) { return (vec2(c) + 0.5) * uL - ${HALF.toFixed(1)}; }
float bedAt(ivec2 c) { return texelFetch(tBed, clampC(c), 0).r; }
vec4 stateAt(ivec2 c) { return texelFetch(tState, clampC(c), 0); }
`;

// Virtual-pipes shallow water: per-cell outflow to the 4 neighbours.
export const FLUX_FRAG = /* glsl */ `
${HEADER}
uniform vec4 uChar;      // x, z, radius, pressure head (m)
uniform vec2 uCharVel;
uniform float uCharPush;
uniform float uDamp;
uniform float uFriction;

float charMask(ivec2 c) {
  vec2 d = cellWorld(c) - uChar.xy;
  return exp(-dot(d, d) / (uChar.z * uChar.z));
}
float surfAt(ivec2 c) {
  return bedAt(c) + stateAt(c).r + uChar.w * charMask(c);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float h = stateAt(c).r;
  float Hc = surfAt(c);
  vec4 f = texelFetch(tFlux, c, 0);
  float m = charMask(c);

  ivec2 nb[4] = ivec2[4](c + ivec2(-1, 0), c + ivec2(1, 0), c + ivec2(0, -1), c + ivec2(0, 1));
  vec2 dirs[4] = vec2[4](vec2(-1.0, 0.0), vec2(1.0, 0.0), vec2(0.0, -1.0), vec2(0.0, 1.0));
  vec4 outF = vec4(0.0);

  for (int k = 0; k < 4; k++) {
    if (!inside(nb[k])) continue;
    float hn = stateAt(nb[k]).r;
    float fk = f[k] * uDamp + uDt * uG * uL * (Hc - surfAt(nb[k]));
    // Moving body drags nearby water toward its own velocity (bounded, no runaway momentum).
    float fTarget = max(dot(uCharVel, dirs[k]), 0.0) * min(h, 0.45) * uL;
    fk += max(fTarget - fk, 0.0) * min(uDt * uCharPush * m, 1.0);
    float ha = max(0.5 * (h + hn), 0.003);
    float v = abs(fk) / (uL * ha);
    fk /= 1.0 + uDt * uFriction * v / ha;
    outF[k] = max(fk, 0.0);
  }

  float sumOut = outF.x + outF.y + outF.z + outF.w;
  float K = sumOut > 0.0 ? min(1.0, h * uL * uL / (sumOut * uDt)) : 0.0;
  gl_FragColor = outF * K;
}
`;

// Depth update, velocity reconstruction, wave forcing and foam transport.
export const STATE_FRAG = /* glsl */ `
${HEADER}
uniform float uTime;
uniform float uWaveAmp;
uniform float uWavePeriod;
uniform float uFoamRate;
uniform float uFoamDecay;
uniform vec4 uChar;
uniform float uCharFoam;

float waveEta(float z, float t) {
  float w = 6.28318 / uWavePeriod;
  float sets = 0.62 + 0.38 * sin(t * 0.083 + 1.0);
  float e = sin(w * t + z * 0.07) * sets;
  e += 0.32 * sin(w * 1.58 * t - z * 0.19 + 1.3);
  e += 0.14 * sin(w * 0.61 * t + z * 0.04 + 4.0);
  return uWaveAmp * e;
}

vec4 fluxAt(ivec2 c) { return inside(c) ? texelFetch(tFlux, c, 0) : vec4(0.0); }

float foamBilinear(vec2 p) {
  vec2 q = p - 0.5;
  ivec2 i0 = ivec2(floor(q));
  vec2 fr = fract(q);
  float a = stateAt(i0).a;
  float b = stateAt(i0 + ivec2(1, 0)).a;
  float c = stateAt(i0 + ivec2(0, 1)).a;
  float d = stateAt(i0 + ivec2(1, 1)).a;
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = stateAt(c);
  float h = s.r;
  float bed = bedAt(c);
  vec4 f = texelFetch(tFlux, c, 0);

  vec4 fl = fluxAt(c + ivec2(-1, 0));
  vec4 fr = fluxAt(c + ivec2(1, 0));
  vec4 fb = fluxAt(c + ivec2(0, -1));
  vec4 ft = fluxAt(c + ivec2(0, 1));

  float fin = fl.y + fr.x + fb.w + ft.z;
  float fout = f.x + f.y + f.z + f.w;
  float hN = max(h + uDt * (fin - fout) / (uL * uL), 0.0);

  float qx = 0.5 * (fl.y - f.x + f.y - fr.x);
  float qz = 0.5 * (fb.w - f.z + f.w - ft.z);
  float hm = max(0.5 * (h + hN), 0.01);
  vec2 vel = vec2(qx, qz) / (uL * hm);
  float sp = length(vel);
  if (sp > 5.0) vel *= 5.0 / sp;
  vel *= smoothstep(0.0, 0.004, hN);

  vec2 wp = cellWorld(c);
  if (c.x == 0) {
    float eta = waveEta(wp.y, uTime);
    hN = max(eta - bed, 0.0);
    vel = vec2(eta * sqrt(uG / max(hN, 0.3)), 0.0);
  }

  // Foam: semi-Lagrangian advection + sources from breaking, convergence, swash and turbulence.
  float foam = foamBilinear(vec2(c) + 0.5 - vel * uDt / uL);

  vec4 sl = stateAt(c + ivec2(-1, 0));
  vec4 sr = stateAt(c + ivec2(1, 0));
  vec4 sb = stateAt(c + ivec2(0, -1));
  vec4 st = stateAt(c + ivec2(0, 1));
  float Hc = bed + h;
  float Hl = sl.r > 0.01 ? bedAt(c + ivec2(-1, 0)) + sl.r : Hc;
  float Hr = sr.r > 0.01 ? bedAt(c + ivec2(1, 0)) + sr.r : Hc;
  float Hb = sb.r > 0.01 ? bedAt(c + ivec2(0, -1)) + sb.r : Hc;
  float Ht = st.r > 0.01 ? bedAt(c + ivec2(0, 1)) + st.r : Hc;
  float slope = length(vec2(Hr - Hl, Ht - Hb)) / (2.0 * uL);
  float div = (sr.g - sl.g + st.b - sb.b) / (2.0 * uL);
  float speed = length(vel);

  float wet = smoothstep(0.003, 0.012, hN);
  float shallow = 1.0 - smoothstep(0.45, 1.4, hN);
  float src = 0.0;
  src += smoothstep(0.07, 0.28, slope) * 2.6 * shallow + smoothstep(0.2, 0.45, slope) * 0.4;
  src += smoothstep(0.7, 2.2, -div) * 0.8 * shallow;
  src += smoothstep(0.7, 2.0, speed) * (1.0 - smoothstep(0.03, 0.25, hN)) * 1.5;
  // Leading edge of the swash: thin, moving water next to dry sand.
  float dryNb = step(sl.r, 0.003) + step(sr.r, 0.003) + step(sb.r, 0.003) + step(st.r, 0.003);
  src += min(dryNb, 2.0) * smoothstep(0.15, 0.7, speed) * (1.0 - smoothstep(0.02, 0.12, hN)) * 2.5;
  src += smoothstep(1.6, 3.2, speed) * 0.8;
  src *= smoothstep(3.0, 8.0, float(c.x));
  vec2 dc = wp - uChar.xy;
  src += exp(-dot(dc, dc) / (uChar.z * uChar.z * 2.2)) * uCharFoam;

  float decay = mix(1.6, uFoamDecay, wet);
  foam = foam * exp(-uDt * decay) + uDt * src * wet * uFoamRate;
  foam = clamp(foam, 0.0, 1.0);

  gl_FragColor = vec4(hN, vel, foam);
}
`;

// Sand wetness memory and the groove left by the character.
export const WET_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D tWet;
uniform vec4 uTrail; // x, z, radius, active
uniform float uDryTime;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = stateAt(c);
  vec4 w = texelFetch(tWet, c, 0);
  float wet = max(w.r * exp(-uDt / uDryTime), smoothstep(0.002, 0.012, s.r));
  float d = distance(cellWorld(c), uTrail.xy);
  float groove = (1.0 - smoothstep(uTrail.z * 0.35, uTrail.z, d)) * uTrail.w;
  float trail = max(w.g, groove);
  trail *= exp(-uDt * (0.004 + step(0.01, s.r) * length(s.gb) * 0.2));
  gl_FragColor = vec4(wet, trail, 0.0, 0.0);
}
`;

// Render surface: extrapolates the water plane into dry cells so the shoreline intersects terrain cleanly.
export const RENDER_A_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D tWet;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = stateAt(c);
  float bed = bedAt(c);
  float surf;
  if (s.r > 0.002) {
    surf = bed + s.r;
  } else {
    float sum = 0.0, cnt = 0.0;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      ivec2 n = c + ivec2(i, j);
      if ((i == 0 && j == 0) || !inside(n)) continue;
      float hn = texelFetch(tState, n, 0).r;
      if (hn > 0.002) { sum += bedAt(n) + hn; cnt += 1.0; }
    }
    surf = cnt > 0.0 ? min(sum / cnt, bed) - 0.004 : bed - 1.0;
  }
  float wet = texelFetch(tWet, c, 0).r;
  gl_FragColor = vec4(surf, s.r, s.a, wet);
}
`;

export const RENDER_B_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D tWet;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = stateAt(c);
  float trail = texelFetch(tWet, c, 0).g;
  gl_FragColor = vec4(s.g, s.b, trail, 0.0);
}
`;

export const INIT_FRAG = /* glsl */ `
${HEADER}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  gl_FragColor = vec4(max(-bedAt(c), 0.0), 0.0, 0.0, 0.0);
}
`;

export const STAMP_VERT = /* glsl */ `
varying float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vY = wp.y;
  gl_Position = vec4(wp.x / ${HALF.toFixed(1)}, wp.z / ${HALF.toFixed(1)}, -wp.y / 50.0, 1.0);
}
`;

export const STAMP_FRAG = /* glsl */ `
varying float vY;
void main() { gl_FragColor = vec4(vY + 100.0, 0.0, 0.0, 1.0); }
`;
