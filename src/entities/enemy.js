import * as THREE from 'three';
import { box, cyl, sphere } from '../core/assets.js';
import { terrainHeight } from '../world/terrain.js';
import { resolvePoint, nearestTree, treeHitAlong } from '../world/colliders.js';
import { Ragdoll } from './ragdoll.js';

const REDS = [0xa8241c, 0x9c2018, 0xb32a20, 0x93211a]; // per-unit coat variation
const SKINS = [0xdba97a, 0xcf9662, 0xe2b285];
const WHITE = 0xe9e2ce;
const BLACK = 0x18140f;
const BRASS = 0xc9a44a;

// Redcoat enemy. Two variants:
//   'infantry' — 80 HP, marches, fires a musket every 5 seconds
//   'cavalry'  — 160 HP, mounted, fast, melees at close range
// Hit zones: meshes tagged userData.zone = 'head' are ONE-SHOT kills.
// Built from cylinders/spheres (less blocky) with a full joint chain —
// shoulders, ELBOWS, hips and KNEES all pivot independently so the ragdoll
// flails every segment on its own.
export class Enemy {
  constructor(scene, audio, type, position, particles = null) {
    this.scene = scene;
    this.audio = audio;
    this.particles = particles;
    this.type = type; // 'infantry' | 'cavalry' | 'mortar' | 'cannon'
    this.hp = type === 'cavalry' ? 160 : 80;
    this.maxHp = this.hp;
    this.speed = type === 'cavalry' ? 10.5 : type === 'mortar' ? 4.5 : type === 'cannon' ? 3.6 : 6;
    this.mortarTimer = 5 + Math.random() * 4; // shared artillery fire timer
    this.dead = false;
    this.dying = false;
    this.ragdoll = null;

    this.musketTimer = 1.5 + Math.random() * 5; // desync volleys
    this.meleeTimer = 0;
    this.strikeT = null; // musket-butt swing progress (null = not swinging)
    this._struck = false;
    this.legPhase = Math.random() * Math.PI * 2;
    this.heading = Math.random() * Math.PI * 2;

    // ~1/3 of infantry are skirmishers: they run to a tree for cover first,
    // fight from there, and only advance if the fight drags on
    this.coverTree = null;
    this.coverTimer = 0;
    this.seeksCover = type === 'infantry' && Math.random() < 0.35;

    this.coatColor = REDS[(Math.random() * REDS.length) | 0];
    this.skinColor = SKINS[(Math.random() * SKINS.length) | 0];

    this.group = new THREE.Group();
    this.group.position.set(position.x, terrainHeight(position.x, position.z), position.z);
    this.group.userData.enemy = this;
    this.limbs = {};

    if (type === 'cavalry') {
      this._buildHorse();
      this._buildSoldier(1.95);
    } else {
      this._buildSoldier(0);
      if (type === 'mortar') this._buildMortarPiece();
      if (type === 'cannon') this._buildCannonPiece();
    }

    scene.add(this.group);

    // Every redcoat blasts the loop from a tinny speaker — 3D positional
    this.musicSound = audio.attachEnemyMusic(this.group);
  }

  // A joint pivot. Meshes keep their soldier-local coordinates (an inner
  // offset group cancels the pivot translation), so rotating the pivot
  // swings everything around the joint with zero coordinate rework.
  // Works nested: pass a parent limb's inner group for elbows/knees.
  _makeLimb(parent, name, jx, jy, jz) {
    const pivot = new THREE.Group();
    pivot.position.set(jx, jy, jz);
    const off = new THREE.Group();
    off.position.set(-jx, -jy, -jz);
    pivot.add(off);
    parent.add(pivot);
    this.limbs[name] = pivot;
    return { pivot, inner: off, add: (m) => off.add(m) };
  }

