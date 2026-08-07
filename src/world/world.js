import * as THREE from 'three';
import { createTerrain, terrainHeight, applyWind } from './terrain.js';
import { box, cyl, sphere, mat } from '../core/assets.js';
import { addCircleCollider, addSegmentCollider, addBoxCollider, clearColliders } from './colliders.js';

export const MAP_RADIUS = 114; // playable area
export const SPAWN_RING_MIN = 80;
export const SPAWN_RING_MAX = 104;

function addTree(parent, x, z, scale) {
  const tree = new THREE.Group();

  const trunk = cyl(0.32 + Math.random() * 0.1, 0.5, 3.2, 0x5a4128, {}, 7);
  trunk.position.y = 1.6;
  tree.add(trunk);

  const greens = [0x2e4d22, 0x35592a, 0x28441e];
  const leafColor = greens[(Math.random() * greens.length) | 0];
  for (let i = 0; i < 3; i++) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(2.4 - i * 0.6, 2.6, 8),
      mat(leafColor)
    );
    cone.castShadow = true;
    cone.position.y = 3.4 + i * 1.5;
    tree.add(cone);
  }

  tree.position.set(x, terrainHeight(x, z) - 0.15, z);
  tree.scale.setScalar(scale);
  tree.rotation.y = Math.random() * Math.PI * 2;
  parent.add(tree);
  addCircleCollider(x, z, 0.55 * scale, true); // trunk blocks movement
}

// Low rounded shrub: 2-3 overlapping dark green spheres
function addBush(parent, x, z, scale) {
  const bush = new THREE.Group();
  const greens = [0x2a4420, 0x33512a, 0x243d1d];
  const n = 2 + (Math.random() * 2 | 0);
  for (let i = 0; i < n; i++) {
    const blob = sphere(0.55 + Math.random() * 0.3, greens[(Math.random() * greens.length) | 0], {}, 8);
    blob.scale.y = 0.75;
    blob.position.set((Math.random() - 0.5) * 0.8, 0.35 + Math.random() * 0.15, (Math.random() - 0.5) * 0.8);
    bush.add(blob);
  }
  bush.position.set(x, terrainHeight(x, z), z);
  bush.scale.setScalar(scale);
  parent.add(bush);
}

function addRock(parent, x, z, scale) {
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), mat(0x77746c, { roughness: 1 }));
  rock.position.set(x, terrainHeight(x, z) + 0.25 * scale, z);
  rock.scale.set(scale, scale * 0.65, scale);
  rock.rotation.set(Math.random(), Math.random() * Math.PI, Math.random());
  rock.castShadow = true;
  rock.receiveShadow = true;
  parent.add(rock);
}

// Split-rail fence that follows the terrain: each post gets its own height,
// rails connect post tops.
function addFence(parent, x, z, angle, segments) {
  const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  const fenceGroup = new THREE.Group();
  parent.add(fenceGroup);
  const posts = [];
  for (let i = 0; i < segments + 1; i++) {
    const px = x + dir.x * i * 2.4;
    const pz = z + dir.z * i * 2.4;
    const py = terrainHeight(px, pz);
    const post = box(0.18, 1.35, 0.18, 0x6b5236);
    post.position.set(px, py + 0.62, pz);
    post.rotation.y = angle + (Math.random() - 0.5) * 0.15;
    fenceGroup.add(post);
    posts.push(new THREE.Vector3(px, py, pz));
  }
  for (let i = 0; i < posts.length - 1; i++) {
    const spanRails = [];
    for (const h of [0.55, 1.05]) {
      const a = posts[i].clone(); a.y += h;
      const b = posts[i + 1].clone(); b.y += h;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const rail = box(0.09, 0.13, 1, 0x75603f);
      rail.scale.z = a.distanceTo(b) + 0.2;
      rail.position.copy(mid);
      rail.lookAt(b);
      fenceGroup.add(rail);
      spanRails.push(rail);
    }
    // Each post-to-post span is its own breakable collider: a charging
    // horse knocks out just that section's rails — the posts and the rest
    // of the fence line stay standing. A jump clears any span.
    addSegmentCollider(posts[i].x, posts[i].z, posts[i + 1].x, posts[i + 1].z, 0.28, {
      breakable: true,
      pieces: spanRails,
    });
  }
}

