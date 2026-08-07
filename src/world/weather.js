import * as THREE from 'three';
import { terrainHeight, slopeAt } from './terrain.js';

const RAIN_COUNT = 2200;
const RAIN_BOX = { x: 70, y: 42, z: 70 };
const RAIN_SPEED = 26;
const WIND = new THREE.Vector3(3.2, 0, 1.6); // constant storm wind drift

// Storm weather: streaking rain that follows the camera, drifting cloud deck,
// reflective puddles on flat ground, and rolling thunder.
export class Weather {
  constructor(scene, audio) {
    this.scene = scene;
    this.audio = audio;
    this.thunderTimer = 6 + Math.random() * 12;

    this._buildRain();
    this._buildClouds();
    this._buildPuddles();
  }

  _buildRain() {
    // Each drop is a short line segment slanted by the wind
    this.drops = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      this.drops[i * 3] = (Math.random() - 0.5) * RAIN_BOX.x;
      this.drops[i * 3 + 1] = Math.random() * RAIN_BOX.y;
      this.drops[i * 3 + 2] = (Math.random() - 0.5) * RAIN_BOX.z;
    }

    const positions = new Float32Array(RAIN_COUNT * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x9fb2c4,
      transparent: true,
      opacity: 0.32,
    });
    this.rain = new THREE.LineSegments(geo, material);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  _buildClouds() {
    // Soft grey blob texture
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(52, 58, 66, 0.9)');
    g.addColorStop(0.6, 'rgba(58, 64, 72, 0.5)');
    g.addColorStop(1, 'rgba(60, 66, 74, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);

    this.clouds = [];
    const cloudGroup = new THREE.Group();
    for (let i = 0; i < 16; i++) {
      const w = 120 + Math.random() * 140;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(w, w * (0.5 + Math.random() * 0.4)),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: 0.4 + Math.random() * 0.3,
          depthWrite: false,
          fog: false,
        })
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(
        (Math.random() - 0.5) * 500,
        52 + Math.random() * 26,
        (Math.random() - 0.5) * 500
      );
      plane.userData.speed = 1.5 + Math.random() * 2;
      cloudGroup.add(plane);
      this.clouds.push(plane);
    }
    this.scene.add(cloudGroup);
  }

  _buildPuddles() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4a5866,
      roughness: 0.06,
      metalness: 0.75,
      transparent: true,
      opacity: 0.85,
    });
    const up = new THREE.Vector3(0, 1, 0);
    let placed = 0;
    let attempts = 0;
    while (placed < 40 && attempts < 400) {
      attempts++;
      const a = Math.random() * Math.PI * 2;
      const r = 5 + Math.sqrt(Math.random()) * 135;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (slopeAt(x, z) > 0.06) continue; // puddles only form on flat ground

      const puddle = new THREE.Mesh(
        new THREE.CircleGeometry(0.8 + Math.random() * 2.0, 14),
        mat
      );
      // Conform to the local terrain normal
      const e = 1.0;
      const n = new THREE.Vector3(
        terrainHeight(x - e, z) - terrainHeight(x + e, z),
        2 * e,
        terrainHeight(x, z - e) - terrainHeight(x, z + e)
      ).normalize();
      puddle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      puddle.position.set(x, terrainHeight(x, z) + 0.035, z);
      puddle.scale.x = 1 + Math.random() * 0.7; // irregular shapes
      puddle.receiveShadow = true;
      this.scene.add(puddle);
      placed++;
    }
    void up;
  }

  update(dt, cameraPos) {
    // --- rain: simulate in a camera-centered box ---
    this.rain.position.copy(cameraPos);
    const pos = this.rain.geometry.attributes.position.array;
    const slantX = WIND.x * 0.045;
    const slantZ = WIND.z * 0.045;
    for (let i = 0; i < RAIN_COUNT; i++) {
      let y = this.drops[i * 3 + 1] - RAIN_SPEED * dt;
      let x = this.drops[i * 3] + WIND.x * dt;
      let z = this.drops[i * 3 + 2] + WIND.z * dt;
      if (y < -6) {
        y += RAIN_BOX.y;
        x = (Math.random() - 0.5) * RAIN_BOX.x;
        z = (Math.random() - 0.5) * RAIN_BOX.z;
      }
      if (x > RAIN_BOX.x / 2) x -= RAIN_BOX.x;
      if (z > RAIN_BOX.z / 2) z -= RAIN_BOX.z;
      this.drops[i * 3] = x;
      this.drops[i * 3 + 1] = y;
      this.drops[i * 3 + 2] = z;

      const j = i * 6;
      pos[j] = x;
      pos[j + 1] = y;
      pos[j + 2] = z;
      pos[j + 3] = x + slantX * 14;
      pos[j + 4] = y - 1.1;
      pos[j + 5] = z + slantZ * 14;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;

    // --- clouds drift with the wind ---
    for (const c of this.clouds) {
      c.position.x += c.userData.speed * dt;
      c.position.z += c.userData.speed * 0.4 * dt;
      if (c.position.x > 300) c.position.x = -300;
      if (c.position.z > 300) c.position.z = -300;
    }

    // --- ambience: rain bed + occasional thunder ---
    if (this.audio.ready) {
      this.audio.playLoop('rain', 0.22); // deduped internally
      this.thunderTimer -= dt;
      if (this.thunderTimer <= 0) {
        this.thunderTimer = 12 + Math.random() * 20;
        this.audio.playSfx('thunder', { volume: 0.5 + Math.random() * 0.3, rateJitter: 0.15 });
      }
    }
  }
}
