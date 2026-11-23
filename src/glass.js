// Window glass for low-poly buildings whose windows are painted into the texture.
// No extra geometry or masks: per pixel, the shader decides "this is a glass pane" when the
// colour is clearly bluer than it is red and neither too bright nor too dark. On those pixels:
//  - Fresnel reflection of a sky/horizon/ground gradient (or a captured cube map)
//  - each pane gets a slightly different tilt, so neighbouring panes reflect different heights
//  - the interior behind the glass is darkened and desaturated
//  - a small, hard sun highlight (bloom spreads it)
// Horizontal faces (blue roofs, awnings) are excluded, and night window emission is kept as is.
import * as THREE from 'three';
import { addCompileHook } from './chunks.js';

const GLSL = `#ifdef ULTRA_GLASS
	{
		vec3 gs = pow( max( diffuseColor.rgb, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) ) * 255.0;
		float gl = ( gs.r + gs.g + gs.b ) / 3.0;
		#ifdef USE_MAP
		float gm = smoothstep( 8.0, 22.0, gs.b - gs.r );
		#else
		float gm = smoothstep( 22.0, 36.0, gs.b - gs.r );
		#endif
		gm *= step( gs.g - 8.0, gs.b ) * smoothstep( 200.0, 182.0, gl ) * smoothstep( 6.0, 16.0, gl );
		if ( gm > 0.0 ) {
			vec3 gV = normalize( vViewPosition ), gN = normalize( normal );
			float gF = .45 + .55 * pow( 1.0 - clamp( dot( gN, gV ), 0.0, 1.0 ), 3.0 );
			vec3 gR = normalize( ( vec4( reflect( -gV, gN ), 0.0 ) * viewMatrix ).xyz );
			vec3 gW = cameraPosition + ( vec4( -vViewPosition, 0.0 ) * viewMatrix ).xyz;
			gm *= 1.0 - smoothstep( .35, .6, abs( ( vec4( gN, 0.0 ) * viewMatrix ).y ) );
			float gP = fract( sin( dot( floor( gW * glassPane ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
			float gy = gR.y + ( gP - .5 ) * .05;
			vec3 gEnv = gy > .03 ? mix( glassRx[ 1 ].rgb, glassRx[ 0 ].rgb, smoothstep( .03, .55, gy ) )
				: gy > -.04 ? mix( glassRx[ 3 ].rgb, glassRx[ 1 ].rgb, .35 + .65 * smoothstep( -.04, .03, gy ) * smoothstep( -.04, .03, gy ) )
				: mix( glassRx[ 3 ].rgb, glassRx[ 2 ].rgb, smoothstep( -.04, -.2, gy ) );
			if ( glassRx[ 3 ].w > 0.0 ) gEnv = mix( gEnv, textureLod( glassEnv, normalize( vec3( gR.x, gy, gR.z ) ), 1.0 ).rgb, glassRx[ 3 ].w );
			float gK = gm * clamp( gF * glassRx[ 0 ].w, 0.0, .7 );
			outgoingLight -= totalEmissiveRadiance;
			outgoingLight = mix( outgoingLight, vec3( dot( outgoingLight, vec3( .2126, .7152, .0722 ) ) ) * .55, .6 * gm );
			outgoingLight = mix( outgoingLight, gEnv, gK ) + totalEmissiveRadiance; diffuseColor.a = mix( diffuseColor.a, 1.0, gK * .7 );
			#if NUM_DIR_LIGHTS > 0
			vec3 gH = normalize( directionalLights[ 0 ].direction + gV );
			outgoingLight += directionalLights[ 0 ].color * gm * pow( max( dot( gN, gH ), 0.0 ), 700.0 ) * glassRx[ 1 ].w;
			#endif
		}
	}
	#endif
	`;

export class GlassReflections {
  // Colours are linear-space multipliers of the given sRGB hex colours.
  constructor({
    skyTop = '#3d7fd6', skyHorizon = '#cfe3f5', ground = '#f4f7fb', horizonBand = '#4a5560',
    brightness = 1.3, groundBrightness = .85, strength = .95, sunGlint = 2.2, paneSize = [1.67, 2.22, 1.67],
  } = {}) {
    this.u = { glassRx: { value: new Float32Array(16) }, glassEnv: { value: null }, glassPane: { value: new THREE.Vector3(1 / paneSize[0], 1 / paneSize[1], 1 / paneSize[2]) } };
    this.setColors({ skyTop, skyHorizon, ground, horizonBand, brightness, groundBrightness, strength, sunGlint });
    this.envMix = .85;
  }
  setColors({ skyTop, skyHorizon, ground, horizonBand, brightness = 1.3, groundBrightness = .85, strength = .95, sunGlint = 2.2 }) {
    const a = this.u.glassRx.value, c = new THREE.Color(), put = (i, hex, k, w) => { c.set(hex).multiplyScalar(k); a[i * 4] = c.r; a[i * 4 + 1] = c.g; a[i * 4 + 2] = c.b; a[i * 4 + 3] = w; };
    const env = a[15];
    put(0, skyTop, brightness, strength); put(1, skyHorizon, brightness, sunGlint); put(2, ground, groundBrightness, 0); put(3, horizonBand, 1, env);
  }
  // material: MeshLambertMaterial or MeshPhongMaterial with blue-ish window pixels.
  apply(material) {
    const u = this.u;
    material.defines = Object.assign(material.defines || {}, { ULTRA_GLASS: '' });
    return addCompileHook(material, 'glass', shader => {
      const k = '#include <opaque_fragment>';
      if (!shader.fragmentShader.includes(k)) { console.warn('[three-ultra-snow] glass: opaque_fragment not found'); return; }
      Object.assign(shader.uniforms, u);
      shader.fragmentShader = 'uniform vec4 glassRx[ 4 ];\nuniform samplerCube glassEnv;\nuniform vec3 glassPane;\n' + shader.fragmentShader.replace(k, GLSL + k);
    });
  }
  // Optional: capture the real surroundings once (e.g. 35 m above the town) and blend it in.
  // Glass is switched off during the capture so it doesn't reflect itself.
  captureEnvironment(renderer, scene, position, size = 256) {
    if (this.rt) this.rt.dispose();
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const cc = new THREE.CubeCamera(1, 20000, rt); cc.position.copy(position);
    const a = this.u.glassRx.value, s = a[3]; a[3] = 0; a[15] = 0;
    cc.update(renderer, scene);
    a[3] = s; a[15] = this.envMix;
    this.rt = rt; this.u.glassEnv.value = rt.texture;
    return rt.texture;
  }
}
