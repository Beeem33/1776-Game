import * as THREE from 'three';

// Shared geometry/material caches so dozens of enemies reuse GPU resources.
// NEVER dispose anything returned from here (ragdolls clone materials before
// fading and dispose only their clones).
const geoCache = new Map();
const matCache = new Map();

export function boxGeo(w, h, d) {
  const key = `b${w},${h},${d}`;
  if (!geoCache.has(key)) geoCache.set(key, new THREE.BoxGeometry(w, h, d));
  return geoCache.get(key);
}

export function cylGeo(rt, rb, h, seg = 8) {
  const key = `c${rt},${rb},${h},${seg}`;
  if (!geoCache.has(key)) geoCache.set(key, new THREE.CylinderGeometry(rt, rb, h, seg));
  return geoCache.get(key);
}

export function sphereGeo(r, seg = 10) {
  const key = `s${r},${seg}`;
  if (!geoCache.has(key)) geoCache.set(key, new THREE.SphereGeometry(r, seg, seg));
  return geoCache.get(key);
}

// Rounded-end limb segment: total height = len + 2r, oriented along Y
export function capGeo(r, len, seg = 10) {
  const key = `p${r},${len},${seg}`;
  if (!geoCache.has(key)) geoCache.set(key, new THREE.CapsuleGeometry(r, len, 4, seg));
  return geoCache.get(key);
}

export function mat(color, { roughness = 0.85, metalness = 0 } = {}) {
  const key = `${color},${roughness},${metalness}`;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness }));
  }
  return matCache.get(key);
}

export function box(w, h, d, color, opts) {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat(color, opts));
  m.castShadow = true;
  return m;
}

export function cyl(rt, rb, h, color, opts, seg = 8) {
  const m = new THREE.Mesh(cylGeo(rt, rb, h, seg), mat(color, opts));
  m.castShadow = true;
  return m;
}

export function sphere(r, color, opts, seg = 10) {
  const m = new THREE.Mesh(sphereGeo(r, seg), mat(color, opts));
  m.castShadow = true;
  return m;
}

export function capsule(r, len, color, opts, seg = 10) {
  const m = new THREE.Mesh(capGeo(r, len, seg), mat(color, opts));
  m.castShadow = true;
  return m;
}
