import * as THREE from 'three';
import { MAP_RADIUS } from '../world/world.js';
import { terrainHeight } from '../world/terrain.js';
import { resolvePoint, removeCollider } from '../world/colliders.js';
import { box, cyl, sphere, capsule } from '../core/assets.js';

const MAX_SPEED = 17;
const ACCEL = 42;
const FRICTION = 8;
const JUMP_VELOCITY = 9.5;
const GRAVITY = 24;

const ease = (t) => t * t * (3 - 2 * t); // smoothstep

// Painted blood-splatter texture: an irregular smeared blob with running
// drips and speckles, alpha-cut so it reads as gore on the coat, not a box.
let _splatTex = null;
function makeSplatterTexture() {
  if (_splatTex) return _splatTex;
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  const reds = ['#7c0f09', '#8e130c', '#690c07', '#9c1a10'];
  // Central irregular blob: overlapping ellipses
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = reds[(Math.random() * reds.length) | 0];
    ctx.globalAlpha = 0.75 + Math.random() * 0.25;
    ctx.beginPath();
    ctx.ellipse(
      S / 2 + (Math.random() - 0.5) * 26,
      S / 2 - 8 + (Math.random() - 0.5) * 20,
      8 + Math.random() * 17,
      6 + Math.random() * 13,
      Math.random() * Math.PI, 0, Math.PI * 2
    );
    ctx.fill();
  }
  // Drips running downward
  for (let i = 0; i < 6; i++) {
    const x = S / 2 + (Math.random() - 0.5) * 36;
    const y0 = S / 2 + Math.random() * 8;
    const len = 14 + Math.random() * 30;
    ctx.fillStyle = reds[(Math.random() * reds.length) | 0];
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.ellipse(x, y0 + len / 2, 1.6 + Math.random() * 1.6, len / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y0 + len, 2.4 + Math.random() * 1.4, 0, Math.PI * 2); // hanging droplet
    ctx.fill();
  }
  // Fine speckles around the impact
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = reds[(Math.random() * reds.length) | 0];
    ctx.globalAlpha = 0.5 + Math.random() * 0.5;
    ctx.beginPath();
    ctx.arc(Math.random() * S, Math.random() * S * 0.8 + S * 0.1, 0.8 + Math.random() * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  _splatTex = new THREE.CanvasTexture(canvas);
  return _splatTex;
}

// The player: an American rider (blue continental coat) on a horse. Model
// faces +Z at yaw 0. Visual bob lives on `meshRoot` so the camera (which
// follows `group`) stays perfectly smooth.
export class Player {
  constructor(scene) {
    this.group = new THREE.Group();          // logical root: terrain + jump height
    this.group.rotation.order = 'YXZ';
    this.meshRoot = new THREE.Group();       // visual root: gallop bob only
    this.group.add(this.meshRoot);

    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.slopePitch = 0;
    this.legPhase = 0;
    this.hp = 100;
    this.maxHp = 100;
    this.timeSinceHurt = 99;

    // Jump state
    this.jumpOffset = 0;    // height above the terrain
    this.vy = 0;
    this.airborne = false;
    this.justLanded = false;
    this._spaceWasDown = false;

    this._reloadT = null;   // null = not reloading
    this.recoil = 0;        // 0..1 gun kickback, decays each frame

    this.scene = scene;
    this.mounted = true;    // E toggles: dismount / remount near the horse
    this._parked = null;    // where the horse waits while on foot
    this._swingT = null;    // sword swing progress

    this._buildHorse();
    this._buildRider();
    this._buildUzi();
    this._buildFootRig();
    this._buildSword();

    scene.add(this.group);
  }

  dispose() {
    this.scene.remove(this.group);
    if (this._parked) this.scene.remove(this.meshRoot);
  }

  // ---------------- model ----------------

