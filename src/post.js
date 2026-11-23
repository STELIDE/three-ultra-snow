// HDR finish: render the scene into a half-float target, then
//  - bloom: keep only the bright parts (sunlit snow, lamps), downsample 1/2 .. 1/64 with a
//    dual-Kawase blur and add it back while upsampling
//  - tone mapping + sRGB in the final pass (three skips tone mapping when drawing to a target)
//  - a little extra contrast and saturation (deep sky, white snow, dark trunks)
// Set renderer.toneMapping (e.g. THREE.NeutralToneMapping) as usual; this pass applies it.
import * as THREE from 'three';

const VS = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';
const DOWN = `uniform sampler2D t; uniform vec2 px; uniform float thr, knee; varying vec2 vUv;
void main() { vec3 c = texture2D( t, vUv ).rgb * 4.0 + texture2D( t, vUv + px * vec2( -1, -1 ) ).rgb + texture2D( t, vUv + px * vec2( 1, -1 ) ).rgb + texture2D( t, vUv + px * vec2( -1, 1 ) ).rgb + texture2D( t, vUv + px ).rgb; c /= 8.0;
  if ( thr > 0.0 ) { float l = max( c.r, max( c.g, c.b ) ), s = clamp( l - thr + knee, 0.0, 2.0 * knee ); s = s * s / ( 4.0 * knee + 1e-4 ); c *= max( s, l - thr ) / max( l, 1e-4 ); c = min( c, vec3( 12.0 ) ); }
  gl_FragColor = vec4( c, 1.0 ); }`;
const UP = `uniform sampler2D t, t2; uniform vec2 px; varying vec2 vUv;
void main() { vec3 c = texture2D( t, vUv + px * vec2( -2, 0 ) ).rgb + texture2D( t, vUv + px * vec2( 2, 0 ) ).rgb + texture2D( t, vUv + px * vec2( 0, -2 ) ).rgb + texture2D( t, vUv + px * vec2( 0, 2 ) ).rgb
  + ( texture2D( t, vUv + px * vec2( -1, -1 ) ).rgb + texture2D( t, vUv + px * vec2( 1, -1 ) ).rgb + texture2D( t, vUv + px * vec2( -1, 1 ) ).rgb + texture2D( t, vUv + px ).rgb ) * 2.0;
  gl_FragColor = vec4( c / 12.0 + texture2D( t2, vUv ).rgb, 1.0 ); }`;
const FINAL = `uniform sampler2D t, tb; uniform float k, sat, curve; varying vec2 vUv;
void main() { gl_FragColor = vec4( texture2D( t, vUv ).rgb + texture2D( tb, vUv ).rgb * k, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  vec3 g = gl_FragColor.rgb; float l = dot( g, vec3( .2126, .7152, .0722 ) ); g = mix( vec3( l ), g, sat ); g = mix( g, g * g * ( 3.0 - 2.0 * g ), curve ); gl_FragColor.rgb = g; }`;

export class UltraPost {
  constructor(renderer, { levels = 6, threshold = 1.05, knee = .35, strength = .32, saturation = 1.12, contrast = .2, msaa = 4 } = {}) {
    this.renderer = renderer; this.levels = levels; this.msaa = msaa;
    const M = (fs, u) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms: u, depthTest: false, depthWrite: false, toneMapped: false });
    this.down = M(DOWN, { t: { value: null }, px: { value: new THREE.Vector2() }, thr: { value: threshold }, knee: { value: knee } });
    this.up = M(UP, { t: { value: null }, t2: { value: null }, px: { value: new THREE.Vector2() } });
    this.fin = M(FINAL, { t: { value: null }, tb: { value: null }, k: { value: strength }, sat: { value: saturation }, curve: { value: contrast } });
    this.fin.toneMapped = true;
    this.threshold = threshold;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fin); this.quad.frustumCulled = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.size = new THREE.Vector2(); this.w = 0; this.h = 0; this.rt = null; this.downRT = []; this.upRT = [];
  }
  get strength() { return this.fin.uniforms.k.value; }
  set strength(v) { this.fin.uniforms.k.value = v; }
  _resize(w, h) {
    this.dispose();
    const o = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: this.msaa });
    let x = w, y = h;
    for (let i = 0; i < this.levels; i++) { x = Math.max(1, x >> 1); y = Math.max(1, y >> 1); this.downRT.push(new THREE.WebGLRenderTarget(x, y, o)); if (i < this.levels - 1) this.upRT.push(new THREE.WebGLRenderTarget(x, y, o)); }
    this.w = w; this.h = h;
  }
  _pass(mat, dst) { this.quad.material = mat; this.renderer.setRenderTarget(dst); this.renderer.render(this.quad, this.cam); }
  // Drop-in replacement for renderer.render(scene, camera).
  render(scene, camera) {
    const r = this.renderer, N = this.levels;
    r.getDrawingBufferSize(this.size); if (this.size.x !== this.w || this.size.y !== this.h) this._resize(this.size.x, this.size.y);
    const prev = r.getRenderTarget(), autoClear = r.autoClear;
    r.setRenderTarget(this.rt); r.render(scene, camera);
    r.autoClear = false;
    const D = this.down.uniforms, U = this.up.uniforms;
    let src = this.rt;
    this.downRT.forEach((dst, i) => { D.t.value = src.texture; D.px.value.set(.5 / src.width, .5 / src.height); D.thr.value = i ? 0 : this.threshold; this._pass(this.down, dst); src = dst; });
    for (let i = N - 2; i >= 0; i--) { const lo = i === N - 2 ? this.downRT[N - 1] : this.upRT[i + 1]; U.t.value = lo.texture; U.t2.value = this.downRT[i].texture; U.px.value.set(.5 / lo.width, .5 / lo.height); this._pass(this.up, this.upRT[i]); }
    this.fin.uniforms.t.value = this.rt.texture; this.fin.uniforms.tb.value = this.upRT[0].texture;
    this._pass(this.fin, prev);
    r.autoClear = autoClear;
  }
  dispose() { for (const t of [this.rt, ...this.downRT, ...this.upRT]) if (t) t.dispose(); this.rt = null; this.downRT = []; this.upRT = []; this.w = this.h = 0; }
}
