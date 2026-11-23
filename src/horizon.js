// Baked mountain shadows. A shadow map only covers a few hundred metres; beyond that, ridges
// still need to shade valleys. For a fixed sun, march from every terrain vertex toward the sun
// over the height field once, and store 0 (shadow) .. 1 (sunlit) as a vertex attribute.
// withSunVisibility() then multiplies only the *sun* term by it, so shaded slopes keep the blue
// sky light instead of going grey.
import * as THREE from 'three';
import { injectIntoSunLoop, addCompileHook } from './chunks.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// heightAt(x, z) -> metres. positions: flat xyz array (e.g. geometry.attributes.position.array, world space).
export function bakeHorizonShadow(heightAt, positions, sunDirection, {
  maxDistance = 7000, firstStep = 12, growth = 1.09, lift = 2, maxHeight, softness = [-.012, .035],
} = {}) {
  const d = sunDirection.clone().normalize(), hl = Math.hypot(d.x, d.z) || 1, ux = d.x / hl, uz = d.z / hl, tanE = d.y / hl;
  const n = positions.length / 3, out = new Float32Array(n);
  let top = maxHeight;
  if (top === undefined) { top = -Infinity; for (let k = 0; k < n; k++) top = Math.max(top, positions[k * 3 + 1]); }
  for (let k = 0; k < n; k++) {
    const x = positions[k * 3], z = positions[k * 3 + 2], h0 = heightAt(x, z) + lift; let m = -1;
    for (let s = firstStep; s < maxDistance; s *= growth) {
      if (h0 + s * tanE > top) break;   // the ray is above every peak: nothing left to hit
      const o = (heightAt(x + ux * s, z + uz * s) - h0) / s - tanE; if (o > m) m = o;
    }
    out[k] = 1 - smooth(softness[0], softness[1], m);
  }
  return out;
}

// Vertex side of the sunVis attribute (shared with withSnow's sunVisibility option).
export function sunVisVaryings(shader) {
  shader.vertexShader = 'attribute float sunVis;\nvarying float vSunVis;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSunVis = sunVis;');
  shader.fragmentShader = 'varying float vSunVis;\n' + shader.fragmentShader;
  return 'directLight.color *= vSunVis;\n\t\t';
}

// Adds the baked values to the geometry as attribute `sunVis` and makes the material use them.
// For snow terrain use withSnow(material, { ground: true, sunVisibility: true }) instead (not both).
export function withSunVisibility(material, geometry, sunVis) {
  if (geometry && sunVis) geometry.setAttribute('sunVis', new THREE.BufferAttribute(sunVis, 1));
  return addCompileHook(material, 'sunVis', shader => {
    const extra = sunVisVaryings(shader), f = injectIntoSunLoop(shader.fragmentShader, extra);
    if (f) shader.fragmentShader = f; else console.warn('[three-ultra-snow] sunVis: light loop not found');
  });
}