  _buildHorse() {
    // A white charger: pale coat, silver-grey points and mane
    const coat = 0xe9e6df;
    const coatDark = 0xc9c5bb;
    const mane = 0x9a958a;

    // Body: rounded barrel + spherical chest and hindquarters for a real
    // equine silhouette instead of stacked crates
    const barrel = cyl(0.52, 0.55, 1.5, coat, {}, 14);
    barrel.rotation.x = Math.PI / 2;
    barrel.scale.x = 0.94;
    barrel.position.set(0, 1.4, 0);
    this.meshRoot.add(barrel);

    const chest = sphere(0.52, coat, {}, 12);
    chest.scale.set(0.92, 1.02, 0.85);
    chest.position.set(0, 1.42, 0.9);
    this.meshRoot.add(chest);

    const rump = sphere(0.5, coatDark, {}, 12);
    rump.scale.set(0.96, 0.96, 0.9);
    rump.position.set(0, 1.42, -0.9);
    this.meshRoot.add(rump);

    // Neck & head: tapered neck, rounded skull, conical snout
    const neck = cyl(0.19, 0.33, 1.05, coat, {}, 12);
    neck.position.set(0, 2.05, 1.22);
    neck.rotation.x = 0.5;
    this.meshRoot.add(neck);

    const skull = sphere(0.27, coat, {}, 12);
    skull.scale.set(0.8, 0.9, 1.15);
    skull.position.set(0, 2.62, 1.62);
    this.meshRoot.add(skull);

    const snout = cyl(0.13, 0.19, 0.5, coatDark, {}, 10);
    snout.rotation.x = Math.PI / 2 + 0.15;
    snout.position.set(0, 2.5, 2.0);
    this.meshRoot.add(snout);

    for (const side of [-1, 1]) {
      const eye = sphere(0.05, 0x14100c, {}, 8);
      eye.position.set(side * 0.19, 2.72, 1.72);
      this.meshRoot.add(eye);

      const ear = cyl(0.02, 0.07, 0.26, coatDark, {}, 6);
      ear.position.set(side * 0.14, 2.95, 1.42);
      ear.rotation.z = side * -0.15;
      this.meshRoot.add(ear);
    }

    // Mane ridge along the neck + tail
    const maneStrip = cyl(0.11, 0.11, 1.0, mane, {}, 8);
    maneStrip.scale.z = 0.55;
    maneStrip.position.set(0, 2.25, 1.05);
    maneStrip.rotation.x = -0.5;
    this.meshRoot.add(maneStrip);

    const forelock = sphere(0.13, mane, {}, 8);
    forelock.scale.set(0.8, 0.9, 1.2);
    forelock.position.set(0, 2.88, 1.55);
    this.meshRoot.add(forelock);

    const tail = cyl(0.1, 0.05, 1.0, mane, {}, 6);
    tail.position.set(0, 1.35, -1.42);
    tail.rotation.x = 0.55;
    this.meshRoot.add(tail);

    // Legs: upper (thigh) + lower (cannon) + hoof, swinging from the hip
    this.legs = [];
    const legPositions = [
      [-0.34, 1.0, 0.85, 0],
      [0.34, 1.0, 0.85, 1],
      [-0.34, 1.0, -0.85, 1],
      [0.34, 1.0, -0.85, 0],
    ];
    for (const [x, y, z, phaseGroup] of legPositions) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);

      const thigh = cyl(0.15, 0.11, 0.55, coat, {}, 7);
      thigh.position.y = -0.26;
      pivot.add(thigh);

      const cannon = cyl(0.1, 0.08, 0.5, coatDark, {}, 7);
      cannon.position.y = -0.75;
      pivot.add(cannon);

      const hoof = cyl(0.1, 0.12, 0.14, 0x1c1813, {}, 8);
      hoof.position.y = -1.02;
      pivot.add(hoof);