function addCannon(parent, x, z, angle) {
  const cannon = new THREE.Group();
  const iron = { roughness: 0.5, metalness: 0.65 };

  const barrel = cyl(0.2, 0.32, 2.6, 0x2b2f33, iron, 12);
  barrel.rotation.x = Math.PI / 2 - 0.15;
  barrel.position.set(0, 0.95, 0.3);
  cannon.add(barrel);

  const muzzleRing = cyl(0.26, 0.26, 0.1, 0x22262a, iron, 12);
  muzzleRing.rotation.x = Math.PI / 2 - 0.15;
  muzzleRing.position.set(0, 1.13, 1.5);
  cannon.add(muzzleRing);

  for (const side of [-1, 1]) {
    const wheel = cyl(0.65, 0.65, 0.16, 0x5f4630, {}, 12);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 0.72, 0.65, 0);
    cannon.add(wheel);
    const hub = cyl(0.14, 0.14, 0.24, 0x3b2c1c, {}, 8);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(side * 0.74, 0.65, 0);
    cannon.add(hub);
  }

  const carriage = box(0.5, 0.3, 1.9, 0x5f4630);
  carriage.position.set(0, 0.62, -0.5);
  cannon.add(carriage);

  cannon.position.set(x, terrainHeight(x, z), z);
  cannon.rotation.y = angle;
  parent.add(cannon);
}

// A fenced wheat field: dense instanced golden stalks swaying in the same
// wind as the grass, bordered by split-rail fence.
function addWheatField(scene, props, cx, cz, w, d, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const local = (u, v) => [cx + u * cos - v * sin, cz + u * sin + v * cos];

  const COUNT = Math.floor(w * d * 3.2);
  const geo = new THREE.ConeGeometry(0.05, 1.05, 4);
  geo.translate(0, 0.52, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
  applyWind(material, 1.5);
  const wheat = new THREE.InstancedMesh(geo, material, COUNT);
  wheat.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < COUNT; i++) {
    const u = (Math.random() - 0.5) * w;
    const v = (Math.random() - 0.5) * d;
    const [x, z] = local(u, v);
    dummy.position.set(x, terrainHeight(x, z), z);
    dummy.rotation.set((Math.random() - 0.5) * 0.2, Math.random() * Math.PI, (Math.random() - 0.5) * 0.2);
    const s = 0.85 + Math.random() * 0.5;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    wheat.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.11 + Math.random() * 0.025, 0.5 + Math.random() * 0.15, 0.4 + Math.random() * 0.14);
    wheat.setColorAt(i, color);
  }
  wheat.instanceMatrix.needsUpdate = true;
  if (wheat.instanceColor) wheat.instanceColor.needsUpdate = true;
  scene.add(wheat);

  // Fence the perimeter
  const hw = w / 2 + 1, hd = d / 2 + 1;
  const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  for (let i = 0; i < 4; i++) {
    const [u0, v0] = corners[i];
    const [u1, v1] = corners[(i + 1) % 4];
    const [x0, z0] = local(u0, v0);
    const [x1, z1] = local(u1, v1);
    const segAngle = Math.atan2(z1 - z0, x1 - x0);
    const segments = Math.max(2, Math.floor(Math.hypot(x1 - x0, z1 - z0) / 2.4));
    addFence(props, x0, z0, segAngle, segments);
  }
}

// Destructible chunk registry: every wall block, door and window of every
// house. Explosions knock nearby chunks loose into physical debris, so a
// shell to a corner takes out just that corner.
export const houseChunks = [];

