// Thin DOM layer for the HUD and overlays.
export class UI {
  constructor() {
    this.hud = document.getElementById('hud');
    this.overlayStart = document.getElementById('overlay-start');
    this.overlayPause = document.getElementById('overlay-pause');
    this.overlayDeath = document.getElementById('overlay-death');
    this.deathStats = document.getElementById('death-stats');

    this.waveLabel = document.getElementById('wave-label');
    this.enemiesLabel = document.getElementById('enemies-label');
    this.killsLabel = document.getElementById('kills-label');
    this.hpFill = document.getElementById('hp-fill');
    this.heatFill = document.getElementById('heat-fill');
    this.heatTitle = document.getElementById('heat-title');
    this.ammoLabel = document.getElementById('ammo-label');
    this.banner = document.getElementById('banner');
    this.vignette = document.getElementById('damage-vignette');
    this.crosshair = document.getElementById('crosshair');

    this._bannerTimer = 0;
    this._vignetteLevel = 0;

    // Screen-blood layer: close-range kills splash gore across the lens
    this.splatLayer = document.createElement('div');
    this.splatLayer.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:30;overflow:hidden;';
    document.body.appendChild(this.splatLayer);
    this._splatUrls = [0, 1, 2].map(() => this._makeSplatUrl());
    this._lastSplatAt = 0;
  }

  // Painted blood splat (blobs + downward runners), baked once to a data URL
  _makeSplatUrl() {
    const S = 256;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    const reds = ['#7c0f09', '#8e130c', '#690c07', '#9c1a10'];
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = reds[(Math.random() * reds.length) | 0];
      ctx.globalAlpha = 0.55 + Math.random() * 0.4;
      ctx.beginPath();
      ctx.ellipse(
        S / 2 + (Math.random() - 0.5) * 90, S / 2 + (Math.random() - 0.5) * 80,
        10 + Math.random() * 38, 8 + Math.random() * 28,
        Math.random() * Math.PI, 0, Math.PI * 2
      );
      ctx.fill();
    }
    for (let i = 0; i < 9; i++) {
      const x = S / 2 + (Math.random() - 0.5) * 110;
      const y0 = S / 2 + Math.random() * 20;
      const len = 25 + Math.random() * 70;
      ctx.fillStyle = reds[(Math.random() * reds.length) | 0];
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.ellipse(x, y0 + len / 2, 2 + Math.random() * 2.5, len / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return canvas.toDataURL();
  }

  // Splash 2-4 fading blood splats onto the screen. Throttled so full-auto
  // kills at point blank don't strobe.
  screenBlood() {
    const now = performance.now();
    if (now - this._lastSplatAt < 220) return;
    this._lastSplatAt = now;
    const n = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const img = document.createElement('img');
      img.src = this._splatUrls[(Math.random() * this._splatUrls.length) | 0];
      const size = 16 + Math.random() * 22;
      img.style.cssText =
        `position:absolute;left:${10 + Math.random() * 70}%;top:${5 + Math.random() * 70}%;` +
        `width:${size}vmin;transform:rotate(${(Math.random() * 360) | 0}deg);` +
        'opacity:0.9;transition:opacity 1.3s ease;';
      this.splatLayer.appendChild(img);
      requestAnimationFrame(() => requestAnimationFrame(() => { img.style.opacity = '0'; }));
      setTimeout(() => img.remove(), 1600);
    }
  }

  showScreen(name) {
    this.overlayStart.classList.toggle('hidden', name !== 'start');
    this.overlayPause.classList.toggle('hidden', name !== 'pause');
    this.overlayDeath.classList.toggle('hidden', name !== 'death');
    this.hud.classList.toggle('hidden', name !== 'game');
  }

  setDeathStats(wave, kills) {
    this.deathStats.textContent = `You fell on wave ${wave} with ${kills} redcoats sent home.`;
  }

  // Pin the crosshair to the actual pointer (fallback mode) or screen center
  // (pointer lock). Pass null/undefined to center it.
  setCrosshair(x, y) {
    if (x == null) {
      this.crosshair.style.left = '50%';
      this.crosshair.style.top = '50%';
    } else {
      this.crosshair.style.left = `${x}px`;
      this.crosshair.style.top = `${y}px`;
    }
  }

  showBanner(text, seconds) {
    this.banner.textContent = text;
    this.banner.classList.remove('hidden');
    this._bannerTimer = seconds;
  }

  flashDamage() {
    this._vignetteLevel = 1;
  }

  update(dt, { wave, aliveCount, kills, hp, maxHp, heat, overheated, ammo, magSize, reloading, intermissionTime }) {
    this.waveLabel.textContent = wave > 0 ? `WAVE ${wave}` : 'PREPARE';
    this.enemiesLabel.textContent =
      intermissionTime != null
        ? `NEXT WAVE IN ${Math.ceil(intermissionTime)}`
        : `REDCOATS: ${aliveCount}`;
    this.killsLabel.textContent = `KILLS: ${kills}`;

    this.hpFill.style.width = `${(hp / maxHp) * 100}%`;
    this.hpFill.style.background =
      hp / maxHp > 0.35
        ? 'linear-gradient(90deg, #7edb6a, #3ea035)'
        : 'linear-gradient(90deg, #ff7a5c, #d43a2f)';

    this.heatFill.style.width = `${heat * 100}%`;
    this.heatTitle.textContent = overheated ? 'OVERHEATED!' : 'UZI HEAT';
    this.heatTitle.classList.toggle('overheated', overheated);

    this.ammoLabel.textContent = reloading ? 'RELOADING…' : `${ammo} / ${magSize}`;
    this.ammoLabel.classList.toggle('reloading', !!reloading);
    this.ammoLabel.classList.toggle('low', !reloading && ammo <= 8);

    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      if (this._bannerTimer <= 0) this.banner.classList.add('hidden');
    }

    if (this._vignetteLevel > 0) {
      this._vignetteLevel = Math.max(0, this._vignetteLevel - dt * 2.2);
    }
    // Persistent red edge when low HP
    const lowHp = hp / maxHp < 0.3 ? 0.45 : 0;
    this.vignette.style.opacity = Math.max(this._vignetteLevel, lowHp);
  }
}
