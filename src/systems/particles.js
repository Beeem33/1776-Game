import * as THREE from 'three';
import { terrainHeight } from '../world/terrain.js';

// Lightweight burst particle system. Each burst is one THREE.Points object
// whose vertices fly apart, fall under gravity, and fade out.
export class Particles {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];
    this.tracers = [];
    this._tracerGeo = new THREE.BoxGeometry(0.05, 0.05, 1);
  }

  // Bullet trace: a bright streak from muzzle to target that fades fast.
  // Used for enemy musket balls (the player's Uzi has its own in weapon.js).
  tracer(from, to, color = 0xffe8b0) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.5) return;
    const mesh = new THREE.Mesh(
      this._tracerGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
    );
    mesh.scale.z = len;
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.lookAt(to);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life: 0.12, maxLife: 0.12 });
  }

  // Common presets
  blood(pos, big = false) {
    // Bright arterial spray...
    this.spawnBurst(pos, {
      color: 0xa61410,
      count: big ? 48 : 24,
      speed: big ? 8.5 : 5.5,
      size: big ? 0.42 : 0.28,
      life: 0.75,
      gravity: 15,
      upBias: 3,
    });
    // ...over a heavier dark splatter
    this.spawnBurst(pos, {
      color: 0x5c0d08,
      count: big ? 22 : 10,
      speed: big ? 5.5 : 3.5,
      size: big ? 0.52 : 0.34,
      life: 0.95,
      gravity: 12,
      upBias: 2,
    });
  }

  // Dark bullet pock pressed into a tree trunk, facing out along the
  // radial normal, plus a spray of bark chips. Capped FIFO so a long
  // firefight can't pile up geometry forever.
  bulletHole(point, nx, nz) {
    if (!this._holeGeo) {
      this._holeGeo = new THREE.CircleGeometry(0.07, 8);
      this._holeMat = new THREE.MeshBasicMaterial({ color: 0x17110b });
      this._holes = [];
    }
    const m = new THREE.Mesh(this._holeGeo, this._holeMat);
    m.position.set(point.x + nx * 0.03, point.y, point.z + nz * 0.03);
    m.lookAt(point.x + nx, point.y, point.z + nz);
    this.scene.add(m);
    this._holes.push(m);
    if (this._holes.length > 140) this.scene.remove(this._holes.shift());

    this.spawnBurst(new THREE.Vector3(point.x + nx * 0.12, point.y, point.z + nz * 0.12), {
      color: 0x6a5138, count: 6, speed: 2.5, size: 0.12, life: 0.5, gravity: 12, upBias: 1,
    });
  }

  smoke(pos) {
    this.spawnBurst(pos, {
      color: 0xcfd2cc,
      count: 12,
      speed: 1.6,
      size: 0.5,
      life: 1.1,
      gravity: -1.2, // drifts upward
      upBias: 0.8,
    });
  }

  dirt(pos) {
    this.spawnBurst(pos, {
      color: 0x6a5432,
      count: 18,
      speed: 5,
      size: 0.26,
      life: 0.55,
      gravity: 18,
      upBias: 3,
    });
  }

  spark(pos) {
    this.spawnBurst(pos, {
      color: 0xffd27a,
      count: 15,
      speed: 8.5,
      size: 0.15,
      life: 0.35,
      gravity: 11,
      upBias: 1,
    });
  }

  // Short hot flame lick at a muzzle
  flame(pos) {
    this.spawnBurst(pos, {
      color: 0xff8c26,
      count: 10,
      speed: 3.5,
      size: 0.3,
      life: 0.18,
      gravity: -3,
      upBias: 0.6,
    });
  }

  // Smoky musket-ball trail: puffs strung along the flight path that drift
  // up and dissipate into the sky instead of reading as a hard line.
  trailSmoke(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1) return;
    const count = Math.min(42, Math.max(6, Math.floor(len / 1.1)));
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const t = (i + Math.random() * 0.8) / count;
      positions[i * 3] = from.x + dir.x * t + (Math.random() - 0.5) * 0.25;
      positions[i * 3 + 1] = from.y + dir.y * t + (Math.random() - 0.5) * 0.25;
      positions[i * 3 + 2] = from.z + dir.z * t + (Math.random() - 0.5) * 0.25;
      velocities[i * 3] = (Math.random() - 0.5) * 0.7;
      velocities[i * 3 + 1] = 0.9 + Math.random() * 1.1; // rises skyward
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.7;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xb9bdb6,
      size: 0.34,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    this.scene.add(points);
    // gravity < 0 makes the update loop carry the puffs upward as they fade
    this.bursts.push({ points, velocities, life: 1.5, maxLife: 1.5, gravity: -0.5 });
  }

  spawnBurst(pos, { color, count, speed, size, life, gravity, upBias = 0 }) {
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;
      // Random direction, biased upward
      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1 + upBias * 0.5,
        Math.random() * 2 - 1
      ).normalize();
      const v = speed * (0.4 + Math.random() * 0.6);
      velocities[i * 3] = dir.x * v;
      velocities[i * 3 + 1] = dir.y * v + upBias;
      velocities[i * 3 + 2] = dir.z * v;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);
    this.bursts.push({ points, velocities, life, maxLife: life, gravity });
  }

  update(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, t.life / t.maxLife) * 0.85;
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        t.mesh.material.dispose();
        this.tracers.splice(i, 1);
      }
    }

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt;
      if (b.life <= 0) {
        this.scene.remove(b.points);
        b.points.geometry.dispose();
        b.points.material.dispose();
        this.bursts.splice(i, 1);
        continue;
      }

      const pos = b.points.geometry.attributes.position;
      const arr = pos.array;
      const vel = b.velocities;
      for (let j = 0; j < arr.length; j += 3) {
        vel[j + 1] -= b.gravity * dt;
        arr[j] += vel[j] * dt;
        arr[j + 1] += vel[j + 1] * dt;
        arr[j + 2] += vel[j + 2] * dt;
        // Rest on the REAL ground — falling blood/dirt follows crater bowls
        // down instead of freezing at a flat height and floating mid-air
        if (b.gravity > 0 && arr[j + 1] < 8) {
          const floor = terrainHeight(arr[j], arr[j + 2]) + 0.05;
          if (arr[j + 1] < floor) arr[j + 1] = floor;
        }
      }
      pos.needsUpdate = true;
      b.points.material.opacity = b.life / b.maxLife;
    }
  }
}
