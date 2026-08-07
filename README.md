# 1776

**▶ [PLAY NOW — click here](https://beeem33.github.io/1776-Game/)** (free, in your browser, nothing to install)

A stylized 3D wave shooter: an American rider on horseback with an Uzi versus
waves of Redcoat infantry, cavalry, and artillery on a single foggy colonial
battlefield. Built with vanilla Three.js. Desktop browser + mouse required.

## Controls

| Key | Action |
| --- | --- |
| **W A S D** | ride / walk |
| **Mouse** | look & aim |
| **Left click (hold)** | fire the Uzi — 600 RPM, 32-round mags |
| **R** | reload |
| **Shift** | sprint |
| **Space** | jump (mounted) |
| **E** | dismount / remount your horse |
| **V** | camera: hip / far / first person |
| **Scroll wheel** | zoom — all the way in enters first person |
| **F** | fullscreen |
| **Ride into redcoats** | trample for an instant kill |
| **Esc** | pause / release mouse |

## Running it locally

**No install needed** (Three.js loads via CDN import map in `index.html`):

```powershell
powershell -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 7761
# then open http://localhost:7761/
```

**With Node.js** (optional, uses Vite for hot reload):

```
npm install
npm run dev
```

## File map — where everything lives

```
1776/
├── index.html              HTML shell: HUD, overlays, import map
├── package.json            Optional Vite/Node setup
├── tools/
│   └── serve.ps1           Zero-dependency static server (PowerShell)
└── src/
    ├── main.js             Game class: bootstrap, state machine (menu/playing/
    │                       paused/dead), main loop, trample melee, damage events
    ├── style.css           All HUD + overlay styling (crosshair, heat bar, banners)
    ├── assets/
    │   └── ground_grass.png  AI-generated (Higgsfield) rain-soaked ground
    │                         texture; seam-blended at load in terrain.js
    ├── core/
    │   ├── input.js        Keyboard state + pointer-lock mouse deltas
    │   ├── camera.js       ThirdPersonCamera: smoothed orbit/follow camera
    │   │                   (position AND look-target filtered), terrain clamp
    │   └── assets.js       Shared geometry/material caches (box/cyl/sphere)
    ├── entities/
    │   ├── player.js       Player: detailed horse + continental rider + poly
    │   │                   Uzi model, WASD movement, spacebar jump, slope
    │   │                   pitch, gallop bob (on meshRoot so camera is smooth),
    │   │                   reload pose animation, HP/regen
    │   ├── enemy.js        Enemy: detailed Redcoat infantry (musket every 5s)
    │   │                   & cavalry (160 HP, melee), head = one-shot zone,
    │   │                   positional music speaker, ragdolls on death
    │   └── ragdoll.js      Death physics: model breaks into tumbling pieces
    │                       with gravity/bounce, fades out, self-disposes
    ├── systems/
    │   ├── audio.js        AudioManager: all SFX synthesized procedurally,
    │   │                   3D PositionalAudio for enemies, gallop/beep helpers
    │   ├── weapon.js       Uzi: 600 RPM hitscan, heat/overheat, tracers, flash
    │   ├── waves.js        WaveManager: progressive spawner, edge-ring spawns,
    │   │                   intermissions, kill tracking
    │   ├── particles.js    Burst particles: blood, musket smoke, dirt, sparks
    │   └── ui.js           DOM HUD updates + overlay switching
    └── world/
        ├── terrain.js      terrainHeight(x,z) rolling hills, displaced ground,
        │                   dense wind-swaying instanced grass (vertex shader),
        │                   wildflowers, shared windClock
        ├── weather.js      Storm: camera-following rain streaks, drifting
        │                   cloud deck, reflective puddles, thunder timer
        └── world.js        The single map: storm lighting/fog, terrain-following
                            props (trees, rocks, fences, cannons), distant hills
```

## Audio mute

Audio is currently **muted** via `this.audio.setMuted(true)` in `src/main.js`
(just after the AudioManager is created). Change it to `false` to re-enable
all sound (gunfire, dirt hoofbeats, battle-music speakers, rain, thunder).

## Custom enemy music

Every enemy blasts a looping track from a 3D positional speaker. By default it
is a procedurally generated bitcrushed chiptune placeholder. To replace it,
create a `public/` folder and drop in `public/enemy_music.mp3` — it loads
automatically (path `/enemy_music.mp3` when served from `public/` under Vite;
if using the PowerShell server put it at the project root as `enemy_music.mp3`).

## Key tuning constants

| What | Where |
| --- | --- |
| Fire rate / mag size / reload time / heat | `src/systems/weapon.js` top constants |
| Player speed / accel / jump | `src/entities/player.js` top constants |
| Enemy HP / speed / damage | `src/entities/enemy.js` constructor + `_fireMusket` |
| Wave sizes / cavalry mix / squads | `src/systems/waves.js` `_beginWave()` |
| Trample kill threshold | `src/main.js` `TRAMPLE_SPEED` |
| Hill shape / grass density | `src/world/terrain.js` |
| Ragdoll gravity / fade time | `src/entities/ragdoll.js` top constants |
| Camera smoothing / shoulder offset / V-key views | `src/core/camera.js` (`VIEWS`) |
| Fog / lighting / map radius | `src/world/world.js` |
