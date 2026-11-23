// Two-layer sun shadow for big outdoor scenes.
//  - static layer: buildings, trees, pylons. One large map, re-rendered only when the camera has
//    moved far enough (usually once every few seconds).
//  - dynamic layer: people, vehicles, chairlift seats. A small map in front of the camera,
//    re-rendered every frame. Cheap because only moving things are drawn into it.
// Needs installUltraChunks({ dualSunShadow: true }) so light 0 is darkened by both maps.
// Both shadow frusta are snapped to whole texels, so shadow edges don't shimmer as they follow the camera.
import * as THREE from 'three';

const _d = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3();

export class UltraSun {
  constructor(scene, {
    direction = new THREE.Vector3(-80, 55, -45),
    color = 0xffffff, intensity = Math.PI * 1.5,
    staticLayer = { mapSize: 4096, extent: 220 },
    dynamicLayer = { mapSize: 2048, extent: 90 },
    layers = { static: 5, dynamic: 4 },
    distance = 700, softness = 3,
  } = {}) {
    this.dir = direction.clone().normalize();
    this.distance = distance;
    this.layers = layers;
    this.cfg = { s: staticLayer, d: dynamicLayer };
    this.sun = new THREE.DirectionalLight(color, intensity);
    this.shadowOnly = new THREE.DirectionalLight(0xffffff, 0);
    for (const [L, c] of [[this.sun, staticLayer], [this.shadowOnly, dynamicLayer]]) {
      L.castShadow = true;
      const sh = L.shadow, cam = sh.camera;
      sh.mapSize.set(c.mapSize, c.mapSize); sh.bias = -.0003; sh.normalBias = .08; sh.radius = softness;
      cam.left = cam.bottom = -c.extent; cam.right = cam.top = c.extent; cam.near = 1; cam.far = distance * 2.3; cam.updateProjectionMatrix();
    }
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.camera.layers.set(layers.static);
    this.shadowOnly.shadow.camera.layers.set(layers.dynamic);
    // Order matters: the sun must be directional light 0, the shadow-only light 1.
    scene.add(this.sun, this.sun.target, this.shadowOnly, this.shadowOnly.target);
    this.staticAt = null;
    this.enabled = true;
    this._off = false;
  }

  // Mark casters. Receivers just need receiveShadow = true as usual.
  addStatic(root) { return this._mark(root, this.layers.static); }
  addDynamic(root) { return this._mark(root, this.layers.dynamic); }
  _mark(root, layer) {
    root.traverse(o => { if (!o.isMesh) return; o.castShadow = true; o.layers.enable(layer); });
    this.invalidate();
    return root;
  }

  // Force the static map to re-render on the next update (call after adding/moving static things).
  invalidate() { this.staticAt = null; }

  _snap(f, ext, map) {
    const d = this.dir, tx = 2 * ext / map;
    _r.crossVectors(THREE.Object3D.DEFAULT_UP, d).normalize(); _u.crossVectors(d, _r);
    const a = f.dot(_r), b = f.dot(_u);
    return f.addScaledVector(_r, Math.round(a / tx) * tx - a).addScaledVector(_u, Math.round(b / tx) * tx - b);
  }
  _aim(L, f) { L.target.position.copy(f); L.position.copy(f).addScaledVector(this.dir, this.distance); L.target.updateMatrixWorld(); L.updateMatrixWorld(); }

  // Call once per frame before rendering.
  //   groundHeight(x, z): optional, keeps the shadow box on the terrain surface
  //   velocity: optional {x, z} of the viewer; when moving forward fast the static box is placed
  //             ahead, so the expensive static re-render happens less often
  update(renderer, camera, { groundHeight, velocity } = {}) {
    renderer.shadowMap.autoUpdate = false;
    if (!this.enabled) {
      // Turning castShadow off recompiles every material; instead aim both boxes at empty space.
      if (!this._off) { this._off = true; this.staticAt = null; _f.set(1e6, -1e5, 1e6); this._aim(this.sun, _f); this._aim(this.shadowOnly, _f); this.sun.shadow.needsUpdate = true; renderer.shadowMap.needsUpdate = true; }
      return;
    }
    this._off = false;
    const S = this.cfg.s, D = this.cfg.d, ground = f => { if (groundHeight) { const h = groundHeight(f.x, f.z); if (isFinite(h)) f.y = h; } return f; };
    camera.getWorldDirection(_d); _d.y = 0; if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1); _d.normalize();
    const fs = ground(_f.copy(camera.position).addScaledVector(_d, S.extent * .4));
    if (!this.staticAt || Math.hypot(fs.x - this.staticAt.x, fs.z - this.staticAt.z) > S.extent * .3) {
      if (this.staticAt && velocity) {
        const sp = Math.hypot(velocity.x, velocity.z), lead = S.extent * .25;
        if (sp > 6 && (velocity.x * _d.x + velocity.z * _d.z) / sp > .5) { const k = lead * Math.min(1, (sp - 6) / 10) / sp; fs.x += velocity.x * k; fs.z += velocity.z * k; ground(fs); }
      }
      this.staticAt = (this.staticAt || new THREE.Vector3()).copy(this._snap(fs, S.extent, S.mapSize));
      this._aim(this.sun, this.staticAt); this.sun.shadow.needsUpdate = true;
    }
    this._aim(this.shadowOnly, this._snap(ground(_g.copy(camera.position).addScaledVector(_d, D.extent * .5)), D.extent, D.mapSize));
    renderer.shadowMap.needsUpdate = true;
  }

  setSoftness(r) { this.sun.shadow.radius = this.shadowOnly.shadow.radius = r; this.invalidate(); }
  setShadowIntensity(k) { this.sun.shadow.intensity = this.shadowOnly.shadow.intensity = k; }
}
