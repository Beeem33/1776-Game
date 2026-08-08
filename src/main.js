import * as THREE from 'three';
import { createWorld, updateSun, houseChunks } from './world/world.js';
import { windClock, terrainHeight, blastCrater } from './world/terrain.js';
import { Weather } from './world/weather.js';
import { DebrisManager } from './world/debris.js';
import { Input } from './core/input.js';
import { ThirdPersonCamera } from './core/camera.js';
import { Player } from './entities/player.js';
import { AudioManager } from './systems/audio.js';
import { Weapon } from './systems/weapon.js';
import { WaveManager } from './systems/waves.js';
import { Particles } from './systems/particles.js';
import { UI } from './systems/ui.js';

const TRAMPLE_SPEED = 9;   // min player speed for an instant-kill trample
const TRAMPLE_RANGE = 3.0;

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 900
    );
    // The camera must live IN the scene graph or its children (the
    // first-person gun + arms rig) are silently never rendered
    this.scene.add(this.camera);

    const { sun, smokeSources } = createWorld(this.scene);
    this.sun = sun;
    this.smokeSources = smokeSources;

    this.input = new Input();
    this.ui = new UI();
    this.audio = new AudioManager(this.camera);
    this.audio.setMuted(false); // sound on — hard-stopped while paused/hidden via _syncAudio
    this.camCtrl = new ThirdPersonCamera(this.camera);
    this.player = new Player(this.scene);
    this.particles = new Particles(this.scene);
    this.weapon = new Weapon(this.scene, this.camera, this.audio, this.particles);
    this.waves = new WaveManager(this.scene, this.audio, this.ui, this.particles);
    this.weather = new Weather(this.scene, this.audio);
    this.debris = new DebrisManager(this.scene);

    this.state = 'menu'; // 'menu' | 'playing' | 'paused' | 'dead'
    this.clock = new THREE.Clock();
    this._rWasDown = false;
    this._vWasDown = false;
    this._eyePos = new THREE.Vector3();
    this.shells = []; // mortar/cannon shells in flight
    this._eWasDown = false;

    this._bindEvents();
    this.ui.showScreen('start');

    this.renderer.setAnimationLoop(() => this._tick());
  }

  _bindEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Any overlay click -> engage pointer lock IMMEDIATELY (synchronously,
    // while the click's user-gesture window is still open — requesting it
    // after async audio setup gets silently denied by browsers, which is
    // exactly how the mouse used to escape the game). Audio init follows.
    const requestPlay = () => {
      try {
        const p = this.canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => this._startWithoutLock());
      } catch (e) {
        this._startWithoutLock();
      }
      this.audio.init();
    };
    document.addEventListener('pointerlockerror', () => this._startWithoutLock());

    // Fallback pause (no pointer lock to release, so Esc is handled manually)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this._noLockMode && this.state === 'playing') {
        this.input.pointerLocked = false;
        this.state = 'paused';
        this.ui.showScreen('pause');
        this._syncAudio();
      }
      // G toggles fullscreen and grabs the mouse so it can't leave the game
      // (F is the saber strike)
      if (e.code === 'KeyG' && this.state === 'playing') {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().then(() => {
            const p = this.canvas.requestPointerLock();
            if (p && p.catch) p.catch(() => {});
          }).catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      }
    });

    // In fallback mode, every canvas click retries a real pointer lock —
    // the moment the browser grants it, the mouse is fenced to the game
    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && this._noLockMode && !document.pointerLockElement) {
        try {
          const p = this.canvas.requestPointerLock();
          if (p && p.catch) p.catch(() => {});
        } catch (err) { /* stay in fallback */ }
      }
    });
    this.ui.overlayStart.addEventListener('click', requestPlay);
    this.ui.overlayPause.addEventListener('click', requestPlay);
    this.ui.overlayDeath.addEventListener('click', () => {
      this._resetRun();
      requestPlay();
    });

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      this.input.pointerLocked = locked;

      if (locked) {
        this._noLockMode = false; // real lock acquired — center the crosshair
        if (this.state === 'menu' || this.state === 'paused') {
          if (this.waves.state === 'idle') this.waves.start();
          this.state = 'playing';
          this.ui.showScreen('game');
          this.clock.getDelta(); // discard time spent in menus
        }
      } else {
        if (this.state === 'playing') {
          this.state = 'paused';
          this.ui.showScreen('pause');
        }
      }
      this._syncAudio();
    });

    // All sound stops the moment the game isn't the thing on screen:
    // tab switch / minimize (visibilitychange), window losing focus (blur),
    // or the page being closed/navigated away (pagehide).
    document.addEventListener('visibilitychange', () => this._syncAudio());
    window.addEventListener('blur', () => this.audio.setSuspended(true));
    window.addEventListener('focus', () => this._syncAudio());
    window.addEventListener('pagehide', () => this.audio.setSuspended(true));
  }

  // Sound runs only while actively playing with the game on screen
  _syncAudio() {
    const active = this.state === 'playing' && !document.hidden;
    this.audio.setSuspended(!active);
  }

  // Some embedded browsers refuse the Pointer Lock API entirely — run with
  // plain mouse-move deltas instead so the game is still playable.
  _startWithoutLock() {
    if (this.state === 'playing') return;
    this._noLockMode = true;
    this.input.pointerLocked = true; // treat mouse as captured
    if (this.waves.state === 'idle') this.waves.start();
    this.state = 'playing';
    this.ui.showScreen('game');
    this.clock.getDelta();
    this._syncAudio();
  }


  // Knock house wall chunks loose around a blast point — a corner shot
  // takes the corner, not the building
  _blastHouseChunks(at, radius) {
    const tmp = new THREE.Vector3();
    for (let i = houseChunks.length - 1; i >= 0; i--) {
      const chunk = houseChunks[i];
      chunk.getWorldPosition(tmp);
      const d = tmp.distanceTo(at);
      if (d > radius) continue;
      houseChunks.splice(i, 1);
      this.scene.attach(chunk);
      const away = tmp.clone().sub(at);
      away.y = Math.abs(away.y) + 1.5;
      away.setLength(6 + Math.random() * 7 * (1 - d / radius));
      this.debris.add(
        chunk,
        away,
        new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 10)
      );
    }
  }

  // ---------------- mortar shells ----------------

  _launchShell(ev) {
    const big = ev.type === 'cannonFire';

    // Cannonballs fly slow and heavy so you can watch them come in;
    // mortar bombs take a fixed high lob. Both lead the rider, then scatter.
    let T;
    if (big) {
      const dist = ev.from.distanceTo(this.player.position);
      T = THREE.MathUtils.clamp(dist / 20, 1.6, 5); // ~20 m/s — cinematic
    } else {
      T = 2.1 + Math.random() * 0.5;
    }
    const target = this.player.position.clone()
      .addScaledVector(this.player.velocity, T * 0.6);
    const scatter = big ? 8 : 11;
    target.x += (Math.random() - 0.5) * scatter;
    target.z += (Math.random() - 0.5) * scatter;
    target.y = terrainHeight(target.x, target.z);

    // Ballistic solve for the arc
    const g = 26;
    const vel = target.clone().sub(ev.from).divideScalar(T);
    vel.y = (target.y - ev.from.y + 0.5 * g * T * T) / T;

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(big ? 0.26 : 0.14, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x1d2126, roughness: 0.5, metalness: 0.6 })
    );
    mesh.castShadow = true;
    mesh.position.copy(ev.from);
    this.scene.add(mesh);

    this.shells.push({ mesh, vel, smokeT: 0, whistled: false, big });
  }

  _updateShells(dt) {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.vel.y -= (s.g ?? 26) * dt;
      s.mesh.position.addScaledVector(s.vel, dt);

      // Sputtering fuse smoke
      s.smokeT -= dt;
      if (s.smokeT <= 0) {
        s.smokeT = 0.07;
        this.particles.spawnBurst(s.mesh.position.clone(), {
          color: 0x8f938c, count: 2, speed: 0.4, size: 0.22, life: 0.7, gravity: -0.6, upBias: 0.3,
        });
      }

      // Whistle once it tips over the top of the arc
      if (!s.whistled && s.vel.y < 0) {
        s.whistled = true;
        const d = s.mesh.position.distanceTo(this.player.position);
        this.audio.playSfx('whistle', {
          volume: Math.min(0.9, Math.max(0.15, 1.1 - d / 60)),
          rate: s.big ? 0.65 : 1, // heavier ball, deeper moan
          rateJitter: 0.1,
        });
      }

      const groundY = terrainHeight(s.mesh.position.x, s.mesh.position.z) + 0.12;
      if (s.mesh.position.y <= groundY && s.vel.y <= 0) {
        const at = s.mesh.position.clone();
        at.y = groundY;
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh.material.dispose();
        this.shells.splice(i, 1);
        this._explodeShell(at, s.big);
      }
    }
  }

  _explodeShell(at, big = false) {
    // Dig a real crater into the terrain (scorch, rim clods, flattened grass)
    const r = blastCrater(this.scene, at.x, at.z, big ? 2.6 : 1);
    const k = big ? 3.4 : 1; // effect scale

    // Carve nearby house walls into flying rubble
    this._blastHouseChunks(at, r * 0.6 + 1.6);

    // The ground just sank here — wake corpses resting near the new crater
    // so bodies, torn-off limbs and blood pools tumble down into the bowl
    // instead of floating over it (craterDip reaches out to 2x the radius)
    for (const e of this.waves.enemies) {
      if (!e.dying || !e.ragdoll) continue;
      const dc = Math.hypot(e.group.position.x - at.x, e.group.position.z - at.z);
      if (dc < r * 2 + 2) e.ragdoll.wake();
    }

    // Dirt hurled HIGH into the sky: a tall central column + a wide fan
    const plume = at.clone();
    plume.y += 0.4;
    this.particles.spawnBurst(plume, {
      color: 0x5b4630, count: Math.round(70 * k), speed: 9 * k, size: 0.42,
      life: 1.9, gravity: 20, upBias: big ? 30 : 22,
    });
    this.particles.spawnBurst(plume, {
      color: 0x3f3222, count: Math.round(40 * k), speed: 14, size: 0.34,
      life: 1.3, gravity: 22, upBias: 10,
    });
    this.particles.spawnBurst(plume, {
      color: 0x777468, count: Math.round(16 * k), speed: 2, size: 0.7 * k,
      life: 2.6, gravity: -0.8, upBias: 2,
    });

    // Big shells throw a fireball + a hot flash of light
    if (big) {
      this.particles.spawnBurst(plume, {
        color: 0xff7a20, count: big ? 70 : 34, speed: big ? 12 : 8,
        size: big ? 0.85 : 0.55, life: big ? 0.6 : 0.45, gravity: -3, upBias: big ? 7 : 4,
      });
      if (big) {
        // Rolling secondary fireball + lingering black smoke column
        this.particles.spawnBurst(plume, {
          color: 0xffb040, count: 44, speed: 7, size: 0.85, life: 0.55, gravity: -4, upBias: 12,
        });
        this.particles.spawnBurst(plume, {
          color: 0x2c2a26, count: 38, speed: 3, size: 1.4, life: 3.8, gravity: -1.4, upBias: 5,
        });
        // Ground-hugging shockwave ring racing out from the impact
        this.particles.spawnBurst(plume, {
          color: 0xcabfa8, count: 46, speed: 20, size: 0.5, life: 0.7, gravity: 2, upBias: 0.3,
        });
      }
      const flash = new THREE.PointLight(0xff9440, big ? 220 : 60, big ? 62 : 30);
      flash.position.copy(at).y += 2;
      this.scene.add(flash);
      setTimeout(() => this.scene.remove(flash), big ? 240 : 130);
    }

    const dPlayer = at.distanceTo(this.player.position);
    this.audio.playSfx('boom', {
      volume: Math.min(1, Math.max(0.25, (big ? 1.45 : 1.25) - dPlayer / 60)),
      rate: big ? 0.8 : 1,
      rateJitter: 0.08,
    });
    this.camCtrl.addShake(Math.min(big ? 1.05 : 0.45, (big ? 24 : 8) / Math.max(dPlayer, 1)));

    // Blast damage to the rider (spared mid-finisher — cinematic luck)...
    const dmgRadius = big ? 11.5 : 7;
    if (dPlayer < dmgRadius && !this.finisher) {
      this.player.takeDamage(Math.round((big ? 40 : 30) * (1 - dPlayer / dmgRadius)) + 6);
      this.ui.flashDamage();
      this.audio.playSfx('hurt', { volume: 0.7 });
    }

    // ...and to any redcoat standing too close (war is messy)
    const killRadius = r + 1.5;
    for (const e of this.waves.enemies) {
      if (e.dead || e.dying) continue;
      const dx = e.group.position.x - at.x;
      const dz = e.group.position.z - at.z;
      const dEnemy = Math.hypot(dx, dz);
      if (dEnemy < killRadius) {
        const impulse = new THREE.Vector3(dx, 0, dz).setLength(10);
        impulse.y = 7;
        e.kill(impulse, true); // explosions can tear limbs off
        this.waves.onKill();
        this.particles.blood(e.group.position.clone().setY(e.group.position.y + 1), true);
      }
    }
  }

  // ---------------- the knife finisher ----------------
  // U near a redcoat on foot: the camera pulls back and slowly orbits, the
  // patriot wrenches him into a headlock (musket clatters away, he thrashes
  // to break free), draws a boot knife, and drives it into the chest 3-5
  // times — blood squirting on every thrust — until the man goes limp.

  _startFinisher(enemy) {
    enemy.inFinisher = true;

    // Face the man you're about to grab
    const dx = enemy.group.position.x - this.player.position.x;
    const dz = enemy.group.position.z - this.player.position.z;
    this.player.heading = Math.atan2(dx, dz);
    this.player.group.rotation.y = this.player.heading;
    this.player.riderUpper.rotation.y = 0;

    // His musket drops from his hands
    let gun = null;
    if (enemy.musketParts && enemy.musketParts.length) {
      gun = new THREE.Group();
      this.scene.add(gun);
      enemy.musketParts[0].getWorldPosition(gun.position);
      for (const part of enemy.musketParts) gun.attach(part);
      enemy.musketParts = [];
    }

    this.finisher = {
      t: 0,
      enemy,
      stabs: 3 + Math.floor(Math.random() * 3), // 3-5 thrusts
      stabsDone: 0,
      knifeOut: false,
      done: false,
      endAt: 0,
      gun,
      gunVel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 2.2, (Math.random() - 0.5) * 1.5),
      gunRest: false,
      enemyStart: enemy.group.position.clone(),
      camSave: {
        view: this.camCtrl.viewIndex,
        zoom: this.camCtrl._zoomTarget,
        yaw: this.camCtrl.yaw,
        pitch: this.camCtrl.pitch,
      },
    };

    // Cinematic frame: drop out of first person, pull back wide and swing
    // AROUND to face the pair — you watch the kill from the front
    if (this.camCtrl.view.fp) this.player.setFirstPerson(false, this.camera);
    this.camCtrl.viewIndex = 0;
    this.camCtrl._zoomTarget = 1.9;
    this.camCtrl.yaw = this.player.heading;
    this.camCtrl.pitch = 0.12;
  }

  _updateFinisher(dt) {
    const F = this.finisher;
    const P = this.player;
    const E = F.enemy;
    F.t += dt;
    const t = F.t;
    const kf = P._kf.bind(P);

    // The dropped musket clatters to the grass
    if (F.gun && !F.gunRest) {
      F.gunVel.y -= 24 * dt;
      F.gun.position.addScaledVector(F.gunVel, dt);
      F.gun.rotation.x += 3 * dt;
      F.gun.rotation.y += 1.5 * dt;
      const gy = terrainHeight(F.gun.position.x, F.gun.position.z) + 0.09;
      if (F.gun.position.y <= gy && F.gunVel.y <= 0) {
        F.gun.position.y = gy;
        F.gun.rotation.x = 0;
        F.gun.rotation.z = Math.PI / 2 + (Math.random() - 0.5) * 0.3;
        F.gunRest = true;
      }
    }

    // If a shell kills him mid-scene, cut straight to the end
    if (E.dying && !F.done) { F.done = true; F.endAt = t; }

    if (!E.dying) {
      // Wrench him into the headlock slot: pressed hard against the
      // patriot's chest, facing away — body contact, no daylight between
      const fwd = new THREE.Vector3(Math.sin(P.heading), 0, Math.cos(P.heading));
      const slot = P.position.clone().addScaledVector(fwd, 0.5);
      slot.y = terrainHeight(slot.x, slot.z);
      const grab = Math.min(1, t / 0.45);
      E.group.position.lerpVectors(F.enemyStart, slot, grab * grab * (3 - 2 * grab));
      E.group.rotation.y = P.heading;
      E.group.rotation.x = -0.2 * grab; // hauled back into the patriot's grip

      // He struggles — arms clawing, head twisting — fading as the knife works
      const struggle = Math.max(0, 1 - Math.max(0, t - 1.9) / (F.stabs * 0.5));
      const wig = Math.sin(t * 13);
      if (E.limbs.armL) {
        E.limbs.armL.rotation.x = grab * (-0.9 + wig * 0.55 * struggle);
        E.limbs.armL.rotation.z = grab * (0.5 + Math.cos(t * 11) * 0.3 * struggle);
      }
      if (E.limbs.armR) {
        E.limbs.armR.rotation.x = grab * (-0.7 - wig * 0.5 * struggle);
        E.limbs.armR.rotation.z = grab * (-0.4 - Math.cos(t * 9) * 0.3 * struggle);
      }
      if (E.limbs.head) E.limbs.head.rotation.z = wig * 0.12 * struggle;

      // Patriot: left arm clamps hard around his neck, body leaning in
      P.armL.rotation.x = P._armLBase.x - 1.15 * grab;
      P.armL.rotation.z = P._armLBase.z + 0.7 * grab;
      P.riderUpper.rotation.x = 0.1 * grab; // shoulders over the hold

      // The knife comes out
      if (t >= 1.2 && !F.knifeOut) {
        F.knifeOut = true;
        P.uziGroup.visible = false;
        P.knife.visible = true;
        this.audio.playSfx('reload', { volume: 0.4, rate: 2.2 }); // steel whisper
      }

      // Right arm: draw + raise, then rhythmic stabs into the chest
      if (t < 1.2) {
        P.armR.rotation.x = 0;
      } else if (t < 1.9) {
        P.armR.rotation.x = -((t - 1.2) / 0.7) * 2.1;
      } else if (!F.done) {
        const cycle = (t - 1.9) / 0.5;
        const i = Math.floor(cycle);
        const ph = cycle - i;
        if (i < F.stabs) {
          P.armR.rotation.x = kf(ph, [[0, -2.1], [0.45, -0.45], [0.6, -0.55], [1, -2.1]]);
          if (ph >= 0.45 && F.stabsDone <= i) {
            F.stabsDone = i + 1;
            // Blood squirts from the chest with every thrust
            const chest = E.group.position.clone();
            chest.y += 1.45;
            chest.addScaledVector(fwd, 0.3);
            this.particles.blood(chest, true);
            this.particles.blood(chest.clone().addScaledVector(fwd, 0.25), false);
            this.audio.playSfx('squish', { volume: 0.9, rate: 1.15, rateJitter: 0.12 });
            this.camCtrl.addShake(0.09);
          }
        } else {
          F.done = true;
          F.endAt = t + 0.35; // a beat of stillness, then he drops
        }
      }
    }

    if (F.done && t >= F.endAt) this._endFinisher();
  }

  _endFinisher() {
    const F = this.finisher;
    const P = this.player;
    const E = F.enemy;
    this.finisher = null;
    E.inFinisher = false;
    E.group.rotation.x = 0;

    if (!E.dying) {
      // He goes limp and slides off the blade
      const fwd = new THREE.Vector3(Math.sin(P.heading), 0, Math.cos(P.heading));
      const imp = fwd.multiplyScalar(2.5);
      imp.y = 1.2;
      E.kill(imp);
      this.waves.onKill();
    }

    // Knife away, uzi back up, controls return
    P.knife.visible = false;
    P.uziGroup.visible = true;
    P.armR.rotation.x = 0;
    P.armL.rotation.x = P._armLBase.x;
    P.armL.rotation.z = P._armLBase.z;
    P.riderUpper.rotation.x = 0;

    // Camera returns to the pre-kill framing
    this.camCtrl.viewIndex = F.camSave.view;
    this.camCtrl._zoomTarget = F.camSave.zoom;
    this.camCtrl.yaw = F.camSave.yaw;
    this.camCtrl.pitch = F.camSave.pitch;
    this.player.setFirstPerson(this.camCtrl.view.fp, this.camera);
  }

  _resetRun() {
    if (this.finisher) {
      this.finisher = null;
      this.player.knife.visible = false;
      this.player.uziGroup.visible = true;
    }
    for (const s of this.shells) {
      this.scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
    }
    this.shells = [];
    this.waves.reset();
    this.player.reset();
    this.weapon.reset();
    this.camCtrl.yaw = Math.PI;
    this.camCtrl.pitch = 0.22;
    this.state = 'menu';
    this.waves.start();
  }

  _die() {
    this.state = 'dead';
    this.ui.setDeathStats(this.waves.wave, this.waves.kills);
    this.ui.showScreen('death');
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.pointerLocked = false;
    this._syncAudio();
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    // Weather, wind, debris and wagon smoke run even on menus so the world
    // feels alive behind them
    windClock.value += dt;
    this.weather.update(dt, this.camera.position);
    this.debris.update(dt);
    this.particles.update(dt);

    this._wagonSmokeT = (this._wagonSmokeT || 0) - dt;
    if (this._wagonSmokeT <= 0 && this.smokeSources) {
      this._wagonSmokeT = 0.4;
      for (const s of this.smokeSources) {
        this.particles.spawnBurst(
          new THREE.Vector3(s.x + (Math.random() - 0.5) * 0.7, s.y, s.z + (Math.random() - 0.5) * 0.7),
          { color: 0x484540, count: 3, speed: 0.5, size: 0.65, life: 2.4, gravity: -0.9, upBias: 1.3 }
        );
      }
    }

    if (this.state !== 'playing') {
      // Cinematic menu camera: a slow aerial orbit well above the field
      // (paused keeps the last gameplay framing instead)
      if (this.state === 'menu' || this.state === 'dead') {
        this._menuAngle = (this._menuAngle || 0) + dt * 0.045;
        const mx = Math.cos(this._menuAngle) * 30;
        const mz = Math.sin(this._menuAngle) * 30;
        this.camera.position.set(mx, Math.max(terrainHeight(mx, mz) + 9, 11), mz);
        this.camera.lookAt(0, terrainHeight(0, 0) + 3, 0);
      }
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // --- cinematic finisher: the cutscene owns the player and his victim,
    // but the battle keeps raging around them ---
    if (this.finisher) {
      this._updateFinisher(dt);
      const cine = [];
      this.waves.update(dt, this.player.position, cine);
      for (const ev of cine) {
        if (ev.type === 'mortarFire' || ev.type === 'cannonFire') this._launchShell(ev);
        // musket balls and melee miss the tangle of bodies — cinematic luck
      }
      this._updateShells(dt);
      this.player.eyeAnchor.getWorldPosition(this._eyePos);
      // Front-on shot with a gentle handheld sway, movie-style
      if (this.finisher) {
        this.camCtrl.yaw = this.player.heading + Math.sin(this.finisher.t * 0.5) * 0.35;
      }
      this.camCtrl.update(dt, this.player.position, { x: 0, y: 0 }, this._eyePos);
      this.input.consumeMouseDelta();
      this.input.consumeWheel();
      this.ui.update(dt, {
        wave: this.waves.wave,
        aliveCount: this.waves.aliveCount,
        kills: this.waves.kills,
        hp: this.player.hp,
        maxHp: this.player.maxHp,
        heat: this.weapon.heat,
        overheated: this.weapon.overheated,
        ammo: this.weapon.ammo,
        magSize: this.weapon.magSize,
        reloading: this.weapon.reloading,
        intermissionTime: this.waves.state === 'intermission' ? this.waves.timer : null,
      });
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // --- E: dismount / remount ---
    const eDown = this.input.isDown('KeyE');
    if (eDown && !this._eWasDown) {
      const result = this.player.toggleMount();
      if (result === 'dismounted') this.ui.showBanner('ON FOOT — E NEAR HORSE TO MOUNT', 1.6);
      else if (result === 'mounted') this.ui.showBanner('MOUNTED', 0.8);
      else if (result === 'too far') this.ui.showBanner('YOUR HORSE IS ELSEWHERE', 1.2);
    }
    this._eWasDown = eDown;

    // --- F: saber strike — swing the sword at anything in front of you ---
    this.meleeCd = Math.max(0, (this.meleeCd || 0) - dt);
    const fDown = this.input.isDown('KeyF');
    if (fDown && !this._fWasDown && this.meleeCd <= 0) {
      this.meleeCd = 0.7;
      this.player.swingSword();
      const fwd = this.camCtrl.getGroundForward();
      let hitAny = false;
      for (const e of this.waves.enemies) {
        if (e.dead || e.dying) continue;
        const dx = e.group.position.x - this.player.position.x;
        const dz = e.group.position.z - this.player.position.z;
        const d = Math.hypot(dx, dz);
        if (d > 3.8) continue;
        if ((dx * fwd.x + dz * fwd.z) / Math.max(d, 0.001) < 0.25) continue; // must be in front
        const impulse = new THREE.Vector3(dx, 0, dz).setLength(9);
        impulse.y = 5;
        const killed = e.takeDamage(80, impulse); // one clean cut fells an infantryman
        hitAny = true;
        const at = e.group.position.clone();
        at.y += 1.4;
        this.particles.blood(at, killed);
        if (killed) this.waves.onKill();
      }
      this.audio.playSfx(hitAny ? 'squish' : 'whistle', {
        volume: hitAny ? 0.8 : 0.3, rate: hitAny ? 1.1 : 1.7, rateJitter: 0.1,
      });
      this.camCtrl.addShake(hitAny ? 0.12 : 0.05);
    }
    this._fWasDown = fDown;

    // --- U: cinematic knife finisher (on foot, within grabbing range) ---
    const uDown = this.input.isDown('KeyU');
    if (uDown && !this._uWasDown) {
      if (this.player.mounted) {
        this.ui.showBanner('DISMOUNT (E) TO FINISH A MAN BY HAND', 1.4);
      } else {
        let best = null;
        let bestD = 3.0;
        for (const e of this.waves.enemies) {
          if (e.dead || e.dying || e.type === 'cavalry') continue;
          const d = Math.hypot(
            e.group.position.x - this.player.position.x,
            e.group.position.z - this.player.position.z
          );
          if (d < bestD) { best = e; bestD = d; }
        }
        if (best) this._startFinisher(best);
      }
    }
    this._uWasDown = uDown;

    // --- camera height follows the ride (saddle / boots) ---
    this.camCtrl.bodyLift = this.player.mounted ? 0 : -1.0;

    // --- camera view cycling (V) ---
    const vDown = this.input.isDown('KeyV');
    if (vDown && !this._vWasDown) {
      const view = this.camCtrl.cycleView();
      this.player.setFirstPerson(view.fp, this.camera);
      this.ui.showBanner(view.name, 0.9);
    }
    this._vWasDown = vDown;

    // Hold right-click to aim: gun centers on screen, view tightens in
    this.player.aiming = this.input.aimHeld;

    // --- player & camera ---
    // Scroll wheel zooms; zooming all the way in enters first person,
    // scrolling back out exits it
    const wheelView = this.camCtrl.handleWheel(this.input.consumeWheel());
    if (wheelView) {
      this.player.setFirstPerson(wheelView.fp, this.camera);
      this.ui.showBanner(wheelView.name, 0.9);
    }
    this.player.update(dt, this.input, this.camCtrl);
    this.player.eyeAnchor.getWorldPosition(this._eyePos);
    this.camCtrl.update(dt, this.player.position, this.input.consumeMouseDelta(), this._eyePos);
    updateSun(this.sun, this.player.position);

    // FOV: widens at a sprint, tightens while aiming down the sight
    const targetFov = 70 + (this.player.sprinting ? 7 : 0) - (this.player.aiming ? 13 : 0);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 8 * dt);
      this.camera.updateProjectionMatrix();
    }

    // --- gallop + landing audio ---
    if (!this.player.airborne) this.audio.updateGallop(dt, this.player.speedRatio);
    if (this.player.justLanded) {
      this.player.justLanded = false;
      this.audio.playSfx('clop', { volume: 0.85, rate: 0.55, rateJitter: 0.05 });
      this.camCtrl.addShake(0.08);
    }

    // --- enemies & waves ---
    const events = [];
    this.waves.update(dt, this.player.position, events);

    // Trample: fast horse + contact = instant kill
    const playerSpeed = this.player.velocity.length();
    if (this.player.mounted && playerSpeed > TRAMPLE_SPEED) {
      for (const e of this.waves.enemies) {
        if (e.dead || e.dying) continue;
        const dx = e.group.position.x - this.player.position.x;
        const dz = e.group.position.z - this.player.position.z;
        const dy = Math.abs(e.group.position.y - this.player.position.y);
        if (Math.hypot(dx, dz) < TRAMPLE_RANGE && dy < 2.5) {
          const impulse = this.player.velocity.clone().setLength(13);
          impulse.y = 9; // launch them skyward
          e.kill(impulse);
          this.waves.onKill();
          this.player.swingSword(); // saber flashes through the arc (horse)
          this.audio.playSfx('squish', { volume: 0.9, rateJitter: 0.1 });
          this.camCtrl.addShake(0.2);
          const splat = e.group.position.clone();
          splat.y += 1.2;
          this.particles.blood(splat, true);
          this.particles.dirt(e.group.position.clone());
        }
      }
    }

    // Smashing through a fence: only the struck section's rails break loose
    // as tumbling debris (plus fresh splinters); neighbouring spans stand
    if (this.player.brokeFence) {
      const { pos, pieces, dir } = this.player.brokeFence;

      const flungParts = [...(pieces || [])];
      // Fresh splinter chunks so the section visibly shatters into ~a dozen bits
      for (let i = 0; i < 8; i++) {
        const splinter = new THREE.Mesh(
          new THREE.BoxGeometry(0.06 + Math.random() * 0.08, 0.06 + Math.random() * 0.06, 0.3 + Math.random() * 0.5),
          new THREE.MeshStandardMaterial({ color: 0x75603f, roughness: 1 })
        );
        splinter.castShadow = true;
        splinter.position.copy(pos);
        splinter.position.y += 0.7 + Math.random() * 0.5;
        this.scene.add(splinter);
        flungParts.push(splinter);
      }

      for (const part of flungParts) {
        if (part.parent !== this.scene) this.scene.attach(part);
        const near = Math.max(0.35, 1 - part.position.distanceTo(pos) / 5);
        this.debris.add(
          part,
          dir.clone().multiplyScalar((4 + Math.random() * 6) * near)
            .add(new THREE.Vector3((Math.random() - 0.5) * 3, 2 + Math.random() * 3.5 * near, (Math.random() - 0.5) * 3)),
          new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 12)
        );
      }

      const at = pos.clone();
      at.y += 1.1;
      this.particles.spawnBurst(at, {
        color: 0x75603f, count: 18, speed: 6, size: 0.22, life: 0.8, gravity: 16, upBias: 3,
      });
      this.particles.dirt(pos.clone());
      this.audio.playSfx('hit', { volume: 0.9, rate: 0.55, rateJitter: 0.1 });
      this.camCtrl.addShake(0.15);
      this.player.brokeFence = null;
    }

    // Galloping hooves kick dirt up behind the horse
    this._hoofDirtT = (this._hoofDirtT || 0) - dt;
    if (!this.player.airborne && this.player.speedRatio > 0.45 && this._hoofDirtT <= 0) {
      this._hoofDirtT = 0.11 - this.player.speedRatio * 0.04;
      const back = new THREE.Vector3(
        -Math.sin(this.player.heading), 0, -Math.cos(this.player.heading)
      );
      const at = this.player.position.clone()
        .addScaledVector(back, 1.1 + Math.random() * 0.5);
      at.x += (Math.random() - 0.5) * 0.7;
      at.z += (Math.random() - 0.5) * 0.7;
      at.y += 0.15;
      this.particles.spawnBurst(at, {
        color: 0x5b4630, count: 5, speed: 2.5 + this.player.speedRatio * 3,
        size: 0.22, life: 0.55, gravity: 13, upBias: 3.5,
      });
    }

    // Riding through a blood pool splashes gore up onto the horse
    this._bloodSplashCd = (this._bloodSplashCd || 0) - dt;
    if (playerSpeed > 4 && this._bloodSplashCd <= 0) {
      for (const e of this.waves.enemies) {
        const pool = e.ragdoll && e.ragdoll.pool;
        if (!pool) continue;
        const d = Math.hypot(
          pool.position.x - this.player.position.x,
          pool.position.z - this.player.position.z
        );
        if (d < pool.scale.x + 0.6) {
          this._bloodSplashCd = 0.2;
          const at = this.player.position.clone();
          at.y += 0.35;
          this.particles.blood(at, false);
          this.player.addBlood();
          break;
        }
      }
    }

    // Damage events from enemies (musket volleys, cavalry melee, mortars)
    for (const ev of events) {
      if (ev.type === 'mortarFire' || ev.type === 'cannonFire') {
        this._launchShell(ev);
        continue;
      }
      this.player.takeDamage(ev.damage);
      this.ui.flashDamage();
      this.audio.playSfx('hurt', { volume: 0.6, rateJitter: 0.1 });
      this.camCtrl.addShake(0.18);
    }

    this._updateShells(dt);

    // --- weapon ---
    const rDown = this.input.isDown('KeyR');
    const reloadRequested = rDown && !this._rWasDown;
    this._rWasDown = rDown;

    // Aim is locked to the middle of the screen in every mode; the mouse
    // steers the camera and the center dot is where bullets go.
    const aimNdc = { x: 0, y: 0 };

    this.weapon.update(
      dt,
      this.input.fireHeld,
      this.player,
      this.waves.enemies,
      (enemy, dmg, zone, point, impulse) => {
        const killed = enemy.takeDamage(dmg, impulse);
        this.particles.blood(point, killed || zone === 'head');
        if (killed) this.waves.onKill();
      },
      this.camCtrl,
      reloadRequested,
      aimNdc
    );

    // --- death check ---
    if (this.player.hp <= 0) {
      this._die();
      return;
    }

    // --- HUD ---
    this.ui.update(dt, {
      wave: this.waves.wave,
      aliveCount: this.waves.aliveCount,
      kills: this.waves.kills,
      hp: this.player.hp,
      maxHp: this.player.maxHp,
      heat: this.weapon.heat,
      overheated: this.weapon.overheated,
      ammo: this.weapon.ammo,
      magSize: this.weapon.magSize,
      reloading: this.weapon.reloading,
      intermissionTime: this.waves.state === 'intermission' ? this.waves.timer : null,
    });

    this.renderer.render(this.scene, this.camera);
  }
}

// Exposed for debugging in the console (window.game.player, .waves, .weapon…)
window.game = new Game();
