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
