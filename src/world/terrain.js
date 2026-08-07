import * as THREE from 'three';

// Cannonball craters blasted into the field: [x, z, radius, depth].
// Baked into terrainHeight itself, so the ground mesh, grass, corpses,
// enemies and the player all follow the bowls and raised rims.
export const CRATERS = [
  [14, -32, 5.2, 1.6], [-42, 10, 6.5, 2.0], [55, 42, 4.5, 1.3],
  [-22, -55, 5.8, 1.8], [32, 16, 4.0, 1.2], [-60, -22, 6.0, 1.7],
  [6, 58, 5.0, 1.5], [-10, -14, 4.2, 1.3], [46, -52, 5.5, 1.7],
  [-52, 46, 4.8, 1.4], [70, 5, 5.4, 1.6], [-5, 34, 4.4, 1.2],
  // Heavy bombardment: big craters toward the outskirts
  [88, -30, 10, 2.8], [-85, 55, 11, 3.2], [20, 95, 9.5, 2.6],
  [-95, -60, 12, 3.4], [62, 82, 9, 2.4],
];

// Fresh craters blasted during gameplay by mortar shells — same shape math,
// appended at runtime (capped so terrainHeight stays cheap).
export const dynamicCraters = [];
const MAX_DYNAMIC_CRATERS = 18;
let _groundGeo = null;
let _grassMesh = null;

function craterDip(h, x, z, list) {
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const dx = x - c[0];
    const dz = z - c[1];
    const r = c[2];
    const q = dx * dx + dz * dz;
    if (q < r * r * 4) {
      const dist = Math.sqrt(q);
      h -= c[3] * Math.exp(-q / (r * r * 0.55));            // the bowl
      const rim = (dist - r) / (r * 0.35);
      h += c[3] * 0.35 * Math.exp(-rim * rim);              // thrown-up rim
    }
  }
  return h;
}

// Deterministic rolling-hills height function. EVERYTHING that touches the
// ground (player, enemies, props, camera, ragdoll pieces) samples this.
export function terrainHeight(x, z) {
  let h =
    Math.sin(x * 0.018) * Math.cos(z * 0.021) * 3.2 +
    Math.sin(x * 0.043 + 1.7) * Math.cos(z * 0.037 + 0.6) * 1.4 +
    Math.sin((x + z) * 0.01 + 0.5) * 2.0 +
    Math.sin(x * 0.11) * Math.sin(z * 0.13) * 0.3;
  h = craterDip(h, x, z, CRATERS);
  if (dynamicCraters.length) h = craterDip(h, x, z, dynamicCraters);
  return h;
}

// A mortar shell just landed: dig a real bowl into the terrain mesh (all
// gameplay follows it via terrainHeight), flatten the grass inside, and
// leave a scorch + rim-clod scar. Returns the crater radius.
export function blastCrater(scene, x, z, scale = 1) {
  const r = (2.8 + Math.random() * 1.3) * scale;
  const d = (0.8 + Math.random() * 0.45) * scale;

  if (dynamicCraters.length < MAX_DYNAMIC_CRATERS && _groundGeo) {
    dynamicCraters.push([x, z, r, d]);

    const pos = _groundGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vz = pos.getZ(i);
      const dx = vx - x;
      const dz = vz - z;
      if (dx * dx + dz * dz < r * r * 4.8) {
        pos.setY(i, terrainHeight(vx, vz));
      }
    }
    pos.needsUpdate = true;
    _groundGeo.computeVertexNormals();

    // Collapse grass blades caught in the blast bowl
    if (_grassMesh) {
      const arr = _grassMesh.instanceMatrix.array;
      for (let i = 0; i < _grassMesh.count; i++) {
        const bx = arr[i * 16 + 12];
        const bz = arr[i * 16 + 14];
        const ddx = bx - x;
        const ddz = bz - z;
        if (ddx * ddx + ddz * ddz < r * r) {
          for (let c = 0; c < 12; c++) arr[i * 16 + c] *= 0.02;
        }
      }
      _grassMesh.instanceMatrix.needsUpdate = true;
    }
  }

  craterScarAt(scene, x, z, r, d);
  return r;
}

