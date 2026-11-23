// Global shader-chunk patches. Call installUltraChunks() once, before the first render.
// They work by exact string replacement on three.js r187 chunks; if three changes a chunk,
// the patch is skipped with a console warning instead of producing broken GLSL.
import * as THREE from 'three';

const state = { stableSoftShadows: false, dualSunShadow: false };

// r18x PCF shadows rotate a 5-tap Vogel disk by per-pixel noise. That noise is meant to be
// averaged away by TAA; without TAA, shadowed snow looks like halftone dots. Fix the angle.
function patchStableSoftShadows() {
  if (state.stableSoftShadows) return true;
  const P = THREE.ShaderChunk.shadowmap_pars_fragment, k = 'interleavedGradientNoise( gl_FragCoord.xy ) * PI2';
  if (!P.includes(k)) { console.warn('[three-ultra-snow] stable soft shadows: shadowmap_pars_fragment changed, skipped'); return false; }
  THREE.ShaderChunk.shadowmap_pars_fragment = P.split(k).join('0.0');
  return (state.stableSoftShadows = true);
}

// Two-layer sun shadow: directional light 0 is the sun (static casters, re-rendered rarely),
// directional light 1 is a zero-intensity "shadow-only" light (moving casters, every frame).
// Light 0 gets multiplied by both shadow maps, so the two read as one shadow.
const SHADOW_LINE = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
function patchDualSunShadow() {
  if (state.dualSunShadow) return true;
  const L = THREE.ShaderChunk.lights_fragment_begin;
  if (L.split(SHADOW_LINE).length !== 2) { console.warn('[three-ultra-snow] dual sun shadow: lights_fragment_begin changed, skipped'); return false; }
  THREE.ShaderChunk.lights_fragment_begin = L.replace(SHADOW_LINE, `#if ( UNROLLED_LOOP_INDEX == 0 )
		${SHADOW_LINE}
		#if ( NUM_DIR_LIGHT_SHADOWS > 1 )
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ) : 1.0;
		#endif
		#endif`);
  return (state.dualSunShadow = true);
}

export function installUltraChunks({ stableSoftShadows = true, dualSunShadow = true } = {}) {
  return {
    stableSoftShadows: stableSoftShadows ? patchStableSoftShadows() : state.stableSoftShadows,
    dualSunShadow: dualSunShadow ? patchDualSunShadow() : state.dualSunShadow,
  };
}

// Insert GLSL right before the first RE_Direct() of the directional-light loop, so it can
// scale directLight.color (sun only, sky light untouched). Returns the patched fragment shader,
// or null if the chunk layout is not recognised.
export function injectIntoSunLoop(fragmentShader, glsl) {
  const L = THREE.ShaderChunk.lights_fragment_begin, a = L.indexOf('NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'), b = a < 0 ? -1 : L.indexOf('RE_Direct( directLight', a);
  if (b < 0 || !fragmentShader.includes('#include <lights_fragment_begin>')) return null;
  return fragmentShader.replace('#include <lights_fragment_begin>', L.slice(0, b) + glsl + L.slice(b));
}

// Chain onBeforeCompile hooks so the library plays nicely with your own.
export function addCompileHook(material, key, hook) {
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) { if (prev) prev.call(this, shader, renderer); hook(shader, renderer); };
  material.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|' + key; };
  material.needsUpdate = true;
  return material;
}
