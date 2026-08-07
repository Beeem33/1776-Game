import * as THREE from 'three';

const RPM = 450;
const FIRE_INTERVAL = 60 / RPM;
const MAG_SIZE = 25;
const RELOAD_TIME = 1.9;        // matches the player's reload animation
const HEAT_PER_SHOT = 0.03;
const COOL_RATE = 0.34;
const OVERHEAT_RECOVER = 0.3;
const RANGE = 300;

// Uzi: 600 RPM hitscan, 32-round magazines with an animated reload, plus a
// sustained-fire heat/overheat mechanic. Headshots are instant kills.
export class Weapon {
  constructor(scene, camera, audio, particles = null) {
    this.scene = scene;
    this.camera = camera;
    this.audio = audio;
    this.particles = particles;

    this.heat = 0;
    this.overheated = false;
    this.cooldown = 0;

    this.ammo = MAG_SIZE;
    this.magSize = MAG_SIZE;
    this.reloading = false;
    this.reloadT = 0;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = RANGE;

    this.tracers = [];
    this._tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0.9,
    });
    this._tracerGeo = new THREE.BoxGeometry(0.04, 0.04, 1);

    this.flash = new THREE.PointLight(0xffb347, 0, 12);
    scene.add(this.flash);

    this._buildFlashSprites();
    this._flashLife = 0;
    this._flashAttached = false;
    this._shotCounter = 0;
  }

  // Real fire at the muzzle: crossed jagged-flame planes (additive) that
  // roll to a random angle every shot, plus a forward-facing bloom disc.
  _buildFlashSprites() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size * 0.22, size / 2, 2, size * 0.22, size / 2, size * 0.75);
    g.addColorStop(0, 'rgba(255, 250, 225, 1)');
    g.addColorStop(0.25, 'rgba(255, 190, 80, 0.95)');
    g.addColorStop(0.55, 'rgba(255, 110, 20, 0.55)');
    g.addColorStop(1, 'rgba(255, 60, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // Jagged flame tongues licking forward
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 9; i++) {
      const y = size / 2 + (Math.random() - 0.5) * size * 0.5;
      const len = size * (0.5 + Math.random() * 0.5);
      const wdt = 3 + Math.random() * 7;
      const grad = ctx.createLinearGradient(size * 0.2, y, len, y);
      grad.addColorStop(0, 'rgba(255, 220, 130, 0.9)');
      grad.addColorStop(1, 'rgba(255, 80, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(size * 0.18, y - wdt);
      ctx.lineTo(len, y + (Math.random() - 0.5) * 6);
      ctx.lineTo(size * 0.18, y + wdt);
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);

    const matFire = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.flashGroup = new THREE.Group();
    // Aim subgroup points the flame planes down the barrel (+z)
    const aim = new THREE.Group();
    aim.rotation.y = -Math.PI / 2;
    this.flashGroup.add(aim);

    const geo = new THREE.PlaneGeometry(0.6, 0.3);
    geo.translate(0.3, 0, 0); // extends forward from the muzzle
    this._flamePlanes = [];
    for (let i = 0; i < 3; i++) {
      const plane = new THREE.Mesh(geo, matFire);
      plane.rotation.x = (i / 3) * Math.PI; // rolled around the barrel
      aim.add(plane);
      this._flamePlanes.push(plane);
    }

    // Forward bloom disc
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), matFire);
    disc.position.z = 0.12;
    this.flashGroup.add(disc);
    this._flashDisc = disc;

    this.flashGroup.visible = false;
  }

  startReload() {
    if (this.reloading || this.ammo === MAG_SIZE) return;
    this.reloading = true;
    this.reloadT = 0;
    this.audio.playSfx('reload', { volume: 0.85 });
  }

  // aimNdc: where the crosshair actually is in NDC — (0,0) under pointer
  // lock, the real mouse position in fallback mode.
  update(dt, firing, player, enemies, onHit, camCtrl, reloadRequested, aimNdc = { x: 0, y: 0 }) {
    this.cooldown -= dt;

    // Fire sprites live on the gun muzzle so they track every gun movement
    if (!this._flashAttached && player.muzzle) {
      player.muzzle.add(this.flashGroup);
      this._flashAttached = true;
    }
    if (this._flashLife > 0) {
      this._flashLife -= dt;
      if (this._flashLife <= 0) this.flashGroup.visible = false;
    }

    if (reloadRequested) this.startReload();

    // Reload progress drives the player's gun/mag animation
    if (this.reloading) {
      this.reloadT += dt / RELOAD_TIME;
      if (this.reloadT >= 1) {
        this.reloading = false;
        this.ammo = MAG_SIZE;
      }
    }
    player.setReloadT(this.reloading ? this.reloadT : null);

    // Cooling
    const coolRate = this.overheated ? COOL_RATE * 1.4 : COOL_RATE;
    if (!firing || this.overheated || this.reloading) {
      this.heat = Math.max(0, this.heat - coolRate * dt);
    } else {
      this.heat = Math.max(0, this.heat - coolRate * 0.4 * dt);
    }
    if (this.overheated && this.heat <= OVERHEAT_RECOVER) {
      this.overheated = false;
    }

    // Warning beeps
    if (firing && this.overheated) {
      this.audio.overheatBeep(dt, true);
    } else if (firing && this.heat > 0.75 && !this.reloading) {
      this.audio.overheatBeep(dt, false);
    }

    // Firing
    if (firing && !this.overheated && !this.reloading && this.ammo > 0 && this.cooldown <= 0) {
      this.cooldown = FIRE_INTERVAL;
      this._fire(player.muzzle, enemies, onHit, camCtrl, aimNdc);
      player.kick(); // visible gun recoil
      this.ammo -= 1;
      if (this.ammo <= 0) this.startReload();
    }

    // Fade tracers + flash
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 260);
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, t.life / t.maxLife) * 0.9;
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        t.mesh.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
  }

  _fire(muzzle, enemies, onHit, camCtrl, aimNdc) {
    this.heat += HEAT_PER_SHOT;
    if (this.heat >= 1) {
      this.heat = 1;
      this.overheated = true;
      this.audio.playSfx('beep', { volume: 0.6, rate: 0.6 });
    }

    this.audio.playSfx('uzi', { volume: 0.5, rate: 1, rateJitter: 0.07 });
    camCtrl.addShake(0.024); // per-shot screen kick, still subtle

    // Hitscan through the crosshair with slight bloom
    const spread = 0.006 + this.heat * 0.012;
    const ndc = new THREE.Vector2(
      aimNdc.x + (Math.random() - 0.5) * 2 * spread,
      aimNdc.y + (Math.random() - 0.5) * 2 * spread
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    const targets = [];
    for (const e of enemies) {
      if (!e.dead && !e.dying) targets.push(e.group);
    }
    const hits = this.raycaster.intersectObjects(targets, true);

    let endPoint = null;
    let hitInfo = null;
    for (const h of hits) {
      if (!h.object.isMesh) continue;
      let node = h.object;
      let enemy = null;
      while (node) {
        if (node.userData && node.userData.enemy) { enemy = node.userData.enemy; break; }
        node = node.parent;
      }
      if (enemy && !enemy.dead && !enemy.dying) {
        const zone = h.object.userData.zone === 'head' ? 'head' : 'body';
        endPoint = h.point.clone();
        hitInfo = { enemy, zone, point: h.point.clone() };
        break;
      }
    }

    if (!endPoint) {
      endPoint = this.raycaster.ray.origin
        .clone()
        .addScaledVector(this.raycaster.ray.direction, RANGE);
      if (endPoint.y < 0) {
        const t = -this.raycaster.ray.origin.y / this.raycaster.ray.direction.y;
        if (t > 0) {
          endPoint = this.raycaster.ray.origin
            .clone()
            .addScaledVector(this.raycaster.ray.direction, t);
        }
      }
    }

    const muzzlePos = new THREE.Vector3();
    muzzle.getWorldPosition(muzzlePos);

    this.flash.position.copy(muzzlePos);
    this.flash.intensity = 14;

    // Fire: re-roll the flame planes so every flash looks different
    this.flashGroup.visible = true;
    this._flashLife = 0.055;
    const s = 0.9 + Math.random() * 0.75;
    this.flashGroup.scale.set(s, s, s);
    for (const plane of this._flamePlanes) {
      plane.rotation.x = Math.random() * Math.PI;
    }
    this._flashDisc.rotation.z = Math.random() * Math.PI;

    // Sparks + a lick of flame every shot, a curl of smoke every few
    this._shotCounter++;
    if (this.particles) {
      this.particles.spark(muzzlePos);
      this.particles.flame(muzzlePos);
      if (this._shotCounter % 3 === 0) this.particles.smoke(muzzlePos);
    }

    this._spawnTracer(muzzlePos, endPoint);

    if (hitInfo) {
      // Headshots one-shot; body shots do 20 (5 to drop infantry)
      const dmg = hitInfo.zone === 'head' ? Infinity : 20;
      this.audio.playSfx(hitInfo.zone === 'head' ? 'headshot' : 'hit', {
        volume: hitInfo.zone === 'head' ? 0.7 : 0.45,
        rateJitter: 0.05,
      });
      // Killing blows launch the body hard along the bullet's travel —
      // away from the shooter, opposite the side that was hit
      const impulse = this.raycaster.ray.direction
        .clone()
        .multiplyScalar(hitInfo.zone === 'head' ? 17 : 12);
      onHit(hitInfo.enemy, dmg, hitInfo.zone, hitInfo.point, impulse);
    }
  }

  _spawnTracer(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.5) return;
    const mesh = new THREE.Mesh(this._tracerGeo, this._tracerMat.clone());
    mesh.scale.z = len;
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.lookAt(to);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life: 0.07, maxLife: 0.07 });
  }

  reset() {
    this.heat = 0;
    this.overheated = false;
    this.cooldown = 0;
    this.ammo = MAG_SIZE;
    this.reloading = false;
    this.reloadT = 0;
  }
}