// Approximate slope magnitude via finite differences
export function slopeAt(x, z) {
  const e = 1.5;
  const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const dz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

// Shared wind clock: main.js advances this every frame; every wind-patched
// material (grass, flowers) reads it in its vertex shader.
export const windClock = { value: 0 };

// Injects a vertex-shader sway driven by windClock: blades bend by world
// position + time, stronger toward the tip (higher local Y).
export function applyWind(material, strength = 1) {
  const s = strength.toFixed(2);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windClock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec4 windWP = instanceMatrix * vec4(position, 1.0);
        #else
          vec4 windWP = vec4(position, 1.0);
        #endif
        float windK = smoothstep(0.0, 0.6, position.y) * ${s};
        float windSway = sin(uWindTime * 2.1 + windWP.x * 0.55 + windWP.z * 0.4)
                       + 0.55 * sin(uWindTime * 4.7 + windWP.x * 1.6 + windWP.z * 0.9);
        transformed.x += windSway * 0.1 * windK;
        transformed.z += windSway * 0.055 * windK;
      `);
  };
}

// Painterly grass texture: layered soft splotches + thousands of thin blade
// strokes, in the darker greens of a rain-soaked field.
function makeGrassTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#3c5426';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 140; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 20 + Math.random() * 70;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const greens = ['#44602c', '#33481f', '#4d6830', '#3a5124', '#57713a'];
    const c = greens[(Math.random() * greens.length) | 0];
    g.addColorStop(0, c + '55');
    g.addColorStop(1, c + '00');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  for (let i = 0; i < 5000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const h = 2 + Math.random() * 6;
    const lean = (Math.random() - 0.5) * 3;
    const g = 75 + Math.random() * 60;
    const r = 38 + Math.random() * 40;
    ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${(24 + Math.random() * 26) | 0}, ${0.35 + Math.random() * 0.4})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + lean, y - h);
    ctx.stroke();
  }

  // Wet dirt patches
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = `rgba(${(80 + Math.random() * 30) | 0}, ${(64 + Math.random() * 20) | 0}, 42, ${0.08 + Math.random() * 0.12})`;
    ctx.beginPath();
    ctx.ellipse(x, y, 5 + Math.random() * 16, 3 + Math.random() * 7, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20, 20);
  tex.anisotropy = 8;
  return tex;
}

export function createTerrain(scene) {
  const SIZE = 480;
  const SEGS = 170;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);

    const s = Math.min(slopeAt(x, z) * 2.2, 1);
    const lift = THREE.MathUtils.clamp(h * 0.02, -0.08, 0.1);
    colors[i * 3] = THREE.MathUtils.lerp(1.0, 1.05, s) + lift;
    colors[i * 3 + 1] = THREE.MathUtils.lerp(1.0, 0.82, s) + lift;
    colors[i * 3 + 2] = THREE.MathUtils.lerp(1.0, 0.6, s) + lift;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const ground = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      map: makeGrassTexture(), // procedural fallback, swapped when the AI texture loads
      vertexColors: true,
      roughness: 0.82, // rain-slicked sheen
    })
  );
  ground.receiveShadow = true;
  scene.add(ground);
  _groundGeo = geo; // mortar blasts re-displace this mesh locally

  loadGeneratedGroundTexture(ground.material);

  addGrassBlades(scene);
  addFlowers(scene);
  addCraterScars(scene);
  return ground;
}

// Scorched earth + debris marking one crater (shared by the pre-baked
// battlefield craters and fresh mortar blasts)
let _scorchMat = null;
let _rockMat = null;
let _rockGeo = null;

function craterScarAt(scene, cx, cz, r, d) {
  if (!_scorchMat) {
    _scorchMat = new THREE.MeshStandardMaterial({ color: 0x1e1811, roughness: 1 });
    _rockMat = new THREE.MeshStandardMaterial({ color: 0x3b332a, roughness: 1 });
    _rockGeo = new THREE.DodecahedronGeometry(1, 0);
  }
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(r * 0.5, 12), _scorchMat);
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.set(cx, terrainHeight(cx, cz) + 0.05, cz);
  scene.add(scorch);

  // Clods thrown onto the rim
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = r * (0.9 + Math.random() * 0.4);
    const x = cx + Math.cos(a) * rr;
    const z = cz + Math.sin(a) * rr;
    const rock = new THREE.Mesh(_rockGeo, _rockMat);
    const s = 0.15 + Math.random() * 0.3 * d;
    rock.scale.set(s, s * 0.7, s);
    rock.rotation.set(Math.random(), Math.random() * Math.PI, Math.random());
    rock.position.set(x, terrainHeight(x, z) + s * 0.3, z);
    rock.castShadow = true;
    scene.add(rock);
  }
}

function addCraterScars(scene) {
  for (const [cx, cz, r, d] of CRATERS) {
    craterScarAt(scene, cx, cz, r, d);
  }
}

// AI-generated ground texture (Higgsfield, assets/ground_grass.png). The
// source is cropped to one quadrant (the generation is a tiled preview) and
// made mathematically wrappable with a 50%-offset rational blend — a JS
// stand-in for the offline seam pipeline. Falls back to the procedural
// canvas texture if the file is missing.
function loadGeneratedGroundTexture(material) {
  const img = new Image();
  img.onload = () => {
    const S = 512; // one quadrant of the 1024 source
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, img.width / 2, img.height / 2, 0, 0, S, S);

    const src = ctx.getImageData(0, 0, S, S);
    const out = ctx.createImageData(S, S);
    const a = src.data;
    const b = out.data;
    const H = S / 2;
    for (let y = 0; y < S; y++) {
      const wy = 1 - Math.abs((2 * y) / S - 1);
      const ry = (y + H) % S;
      for (let x = 0; x < S; x++) {
        const wx = 1 - Math.abs((2 * x) / S - 1);
        // Rational blend: 1 in the center (original), 0 at the borders
        // (50%-rolled copy, which wraps perfectly there)
        const num = wx * wy + 1e-6;
        const w = num / (num + (1 - wx) * (1 - wy) + 1e-6);
        const i = (y * S + x) * 4;
        const j = (ry * S + ((x + H) % S)) * 4;
        b[i] = a[i] * w + a[j] * (1 - w);
        b[i + 1] = a[i + 1] * w + a[j + 1] * (1 - w);
        b[i + 2] = a[i + 2] * w + a[j + 2] * (1 - w);
        b[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(26, 26);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    material.map = tex;
    material.needsUpdate = true;
  };
  img.onerror = () => { /* keep the procedural texture */ };
  // Single-file builds embed the texture as a data URI (GROUND_B64)
  img.src = (typeof GROUND_B64 !== 'undefined') ? GROUND_B64 : './assets/ground_grass.png';
}

// Dense instanced grass covering the whole battlefield, swaying in the wind
// via a vertex-shader patch (zero per-frame CPU cost).
function addGrassBlades(scene) {
  const COUNT = 60000;
  const geo = new THREE.ConeGeometry(0.09, 0.62, 4);
  geo.translate(0, 0.31, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  applyWind(material, 1.0);

  const blades = new THREE.InstancedMesh(geo, material, COUNT);
  blades.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < COUNT; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 2 + Math.sqrt(Math.random()) * 148;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    dummy.position.set(x, terrainHeight(x, z) - 0.03, z);
    dummy.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI, (Math.random() - 0.5) * 0.3);
    const s = 0.8 + Math.random() * 1.6;
    dummy.scale.set(s, s * (0.7 + Math.random() * 0.9), s);
    dummy.updateMatrix();
    blades.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.25 + Math.random() * 0.05, 0.45 + Math.random() * 0.2, 0.2 + Math.random() * 0.12);
    blades.setColorAt(i, color);
  }
  blades.instanceMatrix.needsUpdate = true;
  if (blades.instanceColor) blades.instanceColor.needsUpdate = true;
  scene.add(blades);
  _grassMesh = blades; // mortar blasts flatten blades inside the bowl
}

// Wildflowers scattered across the field: instanced stems + colored blossoms,
// both swaying with the same wind as the grass.
function addFlowers(scene) {
  const COUNT = 1300;
  const positions = [];
  for (let i = 0; i < COUNT; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.sqrt(Math.random()) * 142;
    positions.push([Math.cos(a) * r, Math.sin(a) * r]);
  }

  // Stems
  const stemGeo = new THREE.CylinderGeometry(0.015, 0.02, 0.3, 4);
  stemGeo.translate(0, 0.15, 0);
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x3f5c2a, roughness: 1 });
  applyWind(stemMat, 1.4);
  const stems = new THREE.InstancedMesh(stemGeo, stemMat, COUNT);

  // Blossoms
  const bloomGeo = new THREE.SphereGeometry(0.07, 6, 5);
  bloomGeo.translate(0, 0.32, 0);
  const bloomMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
  applyWind(bloomMat, 1.4);
  const blooms = new THREE.InstancedMesh(bloomGeo, bloomMat, COUNT);

  const palette = [0xe8e6e0, 0xf2d33c, 0xd6604f, 0x9a6fc4, 0xe89ab8, 0xf0f0f0];
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < COUNT; i++) {
    const [x, z] = positions[i];
    dummy.position.set(x, terrainHeight(x, z), z);
    dummy.rotation.set((Math.random() - 0.5) * 0.25, Math.random() * Math.PI, (Math.random() - 0.5) * 0.25);
    const s = 0.8 + Math.random() * 1.0;
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    stems.setMatrixAt(i, dummy.matrix);
    blooms.setMatrixAt(i, dummy.matrix);
    color.set(palette[(Math.random() * palette.length) | 0]);
    blooms.setColorAt(i, color);
  }
  stems.instanceMatrix.needsUpdate = true;
  blooms.instanceMatrix.needsUpdate = true;
  if (blooms.instanceColor) blooms.instanceColor.needsUpdate = true;
  scene.add(stems);
  scene.add(blooms);
}