// Colonial home built from destructible wall chunks: bigger than before,
// clapboard walls in a block grid, gable roof, chimney, door and windows.
function addHouse(props, x, z, angle) {
  const h = new THREE.Group();
  const wallColors = [0xb0a189, 0x8a3b2e, 0x9c8f74];
  const wallCol = wallColors[(Math.random() * wallColors.length) | 0];
  const trimCol = 0xe8e2d0;

  const W = 8.2, D = 6.4, H = 3.6, T = 0.26; // bigger footprint + wall height
  const baseY = 0.5;

  const foundation = box(W + 0.6, 0.7, D + 0.6, 0x6f6a60);
  foundation.position.y = 0.15;
  h.add(foundation);

  const registerChunk = (m) => {
    houseChunks.push(m);
    h.add(m);
  };

  // Front/back walls: 6x3 grid of blocks (front keeps a doorway gap)
  const cols = 6, rows = 3;
  const cw = W / cols, ch = H / rows;
  for (const side of [-1, 1]) {
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (side === 1 && i === 1 && j < 2) continue;
        const chunk = box(cw * 0.985, ch * 0.975, T, wallCol);
        chunk.position.set(-W / 2 + (i + 0.5) * cw, baseY + (j + 0.5) * ch, side * (D / 2));
        registerChunk(chunk);
      }
    }
  }
  // Side walls: 5x3 grid
  const cols2 = 5, cw2 = D / cols2;
  for (const side of [-1, 1]) {
    for (let i = 0; i < cols2; i++) {
      for (let j = 0; j < rows; j++) {
        const chunk = box(T, ch * 0.975, cw2 * 0.985, wallCol);
        chunk.position.set(side * (W / 2), baseY + (j + 0.5) * ch, -D / 2 + (i + 0.5) * cw2);
        registerChunk(chunk);
      }
    }
  }

  // Door fills its gap; windows sit proud of the walls — all destructible
  const door = box(cw * 0.9, ch * 1.9, 0.14, 0x3a2a1a);
  door.position.set(-W / 2 + 1.5 * cw, baseY + ch, D / 2 + 0.03);
  registerChunk(door);

  for (const wx of [0.9, 2.8]) {
    for (const side of [-1, 1]) {
      const trim = box(1.05, 1.3, 0.1, trimCol);
      trim.position.set(wx, baseY + 1.7, side * (D / 2 + 0.04));
      registerChunk(trim);
      const glass = box(0.85, 1.1, 0.12, 0x232b33);
      glass.position.set(wx, baseY + 1.7, side * (D / 2 + 0.04));
      registerChunk(glass);
    }
  }

  // Gable roof + attic + chimney (solid — the shells carve the walls)
  for (const side of [-1, 1]) {
    const panel = box(W + 0.8, 0.18, 4.4, 0x453a2e);
    panel.position.set(0, baseY + H + 1.05, side * 1.6);
    panel.rotation.x = side * 0.6;
    h.add(panel);
  }
  const attic = box(W - 0.2, 1.7, 2.7, wallCol);
  attic.position.y = baseY + H + 0.75;
  h.add(attic);

  const chimney = box(0.85, 2.3, 0.85, 0x7a4436);
  chimney.position.set(2.7, baseY + H + 1.9, 0);
  h.add(chimney);

  h.position.set(x, terrainHeight(x, z), z);
  h.rotation.y = angle;
  props.add(h);
  addBoxCollider(x, z, W / 2 + 0.2, D / 2 + 0.2, angle, { isHouse: true });
}

// A burnt-out supply wagon, still smoking. Returns the smoke anchor point.
function addWagon(parent, x, z, angle) {
  const w = new THREE.Group();
  const char = 0x2c241d;      // charred wood
  const charLight = 0x453629;

  const bed = box(1.6, 0.4, 3.2, char);
  bed.position.y = 1.0;
  bed.rotation.z = 0.1;
  w.add(bed);

  for (const side of [-1, 1]) {
    const rail = box(0.12, 0.5, 3.2, charLight);
    rail.position.set(side * 0.75, 1.35, 0);
    rail.rotation.z = 0.1;
    w.add(rail);
  }

  // Burnt canopy hoops
  for (const hz of [-0.9, 0.2, 1.1]) {
    const hoop = cyl(0.03, 0.03, 1.7, char, {}, 6);
    hoop.rotation.z = Math.PI / 2;
    hoop.position.set(0, 1.85, hz);
    w.add(hoop);
  }

  // Wheels — one collapsed
  const wheelPos = [[-0.95, 1.15], [0.95, 1.15], [-0.95, -1.15], [0.95, -1.15]];
  wheelPos.forEach(([wx, wz], i) => {
    const wheel = cyl(0.68, 0.68, 0.12, charLight, {}, 12);
    if (i === 2) {
      wheel.rotation.x = Math.PI / 2; // fallen flat on the ground
      wheel.position.set(wx - 0.4, 0.08, wz - 0.3);
    } else {
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, 0.68, wz);
    }
    w.add(wheel);
  });

  const shaft = box(0.1, 0.1, 2.0, charLight);
  shaft.position.set(0.2, 0.7, 2.4);
  shaft.rotation.x = 0.35;
  w.add(shaft);

  // Scorched ground beneath
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(2.6, 12), mat(0x1c1712));
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.y = 0.04;
  w.add(scorch);

  const y = terrainHeight(x, z);
  w.position.set(x, y, z);
  w.rotation.y = angle;
  parent.add(w);
  addBoxCollider(x, z, 1.1, 1.9, angle);

  return { x, y: y + 1.7, z };
}

