import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

const DB_GRAVITY = 24;

// Physical debris pieces (smashed fence rails, splinters): each tumbles with
// its own velocity/spin, bounces, and comes to rest in the grass for the
// remainder of the game.
export class DebrisManager {
  constructor(scene) {
    this.scene = scene;
    this.pieces = [];
  }

  // mesh must already be in world space (scene-attached)
  add(mesh, vel, ang) {
    this.pieces.push({ mesh, vel, ang, resting: false });
  }

  update(dt) {
    for (const p of this.pieces) {
      if (p.resting) continue;
      p.vel.y -= DB_GRAVITY * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.ang.x * dt;
      p.mesh.rotation.y += p.ang.y * dt;
      p.mesh.rotation.z += p.ang.z * dt;

      const ground = terrainHeight(p.mesh.position.x, p.mesh.position.z) + 0.08;
      if (p.mesh.position.y <= ground && p.vel.y <= 0) {
        p.mesh.position.y = ground;
        if (Math.abs(p.vel.y) > 2.2) {
          p.vel.y = -p.vel.y * 0.3;
          p.vel.x *= 0.55;
          p.vel.z *= 0.55;
          p.ang.multiplyScalar(0.5);
        } else {
          p.resting = true;
          p.mesh.matrixAutoUpdate = false;
          p.mesh.updateMatrix();
          p.mesh.castShadow = false;
        }
      }
    }
  }

  reset() {
    // Debris persists across waves; nothing to clear mid-run
  }
}
