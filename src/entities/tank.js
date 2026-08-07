import * as THREE from 'three';
import { MAP_RADIUS } from '../world/world.js';
import { terrainHeight } from '../world/terrain.js';
import { resolvePoint, removeCollider } from '../world/colliders.js';
import { box, cyl } from '../core/assets.js';

// Unique names: the single-file build merges every module into one scope
const TANK_MAX_SPEED = 11;
const TANK_ACCEL = 16;
const TANK_FRICTION = 5;

// A small one-man tank (very ahistorical, very fun). Same drive interface as
// the horse Player so main.js can swap between them: slower, heavier steering,
// crushes fences at speed, and its turret tracks the camera. The cannon
// itself is fired by main.js on a 3-second cooldown.
export class Tank {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    this.meshRoot = new THREE.Group();
    this.group.add(this.meshRoot);

    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.slopePitch = 0;
    this.hp = 130;
    this.maxHp = 130;
    this.timeSinceHurt = 99;

    // Interface parity with Player (main.js checks these)
    this.mounted = true;
    this.airborne = false;
    this.justLanded = false;
    this.jumpOffset = 0;
    this.bloodDecals = [];
    this._bloodShown = 0;
    this.brokeFence = null;
    this.legs = [];

    this._build();
    this.meshRoot.scale.setScalar(2); // a proper tank, twice the size
    this.group.position.y = terrainHeight(0, 0);
    scene.add(this.group);
  }

  _build() {
    const olive = 0x4a523a;
    const oliveDark = 0x3a4030;
    const steel = { roughness: 0.5, metalness: 0.55 };

    // Hull
    const hull = box(1.5, 0.55, 2.3, olive, steel);
    hull.position.y = 0.85;
    this.meshRoot.add(hull);

    const glacis = box(1.3, 0.35, 0.5, oliveDark, steel);
    glacis.position.set(0, 0.95, 1.25);
    glacis.rotation.x = 0.5;
    this.meshRoot.add(glacis);

    // Tracks with road-wheel bumps
    for (const side of [-1, 1]) {
      const track = box(0.42, 0.6, 2.6, 0x24261f, { roughness: 0.9 });
      track.position.set(side * 0.85, 0.5, 0);
      this.meshRoot.add(track);
      for (let i = 0; i < 4; i++) {
        const wheel = cyl(0.18, 0.18, 0.44, 0x1a1c16, {}, 8);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * 0.85, 0.28, -0.9 + i * 0.6);
        this.meshRoot.add(wheel);
      }
    }

    // Turret (tracks the camera) + cannon
    this.turret = new THREE.Group();
    this.turret.position.set(0, 1.25, -0.15);
    this.meshRoot.add(this.turret);

    const dome = cyl(0.5, 0.62, 0.42, olive, steel, 10);
    dome.position.y = 0.2;
    this.turret.add(dome);

    const hatch = cyl(0.2, 0.2, 0.08, oliveDark, steel, 8);
    hatch.position.y = 0.45;
    this.turret.add(hatch);

    const barrel = cyl(0.07, 0.09, 1.35, 0x2b2f33, steel, 10);
    barrel.rotation.x = Math.PI / 2 - 0.06;
    barrel.position.set(0, 0.22, 0.9);
    this.turret.add(barrel);

    const muzzleBrake = cyl(0.1, 0.1, 0.14, 0x22262a, steel, 8);
    muzzleBrake.rotation.x = Math.PI / 2 - 0.06;
    muzzleBrake.position.set(0, 0.26, 1.52);
    this.turret.add(muzzleBrake);

    // Cannon muzzle anchor + first-person eye on the hatch
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.27, 1.62);
    this.turret.add(this.muzzle);

    this.eyeAnchor = new THREE.Object3D();
    this.eyeAnchor.position.set(0, 0.7, 0);
    this.turret.add(this.eyeAnchor);
  }

  get position() {
    return this.group.position;
  }

  get speedRatio() {
    return Math.min(this.velocity.length() / TANK_MAX_SPEED, 1);
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    this.timeSinceHurt = 0;
  }

  // Interface no-ops (horse-specific features)
  setReloadT() {}
  addBlood() {}
  swingSword() {}
  toggleMount() {}
  setFirstPerson(fp) {
    this.turret.visible = !fp;
  }

  update(dt, input, camCtrl) {
    const fwd = camCtrl.getGroundForward();
    const right = camCtrl.getGroundRight();
    const move = new THREE.Vector3();
    if (input.isDown('KeyW')) move.add(fwd);
    if (input.isDown('KeyS')) move.sub(fwd);
    if (input.isDown('KeyD')) move.add(right);
    if (input.isDown('KeyA')) move.sub(right);

    if (move.lengthSq() > 0) {
      move.normalize();
      const speed = this.velocity.length();
      if (speed < 1) {
        this.velocity.addScaledVector(move, TANK_ACCEL * dt * 0.7);
      } else {
        // Tracks turn even slower than hooves
        const curA = Math.atan2(this.velocity.x, this.velocity.z);
        const desA = Math.atan2(move.x, move.z);
        let dA = desA - curA;
        while (dA > Math.PI) dA -= Math.PI * 2;
        while (dA < -Math.PI) dA += Math.PI * 2;
        const maxTurn = THREE.MathUtils.lerp(2.0, 0.9, this.speedRatio) * dt;
        const newA = curA + THREE.MathUtils.clamp(dA, -maxTurn, maxTurn);
        const alignment = Math.cos(desA - newA);
        let newSpeed = speed + TANK_ACCEL * dt * Math.max(alignment, -0.7);
        newSpeed = THREE.MathUtils.clamp(newSpeed, 0, TANK_MAX_SPEED);
        this.velocity.set(Math.sin(newA) * newSpeed, 0, Math.cos(newA) * newSpeed);
      }
    } else {
      const damp = Math.max(0, 1 - TANK_FRICTION * dt);
      this.velocity.multiplyScalar(damp);
      if (this.velocity.lengthSq() < 0.01) this.velocity.set(0, 0, 0);
    }

    this.group.position.x += this.velocity.x * dt;
    this.group.position.z += this.velocity.z * dt;

    const r = Math.hypot(this.group.position.x, this.group.position.z);
    if (r > MAP_RADIUS) {
      this.group.position.x *= MAP_RADIUS / r;
      this.group.position.z *= MAP_RADIUS / r;
    }

    // Solid props; a tank flattens fence sections at any real speed
    const speedNow = this.velocity.length();
    const hit = resolvePoint(this.group.position, 2.3);
    if (hit) {
      const c = hit.collider;
      if (c && c.kind === 'segment' && c.breakable && speedNow > 4) {
        removeCollider(c);
        this.brokeFence = {
          pos: this.group.position.clone(),
          pieces: c.pieces || [],
          dir: this.velocity.clone().normalize(),
        };
        this.velocity.multiplyScalar(0.92);
      } else {
        this.velocity.multiplyScalar(0.5);
      }
    }

    // Hull heading + terrain
    if (speedNow > 0.5) {
      const targetHeading = Math.atan2(this.velocity.x, this.velocity.z);
      let diff = targetHeading - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.heading += diff * Math.min(1, 4 * dt);
    }
    this.group.rotation.y = this.heading;
    this.group.position.y = terrainHeight(this.group.position.x, this.group.position.z);

    const sx = Math.sin(this.heading), sz = Math.cos(this.heading);
    const ahead = terrainHeight(this.group.position.x + sx * 1.6, this.group.position.z + sz * 1.6);
    const behind = terrainHeight(this.group.position.x - sx * 1.6, this.group.position.z - sz * 1.6);
    this.slopePitch = THREE.MathUtils.lerp(this.slopePitch, Math.atan2(behind - ahead, 3.2), Math.min(1, 6 * dt));
    this.group.rotation.x = this.slopePitch;

    // Turret follows the camera aim
    let turretYaw = (camCtrl.yaw + Math.PI) - this.heading;
    while (turretYaw > Math.PI) turretYaw -= Math.PI * 2;
    while (turretYaw < -Math.PI) turretYaw += Math.PI * 2;
    this.turret.rotation.y = THREE.MathUtils.lerp(this.turret.rotation.y, turretYaw, Math.min(1, 8 * dt));

    this.timeSinceHurt += dt;
    if (this.timeSinceHurt > 5 && this.hp > 0) {
      this.hp = Math.min(this.maxHp, this.hp + 4 * dt);
    }
  }

  reset() {
    this.group.position.set(0, terrainHeight(0, 0), 0);
    this.velocity.set(0, 0, 0);
    this.hp = this.maxHp;
    this.heading = 0;
    this.timeSinceHurt = 99;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
