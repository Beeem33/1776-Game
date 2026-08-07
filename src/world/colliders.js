// Static world colliders: tree trunks (circles), fence spans (segments),
// buildings (rotated boxes). Registered by world.js at build time; resolved
// against by the player, enemies, and flying ragdolls.
export const colliders = [];

export function clearColliders() {
  colliders.length = 0;
}

export function addCircleCollider(x, z, r, isTree = false) {
  colliders.push({ kind: 'circle', x, z, r, isTree });
}

export function addSegmentCollider(x1, z1, x2, z2, r, meta = {}) {
  colliders.push({ kind: 'segment', x1, z1, x2, z2, r, ...meta });
}

export function removeCollider(c) {
  const i = colliders.indexOf(c);
  if (i >= 0) colliders.splice(i, 1);
}

export function addBoxCollider(x, z, hw, hd, angle, meta = {}) {
  colliders.push({ kind: 'box', x, z, hw, hd, cos: Math.cos(angle), sin: Math.sin(angle), ...meta });
}

// Is a world-space point inside a box collider's footprint?
export function pointInBox(c, x, z) {
  const lx = x - c.x;
  const lz = z - c.z;
  const bx = lx * c.cos + lz * c.sin;
  const bz = -lx * c.sin + lz * c.cos;
  return Math.abs(bx) < c.hw && Math.abs(bz) < c.hd;
}

// Push a point (with its own radius) out of every collider it penetrates.
// Mutates pos {x, z}. Returns {nx, nz, collider} for the last hit, or null.
// opts.skipSegments: ignore fence-type segment colliders (jumping horse).
export function resolvePoint(pos, radius, opts = {}) {
  let normal = null;
  for (const c of colliders) {
    if (opts.skipSegments && c.kind === 'segment') continue;
    if (c.kind === 'circle') {
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const min = c.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (min - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
        normal = { nx: dx / d, nz: dz / d, collider: c };
      }
    } else if (c.kind === 'segment') {
      const ex = c.x2 - c.x1;
      const ez = c.z2 - c.z1;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 1e-8 ? ((pos.x - c.x1) * ex + (pos.z - c.z1) * ez) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = c.x1 + ex * t;
      const pz = c.z1 + ez * t;
      const dx = pos.x - px;
      const dz = pos.z - pz;
      const min = c.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (min - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
        normal = { nx: dx / d, nz: dz / d, collider: c };
      }
    } else {
      // Rotated box: transform into box-local space
      const lx = pos.x - c.x;
      const lz = pos.z - c.z;
      const bx = lx * c.cos + lz * c.sin;
      const bz = -lx * c.sin + lz * c.cos;
      const ox = c.hw + radius - Math.abs(bx);
      const oz = c.hd + radius - Math.abs(bz);
      if (ox > 0 && oz > 0) {
        // Push out along the axis of least penetration
        let nxL, nzL;
        if (ox < oz) {
          nxL = Math.sign(bx) || 1;
          nzL = 0;
          pos.x += nxL * ox * c.cos;
          pos.z += nxL * ox * c.sin;
        } else {
          nxL = 0;
          nzL = Math.sign(bz) || 1;
          pos.x += -nzL * oz * c.sin;
          pos.z += nzL * oz * c.cos;
        }
        // World-space normal
        const nx = nxL * c.cos - nzL * c.sin;
        const nz = nxL * c.sin + nzL * c.cos;
        normal = { nx, nz, collider: c };
      }
    }
  }
  return normal;
}

// Nearest tree collider to a point (for enemy cover-seeking), or null
export function nearestTree(x, z, maxDist = 55) {
  let best = null;
  let bestD = maxDist;
  for (const c of colliders) {
    if (!c.isTree) continue;
    const d = Math.hypot(c.x - x, c.z - z);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