// Distant low-poly hills ringing the battlefield to sell the fog
function addPerimeterHills(scene) {
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
    const r = 185 + Math.random() * 70;
    const h = 24 + Math.random() * 36;
    const hill = new THREE.Mesh(
      new THREE.ConeGeometry(38 + Math.random() * 30, h, 7),
      mat(0x35482c)
    );
    hill.position.set(Math.cos(angle) * r, h / 2 - 5, Math.sin(angle) * r);
    hill.rotation.y = Math.random() * Math.PI;
    scene.add(hill);
  }
}

export function createWorld(scene) {
  // Storm-front lighting: slate sky, thick wet fog, cool diffuse sun
  clearColliders();
  houseChunks.length = 0;

  const skyColor = new THREE.Color(0x6d7883);
  scene.background = skyColor;
  scene.fog = new THREE.FogExp2(skyColor, 0.009); // eased for the larger field

  const hemi = new THREE.HemisphereLight(0x8fa3b5, 0x2f3d26, 0.75);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xd9e2ea, 1.35);
  sun.position.set(90, 130, -70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 500;
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  createTerrain(scene);

  const props = new THREE.Group();
  scene.add(props);

  const rand = (a, b) => a + Math.random() * (b - a);
  const scatter = (minR, maxR) => {
    const a = Math.random() * Math.PI * 2;
    const r = rand(minR, maxR);
    return [Math.cos(a) * r, Math.sin(a) * r];
  };

  for (let i = 0; i < 55; i++) {
    const [x, z] = scatter(14, MAP_RADIUS + 30);
    addTree(props, x, z, rand(0.8, 1.7));
  }
  for (let i = 0; i < 42; i++) {
    const [x, z] = scatter(10, MAP_RADIUS + 15);
    addBush(props, x, z, rand(0.7, 1.6));
  }
  for (let i = 0; i < 20; i++) {
    const [x, z] = scatter(10, MAP_RADIUS + 15);
    addRock(props, x, z, rand(0.5, 1.6));
  }
  for (let i = 0; i < 6; i++) {
    const [x, z] = scatter(14, MAP_RADIUS - 15);
    addFence(props, x, z, Math.random() * Math.PI, 3 + (Math.random() * 3 | 0));
  }
  for (let i = 0; i < 4; i++) {
    const [x, z] = scatter(10, 55);
    addCannon(props, x, z, Math.random() * Math.PI * 2);
  }

  // Farmland: big fenced wheat fields + a war-torn hamlet
  addWheatField(scene, props, -48, 34, 36, 24, Math.random() * Math.PI);
  addWheatField(scene, props, 52, -42, 32, 22, Math.random() * Math.PI);
  const houseAngles = [0.4, 1.4, 2.4, 3.4, 4.4, 5.4];
  for (let i = 0; i < 6; i++) {
    const a = houseAngles[i] + Math.random() * 0.6;
    const r = 34 + Math.random() * 52;
    addHouse(props, Math.cos(a) * r, Math.sin(a) * r, Math.random() * Math.PI * 2);
  }

  // Smoking wrecked supply wagons
  const smokeSources = [];
  for (const [wx, wz] of [[18, 42], [-60, -40], [72, 30]]) {
    smokeSources.push(addWagon(props, wx, wz, Math.random() * Math.PI * 2));
  }

  addPerimeterHills(scene);

  return { sun, smokeSources };
}

// Keep the shadow camera centered on the player so shadows follow the action
export function updateSun(sun, playerPos) {
  sun.position.set(playerPos.x + 90, 130, playerPos.z - 70);
  sun.target.position.set(playerPos.x, 0, playerPos.z);
}
