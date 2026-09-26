// Interactive 3D nail preview: a stylised hand whose nails can be re-coloured,
// re-shaped and given different finishes (gloss / matte / chrome / cat-eye / French tip).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const SHAPES = {
  // tipStart: where the free-edge profile begins (0..1 of nail length); ext: free-edge length
  almond: { tipStart: 0.55, ext: 0.4 },
  oval: { tipStart: 0.7, ext: 0.26 },
  square: { tipStart: 0.9, ext: 0.24 },
  coffin: { tipStart: 0.6, ext: 0.42 },
};

function halfWidth(shape, v, W) {
  const hw = W / 2;
  // rounded cuticle
  const cut = 0.1;
  let base = 1;
  if (v < cut) base = Math.sqrt(Math.max(0, 1 - ((cut - v) / cut) ** 2)) * 0.9 + 0.1;
  const { tipStart } = SHAPES[shape];
  if (v <= tipStart) return hw * base;
  const t = Math.min(1, (v - tipStart) / (1 - tipStart));
  switch (shape) {
    case 'almond': return hw * Math.pow(Math.max(0, 1 - Math.pow(t, 1.7)), 0.72);
    case 'oval': return hw * Math.sqrt(Math.max(0, 1 - t * t));
    case 'square': { const rc = hw * 0.35; return hw - rc + rc * Math.sqrt(Math.max(0, 1 - t * t)); }
    case 'coffin': { const taper = hw * (1 - 0.42 * t); const rc = hw * 0.12; return t > 0.9 ? taper - rc + rc * Math.sqrt(Math.max(0, 1 - ((t - 0.9) / 0.1) ** 2)) : taper; }
    default: return hw;
  }
}

