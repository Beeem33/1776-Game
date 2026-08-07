import * as THREE from 'three';

// AudioManager — all SFX are procedurally synthesized into AudioBuffers at
// startup so the game needs zero audio assets. Enemy music is 3D positional
// (THREE.PositionalAudio) so it pans/attenuates with enemy position.
//
// To use a real track for the enemy loop, drop a file at /public/enemy_music.mp3
// — it is loaded automatically and replaces the synth placeholder.
export class AudioManager {
  constructor(camera) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.ctx = this.listener.context;
    this.buffers = {};
    this.ready = false;

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.85;
    this.sfxGain.connect(this.ctx.destination);

    this._gallopTimer = 0;
    this._beepTimer = 0;
    this.muted = false;
  }

  // Master mute: covers both raw SFX (sfxGain) and all THREE positional audio
  // (listener master volume). Everything else keeps running normally.
  setMuted(muted) {
    this.muted = muted;
    this.sfxGain.gain.value = muted ? 0 : 0.85;
    this.listener.setMasterVolume(muted ? 0 : 1);
  }

  // Must be called from a user gesture (the click that engages pointer lock).
  async init() {
    if (this.ready) return;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    }

    const b = this.buffers;
    b.uzi = this._makeUzi();
    b.musket = this._makeMusket();
    b.hit = this._makeHit();
    b.headshot = this._makeHeadshot();
    b.squish = this._makeSquish();
    b.beep = this._makeBeep();
    b.clop = this._makeClop();
    b.hurt = this._makeHurt();
    b.waveHorn = this._makeWaveHorn();
    b.reload = this._makeReload();
    b.rain = this._makeRain();
    b.thunder = this._makeThunder();
    b.boom = this._makeBoom();
    b.whistle = this._makeWhistle();
    b.enemyMusic = this._makeEnemyMusicLoop();

    // Optional: user-supplied track overrides the synth loop
    try {
      const loaded = await new Promise((resolve) => {
        new THREE.AudioLoader().load('/enemy_music.mp3', resolve, undefined, () => resolve(null));
      });
      if (loaded) b.enemyMusic = loaded;
    } catch (e) { /* keep synth loop */ }

    this.ready = true;
  }

  // ---------------- playback ----------------

  playSfx(name, { volume = 1, rate = 1, rateJitter = 0 } = {}) {
    if (!this.ready) return;
    const buf = this.buffers[name];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate + (Math.random() - 0.5) * 2 * rateJitter;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.sfxGain);
    src.start();
  }

  // Global looped ambience (e.g. rain). Deduped by name.
  playLoop(name, volume = 0.3) {
    if (!this.ready) return null;
    this._loops = this._loops || {};
    if (this._loops[name]) return this._loops[name];
    const buf = this.buffers[name];
    if (!buf) return null;
    const sound = new THREE.Audio(this.listener);
    sound.setBuffer(buf);
    sound.setLoop(true);
    sound.setVolume(volume);
    sound.play();
    this._loops[name] = sound;
    return sound;
  }

  // One-shot 3D sound attached to a moving object (e.g. enemy musket fire)
  playPositional(name, object3d, { volume = 1, refDistance = 10 } = {}) {
    if (!this.ready) return;
    const buf = this.buffers[name];
    if (!buf) return;
    const sound = new THREE.PositionalAudio(this.listener);
    sound.setBuffer(buf);
    sound.setRefDistance(refDistance);
    sound.setRolloffFactor(1.6);
    sound.setVolume(volume);
    object3d.add(sound);
    sound.onEnded = () => {
      sound.isPlaying = false;
      object3d.remove(sound);
    };
    sound.play();
  }

  // Looping positional music blasted by every enemy. Returns the sound so
  // the enemy can stop/detach it on death.
  attachEnemyMusic(object3d) {
    if (!this.ready) return null;
    const sound = new THREE.PositionalAudio(this.listener);
    sound.setBuffer(this.buffers.enemyMusic);
    sound.setLoop(true);
    sound.setRefDistance(7);
    sound.setMaxDistance(90);
    sound.setRolloffFactor(1.9);
    sound.setDistanceModel('exponential');
    sound.setVolume(0.55);
    // Desync the horde so it sounds like a mob of tinny speakers
    sound.offset = Math.random() * this.buffers.enemyMusic.duration;
    object3d.add(sound);
    sound.play();
    return sound;
  }

  detachSound(sound, object3d) {
    if (!sound) return;
    try {
      if (sound.isPlaying) sound.stop();
      object3d.remove(sound);
    } catch (e) { /* already gone */ }
  }

  // Horse gallop loop — dynamic tempo & pitch driven by speed ratio [0..1]
  updateGallop(dt, speedRatio) {
    if (!this.ready || speedRatio < 0.08) return;
    this._gallopTimer -= dt;
    if (this._gallopTimer <= 0) {
      // Faster horse -> tighter hoofbeat interval
      this._gallopTimer = THREE.MathUtils.lerp(0.42, 0.16, speedRatio);
      this.playSfx('clop', {
        volume: 0.25 + speedRatio * 0.4,
        rate: 0.9 + speedRatio * 0.35,
        rateJitter: 0.08,
      });
    }
  }

  // Overheat warning — throttled so it doesn't spam every frame
  overheatBeep(dt, urgent) {
    if (!this.ready) return;
    this._beepTimer -= dt;
    if (this._beepTimer <= 0) {
      this._beepTimer = urgent ? 0.18 : 0.4;
      this.playSfx('beep', { volume: urgent ? 0.5 : 0.3, rate: urgent ? 1.4 : 1 });
    }
  }

  // ---------------- synthesis helpers ----------------

  _buffer(duration, fn) {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.max(1, Math.floor(sr * duration)), sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.max(-1, Math.min(1, fn(i / sr, i)));
    }
    return buf;
  }

  // Deeper, punchier gunshot: lowpassed crack over a pitch-dropping thump
  _makeUzi() {
    let lp = 0;
    return this._buffer(0.16, (t) => {
      const raw = (Math.random() * 2 - 1) * Math.exp(-t * 36);
      lp += (raw - lp) * 0.32; // round off the fizz
      const punch = Math.sin(2 * Math.PI * (115 - t * 150) * t) * Math.exp(-t * 26) * 1.15;
      const body = Math.sin(2 * Math.PI * 235 * t) * Math.exp(-t * 42) * 0.5;
      return (lp * 1.15 + punch + body) * 0.95;
    });
  }

  _makeMusket() {
    let lp = 0;
    return this._buffer(0.7, (t) => {
      const raw = (Math.random() * 2 - 1) * Math.exp(-t * 9);
      lp += (raw - lp) * 0.12; // crude lowpass for a deep black-powder boom
      const boom = Math.sin(2 * Math.PI * (65 - t * 30) * t) * Math.exp(-t * 6) * 0.9;
      return lp * 1.4 + boom;
    });
  }

  _makeHit() {
    return this._buffer(0.08, (t) => {
      const tick = Math.sin(2 * Math.PI * (700 - t * 3000) * t) * Math.exp(-t * 60);
      const n = (Math.random() * 2 - 1) * Math.exp(-t * 90) * 0.4;
      return (tick + n) * 0.8;
    });
  }

  _makeHeadshot() {
    return this._buffer(0.22, (t) => {
      const ding = Math.sin(2 * Math.PI * 1320 * t) * Math.exp(-t * 14) * 0.6;
      const ding2 = Math.sin(2 * Math.PI * 1980 * t) * Math.exp(-t * 18) * 0.35;
      const thud = Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 40) * 0.5;
      return ding + ding2 + thud;
    });
  }

  _makeSquish() {
    let lp = 0;
    return this._buffer(0.35, (t) => {
      const raw = (Math.random() * 2 - 1) * Math.exp(-t * 11);
      lp += (raw - lp) * (0.25 + 0.2 * Math.sin(t * 60)); // gurgly wobble
      const plop = Math.sin(2 * Math.PI * (160 - t * 260) * t) * Math.exp(-t * 12) * 0.8;
      return lp * 1.5 + plop;
    });
  }

  _makeBeep() {
    return this._buffer(0.13, (t) => {
      const env = t < 0.015 ? t / 0.015 : Math.exp(-(t - 0.015) * 22);
      return Math.sign(Math.sin(2 * Math.PI * 1250 * t)) * env * 0.35;
    });
  }

  // Hooves on soft dirt: muffled low thumps, no stony click
  _makeClop() {
    let lp = 0;
    return this._buffer(0.16, (t) => {
      const hit = (tt, amp) => {
        if (tt < 0) return 0;
        const noise = (Math.random() * 2 - 1) * Math.exp(-tt * 45);
        const thump = Math.sin(2 * Math.PI * (68 - tt * 80) * tt) * Math.exp(-tt * 32);
        return (noise * 0.45 + thump) * amp;
      };
      const raw = hit(t, 1) + hit(t - 0.065, 0.75);
      lp += (raw - lp) * 0.16; // heavy lowpass = earth, not cobblestone
      return lp * 1.9;
    });
  }

  _makeHurt() {
    return this._buffer(0.25, (t) => {
      const grunt = Math.sin(2 * Math.PI * (170 - t * 180) * t) * Math.exp(-t * 12);
      const n = (Math.random() * 2 - 1) * Math.exp(-t * 25) * 0.3;
      return (grunt + n) * 0.8;
    });
  }

  // Timed to the 1.9s reload animation: mag release + slide-out noise near
  // the start, mag-in clunk at ~1.15s, bolt rack at ~1.55s.
  _makeReload() {
    const click = (t, t0, f, decay) =>
      t > t0 ? Math.sin(2 * Math.PI * f * (t - t0)) * Math.exp(-(t - t0) * decay) : 0;
    return this._buffer(1.9, (t) => {
      let s = click(t, 0.08, 520, 90) * 0.6 + click(t, 0.11, 300, 70) * 0.5;   // mag release
      if (t > 0.15 && t < 0.42) {
        s += (Math.random() * 2 - 1) * 0.14 * Math.exp(-(t - 0.15) * 7);        // slide out
      }
      s += click(t, 1.15, 210, 45) * 0.9 + click(t, 1.19, 430, 80) * 0.4;      // mag in
      s += click(t, 1.55, 620, 110) * 0.5 + click(t, 1.64, 470, 90) * 0.6;     // bolt rack
      return s;
    });
  }

  _makeWaveHorn() {
    return this._buffer(1.4, (t) => {
      const env = Math.min(t / 0.08, 1) * Math.exp(-Math.max(0, t - 0.7) * 4);
      const f = 220;
      const tone =
        Math.sin(2 * Math.PI * f * t) * 0.5 +
        Math.sin(2 * Math.PI * f * 1.5 * t) * 0.3 +
        Math.sin(2 * Math.PI * f * 2 * t) * 0.2;
      return tone * env * 0.6;
    });
  }

  // Battle music: war drums, military snare taps & rolls, a droning bass and
  // a fife-like lead in D minor. Blasted positionally by every redcoat.
  // Placeholder for /public/enemy_music.mp3.
  _makeEnemyMusicLoop() {
    const bpm = 116;
    const stepDur = 60 / bpm / 4; // 16th notes
    const steps = 64;             // 4 bars
    const duration = stepDur * steps;

    const F = {
      D3: 146.8, F3: 174.6, G3: 196.0, A3: 220.0, Bb3: 233.1, C4: 261.6,
      D4: 293.7, E4: 329.6, F4: 349.2, G4: 392.0, A4: 440.0, Bb4: 466.2,
      C5: 523.3, D5: 587.3,
    };
    // Fife lead on 8th notes (0 = rest)
    const lead = [
      F.D4, 0, F.F4, 0, F.A4, 0, F.D5, 0, F.C5, 0, F.A4, 0, F.F4, 0, F.E4, 0,
      F.D4, 0, F.D4, 0, F.F4, 0, F.G4, 0, F.A4, 0, 0, 0, F.A4, 0, 0, 0,
      F.Bb4, 0, F.A4, 0, F.G4, 0, F.F4, 0, F.E4, 0, F.F4, 0, F.G4, 0, F.E4, 0,
      F.D4, 0, F.F4, 0, F.E4, 0, F.C4, 0, F.D4, 0, 0, 0, 0, 0, 0, 0,
    ];
    const barRoots = [F.D3, F.F3, F.G3, F.A3]; // one drone root per bar

    const crush = 3; // light grit so it still reads as a battered field speaker
    let held = 0;

    return this._buffer(duration, (t, i) => {
      const step = Math.floor(t / stepDur) % steps;
      const tIn = t - Math.floor(t / stepDur) * stepDur;
      const bar = Math.floor(step / 16);

      let s = 0;

      // Fife lead: square wave with a soft envelope
      const note = lead[step];
      if (note) {
        s += Math.sign(Math.sin(2 * Math.PI * note * t)) * 0.16 * Math.exp(-tIn * 6);
      }

      // Bass drone: root hit on every quarter note
      if (step % 4 === 0) {
        const root = barRoots[bar];
        s += (Math.sin(2 * Math.PI * root * t) + 0.4 * Math.sin(2 * Math.PI * root * 2 * t))
          * 0.3 * Math.exp(-tIn * 3.2);
      }

      // War drum (deep tom) on beats 1 and 3 of each bar
      if (step % 16 === 0 || step % 16 === 8) {
        if (tIn < 0.13) {
          s += Math.sin(2 * Math.PI * (72 - tIn * 180) * tIn) * 0.85 * (1 - tIn / 0.13);
        }
      }

      // Military snare: backbeat taps + a four-16th roll into each bar
      const snareHit = step % 8 === 4 || step >= 60 || (step % 16 >= 13 && bar % 2 === 1);
      if (snareHit && tIn < 0.05) {
        const n = (Math.random() * 2 - 1) * 0.4 + Math.sin(2 * Math.PI * 190 * tIn) * 0.2;
        s += n * (1 - tIn / 0.05) * 0.6;
      }

      if (i % crush === 0) held = Math.round(s * 24) / 24;
      return held * 0.9;
    });
  }

  // Steady filtered-noise rain bed (looped globally, not positional)
  _makeRain() {
    let lp = 0;
    return this._buffer(4, (t) => {
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * 0.24;
      return lp * 0.5 * (0.9 + 0.1 * Math.sin(t * 2.7));
    });
  }

  // Mortar shell detonation: hard sub-bass slam with a rumbling tail
  _makeBoom() {
    let lp = 0;
    return this._buffer(1.5, (t) => {
      const raw = (Math.random() * 2 - 1) * Math.exp(-t * 4.5);
      lp += (raw - lp) * 0.085;
      const sub = Math.sin(2 * Math.PI * (48 - t * 16) * t) * Math.exp(-t * 2.4);
      const crack = (Math.random() * 2 - 1) * Math.exp(-t * 60) * 0.5;
      return (lp * 1.7 + sub * 1.1 + crack) * Math.min(t / 0.008, 1);
    });
  }

  // Incoming-shell whistle: a falling pitch with a nervous vibrato
  _makeWhistle() {
    return this._buffer(1.2, (t) => {
      const f = 1350 - t * 780;
      const env = Math.min(t / 0.18, 1) * Math.max(0, 1 - t / 1.2);
      return Math.sin(2 * Math.PI * (f * t - 390 * t * t / 1.2) + Math.sin(t * 26) * 1.6) * env * 0.22;
    });
  }

  // Distant thunder rumble
  _makeThunder() {
    let acc = 0, lp = 0;
    return this._buffer(3.2, (t) => {
      acc += (Math.random() * 2 - 1) * 0.5;
      acc *= 0.994;
      lp += (acc - lp) * 0.018;
      const env = Math.min(t / 0.25, 1) * Math.exp(-t * 1.3);
      const flicker = 0.75 + 0.25 * Math.sin(t * 17 + Math.sin(t * 5) * 3);
      return lp * env * flicker * 0.35;
    });
  }
}
