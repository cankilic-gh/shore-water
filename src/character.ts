import { Camera, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HALF } from './shared';
import type { CharacterInput, WaterSim } from './sim';
import { touch } from './touch';

const SCALE = 1.7;
const HEIGHT = 0.46 * SCALE;
const GRAVITY = 18;
const MAX_STEP = 0.26;
// Buoyancy balances gravity at ~28% immersion: the duck rides high like a real one.
const BUOYANCY = 1 / 0.28;

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const jumpPressed = () => keys.has('Space') || touch.jump;

const forward = new Vector3();
const right = new Vector3();
const move = new Vector3();
const UP = new Vector3(0, 1, 0);

interface DuckRig {
  root: Object3D;
  body: Object3D;
  head: Object3D;
  wingL: Object3D;
  wingR: Object3D;
  legL: Object3D;
  legR: Object3D;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (a: number, b: number, rate: number, dt: number) => a + (b - a) * (1 - Math.exp(-rate * dt));

export class Character {
  readonly mesh = new Group();
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  grounded = false;
  immersion = 0;
  waterSurface = 0;
  bedHere = 0;
  private rig: DuckRig | null = null;
  private jumpHeld = false;
  private airJumps = 0;
  private heading = 0;
  private gait = 0;
  private flap = 0;
  private time = 0;
  private bob = 0;