  _buildSoldier(baseY) {
    const RED = this.coatColor;
    const SKIN = this.skinColor;
    const s = new THREE.Group();
    s.position.y = baseY;
    this.soldier = s;
    this.group.add(s);

    const torsoY = this.type === 'cavalry' ? 0.75 : 1.35;

    if (this.type !== 'cavalry') {
      // Marching legs: hip pivot -> thigh, knee pivot -> gaitered calf + shoe
      this.legs = [];
      let li = 0;
      for (const side of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(side * 0.18, 0.95, 0);
        s.add(hip);
        this.legs.push(hip);
        this.limbs['leg' + li] = hip;

        const thigh = cyl(0.105, 0.09, 0.5, WHITE, {}, 10);
        thigh.position.y = -0.22;
        hip.add(thigh);

        const knee = new THREE.Group();
        knee.position.y = -0.45;
        hip.add(knee);
        this.limbs['knee' + li] = knee;

        const calf = cyl(0.085, 0.07, 0.42, 0x2b2b2e, {}, 10);
        calf.position.y = -0.2;
        knee.add(calf);

        const shoe = sphere(0.09, BLACK, {}, 8);
        shoe.scale.set(0.9, 0.5, 1.7);
        shoe.position.set(0, -0.43, 0.06);
        knee.add(shoe);

        li++;
      }
    } else {
      // Mounted legs straddle the horse
      for (const side of [-1, 1]) {
        const thigh = cyl(0.1, 0.09, 0.5, WHITE, {}, 10);
        thigh.position.set(side * 0.42, 0.08, 0.05);
        thigh.rotation.z = side * 1.15;
        s.add(thigh);
        const boot = cyl(0.085, 0.075, 0.5, BLACK, {}, 10);
        boot.position.set(side * 0.62, -0.22, 0.08);
        s.add(boot);
      }
    }

    // Elliptical coat barrel instead of a box torso
    const torso = cyl(0.33, 0.37, 0.92, RED, {}, 12);
    torso.scale.z = 0.66;
    torso.position.y = torsoY;
    s.add(torso);

    const facing = box(0.26, 0.72, 0.06, WHITE);
    facing.position.set(0, torsoY, 0.2);
    s.add(facing);

    for (let i = 0; i < 4; i++) {
      const btn = sphere(0.028, BRASS, { roughness: 0.4, metalness: 0.7 }, 6);
      btn.position.set(0.1, torsoY - 0.26 + i * 0.17, 0.24);
      s.add(btn);
    }

    // Coat tails
    const tails = box(0.46, 0.42, 0.07, RED);
    tails.position.set(0, torsoY - 0.6, -0.2);
    tails.rotation.x = 0.3;
    s.add(tails);

    // White cross-belts with brass buckle
    for (const rot of [0.6, -0.6]) {
      const belt = box(0.66, 0.13, 0.5, WHITE);
      belt.position.y = torsoY + 0.08;
      belt.rotation.z = rot;
      s.add(belt);
    }
    const buckle = box(0.12, 0.12, 0.04, BRASS);
    buckle.position.set(0, torsoY + 0.08, 0.25);
    s.add(buckle);

    // Rounded shoulder rolls
    for (const side of [-1, 1]) {
      const wing = cyl(0.1, 0.1, 0.22, WHITE, {}, 8);
      wing.rotation.z = Math.PI / 2;
      wing.position.set(side * 0.36, torsoY + 0.42, 0.02);
      s.add(wing);
    }

    // Neck + black neckcloth (torso-attached)
    const neck = cyl(0.09, 0.11, 0.18, SKIN, {}, 8);
    neck.position.y = torsoY + 0.52;
    s.add(neck);
    const stockCloth = cyl(0.115, 0.12, 0.1, BLACK, {}, 8);
    stockCloth.position.y = torsoY + 0.47;
    s.add(stockCloth);

    // HEAD on a neck pivot — one-shot zone; a squashed sphere, not a box
    const headLimb = this._makeLimb(s, 'head', 0, torsoY + 0.55, 0);
    const headY = torsoY + 0.9;

    const head = sphere(0.21, SKIN, {}, 12);
    head.scale.set(0.9, 1.08, 0.94);
    head.position.y = headY;
    head.userData.zone = 'head';
    this.headMesh = head;
    headLimb.add(head);

    for (const side of [-1, 1]) {
      const eye = sphere(0.03, 0x1a140e, {}, 6);
      eye.position.set(side * 0.08, headY + 0.05, 0.18);
      eye.userData.zone = 'head';
      headLimb.add(eye);

      const curl = cyl(0.05, 0.05, 0.13, 0xd8d3c0, {}, 6);
      curl.rotation.x = Math.PI / 2;
      curl.position.set(side * 0.19, headY + 0.01, -0.02);
      headLimb.add(curl);
    }
    const nose = sphere(0.045, 0xc98f5d, {}, 8);
    nose.scale.set(0.85, 1.3, 0.95);
    nose.position.set(0, headY - 0.02, 0.2);
    nose.userData.zone = 'head';
    headLimb.add(nose);

    // Headgear rides the head pivot (hats are body-tier — face one-shots)
    if (this.type !== 'cavalry') {
      const mitre = cyl(0.12, 0.19, 0.52, BLACK, {}, 10);
      mitre.position.set(0, headY + 0.42, -0.02);
      headLimb.add(mitre);
      const plate = box(0.3, 0.42, 0.04, BRASS);
      plate.position.set(0, headY + 0.42, 0.13);
      plate.rotation.x = -0.1;
      headLimb.add(plate);
      const mitreTuft = sphere(0.05, WHITE, {}, 6);
      mitreTuft.position.set(0, headY + 0.7, -0.02);
      headLimb.add(mitreTuft);

      // Field kit stays strapped to the torso
      const pack = box(0.42, 0.42, 0.17, 0x6e5638);
      pack.position.set(0, torsoY + 0.1, -0.32);
      s.add(pack);
      const roll = cyl(0.09, 0.09, 0.46, 0x8d8778, {}, 8);
      roll.rotation.z = Math.PI / 2;
      roll.position.set(0, torsoY + 0.38, -0.34);
      s.add(roll);
      const canteen = cyl(0.09, 0.09, 0.06, 0x4c5866, { roughness: 0.5, metalness: 0.4 }, 10);
      canteen.rotation.x = Math.PI / 2;
      canteen.position.set(-0.3, torsoY - 0.28, -0.2);
      s.add(canteen);
    } else {
      const helmet = sphere(0.24, BLACK, {}, 10);
      helmet.scale.set(1, 0.75, 1.05);
      helmet.position.set(0, headY + 0.16, 0);
      headLimb.add(helmet);
      const crest = box(0.08, 0.14, 0.42, 0xd8d3c0);
      crest.position.set(0, headY + 0.4, 0);
      headLimb.add(crest);
    }

    // Jointed arms: shoulder pivot -> upper arm, elbow pivot -> forearm+hand
    for (const side of [-1, 1]) {
      const armName = side === 1 ? 'armR' : 'armL';
      const shoulder = this._makeLimb(s, armName, side * 0.42, torsoY + 0.38, 0.03);

      const upper = cyl(0.075, 0.068, 0.4, RED, {}, 8);
      upper.position.set(side * 0.42, torsoY + 0.2, 0.03);
      upper.rotation.x = -0.35;
      shoulder.add(upper);

      // Elbow sub-joint nests inside the shoulder's inner group; soldier-
      // local coordinates still apply thanks to the offset trick
      const elbow = this._makeLimb(
        shoulder.inner, side === 1 ? 'elbowR' : 'elbowL',
        side * 0.42, torsoY + 0.05, 0.13
      );

      const forearm = cyl(0.065, 0.058, 0.36, RED, {}, 8);
      forearm.position.set(side * 0.41, torsoY + 0.02, 0.26);
      forearm.rotation.x = -1.25;
      elbow.add(forearm);

      const cuff = cyl(0.078, 0.078, 0.12, WHITE, {}, 8);
      cuff.position.set(side * 0.41, torsoY - 0.02, 0.36);
      cuff.rotation.x = -1.25;
      elbow.add(cuff);

      const hand = sphere(0.065, SKIN, {}, 8);
      hand.position.set(side * 0.4, torsoY - 0.02, 0.46);
      elbow.add(hand);

      if (side === 1) this._rightElbow = elbow;
    }

    // Artillery crews man their piece instead of carrying a musket
    this.musketParts = [];
    if (this.type === 'mortar' || this.type === 'cannon') {
      this.musketTip = new THREE.Object3D();
      s.add(this.musketTip);
      return;
    }

    // Brown Bess musket rides in the right hand — flops with the forearm,
    // and is dropped as a separate item when the soldier dies
    const armR = this._rightElbow;

    const stock = box(0.09, 0.12, 1.3, 0x4a3520);
    stock.position.set(0.22, torsoY + 0.24, 0.42);
    stock.rotation.y = 0.12;
    stock.rotation.x = -0.12;
    armR.add(stock);

    const barrel = cyl(0.03, 0.03, 0.9, 0x50555c, { roughness: 0.4, metalness: 0.7 }, 8);
    barrel.rotation.x = Math.PI / 2 - 0.12;
    barrel.position.set(0.26, torsoY + 0.4, 0.95);
    armR.add(barrel);

    const bayonet = box(0.025, 0.025, 0.4, 0xb9bec6, { roughness: 0.25, metalness: 0.85 });
    bayonet.position.set(0.28, torsoY + 0.48, 1.5);
    bayonet.rotation.x = -0.12;
    armR.add(bayonet);

    const lockPlate = box(0.04, 0.08, 0.14, BRASS);
    lockPlate.position.set(0.28, torsoY + 0.22, 0.3);
    armR.add(lockPlate);
    this.musketParts.push(stock, barrel, bayonet, lockPlate);

    this.musketTip = new THREE.Object3D();
    this.musketTip.position.set(0.28, torsoY + 0.5, 1.7);
    armR.add(this.musketTip);
  }

