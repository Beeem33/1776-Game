import * as THREE from 'three';
import { Enemy } from '../entities/enemy.js';
import { SPAWN_RING_MIN, SPAWN_RING_MAX } from '../world/world.js';

const INTERMISSION = 5;

// Progressive wave spawner. Enemies spawn on a ring at the map edges and
// track toward the player. Cavalry mixes in from wave 2.
export class WaveManager {
  constructor(scene, audio, ui, particles) {
    this.scene = scene;
    this.audio = audio;
    this.ui = ui;
    this.particles = particles;
    this.enemies = [];
    this.wave = 0;
    this.kills = 0;
    this.state = 'idle'; // 'idle' | 'intermission' | 'active'
    this.timer = 0;
    this._spawnQueue = [];
    this._spawnTimer = 0;
  }

  start() {
    this.state = 'intermission';
    this.timer = 2.5;
  }

  _beginWave() {
    this.wave += 1;
    this.state = 'active';

    // Wave 1 = 10 redcoats, +5 every wave after (capped for performance).
    // Artillery joins early and grows fast.
    const total = Math.min(10 + (this.wave - 1) * 5, 50);
    const cavalry = Math.min(Math.floor(this.wave / 2) * 2, Math.floor(total / 4));
    const mortars = this.wave >= 2 ? Math.min(2 + Math.floor(this.wave / 2), 6) : 0;
    const cannons = Math.min(2 + Math.floor(this.wave / 2), 8); // guns from wave 1, heavy battery fast
    const infantry = Math.max(0, total - cavalry - mortars - cannons);

    const types = [];
    for (let i = 0; i < infantry; i++) types.push('infantry');
    for (let i = 0; i < cavalry; i++) types.push('cavalry');
    for (let i = 0; i < mortars; i++) types.push('mortar');
    for (let i = 0; i < cannons; i++) types.push('cannon');
    // Shuffle
    for (let i = types.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [types[i], types[j]] = [types[j], types[i]];
    }

    // Group the wave into squads that march in together from shared points
    // on the map edge.
    this._spawnQueue = [];
    let idx = 0;
    while (idx < types.length) {
      const squadSize = Math.min(3 + ((Math.random() * 4) | 0), types.length - idx);
      const angle = Math.random() * Math.PI * 2;
      const r = SPAWN_RING_MIN + Math.random() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
      const center = new THREE.Vector3(Math.cos(angle) * r, 0, Math.sin(angle) * r);
      for (let i = 0; i < squadSize; i++) {
        this._spawnQueue.push({ type: types[idx++], center });
      }
    }
    this._spawnTimer = 0;

    this.audio.playSfx('waveHorn', { volume: 0.8 });
    this.ui.showBanner(`WAVE ${this.wave}`, 2.2);
  }

  _spawnOne(entry) {
    // Loose formation around the squad's spawn point: wider spread, and
    // re-roll spots that land on top of a squadmate
    let pos;
    for (let attempt = 0; attempt < 8; attempt++) {
      pos = entry.center.clone().add(
        new THREE.Vector3((Math.random() - 0.5) * 24, 0, (Math.random() - 0.5) * 24)
      );
      const crowded = this.enemies.some((e) =>
        !e.dying && !e.dead &&
        Math.hypot(e.group.position.x - pos.x, e.group.position.z - pos.z) < 4.5
      );
      if (!crowded) break;
    }
    this.enemies.push(new Enemy(this.scene, this.audio, entry.type, pos, this.particles));
  }

  get aliveCount() {
    return this.enemies.filter((e) => !e.dead && !e.dying).length;
  }

  update(dt, playerPos, events) {
    if (this.state === 'intermission') {
      this.timer -= dt;
      if (this.timer <= 0) this._beginWave();
    } else if (this.state === 'active') {
      // Stagger spawns so the horde trickles in
      if (this._spawnQueue.length > 0) {
        this._spawnTimer -= dt;
        if (this._spawnTimer <= 0) {
          this._spawnTimer = 0.35;
          this._spawnOne(this._spawnQueue.pop());
        }
      } else if (this.aliveCount === 0) {
        this.state = 'intermission';
        this.timer = INTERMISSION;
        this.ui.showBanner('WAVE CLEARED', 2.5);
      }
    }

    // Update all enemies; cull only the explicitly removed
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, playerPos, events);
      if (e.dead) {
        e.dispose();
        this.enemies.splice(i, 1);
      }
    }

    // Corpses persist on the battlefield for the whole run — only a
    // performance backstop removes the oldest once the field is truly littered
    const CORPSE_CAP = 70;
    const corpses = this.enemies.filter((e) => e.dying && !e.dead);
    for (let i = 0; i < corpses.length - CORPSE_CAP; i++) {
      corpses[i].dead = true;
    }

    // Soft separation so squadmates don't stack inside each other
    // (a man locked in the finisher is pinned — nothing shoves him)
    const alive = this.enemies.filter((e) => !e.dying && !e.dead && !e.inFinisher);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i].group.position;
        const b = alive[j].group.position;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.001 && d < 1.9) {
          const push = ((1.9 - d) / d) * 0.5;
          a.x -= dx * push; a.z -= dz * push;
          b.x += dx * push; b.z += dz * push;
        }
      }
    }
  }

  onKill() {
    this.kills += 1;
  }

  reset() {
    for (const e of this.enemies) e.dispose();
    this.enemies = [];
    this.wave = 0;
    this.kills = 0;
    this.state = 'idle';
    this._spawnQueue = [];
  }
}