      pivot.userData.phaseGroup = phaseGroup;
      this.legs.push(pivot);
      this.meshRoot.add(pivot);
    }

    // Tack: saddle blanket, saddle, girth strap, reins
    const blanket = box(1.1, 0.1, 1.05, 0x8b2e2e);
    blanket.position.y = 1.95;
    this.meshRoot.add(blanket);

    const blanketTrim = box(1.12, 0.04, 1.07, 0xc9a44a);
    blanketTrim.position.y = 1.9;
    this.meshRoot.add(blanketTrim);

    const saddle = box(0.8, 0.16, 0.75, 0x4a2f18);
    saddle.position.y = 2.05;
    this.meshRoot.add(saddle);

    const pommel = box(0.24, 0.16, 0.14, 0x4a2f18);
    pommel.position.set(0, 2.16, 0.38);
    this.meshRoot.add(pommel);

    // Hidden gore decals — flat smeared splatter planes hugging the coat,
    // revealed one by one as the horse wades through blood pools (addBlood)
    this.bloodDecals = [];
    this._bloodShown = 0;

    const splatMat = new THREE.MeshStandardMaterial({
      map: makeSplatterTexture(),
      transparent: true,
      alphaTest: 0.12,
      roughness: 0.5,
      side: THREE.DoubleSide,
    });
    const splatGeo = new THREE.PlaneGeometry(0.55, 0.42);
    const makeSplat = (parent, x, y, z, ry) => {
      const splat = new THREE.Mesh(splatGeo, splatMat);
      splat.position.set(x, y, z);
      splat.rotation.y = ry;
      splat.rotation.z = Math.random() * Math.PI * 2; // random smear direction
      splat.scale.set(1.1 + Math.random() * 0.8, 0.8 + Math.random() * 0.5, 1); // stretched = smeared
      splat.visible = false;
      splat.castShadow = false;
      parent.add(splat);
      this.bloodDecals.push(splat);
    };

    // Flanks (facing outward), chest (facing forward), hindquarters
    makeSplat(this.meshRoot, 0.52, 1.3, 0.3, Math.PI / 2);
    makeSplat(this.meshRoot, -0.52, 1.2, 0.1, -Math.PI / 2);
    makeSplat(this.meshRoot, 0.52, 1.5, -0.5, Math.PI / 2);
    makeSplat(this.meshRoot, -0.52, 1.4, -0.6, -Math.PI / 2);
    makeSplat(this.meshRoot, 0.48, 1.1, 0.75, Math.PI / 2);
    makeSplat(this.meshRoot, -0.48, 1.05, 0.6, -Math.PI / 2);
    makeSplat(this.meshRoot, 0.15, 1.15, 1.32, 0);
    makeSplat(this.meshRoot, -0.2, 1.35, 1.31, 0);
    // One per leg (parented to the leg pivot so it swings with the stride)
    for (const [i, leg] of this.legs.entries()) {
      const side = i % 2 === 0 ? -1 : 1;
      const splat = new THREE.Mesh(splatGeo, splatMat);
      splat.position.set(side * 0.17, -0.5, 0);
      splat.rotation.y = side * Math.PI / 2;
      splat.rotation.z = Math.random() * Math.PI * 2;
      splat.scale.set(0.55, 0.75, 1);
      splat.visible = false;
      splat.castShadow = false;
      leg.add(splat);
      this.bloodDecals.push(splat);
    }

    const girth = box(1.06, 0.9, 0.14, 0x2e241a);
    girth.position.set(0, 1.45, 0.1);
    this.meshRoot.add(girth);

    for (const side of [-1, 1]) {
      const rein = box(0.03, 0.03, 1.6, 0x2e241a);
      rein.position.set(side * 0.26, 2.45, 0.9);
      rein.rotation.x = -0.25;
      this.meshRoot.add(rein);
    }
  }

  _buildRider() {
    const coatBlue = 0x24408f;
    const coatBlueDark = 0x1b3070;
    const skin = 0xd9a06b;
    const buff = 0xd8cfb4;
    const gold = 0xc9a44a;

    // Legs straddling the saddle (grouped so they hide when dismounted)
    this.mountedLegs = new THREE.Group();
    this.meshRoot.add(this.mountedLegs);
    for (const side of [-1, 1]) {
      const thigh = capsule(0.12, 0.4, buff, {}, 10);
      thigh.position.set(side * 0.5, 2.08, 0.05);
      thigh.rotation.z = side * 1.15;
      this.mountedLegs.add(thigh);

      const shin = capsule(0.09, 0.36, 0x2a2119, {}, 10);
      shin.position.set(side * 0.66, 1.72, 0.08);
      this.mountedLegs.add(shin);

      const bootCuff = cyl(0.105, 0.105, 0.12, 0x3a2e20, {}, 10);
      bootCuff.position.set(side * 0.66, 1.99, 0.08);
      this.mountedLegs.add(bootCuff);

      const foot = sphere(0.1, 0x201a12, {}, 8);
      foot.scale.set(0.9, 0.55, 1.8);
      foot.position.set(side * 0.66, 1.46, 0.14);
      this.mountedLegs.add(foot);
    }

    // Upper body pivots to track the camera aim
    this.riderUpper = new THREE.Group();
    this.riderUpper.position.set(0, 2.2, 0);
    this.meshRoot.add(this.riderUpper);

    // Elliptical coat barrel instead of a box torso
    const torso = cyl(0.3, 0.34, 0.85, coatBlue, {}, 12);
    torso.scale.z = 0.68;
    torso.position.y = 0.5;
    this.riderUpper.add(torso);

    // White facing panel + buttons down the chest
    const facing = box(0.26, 0.68, 0.05, buff);
    facing.position.set(0, 0.5, 0.19);
    this.riderUpper.add(facing);

    for (let i = 0; i < 4; i++) {
      const btn = sphere(0.028, gold, { roughness: 0.4, metalness: 0.7 }, 6);
      btn.position.set(0.1, 0.24 + i * 0.18, 0.22);
      this.riderUpper.add(btn);
    }

    // Rounded epaulettes + collar
    for (const side of [-1, 1]) {
      const ep = cyl(0.09, 0.09, 0.22, gold, {}, 8);
      ep.rotation.z = Math.PI / 2;
      ep.position.set(side * 0.32, 0.94, 0.02);
      this.riderUpper.add(ep);
    }
    const collar = cyl(0.2, 0.23, 0.14, coatBlueDark, {}, 10);
    collar.scale.z = 0.8;
    collar.position.y = 0.96;
    this.riderUpper.add(collar);

    // Coat tails draped behind the saddle
    const tails = box(0.5, 0.5, 0.1, coatBlueDark);
    tails.position.set(0, 0.02, -0.24);
    tails.rotation.x = 0.35;
    this.riderUpper.add(tails);

    // Head: rounded face with a neck, eyes, nose, hair cap
    const neckJoint = cyl(0.09, 0.11, 0.16, skin, {}, 8);
    neckJoint.position.y = 1.0;
    this.riderUpper.add(neckJoint);

    const head = sphere(0.22, skin, {}, 14);
    head.scale.set(0.9, 1.06, 0.94);
    head.position.y = 1.24;
    this.riderUpper.add(head);

    for (const side of [-1, 1]) {
      const eye = sphere(0.032, 0x1a140e, {}, 6);
      eye.position.set(side * 0.08, 1.29, 0.18);
      this.riderUpper.add(eye);
    }
    const nose = sphere(0.05, 0xcf9662, {}, 8);
    nose.scale.set(0.8, 1.25, 0.9);
    nose.position.set(0, 1.21, 0.2);
    this.riderUpper.add(nose);

    const hair = sphere(0.22, 0x4a3018, {}, 12);
    hair.scale.set(0.96, 0.7, 1.0);
    hair.position.set(0, 1.4, -0.03);
    this.riderUpper.add(hair);

    const queue = cyl(0.045, 0.03, 0.28, 0x4a3018, {}, 6); // colonial ponytail
    queue.position.set(0, 1.24, -0.22);
    queue.rotation.x = 0.25;
    this.riderUpper.add(queue);

    // Tricorn hat: triangular brim + crown + cockade
    const brim = cyl(0.4, 0.4, 0.06, 0x1a1611, {}, 3);
    brim.position.y = 1.52;
    brim.rotation.y = Math.PI / 6;
    this.riderUpper.add(brim);

    const crown = cyl(0.2, 0.24, 0.2, 0x1a1611, {}, 8);
    crown.position.y = 1.63;
    this.riderUpper.add(crown);

    const cockade = box(0.09, 0.09, 0.03, 0x8b8fd6);
    cockade.position.set(0.16, 1.55, 0.3);
    this.riderUpper.add(cockade);

    // First-person camera anchor at the rider's eyes
    this.eyeAnchor = new THREE.Object3D();
    this.eyeAnchor.position.set(0, 1.3, 0.12);
    this.riderUpper.add(this.eyeAnchor);

    // Buff sash across the chest
    const sash = box(0.62, 0.13, 0.42, buff);
    sash.position.y = 0.56;
    sash.rotation.z = 0.6;
    this.riderUpper.add(sash);

    // Left arm forward holding the reins (reaches for the mag during reloads)
    this.armL = capsule(0.085, 0.36, coatBlue, {}, 10);
    this.armL.position.set(-0.38, 0.62, 0.16);
    this._armLBase = { x: -1.0, z: -0.3 };
    this.armL.rotation.x = this._armLBase.x;
    this.armL.rotation.z = this._armLBase.z;
    this.riderUpper.add(this.armL);

    const handL = sphere(0.075, skin, {}, 8);
    handL.position.set(-0.44, 0.62, 0.42);
    this.riderUpper.add(handL);

    // Right arm — parented into a group so it follows the gun during reload
    this.armR = new THREE.Group();
    this.armR.position.set(0.4, 0.82, 0.05);
    this.riderUpper.add(this.armR);

    const upperArmR = capsule(0.085, 0.3, coatBlue, {}, 10);
    upperArmR.position.set(0.02, -0.1, 0.12);
    upperArmR.rotation.x = -1.15;
    this.armR.add(upperArmR);

    const cuffR = cyl(0.095, 0.095, 0.12, buff, {}, 10);
    cuffR.position.set(0.02, -0.02, 0.3);
    cuffR.rotation.x = -1.15;
    this.armR.add(cuffR);

    const handR = sphere(0.075, skin, {}, 8);
    handR.position.set(0.02, 0.02, 0.42);
    this.armR.add(handR);
  }

  // High-detail primitive Uzi: receiver, ribbed top cover, barrel & sights,
  // grip, trigger guard, folding stock, charging handle, removable mag.
  _buildUzi() {
    const steel = { roughness: 0.35, metalness: 0.8 };
    const dark = 0x23262b;
    const darker = 0x17191d;
    const gripCol = 0x1d1d1f;

    this.uziGroup = new THREE.Group();
    this._uziRest = { pos: new THREE.Vector3(0.02, 0.02, 0.52), rot: new THREE.Euler(0, 0, 0) };
    this.uziGroup.position.copy(this._uziRest.pos);
    this.armR.add(this.uziGroup);

    const receiver = box(0.13, 0.15, 0.52, dark, steel);
    this.uziGroup.add(receiver);

    const topCover = box(0.11, 0.05, 0.5, darker, steel);
    topCover.position.y = 0.09;
    this.uziGroup.add(topCover);

    // Cooling ribs on the top cover
    for (let i = 0; i < 4; i++) {
      const rib = box(0.115, 0.015, 0.05, 0x2c3036, steel);
      rib.position.set(0, 0.12, -0.16 + i * 0.1);
      this.uziGroup.add(rib);
    }

    const chargingHandle = box(0.05, 0.04, 0.07, 0x33373d, steel);
    chargingHandle.position.set(0, 0.15, -0.05);
    this.uziGroup.add(chargingHandle);

    const barrel = cyl(0.032, 0.032, 0.24, 0x2c3036, steel, 10);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, 0.36);
    this.uziGroup.add(barrel);

    const barrelNut = cyl(0.05, 0.055, 0.06, darker, steel, 10);
    barrelNut.rotation.x = Math.PI / 2;
    barrelNut.position.set(0, 0.02, 0.27);
    this.uziGroup.add(barrelNut);

    const frontSight = box(0.02, 0.08, 0.02, darker, steel);
    frontSight.position.set(0, 0.15, 0.24);
    this.uziGroup.add(frontSight);
    const frontSightGuard = box(0.08, 0.02, 0.02, darker, steel);
    frontSightGuard.position.set(0, 0.19, 0.24);
    this.uziGroup.add(frontSightGuard);

    const rearSight = box(0.07, 0.05, 0.03, darker, steel);
    rearSight.position.set(0, 0.14, -0.22);
    this.uziGroup.add(rearSight);

    // Pistol grip (mag well) + trigger
    const grip = box(0.11, 0.26, 0.14, gripCol, { roughness: 0.6, metalness: 0.2 });
    grip.position.set(0, -0.18, -0.02);
    grip.rotation.x = 0.12;
    this.uziGroup.add(grip);

    const triggerGuard = box(0.02, 0.1, 0.14, darker, steel);
    triggerGuard.position.set(0, -0.14, 0.12);
    this.uziGroup.add(triggerGuard);

    const trigger = box(0.025, 0.06, 0.02, 0x3a3f45, steel);
    trigger.position.set(0, -0.1, 0.1);
    this.uziGroup.add(trigger);

    // Folding stock along the rear
    const stockArm = box(0.04, 0.04, 0.22, 0x2c3036, steel);
    stockArm.position.set(0, -0.04, -0.34);
    this.uziGroup.add(stockArm);
    const stockPad = box(0.1, 0.12, 0.04, darker, steel);
    stockPad.position.set(0, -0.05, -0.45);
    this.uziGroup.add(stockPad);

    // Magazine — separate mesh so the reload animation can eject it
    this.uziMag = box(0.09, 0.3, 0.12, 0x2a2e33, steel);
    this._magRest = new THREE.Vector3(0, -0.42, -0.03);
    this.uziMag.position.copy(this._magRest);
    this.uziMag.rotation.x = 0.12;
    this.uziGroup.add(this.uziMag);

    // Muzzle anchor for flashes/tracers
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.02, 0.5);
    this.uziGroup.add(this.muzzle);
  }

  // Standing rig used while dismounted: walking legs under the same
  // riderUpper (which carries torso, head, arms and the Uzi with it)
  _buildFootRig() {
    this.footRoot = new THREE.Group();
    this.footRoot.visible = false;
    this.group.add(this.footRoot);

    const buff = 0xd8cfb4;
    this.footLegs = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.15, 0.95, 0);
      this.footRoot.add(hip);

      const thigh = capsule(0.105, 0.3, buff, {}, 10);
      thigh.position.y = -0.24;
      hip.add(thigh);

      const boot = cyl(0.09, 0.078, 0.5, 0x2a2119, {}, 10);
      boot.position.y = -0.7;
      hip.add(boot);

      const foot = sphere(0.09, 0x201a12, {}, 8);
      foot.scale.set(0.9, 0.55, 1.7);
      foot.position.set(0, -0.92, 0.06);
      hip.add(foot);

      this.footLegs.push(hip);
    }
    this._footPhase = 0;
  }

  // Cavalry saber in the left hand — hidden until a trample swing
  _buildSword() {
    this.swordPivot = new THREE.Group();
    this.swordPivot.position.set(-0.42, 0.78, 0.1);
    this.swordPivot.visible = false;
    this.riderUpper.add(this.swordPivot);

    const grip = box(0.06, 0.2, 0.06, 0x2e2418);
    grip.position.y = -0.08;
    this.swordPivot.add(grip);

    const guard = box(0.16, 0.04, 0.1, 0xc9a44a, { roughness: 0.4, metalness: 0.7 });
    guard.position.y = -0.2;
    this.swordPivot.add(guard);

    const blade = box(0.035, 0.95, 0.1, 0xd9dee6, { roughness: 0.2, metalness: 0.9 });
    blade.position.y = -0.72;
    this.swordPivot.add(blade);
  }

  // Trample kill: flash the saber through a full cutting arc
  swingSword() {
    this._swingT = 0;
    this.swordPivot.visible = true;
  }

  _updateSword(dt) {
    if (this._swingT == null) return;
    this._swingT += dt / 0.45;
    const t = this._swingT;
    if (t >= 1) {
      this._swingT = null;
      this.swordPivot.visible = false;
      return;
    }
    const kf = this._kf.bind(this);
    // Raised behind the shoulder -> hard diagonal slash -> follow-through
    this.swordPivot.rotation.x = kf(t, [[0, -2.5], [0.45, 0.7], [1, 1.1]]);
    this.swordPivot.rotation.z = kf(t, [[0, 0.9], [0.45, -0.5], [1, -0.8]]);
    this.swordPivot.rotation.y = kf(t, [[0, 0.4], [1, -0.3]]);
  }

  // E: hop off the horse (it waits where you left it) / climb back on nearby
  toggleMount() {
    if (this.mounted) {
      this._parked = {
        pos: this.group.position.clone(),
        heading: this.heading,
      };
      this.scene.attach(this.meshRoot); // horse stays behind, world-frozen
      this.mountedLegs.visible = false;
      this.footRoot.add(this.riderUpper);
      this.riderUpper.position.set(0, 0.95, 0);
      this.footRoot.visible = true;
      this.mounted = false;
      this.velocity.multiplyScalar(0.2);
      // Step aside so you don't stand inside the horse
      this.group.position.x += Math.cos(this.heading) * 1.3;
      this.group.position.z -= Math.sin(this.heading) * 1.3;
      return 'dismounted';
    }
    // Remount only near the waiting horse
    const d = this.group.position.distanceTo(this.meshRoot.position);
    if (d > 3.4) return 'too far';
    this.group.position.set(
      this._parked.pos.x,
      terrainHeight(this._parked.pos.x, this._parked.pos.z),
      this._parked.pos.z
    );
    this.heading = this._parked.heading;
    this.group.rotation.y = this.heading;
    this.group.add(this.meshRoot);
    this.meshRoot.position.set(0, 0, 0);
    this.meshRoot.rotation.set(0, 0, 0);
    this.mountedLegs.visible = true;
    this.riderUpper.position.set(0, 2.2, 0);
    this.meshRoot.add(this.riderUpper);
    this.footRoot.visible = false;
    this.mounted = true;
    this._parked = null;
    return 'mounted';
  }

  // ---------------- state ----------------

  get position() {
    return this.group.position;
  }

  get speedRatio() {
    return Math.min(this.velocity.length() / MAX_SPEED, 1);
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    this.timeSinceHurt = 0;
  }

  // Weapon calls this every frame: t in [0..1] while reloading, null otherwise
  setReloadT(t) {
    this._reloadT = t;
  }

  // Weapon calls this per shot: the uzi kicks back and the muzzle climbs
  kick() {
    this.recoil = Math.min(this.recoil + 0.55, 1);
  }

  // Splashing through a blood pool paints the horse, a few splats a time
  addBlood() {
    for (let i = 0; i < 3 && this._bloodShown < this.bloodDecals.length; i++) {
      this.bloodDecals[this._bloodShown++].visible = true;
    }
  }

  // First person: hide the rider's upper body so it doesn't block the view
  // (the horse stays visible for the riding feel; matrices still update, so
  // the muzzle and eye anchors keep working).
  setFirstPerson(fp) {
    this.riderUpper.visible = !fp;
  }

  // Keyframe interpolator: stops = [[t, value], ...] with cosine easing
  // between neighbours — every curve is C0-continuous, no pops.
  _kf(t, stops) {
    if (t <= stops[0][0]) return stops[0][1];
    for (let i = 0; i < stops.length - 1; i++) {
      const [ta, va] = stops[i];
      const [tb, vb] = stops[i + 1];
      if (t <= tb) {
        const p = (t - ta) / (tb - ta);
        const e = 0.5 - 0.5 * Math.cos(p * Math.PI);
        return va + (vb - va) * e;
      }
    }
    return stops[stops.length - 1][1];
  }

  _applyReloadPose() {
    const t = this._reloadT;
    if (t == null) {
      // Rest pose + recoil kickback: gun slides rearward, muzzle climbs
      this.uziGroup.rotation.set(-0.16 * this.recoil, 0, 0);
      this.uziGroup.position.copy(this._uziRest.pos);
      this.uziGroup.position.z -= 0.09 * this.recoil;
      this.uziGroup.position.y += 0.025 * this.recoil;
      this.uziMag.position.copy(this._magRest);
      this.uziMag.rotation.set(0.12, 0, 0);
      this.uziMag.visible = true;
      this.armL.rotation.x = this._armLBase.x;
      this.armL.rotation.z = this._armLBase.z;
      return;
    }
    const kf = this._kf.bind(this);

    // Gun: tilts up/inward, holds, small seat-bump when the mag locks in,
    // then settles back down — one continuous eased motion.
    this.uziGroup.rotation.x = kf(t, [[0, 0], [0.2, -0.72], [0.78, -0.72], [0.84, -0.62], [1, 0]]);
    this.uziGroup.rotation.z = kf(t, [[0, 0], [0.2, 0.45], [0.82, 0.45], [1, 0]]);
    this.uziGroup.position.y = this._uziRest.pos.y +
      kf(t, [[0, 0], [0.2, 0.12], [0.76, 0.12], [0.8, 0.16], [1, 0]]);

    // Mag: slides down and back with a slight tip, swaps at the bottom of the
    // arc (hidden only while fully clear of the gun), then seats home.
    const magDrop = kf(t, [[0.16, 0], [0.42, 0.6], [0.58, 0.6], [0.82, 0]]);
    this.uziMag.position.set(
      this._magRest.x,
      this._magRest.y - magDrop,
      this._magRest.z - magDrop * 0.2
    );
    this.uziMag.rotation.x = 0.12 + kf(t, [[0.16, 0], [0.42, 0.5], [0.58, 0.5], [0.82, 0]]);
    this.uziMag.visible = !(t > 0.46 && t < 0.54);

    // Left hand lets go of the reins and works the mag
    this.armL.rotation.x = this._armLBase.x +
      kf(t, [[0, 0], [0.25, -0.55], [0.5, -0.35], [0.75, -0.55], [1, 0]]);
    this.armL.rotation.z = this._armLBase.z +
      kf(t, [[0, 0], [0.25, 0.5], [0.75, 0.5], [1, 0]]);
  }

  // ---------------- per-frame ----------------

  update(dt, input, camCtrl) {
    // Camera-relative movement input
    const fwd = camCtrl.getGroundForward();
    const right = camCtrl.getGroundRight();
    const move = new THREE.Vector3();
    if (input.isDown('KeyW')) move.add(fwd);
    if (input.isDown('KeyS')) move.sub(fwd);
    if (input.isDown('KeyD')) move.add(right);
    if (input.isDown('KeyA')) move.sub(right);

    // Shift = sprint: faster cap and harder acceleration, on foot or mounted
    const sprint = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && move.lengthSq() > 0;
    this.sprinting = sprint;

    if (move.lengthSq() > 0 && !this.mounted) {
      // On foot: nimble direct movement, no galloping inertia
      move.normalize();
      const footCap = sprint ? 10.5 : 6.5;
      this.velocity.addScaledVector(move, (sprint ? 38 : 26) * dt);
      if (this.velocity.length() > footCap) this.velocity.setLength(footCap);
    } else if (move.lengthSq() > 0) {
      move.normalize();
      const maxSpd = sprint ? MAX_SPEED * 1.4 : MAX_SPEED;
      const accel = sprint ? ACCEL * 1.3 : ACCEL;
      const speed = this.velocity.length();
      if (speed < 1.5) {
        // From a standstill the horse can step off in any direction
        this.velocity.addScaledVector(move, accel * dt * 0.6);
      } else {
        // At speed the horse carves an arc: its travel direction can only
        // rotate so fast, and asking for a hard reversal bleeds speed first.
        const curA = Math.atan2(this.velocity.x, this.velocity.z);
        const desA = Math.atan2(move.x, move.z);
        let dA = desA - curA;
        while (dA > Math.PI) dA -= Math.PI * 2;
        while (dA < -Math.PI) dA += Math.PI * 2;

        const maxTurn = THREE.MathUtils.lerp(3.2, 1.4, this.speedRatio) * dt;
        const turn = THREE.MathUtils.clamp(dA, -maxTurn, maxTurn);
        const newA = curA + turn;

        // Alignment: 1 = pushing forward, negative = braking into the turn
        const alignment = Math.cos(desA - newA);
        let newSpeed = speed + accel * dt * Math.max(alignment, -0.7);
        newSpeed = THREE.MathUtils.clamp(newSpeed, 0, maxSpd);
        this.velocity.set(Math.sin(newA) * newSpeed, 0, Math.cos(newA) * newSpeed);
      }
      if (this.velocity.length() > maxSpd) this.velocity.setLength(maxSpd);
    } else {
      const damp = Math.max(0, 1 - FRICTION * dt);
      this.velocity.multiplyScalar(damp);
      if (this.velocity.lengthSq() < 0.01) this.velocity.set(0, 0, 0);
    }

    this.group.position.x += this.velocity.x * dt;
    this.group.position.z += this.velocity.z * dt;

    // Clamp to the battlefield
    const r = Math.hypot(this.group.position.x, this.group.position.z);
    if (r > MAP_RADIUS) {
      this.group.position.x *= MAP_RADIUS / r;
      this.group.position.z *= MAP_RADIUS / r;
    }

    // Solid props: trees and houses stop the horse. Fences are fair game —
    // a jumping horse sails over them, a galloping one smashes through.
    const speedNow = this.velocity.length();
    const hit = resolvePoint(this.group.position, this.mounted ? 1.0 : 0.45, {
      skipSegments: this.airborne && this.jumpOffset > 0.4,
    });
    if (hit) {
      const c = hit.collider;
      if (c && c.kind === 'segment' && c.breakable && speedNow > 9) {
        // Smash through: this SECTION of fence shatters, the rest stands
        removeCollider(c);
        this.brokeFence = {
          pos: this.group.position.clone(),
          pieces: c.pieces || (c.fenceGroup ? [...c.fenceGroup.children] : []),
          dir: this.velocity.clone().normalize(),
        };
        this.velocity.multiplyScalar(0.85);
      } else {
        this.velocity.multiplyScalar(0.6);
      }
    }

    // --- jump + terrain following (jumping is the horse's trick) ---
    const spaceDown = input.isDown('Space');
    if (this.mounted && !this.airborne && spaceDown && !this._spaceWasDown) {
      this.airborne = true;
      this.vy = JUMP_VELOCITY;
    }
    this._spaceWasDown = spaceDown;

    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      this.jumpOffset += this.vy * dt;
      if (this.jumpOffset <= 0) {
        this.jumpOffset = 0;
        this.airborne = false;
        this.justLanded = true;
      }
    }
    const th = terrainHeight(this.group.position.x, this.group.position.z);
    this.group.position.y = th + this.jumpOffset;

    // --- smoothly rotate the horse toward its direction of travel ---
    const speed = this.velocity.length();
    if (speed > 0.5) {
      const targetHeading = Math.atan2(this.velocity.x, this.velocity.z);
      let diff = targetHeading - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.heading += diff * Math.min(1, 6 * dt); // the body lags the turn
    }
    this.group.rotation.y = this.heading;

    // Pitch the horse to match the slope it's standing on
    const sx = Math.sin(this.heading), sz = Math.cos(this.heading);
    const ahead = terrainHeight(this.group.position.x + sx * 1.6, this.group.position.z + sz * 1.6);
    const behind = terrainHeight(this.group.position.x - sx * 1.6, this.group.position.z - sz * 1.6);
    const targetPitch = !this.mounted ? 0 : this.airborne
      ? THREE.MathUtils.clamp(-this.vy * 0.03, -0.25, 0.3)
      : Math.atan2(behind - ahead, 3.2);
    this.slopePitch = THREE.MathUtils.lerp(this.slopePitch, targetPitch, Math.min(1, 8 * dt));
    this.group.rotation.x = this.slopePitch;

    // Rider's upper body twists toward the camera aim direction
    let riderYaw = (camCtrl.yaw + Math.PI) - this.heading;
    while (riderYaw > Math.PI) riderYaw -= Math.PI * 2;
    while (riderYaw < -Math.PI) riderYaw += Math.PI * 2;
    this.riderUpper.rotation.y = THREE.MathUtils.lerp(
      this.riderUpper.rotation.y, riderYaw, Math.min(1, 12 * dt)
    );

    // --- locomotion animation ---
    const ratio = this.speedRatio;
    if (!this.mounted) {
      // Walking on foot: alternate leg swing, light bob. Sprinting pumps the
      // legs harder and faster and pitches the whole body into the run.
      const footRatio = Math.min(this.velocity.length() / 6.5, 1);
      this._footPhase += dt * (3 + footRatio * 9) * (this.sprinting ? 1.35 : 1);
      const stride = this.sprinting ? 0.95 : 0.65;
      const swing = Math.sin(this._footPhase) * stride * footRatio;
      this.footLegs[0].rotation.x = swing;
      this.footLegs[1].rotation.x = -swing;
      this.footRoot.position.y =
        Math.abs(Math.sin(this._footPhase)) * (this.sprinting ? 0.09 : 0.05) * footRatio;
      this.footRoot.rotation.x = THREE.MathUtils.lerp(
        this.footRoot.rotation.x, this.sprinting ? 0.22 : 0, Math.min(1, 8 * dt)
      );
    } else if (this.airborne) {
      // Legs tucked mid-jump
      for (const leg of this.legs) {
        const dir = leg.userData.phaseGroup === 0 ? 1 : -1;
        leg.rotation.x = THREE.MathUtils.lerp(leg.rotation.x, 0.45 * dir, Math.min(1, 10 * dt));
      }
      this.meshRoot.position.y = 0;
    } else {
      // Sprint = full gallop: quicker stride, bigger leg sweep, deeper bob,
      // and the horse stretches forward into the run
      this.legPhase += dt * (2 + ratio * 6.5) * (this.sprinting ? 1.3 : 1);
      const strideAmp = this.sprinting ? 0.95 : 0.8;
      for (const leg of this.legs) {
        const dir = leg.userData.phaseGroup === 0 ? 1 : -1;
        leg.rotation.x = Math.sin(this.legPhase) * strideAmp * ratio * dir;
      }
      this.meshRoot.position.y =
        Math.abs(Math.sin(this.legPhase)) * (this.sprinting ? 0.16 : 0.12) * ratio;
      this.meshRoot.rotation.x = THREE.MathUtils.lerp(
        this.meshRoot.rotation.x,
        this.sprinting && ratio > 0.5 ? 0.06 : 0,
        Math.min(1, 6 * dt)
      );
    }

    this.recoil = Math.max(0, this.recoil - dt * 9);
    this._applyReloadPose();
    this._updateSword(dt);

    // HP regen after 5s without damage
    this.timeSinceHurt += dt;
    if (this.timeSinceHurt > 5 && this.hp > 0) {
      this.hp = Math.min(this.maxHp, this.hp + 4 * dt);
    }
  }

  reset() {
    if (!this.mounted) {
      // Walk back to the horse (teleport) so remount always succeeds
      this.group.position.copy(this.meshRoot.position);
      this.toggleMount();
    }
    this.group.position.set(0, terrainHeight(0, 0), 0);
    this.velocity.set(0, 0, 0);
    this.hp = this.maxHp;
    this.heading = 0;
    this.timeSinceHurt = 99;
    this.jumpOffset = 0;
    this.vy = 0;
    this.airborne = false;
    this.sprinting = false;
    this.footRoot.rotation.x = 0;
    this._reloadT = null;
    this._swingT = null;
    this.swordPivot.visible = false;
    for (const splat of this.bloodDecals) splat.visible = false;
    this._bloodShown = 0;
  }
}
