import * as THREE from 'three';
import { terrainHeight } from '../world/terrain.js';
import { resolvePoint } from '../world/colliders.js';

const RD_GRAVITY = 26;
const UP = new THREE.Vector3(0, 1, 0);

// Loose-limbed ragdoll v3. The body launches along the killing blow and
// tumbles head-over-heels around the axis perpendicular to it. Every joint
// pivot (head, arms, legs) runs a barely-damped spring — limbs flail in the
// air, whip on every bounce, and slump when the body finally rests. The
// corpse settles toward its NEAREST flat orientation (so bodies end up on
// sides, backs, faces — never one scripted pose), bleeds a trail while
// flying, and leaves a growing blood pool where it lands. Bodies persist;
// once still, the ragdoll sleeps and costs nothing.
const LIMB_LENGTHS = { head: 0.45, arm: 0.85, elbow: 0.5, leg: 0.95, knee: 0.55, hleg: 1.0 };
const _limbPos = new THREE.Vector3();
const _limbTip = new THREE.Vector3();
const _limbQuat = new THREE.Quaternion();

export class Ragdoll {
  constructor(scene, group, impulse, bodyHalfWidth = 0.5, limbs = {}, particles = null, droppedGun = null, severed = []) {
    this.scene = scene;
    this.group = group;
    this.halfWidth = bodyHalfWidth;
    this.particles = particles;
    this.sleeping = false;

    // Shove BACK along the hit direction like a blast wave — a hard, flat
    // knockback with just enough lift to skip along the ground, never a
    // moon-launch into the sky
    const dir = impulse.lengthSq() > 0.01
      ? impulse.clone().normalize()
      : new THREE.Vector3(0, 1, 0);
    this.vel = impulse.clone().multiplyScalar(1.05 + Math.random() * 0.35);
    this.vel.y = Math.min(this.vel.y, 2) + 1.2 + Math.random() * 1.2 + impulse.length() * 0.05;
    // Sideways scatter so identical shots don't drop identical corpses
    this.vel.addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), (Math.random() - 0.5) * 4);

    // Tumble around the axis perpendicular to the launch direction
    const tumbleAxis = new THREE.Vector3().crossVectors(UP, dir);
    if (tumbleAxis.lengthSq() < 0.01) tumbleAxis.set(1, 0, 0);
    tumbleAxis.normalize();
    // Spin size AND direction vary: some men whip head-over-heels with the
    // blow, some against it, some barely turn and simply crumple (the
    // random-collapse pick at landing decides which way those fall)
    const spin = (1 + Math.random() * 7.5) * (Math.random() < 0.6 ? 1 : -1);
    this.angVel = new THREE.Vector3(
      tumbleAxis.x * spin + (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 4,
      tumbleAxis.z * spin + (Math.random() - 0.5) * 3
    );

    this.grounded = false;
    this.restTime = 0;
    this.life = 0;
    this.bloodTimer = 0;
    this.lieX = 0;
    this.lieZ = 0;
    this.rotVelX = 0;
    this.rotVelZ = 0;
    this.pool = null;
    this.poolMax = 1;

    // Blown-off limbs: each flies hard off the blast with its own tumble,
    // trailing blood, then rests in the grass with the corpse
    this.severed = severed.map((obj) => ({
      obj,
      vel: impulse.clone().multiplyScalar(0.7 + Math.random() * 0.6).add(new THREE.Vector3(
        (Math.random() - 0.5) * 6, 4 + Math.random() * 4, (Math.random() - 0.5) * 6
      )),
      ang: new THREE.Vector3(
        (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 18
      ),
      bloodT: 0,
      resting: false,
    }));

    // The dead man's musket tumbles away on its own
    this.gun = null;
    if (droppedGun) {
      this.gun = {
        g: droppedGun,
        vel: impulse.clone().multiplyScalar(0.4).add(new THREE.Vector3(
          (Math.random() - 0.5) * 3, 2.5 + Math.random() * 2, (Math.random() - 0.5) * 3
        )),
        ang: new THREE.Vector3(
          (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 12
        ),
        resting: false,
      };
    }

    // Per-limb spring state; the killing blow kicks the limbs too.
    // Elbows/knees are one-way hinges with a narrower range than the
    // ball-jointed shoulders/hips/neck.
    this.limbStates = Object.entries(limbs)
      .filter(([, pivot]) => !!pivot)
      .map(([name, pivot]) => {
        const hinge = /^(knee|elbow)/.test(name);
        const kickX = (Math.random() - 0.5) * 10 + impulse.x * Math.random() * 0.6;
        const lenKey = Object.keys(LIMB_LENGTHS).find((k) => name.startsWith(k));
        return {
          pivot,
          hinge,
          len: LIMB_LENGTHS[lenKey] || 0.7,
          loX: hinge ? -2.0 : -2.6,
          hiX: hinge ? 0.35 : 2.6,
          // Hinges take their kick into the legal bend direction
          vx: hinge ? -Math.abs(kickX) : kickX,
          vz: (Math.random() - 0.5) * 10 + impulse.z * Math.random() * 0.6,
          vy: (Math.random() - 0.5) * 6,
          tx: hinge ? -Math.random() * 1.4 : (Math.random() - 0.5) * 2.6,
          tz: (Math.random() - 0.5) * (hinge ? 0.5 : 2.2),
          ty: (Math.random() - 0.5) * 1.2,
          wander: Math.random() * 10,
        };
      });
  }

  // A nearby blast just reshaped the ground (fresh crater): wake the corpse
  // so the body, severed limbs, dropped gun and blood pool all settle down
  // onto the NEW terrain instead of floating over the hole. Pieces get a
  // tiny pop so they visibly tumble and bleed down into the bowl.
  wake() {
    if (!this.grounded) return; // still flying — it will land on the new ground anyway
    this.sleeping = false;
    this.restTime = 0;
    this.group.traverse((o) => { o.matrixAutoUpdate = true; });
    this.rotVelX += (Math.random() - 0.5) * 0.8;
    this.rotVelZ += (Math.random() - 0.5) * 0.8;
    this._retargetLimbs(0.4);

    for (const S of this.severed) {
      S.resting = false;
      S.obj.matrixAutoUpdate = true;
      S.obj.traverse((o) => { o.matrixAutoUpdate = true; });
      S.vel.set((Math.random() - 0.5) * 2, 1.2 + Math.random() * 1.6, (Math.random() - 0.5) * 2);
      S.ang.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 5);
      S.bloodT = 0.15; // fresh drips as it slides down
    }
    if (this.gun && this.gun.resting) {
      this.gun.resting = false;
      this.gun.g.matrixAutoUpdate = true;
      this.gun.g.traverse((o) => { o.matrixAutoUpdate = true; });
      this.gun.vel.set((Math.random() - 0.5) * 1.2, 0.8, (Math.random() - 0.5) * 1.2);
      this.gun.ang.set(0, 0, 0);
    }
    // The pool drops flush onto the new crater floor
    if (this.pool) {
      this.pool.position.y = terrainHeight(this.pool.position.x, this.pool.position.z) + 0.045;
    }
  }

  _retargetLimbs(energy) {
    for (const L of this.limbStates) {
      L.tx = (Math.random() - 0.5) * (L.hinge ? 1.6 : 2.6) * energy;
      L.tz = (Math.random() - 0.5) * (L.hinge ? 0.5 : 2.2) * energy;
      L.ty = (Math.random() - 0.5) * 1.4 * energy;
      L.vx += (Math.random() - 0.5) * 14 * energy;
      L.vz += (Math.random() - 0.5) * 14 * energy;
    }
  }

  _updateLimbs(dt) {
    // Soft, barely-damped joints in the air = floppy; firmer once grounded
    // so the limbs slump into the sprawl and stop.
    const k = this.grounded ? 10 : 2.6;
    const c = this.grounded ? 4.5 : 0.55;
    let motion = 0;
    for (const L of this.limbStates) {
      if (!this.grounded) {
        // Targets drift continuously so limbs never freeze mid-flight
        L.wander += dt;
        L.tx += Math.sin(L.wander * 3.1) * dt * 1.6;
        L.tz += Math.cos(L.wander * 2.3) * dt * 1.4;
      }
      const r = L.pivot.rotation;
      L.vx += (-k * (r.x - L.tx) - c * L.vx) * dt;
      L.vz += (-k * (r.z - L.tz) - c * L.vz) * dt;
      L.vy += (-k * (r.y - L.ty) - c * L.vy) * dt;
      r.x = THREE.MathUtils.clamp(r.x + L.vx * dt, L.loX, L.hiX);
      r.z = THREE.MathUtils.clamp(r.z + L.vz * dt, L.hinge ? -0.7 : -2.4, L.hinge ? 0.7 : 2.4);
      r.y = THREE.MathUtils.clamp(r.y + L.vy * dt, -1.5, 1.5);
      // Rebound off joint limits instead of pinning against them
      if (r.x === L.loX && L.vx < 0) L.vx *= -0.4;
      if (r.x === L.hiX && L.vx > 0) L.vx *= -0.4;
      motion = Math.max(motion, Math.abs(L.vx), Math.abs(L.vz), Math.abs(L.vy));
    }
    return motion;
  }

  // Limb tips collide with the ground and with solid props: a swinging arm
  // that whacks a tree or the dirt rebounds instead of passing through.
  _collideLimbs() {
    for (const L of this.limbStates) {
      L.pivot.getWorldPosition(_limbPos);
      L.pivot.getWorldQuaternion(_limbQuat);
      _limbTip.set(0, -L.len, 0).applyQuaternion(_limbQuat).add(_limbPos);

      const ground = terrainHeight(_limbTip.x, _limbTip.z) + 0.05;
      let struck = _limbTip.y < ground;
      if (!struck) {
        const probe = { x: _limbTip.x, z: _limbTip.z };
        struck = !!resolvePoint(probe, 0.06);
      }
      if (struck) {
        if (!this.grounded && Math.abs(L.vx) + Math.abs(L.vz) > 0.5) {
          // Fast swing into an obstacle: rebound
          L.vx *= -0.45;
          L.vz *= -0.45;
          L.vy *= 0.5;
        } else {
          // Resting contact: bleed energy and stop the spring from
          // driving the limb into the surface, so corpses can sleep
          L.vx *= 0.5;
          L.vz *= 0.5;
          L.vy *= 0.5;
          L.tx = L.pivot.rotation.x;
          L.tz = L.pivot.rotation.z;
        }
      }
    }
  }

  _updateSevered(dt) {
    for (const S of this.severed) {
      if (S.resting) continue;
      S.vel.y -= RD_GRAVITY * dt;
      S.obj.position.addScaledVector(S.vel, dt);
      S.obj.rotation.x += S.ang.x * dt;
      S.obj.rotation.y += S.ang.y * dt;
      S.obj.rotation.z += S.ang.z * dt;

      // Blood streams off the flying limb
      if (this.particles) {
        S.bloodT -= dt;
        if (S.bloodT <= 0) {
          S.bloodT = 0.09;
          this.particles.blood(S.obj.position.clone(), false);
        }
      }

      const ground = terrainHeight(S.obj.position.x, S.obj.position.z) + 0.18;
      if (S.obj.position.y <= ground && S.vel.y <= 0) {
        S.obj.position.y = ground;
        if (Math.abs(S.vel.y) > 2.5) {
          S.vel.y = -S.vel.y * 0.3;
          S.vel.x *= 0.55;
          S.vel.z *= 0.55;
          S.ang.multiplyScalar(0.5);
        } else {
          S.resting = true;
          S.obj.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); o.castShadow = false; });
          S.obj.matrixAutoUpdate = false;
          S.obj.updateMatrix();
        }
      }
    }
  }

  _updateGun(dt) {
    const G = this.gun;
    if (!G || G.resting) return;
    G.vel.y -= RD_GRAVITY * dt;
    G.g.position.addScaledVector(G.vel, dt);
    G.g.rotation.x += G.ang.x * dt;
    G.g.rotation.y += G.ang.y * dt;
    G.g.rotation.z += G.ang.z * dt;

    const hit = resolvePoint(G.g.position, 0.2);
    if (hit) {
      const dot = G.vel.x * hit.nx + G.vel.z * hit.nz;
      if (dot < 0) { G.vel.x -= 1.6 * dot * hit.nx; G.vel.z -= 1.6 * dot * hit.nz; G.vel.multiplyScalar(0.6); }
    }

    const ground = terrainHeight(G.g.position.x, G.g.position.z) + 0.09;
    if (G.g.position.y <= ground && G.vel.y <= 0) {
      G.g.position.y = ground;
      if (Math.abs(G.vel.y) > 2.5) {
        G.vel.y = -G.vel.y * 0.3;
        G.vel.x *= 0.5;
        G.vel.z *= 0.5;
        G.ang.multiplyScalar(0.5);
      } else {
        // Come to rest lying flat in the grass
        G.resting = true;
        G.g.rotation.x = 0;
        G.g.rotation.z = Math.PI / 2 + (Math.random() - 0.5) * 0.3;
        G.g.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); o.castShadow = false; });
        G.g.matrixAutoUpdate = false;
        G.g.updateMatrix();
      }
    }
  }

  update(dt) {
    if (this.sleeping) return false;
    this.life += dt;

    const p = this.group.position;
    const r = this.group.rotation;
    const limbMotion = this._updateLimbs(dt);
    this._collideLimbs();
    this._updateGun(dt);
    this._updateSevered(dt);

    if (!this.grounded) {
      // Airborne tumble
      this.vel.y -= RD_GRAVITY * dt;
      p.addScaledVector(this.vel, dt);
      r.x += this.angVel.x * dt;
      r.y += this.angVel.y * dt;
      r.z += this.angVel.z * dt;

      // Blood trail streaming off the flying body
      if (this.particles && this.life < 1.5) {
        this.bloodTimer -= dt;
        if (this.bloodTimer <= 0) {
          this.bloodTimer = 0.07;
          const at = p.clone();
          at.y += this.halfWidth;
          this.particles.blood(at, false);
        }
      }

      // Slam into trees/fences/houses: bounce off and shed speed
      const hit = resolvePoint(p, 0.45);
      if (hit) {
        const dot = this.vel.x * hit.nx + this.vel.z * hit.nz;
        if (dot < 0) {
          this.vel.x -= 1.6 * dot * hit.nx;
          this.vel.z -= 1.6 * dot * hit.nz;
          this.vel.multiplyScalar(0.55);
          this.angVel.multiplyScalar(0.7);
          this._retargetLimbs(0.9);
          if (this.particles) {
            const at = p.clone();
            at.y += this.halfWidth;
            this.particles.blood(at, true);
          }
        }
      }

      // Only a DOWNWARD contact is a landing — the body starts at ground
      // level and must be free to launch upward without a phantom bounce
      const ground = terrainHeight(p.x, p.z) + this.halfWidth;
      if (p.y <= ground && this.vel.y <= 0) {
        p.y = ground;
        const impact = Math.abs(this.vel.y);
        if (impact > 3.5) {
          // Bounce: keep tumbling, limbs whip, blood splashes
          this.vel.y = impact * 0.42;
          this.vel.x *= 0.6;
          this.vel.z *= 0.6;
          this.angVel.multiplyScalar(0.65);
          this._retargetLimbs(Math.min(impact * 0.15, 1.2));
          if (this.particles) {
            const at = p.clone();
            at.y += 0.3;
            this.particles.blood(at, true);
          }
        } else {
          this.grounded = true;
          this.vel.set(0, 0, 0);
          // Settle toward the NEAREST flat orientation from the current
          // tumble — bodies land on sides, backs, faces, half-twisted
          this.lieX = Math.round(r.x / Math.PI) * Math.PI;
          this.lieZ = Math.round((r.z - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
          // A body that lands still nearly upright (bullet kills barely
          // tumble) would ALWAYS round to the same keel — instead pick the
          // collapse at random: face-plant, flat on the back, or crumpling
          // to either side, with a shove of roll momentum to sell it
          const baseX = Math.round(r.x / Math.PI) * Math.PI;
          const baseZ = Math.round(r.z / Math.PI) * Math.PI;
          if (Math.abs(r.x - baseX) < 0.6 && Math.abs(r.z - baseZ) < 0.6) {
            if (Math.random() < 0.45) {
              // Pitch over face-first or flat onto the back
              this.lieX = baseX + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
              this.lieZ = baseZ;
              this.rotVelX += (this.lieX > baseX ? 1.6 : -1.6) + (Math.random() - 0.5);
            } else {
              // Keel sideways — either side, never the same one every time
              this.lieX = baseX;
              this.lieZ = baseZ + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
              this.rotVelZ += (this.lieZ > baseZ ? 1.6 : -1.6) + (Math.random() - 0.5);
            }
          }
          this.rotVelX = this.angVel.x * 0.5;
          this.rotVelZ = this.angVel.z * 0.5;
          this._retargetLimbs(0.5);
          this._makePool(p);
        }
      }
      return false;
    }

    // Grounded: crumple with springy wobble (carried momentum, slight
    // overshoot) rather than a scripted lerp
    this.restTime += dt;
    const K = 22, C = 7.5;
    this.rotVelX += (-K * (r.x - this.lieX) - C * this.rotVelX) * dt;
    this.rotVelZ += (-K * (r.z - this.lieZ) - C * this.rotVelZ) * dt;
    r.x += this.rotVelX * dt;
    r.z += this.rotVelZ * dt;

    const lyingY = terrainHeight(p.x, p.z) + this.halfWidth * 0.8;
    p.y += (lyingY - p.y) * Math.min(1, 6 * dt);

    // Blood pool spreads beneath the body
    if (this.pool && this.pool.scale.x < this.poolMax) {
      const s = Math.min(this.poolMax, this.pool.scale.x + dt * 0.7);
      this.pool.scale.set(s, s, 1);
    }

    const bodyStill = Math.abs(this.rotVelX) + Math.abs(this.rotVelZ) < 0.05;
    const gunDone = !this.gun || this.gun.resting;
    const severedDone = this.severed.every((S) => S.resting);
    if (this.restTime > 2.2 && limbMotion < 0.05 && bodyStill && gunDone && severedDone) {
      this.sleeping = true;
      this.group.traverse((o) => {
        o.matrixAutoUpdate = false;
        o.updateMatrix();
        o.castShadow = false; // sleeping corpses skip the shadow pass
      });
    }
    return false;
  }

  _makePool(p) {
    if (this.pool || !this.scene) return;
    const material = new THREE.MeshStandardMaterial({
      color: 0x4a0b07,
      roughness: 0.25,
      metalness: 0.25,
      transparent: true,
      opacity: 0.9,
    });
    this.pool = new THREE.Mesh(new THREE.CircleGeometry(1, 12), material);
    this.pool.rotation.x = -Math.PI / 2;
    this.pool.rotation.z = Math.random() * Math.PI;
    this.pool.position.set(p.x, terrainHeight(p.x, p.z) + 0.045, p.z);
    this.pool.scale.set(0.25, 0.25, 1);
    this.poolMax = 0.9 + Math.random() * 0.7;
    this.scene.add(this.pool);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const S of this.severed) this.scene.remove(S.obj);
    this.severed = [];
    if (this.gun) {
      // The dropped musket STAYS in the grass — battle litter outlives
      // the man who carried it
      this.gun = null;
    }
    if (this.pool) {
      this.scene.remove(this.pool);
      this.pool.geometry.dispose();
      this.pool.material.dispose();
      this.pool = null;
    }
  }
}