// Builds a thin, curved nail plate: top & bottom surfaces bent around the finger axis (Y), stitched at the edges.
function buildNailGeometry({ shape, R, W, length, thickness = 0.032, NU = 18, NV = 44 }) {
  const pos = [];
  const uv = [];
  const idx = [];
  const point = (u, v, rad) => {
    const hw = halfWidth(shape, v, W);
    const x = (u * 2 - 1) * hw;
    const a = x / R;
    const y = v * length;
    const droop = 0.06 * Math.max(0, v - 0.55) ** 2; // gentle C-curve toward the free edge
    return [rad * Math.sin(a), y, rad * Math.cos(a) - droop];
  };
  const addGrid = (rad, flip) => {
    const start = pos.length / 3;
    for (let j = 0; j <= NV; j++) {
      for (let i = 0; i <= NU; i++) {
        pos.push(...point(i / NU, j / NV, rad));
        uv.push(i / NU, j / NV);
      }
    }
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const a = start + j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
        if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
      }
    }
    return start;
  };
  const top = addGrid(R + thickness, false);
  const bot = addGrid(R, true);
  const at = (s, i, j) => s + j * (NU + 1) + i;
  // side walls (u = 0, u = 1) and tip (v = 1)
  for (let j = 0; j < NV; j++) {
    idx.push(at(top, 0, j), at(bot, 0, j), at(top, 0, j + 1), at(bot, 0, j), at(bot, 0, j + 1), at(top, 0, j + 1));
    idx.push(at(top, NU, j), at(top, NU, j + 1), at(bot, NU, j), at(bot, NU, j), at(top, NU, j + 1), at(bot, NU, j + 1));
  }
  for (let i = 0; i < NU; i++) {
    idx.push(at(top, i, NV), at(top, i + 1, NV), at(bot, i, NV), at(bot, i, NV), at(top, i + 1, NV), at(bot, i + 1, NV));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const FINGERS = [
  // x, base y, radius, length (cylinder), tilt (rad), nail bed length
  { x: -1.02, y: -0.55, r: 0.285, L: 1.45, rz: 0.12, bed: 0.46 },
  { x: -0.34, y: -0.45, r: 0.31, L: 1.85, rz: 0.035, bed: 0.52 },
  { x: 0.34, y: -0.5, r: 0.3, L: 1.7, rz: -0.035, bed: 0.5 },
  { x: 0.98, y: -0.65, r: 0.26, L: 1.25, rz: -0.13, bed: 0.42 },
];
const THUMB = { x: -1.62, y: -1.55, r: 0.33, L: 1.05, rz: 0.78, bed: 0.5 };

export function createNailViewer(canvas, { color = '#E9B8B0', finish = 'gloss', shape = 'almond', french = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 0.55; // skin; nails set their own envMap intensity per finish

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0.4, 0.6, 10);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(-0.2, 0.1, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 4.2;
  controls.maxDistance = 11;
  controls.minPolarAngle = Math.PI * 0.2;
  controls.maxPolarAngle = Math.PI * 0.75;
  controls.update();

  const key = new THREE.DirectionalLight(0xfff4ec, 1.6);
  key.position.set(3, 5, 6);
  const rim = new THREE.DirectionalLight(0xffe0e8, 0.6);
  rim.position.set(-4, 2, -3);
  scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.15));

  const hand = new THREE.Group();
  hand.position.y = -0.2;
  scene.add(hand);

  const skin = new THREE.MeshPhysicalMaterial({ color: 0xD9A487, roughness: 0.58, sheen: 0.6, sheenColor: 0xffc9b0, sheenRoughness: 0.5 });
  const palm = new THREE.Mesh(new RoundedBoxGeometry(2.75, 2.3, 0.85, 6, 0.42), skin);
  palm.position.set(-0.02, -1.55, -0.05);
  hand.add(palm);
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 1.6, 40), skin);
  wrist.scale.z = 0.55;
  wrist.position.set(0, -3.2, -0.05);
  hand.add(wrist);

  // Nail texture (base colour, French tip, cat-eye band) drawn on a canvas.
  const texCanvas = document.createElement('canvas');
  texCanvas.width = 128; texCanvas.height = 256;
  const ctx = texCanvas.getContext('2d');
  const texture = new THREE.CanvasTexture(texCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const nailMat = new THREE.MeshPhysicalMaterial({ map: texture, color: 0xffffff, envMap });

  const state = { color, finish, shape, french, band: 0.5 };
  const nails = [];
  const fingerDefs = [...FINGERS, THUMB];
  for (const f of fingerDefs) {
    const g = new THREE.Group();
    g.position.set(f.x, f.y, 0);
    g.rotation.z = f.rz;
    if (f === THUMB) g.rotation.y = -0.55;
    const finger = new THREE.Mesh(new THREE.CapsuleGeometry(f.r, f.L, 10, 28), skin);
    finger.position.y = f.L / 2;
    finger.scale.z = 0.92;
    g.add(finger);
    const nail = new THREE.Mesh(undefined, nailMat);
    nail.position.y = f.L - f.bed + 0.05;
    nail.userData.f = f;
    g.add(nail);
    nails.push(nail);
    hand.add(g);
  }

  function rebuildNails() {
    const { ext } = SHAPES[state.shape];
    for (const n of nails) {
      const f = n.userData.f;
      const length = f.bed + f.r * 0.75 + ext * (f.r / 0.3);
      n.geometry?.dispose();
      n.geometry = buildNailGeometry({ shape: state.shape, R: f.r * 0.93, W: f.r * 1.72, length });
    }
  }

  function paint() {
    const W = texCanvas.width, H = texCanvas.height;
    ctx.fillStyle = state.color;
    ctx.fillRect(0, 0, W, H);
    if (state.finish === 'cateye') {
      const c = new THREE.Color(state.color);
      const hi = c.clone().lerp(new THREE.Color(0xffffff), 0.75).getStyle();
      const mid = c.clone().lerp(new THREE.Color(0xffffff), 0.35).getStyle();
      const y = state.band * H;
      const grad = ctx.createLinearGradient(0, y - H * 0.22, W * 0.25, y + H * 0.22);
      grad.addColorStop(0, state.color);
      grad.addColorStop(0.38, mid);
      grad.addColorStop(0.5, hi);
      grad.addColorStop(0.62, mid);
      grad.addColorStop(1, state.color);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    if (state.french) {
      // Canvas y=0 maps to the free edge (v=1) because CanvasTexture flips Y. Smile line curves toward the cuticle.
      ctx.fillStyle = '#FBFAF7';
      ctx.beginPath();
      ctx.moveTo(0, H * 0.3);
      ctx.quadraticCurveTo(W / 2, H * 0.14, W, H * 0.3);
      ctx.lineTo(W, 0);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
    }
    texture.needsUpdate = true;
  }

  function applyFinish() {
    const m = nailMat;
    const presets = {
      gloss: { roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 0.8 },
      matte: { roughness: 0.85, metalness: 0, clearcoat: 0, clearcoatRoughness: 1, envMapIntensity: 0.5 },
      chrome: { roughness: 0.16, metalness: 1, clearcoat: 0.5, clearcoatRoughness: 0.05, envMapIntensity: 2.2 },
      cateye: { roughness: 0.28, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.2 },
    };
    Object.assign(m, presets[state.finish] || presets.gloss);
    m.needsUpdate = true;
    paint();
  }

  rebuildNails();
  applyFinish();

  // ----- sizing & render loop -----
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let userTouched = reduceMotion;
  controls.addEventListener('start', () => { userTouched = true; });

  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
  io.observe(canvas);

  const clock = new THREE.Clock();
  let lastBand = -1;
  renderer.setAnimationLoop(() => {
    if (!visible) return;
    const t = clock.getElapsedTime();
    if (!userTouched) hand.rotation.y = Math.sin(t * 0.5) * 0.35;
    controls.update();
    if (state.finish === 'cateye') {
      // the cat-eye highlight follows the viewing angle, like a real magnetic polish
      const az = controls.getAzimuthalAngle() + hand.rotation.y;
      state.band = 0.5 + Math.sin(az) * 0.3 + (controls.getPolarAngle() - Math.PI / 2) * 0.4;
      if (Math.abs(state.band - lastBand) > 0.01) { lastBand = state.band; paint(); }
    }
    renderer.render(scene, camera);
  });

  return {
    setColor(hex) { state.color = hex; paint(); },
    setFinish(f) { state.finish = f; applyFinish(); },
    setShape(s) { if (SHAPES[s]) { state.shape = s; rebuildNails(); } },
    setFrench(on) { state.french = !!on; paint(); },
    get state() { return { ...state }; },
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect(); io.disconnect(); controls.dispose();
      renderer.dispose(); pmrem.dispose();
    },
  };
}
