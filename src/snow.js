// Snow lighting for MeshLambertMaterial / MeshPhongMaterial (terrain, snow on trees, roofs):
//  - broad sheen toward the sun (Blinn-Phong)
//  - glints: the surface is split into 3 cm world cells, each a tiny mirror with its own tilt;
//    only ~10% of cells, only within ~30 m, only on bright (snow-coloured) pixels. Moving the
//    camera changes which cells hit the sun, so the snow sparkles.
//  - blue shade: snow that the sun can't reach gets only sky light, tinted blue
//  - ground only: grazing-angle Fresnel picks up more sky colour on distant slopes
//  - not ground: light scattering inside the snow brightens the side facing away from the sun
// The sun term used here is the one after shadows (and after sunVis, if enabled), so nothing
// sparkles in the shade.
import { addCompileHook } from './chunks.js';
import { sunVisVaryings } from './horizon.js';
import * as THREE from 'three';

const snowGLSL = (ground, o) => `
#if NUM_DIR_LIGHTS > 0
  {
  vec3 sV = normalize( vViewPosition ), sN = normalize( normal ), sH = normalize( gSunL + sV );
  float sDist = length( vViewPosition ), sSnow = smoothstep( .55, .85, dot( diffuseColor.rgb, vec3( .3333 ) ) );
  float sSun = clamp( dot( gSunC, vec3( 1.0 ) ) / max( dot( directionalLights[ 0 ].color, vec3( 1.0 ) ), 1e-4 ), 0.0, 1.0 );
  reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), vec3( ${o.shadeTint} ), ( 1.0 - sSun ) * sSnow );
  float sSheen = pow( max( dot( sN, sH ), 0.0 ), 40.0 ) * ${(ground ? o.sheen : o.sheen * .6).toFixed(4)};
  vec3 sCell = floor( vGW * ${(1 / o.glintCell).toFixed(3)} ), sh = fract( sin( vec3( dot( sCell, vec3( 127.1, 311.7, 74.7 ) ), dot( sCell, vec3( 269.5, 183.3, 246.1 ) ), dot( sCell, vec3( 113.5, 271.9, 124.6 ) ) ) ) * 43758.5453 );
  vec3 sG = normalize( sN + ( sh - .5 ) * 1.3 );
  float sGlint = pow( max( dot( reflect( -sV, sG ), gSunL ), 0.0 ), 900.0 ) * step( ${(1 - o.glintDensity).toFixed(3)}, sh.z ) * ( 1.0 - smoothstep( ${(o.glintRange * .27).toFixed(2)}, ${o.glintRange.toFixed(2)}, sDist ) ) * ${o.glint.toFixed(3)};
  reflectedLight.directDiffuse += gSunC * sSnow * ( sSheen + sGlint );
  ${ground ? `#if NUM_HEMI_LIGHTS > 0
  float sF = pow( 1.0 - clamp( dot( sN, sV ), 0.0, 1.0 ), 4.0 );
  reflectedLight.directDiffuse += hemisphereLights[ 0 ].skyColor * sF * ${o.fresnel.toFixed(3)} * sSnow;
  #endif` : `reflectedLight.directDiffuse += gSunC * BRDF_Lambert( diffuseColor.rgb ) * sSnow * ${o.scatter.toFixed(3)} * ( 1.0 - clamp( dot( sN, gSunL ), 0.0, 1.0 ) );`}
  }
#endif`;

const DEFAULTS = { sheen: .1, glint: 8, glintCell: .03, glintDensity: .1, glintRange: 30, fresnel: .18, scatter: .45, shadeTint: [.78, .9, 1.18] };

// options: ground (terrain vs. snow on objects), sunVisibility (terrain with a baked sunVis
// attribute, see bakeHorizonShadow), extraSunGLSL (your own line that scales directLight.color),
// plus any of DEFAULTS to tune the look.
export function withSnow(material, { ground = false, sunVisibility = false, extraSunGLSL = '', ...tune } = {}) {
  const o = { ...DEFAULTS, ...tune };
  o.shadeTint = o.shadeTint.map(v => (+v).toFixed(3)).join(', ');
  const key = 'snow' + JSON.stringify([ground, sunVisibility, extraSunGLSL, o]);
  return addCompileHook(material, key, shader => {
    let extra = extraSunGLSL;
    if (sunVisibility) extra = sunVisVaryings(shader) + extra;
    shader.vertexShader = 'varying vec3 vGW;\n' + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
#ifdef USE_INSTANCING
	vGW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
#else
	vGW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif`);
    const L = THREE.ShaderChunk.lights_fragment_begin, a = L.indexOf('NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'), b = a < 0 ? -1 : L.indexOf('RE_Direct( directLight', a);
    if (b < 0 || !shader.fragmentShader.includes('#include <lights_fragment_begin>')) { console.warn('[three-ultra-snow] snow: light loop not found'); return; }
    shader.fragmentShader = 'varying vec3 vGW;\nvec3 gSunC = vec3( 0.0 ), gSunL = vec3( 0.0, 1.0, 0.0 );\n' + shader.fragmentShader
      .replace('#include <lights_fragment_begin>', L.slice(0, b) + extra + '#if ( UNROLLED_LOOP_INDEX == 0 )\n\t\tgSunC = directLight.color; gSunL = directLight.direction;\n\t\t#endif\n\t\t' + L.slice(b))
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + snowGLSL(ground, o));
  });
}