  // A six-pounder field gun the crewman pushes into position: long iron
  // barrel on big spoked wheels with a trail carriage. Faces the player as
  // the group rotates.
  _buildCannonPiece() {
    const iron = { roughness: 0.45, metalness: 0.65 };
    const woodCol = 0x4a3520;
    const c = new THREE.Group();

    const barrel = cyl(0.13, 0.18, 2.2, 0x2b2f33, iron, 12);
    barrel.rotation.x = Math.PI / 2 - 0.12;
    barrel.position.set(0, 1.05, 0.5);
    c.add(barrel);

    const muzzleRing = cyl(0.17, 0.17, 0.1, 0x22262a, iron, 12);
    muzzleRing.rotation.x = Math.PI / 2 - 0.12;
    muzzleRing.position.set(0, 1.18, 1.55);
    c.add(muzzleRing);

    for (const side of [-1, 1]) {
      const wheel = cyl(0.78, 0.78, 0.14, woodCol, {}, 14);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 0.75, 0.78, 0);
      c.add(wheel);
      const hub = cyl(0.16, 0.16, 0.22, 0x33281c, {}, 8);
      hub.rotation.z = Math.PI / 2;
      hub.position.set(side * 0.77, 0.78, 0);
      c.add(hub);
    }

    const trail = box(0.42, 0.28, 2.2, woodCol);
    trail.position.set(0, 0.6, -1.0);
    trail.rotation.x = 0.2;
    c.add(trail);

