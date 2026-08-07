import * as THREE from 'three';
import { terrainHeight } from '../world/terrain.js';

// RDR2-style third-person orbit camera, decoupled from the horse's gallop:
// both the orbit position AND the look-at target are smoothed, and the
// player's visual bob never reaches the camera (it lives on the player's
// meshRoot, not its logical root).
// Camera views cycled with V
export const VIEWS = [
  // Hip view rides low beside the patriot's right boot
  { name: 'HIP VIEW', distance: 3.6, targetHeight: 1.65, shoulder: 1.05, fp: false },
  { name: 'THIRD PERSON', distance: 13, targetHeight: 3.4, shoulder: 0.9, fp: false },
  { name: 'FIRST PERSON', distance: 0, targetHeight: 0, shoulder: 0, fp: true },
];

export class ThirdPersonCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = Math.PI;
    this.pitch = 0.22;
    this.sensitivity = 0.0023;

    this.viewIndex = 1; // start in third person
    const v = VIEWS[this.viewIndex];
    this.distance = v.distance;
    this.targetHeight = v.targetHeight;
    this.shoulderOffset = v.shoulder;

    // Smooth scroll-wheel zoom (multiplier on the active view's distance)
    this.zoom = 1;
    this._zoomTarget = 1;

    this.minPitch = -0.28;
    this.maxPitch = 1.15;

    this._smoothPos = new THREE.Vector3();
    this._smoothTarget = new THREE.Vector3();
    this._initialized = false;
    this.shake = 0;
  }

  get view() {
    return VIEWS[this.viewIndex];
  }

  cycleView() {
    this.viewIndex = (this.viewIndex + 1) % VIEWS.length;
    return this.view;
  }

  handleWheel(deltaY) {
    if (!deltaY) return;
    this._zoomTarget = THREE.MathUtils.clamp(
      this._zoomTarget * Math.exp(deltaY * 0.0011), 0.4, 2.4
    );
  }

  addShake(amount) {
    this.shake = Math.min(this.shake + amount, 0.4);
  }

  update(dt, playerPos, mouseDelta, eyePos = null) {
    this.yaw -= mouseDelta.x * this.sensitivity;
    this.pitch += mouseDelta.y * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, this.minPitch, this.maxPitch);

    // --- first person: camera rides at the rider's eyes ---
    if (this.view.fp && eyePos) {
      const cp0 = Math.cos(this.pitch);
      const dir = new THREE.Vector3(
        -Math.sin(this.yaw) * cp0,
        -Math.sin(this.pitch),
        -Math.cos(this.yaw) * cp0
      );
      this.camera.position.copy(eyePos).addScaledVector(dir, 0.3);
      if (this.shake > 0) {
        this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.2;
        this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.2;
        this.shake = Math.max(0, this.shake - dt * 2.5);
      }
      this.camera.lookAt(eyePos.clone().addScaledVector(dir, 10));
      // Keep the orbit filters synced so switching back doesn't lurch
      this._smoothPos.copy(this.camera.position);
      this._smoothTarget.copy(eyePos);
      this._initialized = true;
      return;
    }

    // --- third person: glide toward the active view's framing ---
    const v = this.view;
    const kView = Math.min(1, 6 * dt);
    this.zoom = THREE.MathUtils.lerp(this.zoom, this._zoomTarget, Math.min(1, 9 * dt));
    this.distance = THREE.MathUtils.lerp(this.distance, v.distance * this.zoom, kView);
    this.targetHeight = THREE.MathUtils.lerp(this.targetHeight, v.targetHeight, kView);
    this.shoulderOffset = THREE.MathUtils.lerp(this.shoulderOffset, v.shoulder, kView);

    const rawTarget = new THREE.Vector3(
      playerPos.x,
      playerPos.y + this.targetHeight + (this.bodyLift || 0),
      playerPos.z
    );

    const cp = Math.cos(this.pitch);
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp
    ).multiplyScalar(this.distance);

    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    if (!this._initialized) {
      this._smoothTarget.copy(rawTarget);
      this._smoothPos.copy(rawTarget).add(offset).addScaledVector(right, this.shoulderOffset);
      this._initialized = true;
    } else {
      // Framerate-independent exponential smoothing; the target filter eats
      // the last of the hoofbeat jitter, the position filter adds follow lag.
      const kTarget = 1 - Math.pow(0.000002, dt);
      const kPos = 1 - Math.pow(0.00002, dt);
      this._smoothTarget.lerp(rawTarget, kTarget);

      const desired = this._smoothTarget.clone().add(offset).addScaledVector(right, this.shoulderOffset);
      this._smoothPos.lerp(desired, kPos);
    }

    // Never clip into the rolling terrain
    const groundY = terrainHeight(this._smoothPos.x, this._smoothPos.z) + 0.7;
    if (this._smoothPos.y < groundY) this._smoothPos.y = groundY;

    this.camera.position.copy(this._smoothPos);

    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.3;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.3;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }

    const lookTarget = this._smoothTarget.clone().addScaledVector(right, this.shoulderOffset);
    this.camera.lookAt(lookTarget);
  }

  // Camera-relative movement basis, projected on the ground plane
  getGroundForward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
  }

  getGroundRight() {
    return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
  }
}