  constructor(private sim: WaterSim, x: number, z: number) {
    this.pos.set(x, sim.bedAt(x, z), z);
    this.heading = -2.2;
    new GLTFLoader().load(`${import.meta.env.BASE_URL}models/duck.glb`, (gltf) => {
      const root = gltf.scene;
      root.scale.setScalar(SCALE);
      root.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.receiveShadow = true;
        const mat = m.material as MeshStandardMaterial;
        mat.envMapIntensity = 0.7;
      });
      const get = (name: string) => root.getObjectByName(name) ?? new Object3D();
      this.rig = {
        root,
        body: get('Body'),
        head: get('Head'),
        wingL: get('WingL'),
        wingR: get('WingR'),
        legL: get('LegL'),
        legR: get('LegR'),
      };
      this.mesh.add(root);
    });
  }

  update(dt: number, camera: Camera): CharacterInput {
    const { sim, pos, vel } = this;
    this.time += dt;
    const probe = sim.probe;
    this.bedHere = sim.bedAt(pos.x, pos.z);
    const depth = probe[0];
    this.waterSurface = depth > 0.003 ? this.bedHere + depth : this.bedHere;
    const submergedDepth = Math.max(this.waterSurface - pos.y, 0);
    this.immersion = Math.min(submergedDepth / HEIGHT, 1);
    const imm = this.immersion;
    const swimming = imm > 0.12;

    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, UP).normalize();
    move.set(0, 0, 0);
    if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward);
    if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward);
    if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
    if (Math.hypot(touch.x, touch.y) > 0.12) move.addScaledVector(forward, -touch.y).addScaledVector(right, touch.x);
    const moving = move.lengthSq() > 0;
    if (move.lengthSq() > 1) move.normalize();

    const speed = swimming ? 2.3 : 2.8;
    const accel = this.grounded ? 10 : swimming ? 3.5 : 2.2;
    const k = 1 - Math.exp(-dt * accel);
    vel.x += (move.x * speed - vel.x) * k;
    vel.z += (move.z * speed - vel.z) * k;

    // Currents carry the duck along with the water.
    if (imm > 0) {
      const c = 1 - Math.exp(-dt * 2.2 * Math.min(imm * 3, 1));
      vel.x += (probe[1] - vel.x) * c * (moving ? 0.3 : 1);
      vel.z += (probe[2] - vel.z) * c * (moving ? 0.3 : 1);
    }

    // Holding jump while falling flutters the wings and slows the descent.
    const jump = jumpPressed();
    const gliding = jump && !this.grounded && !swimming && vel.y < 0;
    vel.y -= GRAVITY * (gliding ? 0.35 : 1) * dt;
    vel.y += GRAVITY * BUOYANCY * imm * dt;
    vel.y *= Math.exp(-dt * 6 * Math.min(imm * 3, 1));

    if (jump && !this.jumpHeld) {
      if (this.grounded || swimming) {
        vel.y = swimming ? 5.6 : 6.0;
        this.grounded = false;
        this.airJumps = 1;
        this.flap = 1;
      } else if (this.airJumps > 0) {
        vel.y = Math.max(vel.y, 5.4);
        this.airJumps--;
        this.flap = 1;
      }
    }
    this.jumpHeld = jump;

    const tryMove = (nx: number, nz: number) => {
      const g = sim.bedAt(nx, nz);
      if (g - pos.y > MAX_STEP) return false;
      pos.x = nx;
      pos.z = nz;
      return true;
    };
    const lim = HALF - 0.3;
    const nx = Math.min(Math.max(pos.x + vel.x * dt, -lim), lim);
    const nz = Math.min(Math.max(pos.z + vel.z * dt, -lim), lim);
    if (!tryMove(nx, nz)) {
      if (!tryMove(nx, pos.z)) vel.x = 0;
      if (!tryMove(pos.x, nz)) vel.z = 0;
    }

    const ground = sim.bedAt(pos.x, pos.z);
    const wasGrounded = this.grounded;
    pos.y += vel.y * dt;
    if (pos.y <= ground) {
      pos.y = ground;
      vel.y = Math.max(vel.y, 0);
      this.grounded = true;
    } else if (wasGrounded && vel.y <= 0 && pos.y - ground < 0.2 && imm < 0.2) {
      pos.y = ground;
      vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    if (this.grounded || swimming) this.airJumps = 1;

    const horiz = Math.hypot(vel.x, vel.z);
    this.animate(dt, horiz, swimming, moving);

    return {
      x: pos.x,
      z: pos.z,
      vx: vel.x,
      vz: vel.z,
      pressure: Math.min(submergedDepth, 0.35) * 0.3,
      foam: imm > 0 ? 0.12 + horiz * 0.3 + Math.max(-vel.y, 0) * 0.9 : 0,
      trail: this.grounded && pos.y - ground < 0.02 && imm < 0.2,
    };
  }

  private animate(dt: number, horiz: number, swimming: boolean, moving: boolean) {
    const { pos, vel } = this;
    if (horiz > 0.25) {
      const target = Math.atan2(vel.x, vel.z);
      this.heading += wrapAngle(target - this.heading) * (1 - Math.exp(-dt * 10));
    }
    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.mesh.rotation.set(0, this.heading, 0);

    const rig = this.rig;
    if (!rig) return;
    const t = this.time;
    const onLand = this.grounded && !swimming;
    const inAir = !this.grounded && !swimming;

    // Gait phase advances with speed: quick waddle on land, steady paddle in water.
    this.gait += dt * (onLand ? 4 + horiz * 5.5 : swimming ? 3 + horiz * 4 : 0);
    const s = Math.sin(this.gait);
    this.flap = Math.max(this.flap - dt * 1.6, inAir ? 0.35 : 0);
    if (inAir && jumpPressed()) this.flap = Math.max(this.flap, 0.8);

    let legSwing = 0;
    let legTuck = 0;
    let roll = 0;
    let bodyLift = 0;
    let headPitch = Math.sin(t * 1.3) * 0.04;
    let headYaw = Math.sin(t * 0.47) * 0.25 * (moving ? 0.2 : 1);
    if (onLand) {
      const amt = Math.min(horiz / 1.5, 1);
      legSwing = s * 0.75 * amt;
      roll = s * 0.11 * amt;
      bodyLift = Math.abs(Math.cos(this.gait)) * 0.015 * amt;
      headPitch += Math.sin(this.gait * 2) * 0.16 * amt;
    } else if (swimming) {
      legSwing = s * 0.5;
      legTuck = 0.6;
      this.bob = damp(this.bob, Math.sin(t * 2.1) * 0.01, 4, dt);
      bodyLift = this.bob;
      roll = Math.sin(t * 1.7) * 0.04;
      headPitch += Math.sin(this.gait * 2) * 0.05;
    } else {
      legTuck = 0.9;
      headPitch -= 0.15;
    }

    rig.legL.rotation.x = legSwing + legTuck;
    rig.legR.rotation.x = -legSwing + legTuck;
    rig.root.rotation.z = damp(rig.root.rotation.z, roll, 14, dt);
    rig.root.position.y = bodyLift;
    rig.head.rotation.x = damp(rig.head.rotation.x, headPitch, 12, dt);
    rig.head.rotation.y = damp(rig.head.rotation.y, headYaw, 3, dt);

    const flapAngle = this.flap > 0.01 ? 0.25 + (0.5 + 0.5 * Math.sin(t * 24)) * 1.1 * this.flap : 0;
    rig.wingL.rotation.z = damp(rig.wingL.rotation.z, flapAngle, 20, dt);
    rig.wingR.rotation.z = damp(rig.wingR.rotation.z, -flapAngle, 20, dt);
    const tilt = this.grounded ? 0 : Math.max(Math.min(-vel.y * 0.04, 0.25), -0.25);
    rig.root.rotation.x = damp(rig.root.rotation.x, tilt, 6, dt);
  }
}