    const axle = box(1.7, 0.18, 0.2, 0x33281c);
    axle.position.set(0, 0.78, 0);
    c.add(axle);

    this.cannonTip = new THREE.Object3D();
    this.cannonTip.position.set(0, 1.22, 1.7);
    c.add(this.cannonTip);

    c.position.set(1.15, 0, 0);
    this.artPiece = c; // stays planted when the crew is killed
    this.group.add(c);
  }

  // A coehorn mortar planted beside the crewman: wooden bed + stubby
  // upward-angled iron tube. Points at the player as the group rotates.
  _buildMortarPiece() {
    const iron = { roughness: 0.45, metalness: 0.65 };
    const m = new THREE.Group();

    const bed = box(0.78, 0.3, 0.98, 0x4a3520);
    bed.position.y = 0.15;
    m.add(bed);

    const tube = cyl(0.15, 0.2, 0.72, 0x2b2f33, iron, 10);
    tube.rotation.x = -0.85;
    tube.position.set(0, 0.55, 0.05);
    m.add(tube);

    const ring = cyl(0.21, 0.21, 0.08, 0x22262a, iron, 10);
    ring.rotation.x = -0.85;
    ring.position.set(0, 0.79, 0.29);
    m.add(ring);

    this.mortarTip = new THREE.Object3D();
    this.mortarTip.position.set(0, 0.92, 0.42);
    m.add(this.mortarTip);

    m.position.set(0.95, 0, 0.1);
    this.artPiece = m; // stays planted when the crew is killed
    this.group.add(m);
  }

  _buildHorse() {
    const coats = [0x3a2f26, 0x2c2620, 0x453324];
    const coat = coats[(Math.random() * coats.length) | 0];
    const dark = 0x241c14;

    // Rounded barrel body
    const barrel = cyl(0.5, 0.52, 1.5, coat, {}, 12);
    barrel.rotation.x = Math.PI / 2;
    barrel.scale.x = 0.92;
    barrel.position.y = 1.35;
    this.group.add(barrel);

    const chest = sphere(0.47, coat, {}, 10);
    chest.scale.set(0.92, 1.0, 0.85);
    chest.position.set(0, 1.37, 0.85);
    this.group.add(chest);

    const rump = sphere(0.46, dark, {}, 10);
    rump.scale.set(0.95, 0.95, 0.9);
    rump.position.set(0, 1.37, -0.85);
    this.group.add(rump);

    const neck = cyl(0.18, 0.3, 1.0, coat, {}, 10);
    neck.position.set(0, 2.0, 1.18);
    neck.rotation.x = 0.5;
    this.group.add(neck);

    const skull = sphere(0.25, coat, {}, 12);
    skull.scale.set(0.78, 0.88, 1.15);
    skull.position.set(0, 2.5, 1.55);
    this.group.add(skull);

    const snout = cyl(0.12, 0.17, 0.45, dark, {}, 8);
    snout.rotation.x = Math.PI / 2 + 0.15;
    snout.position.set(0, 2.4, 1.94);
    this.group.add(snout);

    for (const side of [-1, 1]) {
      const ear = cyl(0.02, 0.06, 0.22, dark, {}, 6);
      ear.position.set(side * 0.13, 2.8, 1.36);
      this.group.add(ear);
    }

    const tail = cyl(0.09, 0.04, 0.95, dark, {}, 6);
    tail.position.set(0, 1.3, -1.35);
    tail.rotation.x = 0.55;
    this.group.add(tail);

    // Regimental saddle cloth
    const cloth = box(1.05, 0.1, 1.0, 0x7a1f1f);
    cloth.position.y = 1.88;
    this.group.add(cloth);
    const clothTrim = box(1.07, 0.04, 1.02, BRASS);
    clothTrim.position.y = 1.83;
    this.group.add(clothTrim);

    this.horseLegs = [];
    const legPositions = [
      [-0.32, 0.95, 0.85, 0],
      [0.32, 0.95, 0.85, 1],
      [-0.32, 0.95, -0.85, 1],
      [0.32, 0.95, -0.85, 0],
    ];
    let hi = 0;
    for (const [x, y, z, phaseGroup] of legPositions) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);

      const thigh = cyl(0.14, 0.1, 0.5, coat, {}, 8);
      thigh.position.y = -0.24;
      pivot.add(thigh);

      const cannon = cyl(0.09, 0.07, 0.48, dark, {}, 8);
      cannon.position.y = -0.7;
      pivot.add(cannon);

      const hoof = cyl(0.1, 0.11, 0.12, 0x14100c, {}, 8);
      hoof.position.y = -0.97;
      pivot.add(hoof);

      pivot.userData.phaseGroup = phaseGroup;
      this.horseLegs.push(pivot);
      this.limbs['hleg' + hi++] = pivot;
      this.group.add(pivot);
    }
  }

  // Returns damage events for the player: {type:'musket'|'melee', damage}
  update(dt, playerPos, events) {
    if (this.dead) return;

    if (this.dying) {
      // Corpses persist on the field; the ragdoll goes to sleep once still
      if (this.ragdoll && !this.ragdoll.sleeping) this.ragdoll.update(dt);
      // The riderless horse gallops away from the fight, then leaves
      if (this.fleeT > 0) {
        this.fleeT -= dt;
        let dy = this._fleeYaw - this.group.rotation.y;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.group.rotation.y += dy * Math.min(1, 3 * dt);
        const fx = Math.sin(this._fleeYaw);
        const fz = Math.cos(this._fleeYaw);
        this.group.position.x += fx * 12 * dt;
        this.group.position.z += fz * 12 * dt;
        this.legPhase += dt * 8;
        const swing = Math.sin(this.legPhase);
        if (this.horseLegs) {
          for (const leg of this.horseLegs) {
            leg.rotation.x = swing * 0.75 * (leg.userData.phaseGroup === 0 ? 1 : -1);
          }
        }
        this.group.position.y =
          terrainHeight(this.group.position.x, this.group.position.z) + Math.abs(swing) * 0.1;
        if (this.fleeT <= 0) this.scene.remove(this.group); // gone over the hills
      }
      return;
    }

    // Held in the patriot's finisher: the cutscene drives this body
    if (this.inFinisher) return;

    const toPlayer = new THREE.Vector3().subVectors(playerPos, this.group.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    const dir = toPlayer.normalize();

    // Face the player
    const targetHeading = Math.atan2(dir.x, dir.z);
    let diff = targetHeading - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.heading += diff * Math.min(1, 6 * dt);
    this.group.rotation.y = this.heading;

    // Movement
    let moving = false;
    if (this.type === 'infantry') {
      // Skirmishers pick a tree between them and the fight and hole up
      // behind it for a while before pressing the attack
      if (this.seeksCover && !this.coverTree) {
        const midX = this.group.position.x + (playerPos.x - this.group.position.x) * 0.4;
        const midZ = this.group.position.z + (playerPos.z - this.group.position.z) * 0.4;
        this.coverTree = nearestTree(midX, midZ, 45);
        if (this.coverTree) this.coverTimer = 12 + Math.random() * 10;
        else this.seeksCover = false; // no tree around — press on
      }

      if (this.coverTree) {
        // Stand on the far side of the trunk from the player
        const t = this.coverTree;
        const away = new THREE.Vector3(t.x - playerPos.x, 0, t.z - playerPos.z).normalize();
        const spot = new THREE.Vector3(t.x + away.x * (t.r + 1.1), 0, t.z + away.z * (t.r + 1.1));
        const toSpot = new THREE.Vector3(spot.x - this.group.position.x, 0, spot.z - this.group.position.z);
        if (toSpot.length() > 1.2) {
          toSpot.normalize();
          this.group.position.x += toSpot.x * this.speed * dt;
          this.group.position.z += toSpot.z * this.speed * dt;
          moving = true;
        }
        this.coverTimer -= dt;
        if (this.coverTimer <= 0 || dist < 14) this.coverTree = null; // charge!
      } else if (dist > 26) {
        this.group.position.x += dir.x * this.speed * dt;
        this.group.position.z += dir.z * this.speed * dt;
        moving = true;
      }

      if (dist < 3.4) {
        // Too close for musketry — swing the butt of the Brown Bess instead
        this.meleeTimer -= dt;
        if (this.meleeTimer <= 0 && this.strikeT == null) {
          this.meleeTimer = 1.5;
          this.strikeT = 0;
          this._struck = false;
        }
      } else {
        this.musketTimer -= dt;
        if (this.musketTimer <= 0 && dist < 70) {
          this.musketTimer = 5; // GDD: one round every 5 seconds
          this._fireMusket(dist, events, playerPos);
        }
      }
    } else if (this.type === 'cannon') {
      // Gun crews work the piece from far off: push forward into range,
      // pull back if the rider closes in, and fire slow heavy balls
      if (dist > 88) {
        this.group.position.x += dir.x * this.speed * dt;
        this.group.position.z += dir.z * this.speed * dt;
        moving = true;
      } else if (dist < 42) {
        this.group.position.x -= dir.x * this.speed * 0.8 * dt;
        this.group.position.z -= dir.z * this.speed * 0.8 * dt;
        moving = true;
      } else {
        this.mortarTimer -= dt;
        if (this.mortarTimer <= 0 && dist < 120) {
          this.mortarTimer = 5.5 + Math.random() * 2;
          const from = new THREE.Vector3();
          this.cannonTip.getWorldPosition(from);
          this.audio.playPositional('boom', this.group, { volume: 0.55, refDistance: 26 });
          if (this.particles) {
            this.particles.smoke(from);
            this.particles.flame(from);
            this.particles.spark(from);
            this.particles.smoke(from); // double charge of powder smoke
          }
          const flash = new THREE.PointLight(0xffb35c, 22, 16);
          flash.position.copy(from);
          this.scene.add(flash);
          setTimeout(() => this.scene.remove(flash), 90);
          events.push({ type: 'cannonFire', from, enemy: this });
        }
      }
    } else if (this.type === 'mortar') {
      // Artillery keeps its distance: walk into range, plant the tube, lob
      // shells on a slow cycle. main.js flies the shell and detonates it.
      if (dist > 55) {
        this.group.position.x += dir.x * this.speed * dt;
        this.group.position.z += dir.z * this.speed * dt;
        moving = true;
      } else {
        this.mortarTimer -= dt;
        if (this.mortarTimer <= 0 && dist >= 14 && dist < 95) {
          this.mortarTimer = 7 + Math.random() * 3;
          const from = new THREE.Vector3();
          this.mortarTip.getWorldPosition(from);
          this.audio.playPositional('musket', this.group, { volume: 0.85, refDistance: 18 });
          if (this.particles) this.particles.smoke(from);
          events.push({ type: 'mortarFire', from, enemy: this });
        }
      }
    } else {
      if (dist > 2.6) {
        this.group.position.x += dir.x * this.speed * dt;
        this.group.position.z += dir.z * this.speed * dt;
        moving = true;
      } else {
        this.meleeTimer -= dt;
        if (this.meleeTimer <= 0 && this.strikeT == null) {
          this.meleeTimer = 1.3;
          this.strikeT = 0;
          this._struck = false;
        }
      }
    }

    // Melee strike animation: the right arm winds up over the shoulder,
    // then smashes forward. Damage lands mid-swing IF the rider is still
    // in reach — you can back out of a swing you see coming.
    if (this.strikeT != null) {
      this.strikeT += dt / 0.55;
      const arm = this.limbs.armR;
      if (this.strikeT >= 1) {
        this.strikeT = null;
        if (arm) arm.rotation.x = 0;
      } else if (arm) {
        const t = this.strikeT;
        arm.rotation.x = t < 0.4 ? -(t / 0.4) * 1.9 : -1.9 + ((t - 0.4) / 0.6) * 2.7;
        if (!this._struck && t >= 0.55) {
          this._struck = true;
          if (dist < 4.2) {
            events.push({ type: 'melee', damage: this.type === 'cavalry' ? 18 : 12, enemy: this });
          }
        }
      }
    }

    // Solid props stop redcoats too
    resolvePoint(this.group.position, this.type === 'cavalry' ? 0.9 : 0.5);

    // Terrain following + walk/gallop animation (weighty, unhurried stride)
    const th = terrainHeight(this.group.position.x, this.group.position.z);
    let bob = 0;
    if (moving) {
      this.legPhase += dt * (this.type === 'cavalry' ? 7 : 4.5);
      const swing = Math.sin(this.legPhase);
      if (this.legs) {
        this.legs[0].rotation.x = swing * 0.55;
        this.legs[1].rotation.x = -swing * 0.55;
        // Knees flex a touch on the back-swing for a natural stride
        this.limbs.knee0.rotation.x = Math.max(0, -swing) * 0.5;
        this.limbs.knee1.rotation.x = Math.max(0, swing) * 0.5;
      }
      if (this.horseLegs) {
        for (const leg of this.horseLegs) {
          const d = leg.userData.phaseGroup === 0 ? 1 : -1;
          leg.rotation.x = swing * 0.7 * d;
        }
        bob = Math.abs(swing) * 0.1;
      } else {
        bob = Math.abs(swing) * 0.05;
      }
    }
    this.group.position.y = th + bob;
  }

  _fireMusket(dist, events, playerPos) {
    // Positional bang so you hear which direction the volley came from
    this.audio.playPositional('musket', this.group, { volume: 0.9, refDistance: 14 });

    const flash = new THREE.PointLight(0xffc477, 10, 9);
    const tip = new THREE.Vector3();
    this.musketTip.getWorldPosition(tip);
    flash.position.copy(tip);
    this.scene.add(flash);
    setTimeout(() => this.scene.remove(flash), 70);

    // Black-powder blast at the muzzle: smoke, sparks and a flame lick
    if (this.particles) {
      this.particles.smoke(tip);
      this.particles.spark(tip);
      this.particles.flame(tip);
    }

    // Smoothbore muskets are wildly inaccurate — most balls whistle past
    const hitChance = Math.max(0.05, 0.36 - dist * 0.005);
    let hit = Math.random() < hitChance;

    // Where the ball actually flies — at the rider on a hit, wide on a miss
    let target = null;
    if (playerPos) {
      target = playerPos.clone();
      target.y += 1.9;
      if (!hit) {
        target.x += (Math.random() - 0.5) * 7;
        target.y += (Math.random() - 0.2) * 3;
        target.z += (Math.random() - 0.5) * 7;
      }
      // A trunk in the ball's path soaks it: pocked bark, no damage through
      const bark = treeHitAlong(tip, target);
      if (bark) {
        hit = false;
        target = new THREE.Vector3(bark.point.x, bark.point.y, bark.point.z);
        if (this.particles) this.particles.bulletHole(bark.point, bark.nx, bark.nz);
      }
    }

    if (hit) {
      events.push({ type: 'musket', damage: 9, enemy: this });
    }

    // Visible ball trace: a smoky wake along the flight path
    if (this.particles && target) this.particles.trailSmoke(tip, target);
  }

  // impulse: world-space kick applied to the ragdoll
  takeDamage(amount, impulse) {
    if (this.dying || this.dead) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.kill(impulse);
      return true;
    }
    return false;
  }

  kill(impulse = new THREE.Vector3(0, 4, 0), canDismember = false) {
    if (this.dying || this.dead) return;
    this.dying = true;
    // The blessed silence: the speaker dies with them
    this.audio.detachSound(this.musicSound, this.group);
    this.musicSound = null;
    // The musket flies from his hands as a separate dropped item
    let droppedGun = null;
    if (this.musketParts && this.musketParts.length) {
      droppedGun = new THREE.Group();
      this.scene.add(droppedGun);
      this.musketParts[0].getWorldPosition(droppedGun.position);
      for (const part of this.musketParts) droppedGun.attach(part);
    }

    // Explosive deaths sometimes tear limbs clean off — the severed pieces
    // fly on their own with a burst of blood at the stump
    const severed = [];
    if (canDismember && Math.random() < 0.55) {
      const pairedJoint = { armL: 'elbowL', armR: 'elbowR', leg0: 'knee0', leg1: 'knee1' };
      const candidates = ['armL', 'armR', 'leg0', 'leg1', 'head'].filter((k) => this.limbs[k]);
      const count = 1 + (Math.random() < 0.35 ? 1 : 0);
      for (let i = 0; i < count && candidates.length; i++) {
        const key = candidates.splice((Math.random() * candidates.length) | 0, 1)[0];
        const pivot = this.limbs[key];
        delete this.limbs[key];
        if (pairedJoint[key]) delete this.limbs[pairedJoint[key]];
        this.scene.attach(pivot);
        severed.push(pivot);
        if (this.particles) {
          const at = new THREE.Vector3();
          pivot.getWorldPosition(at);
          this.particles.blood(at, true);
        }
      }
    }

    if (this.type === 'cavalry') {
      // The rider topples out of the saddle and crumples in the grass —
      // his horse survives, bolts riderless for the horizon, and leaves
      // the field. Only the man ragdolls, gently (no rocket launch).
      this.scene.attach(this.soldier);
      const riderLimbs = {};
      for (const [k, pivot] of Object.entries(this.limbs)) {
        if (!k.startsWith('hleg')) riderLimbs[k] = pivot;
      }
      const soft = impulse.clone().multiplyScalar(0.4);
      soft.y = Math.min(impulse.y * 0.3, 1.5);
      this.ragdoll = new Ragdoll(
        this.scene, this.soldier, soft, 0.45,
        riderLimbs, this.particles, droppedGun, severed
      );
      this.fleeT = 7;
      this._fleeYaw = this.heading + Math.PI;
    } else {
      // Gun crews die alone — the piece stays planted where it stood
      if (this.artPiece) this.scene.attach(this.artPiece);
      // Knock the body flying — every joint flails on its own
      this.ragdoll = new Ragdoll(
        this.scene, this.group, impulse, 0.5,
        this.limbs, this.particles, droppedGun, severed
      );
    }
  }

  dispose() {
    this.audio.detachSound(this.musicSound, this.group);
    this.musicSound = null;
    if (this.ragdoll) this.ragdoll.dispose();
    // For cavalry the ragdoll is only the rider — the horse group (or the
    // whole body for foot troops, if no ragdoll ever spawned) goes here
    this.scene.remove(this.group);
    // A detached artillery piece stays planted on the field — the gun
    // outlives its crew (and can still be manned by the player)
    // Geometries/materials live in the shared cache — nothing else to free
  }
}
