import * as THREE from 'three';
import { ParallaxEngine, ThreeJSAdapter, CalibrationPanel, CalibrationOverlay, DiagnosticOverlay, GridRoom, screenFromViewport } from '../../src/three';
import type { EyePosition } from '../../src/three';

// Auto-compute screen dimensions from viewport
const screen = screenFromViewport();

// --- Three.js scene setup ---

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.domElement.style.visibility = 'hidden';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const BG_COLOR = 0x000000;
scene.background = new THREE.Color(BG_COLOR);
const bgColor = new THREE.Color(BG_COLOR);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0, 0, 0.6);

// --- Grid room anchored to viewport edges ---

const ROOM_DEPTH = 0.60;
const gridRoom = new GridRoom(screen, {
  depth: ROOM_DEPTH,
  gridSpacing: 0.053,
});
scene.add(gridRoom.getGroup());

// =========================================================================
// CHARACTER SPRITES
// Each character is built as a grid of tiny voxel blocks, one per opaque
// pixel of the source art. Transparent pixels get no block at all, so the
// silhouette is a true cutout rather than a rectangle — and because each
// block's material color is sampled straight from that pixel, the block's
// side faces (the "depth" you see as you look at it off-axis) are always
// the same color as the pixel that produced them.
// =========================================================================

interface CharacterDef {
  x: number;
  y: number;
  z: number;
  widthMeters: number;   // on-screen width of the whole sprite
  hue: number;            // used by the placeholder generator; ignored once you supply imageUrl
  imageUrl?: string;      // set this to use your own artwork instead of the placeholder
  name?: string;
}

// --- Tunables ---
const SPRITE_THICKNESS = 0.003;   // ~3mm — turn this down further for an almost-flat relief look
const VOXEL_GAP = 1.0;            // 1 = seamless blocks (no gaps); <1 leaves a thin seam between them if you want that look later
const ALPHA_CUTOFF = 128;         // pixels with alpha below this (0-255) are skipped entirely (cutout)
const PIXEL_GRID = 16;            // placeholder character resolution (16x16)
const MAX_VOXEL_GRID = 200;       // safety cap when loading real images — comfortably fits e.g. 150x150 at native resolution

/**
 * Draws a simple blocky humanoid at native 1px-per-cell resolution — this is
 * sampled directly for voxel placement, so no upscaling here.
 */
function createPlaceholderCharacterCanvas(hue: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = PIXEL_GRID;
  canvas.height = PIXEL_GRID;
  const ctx = canvas.getContext('2d')!;

  const draw = (col: number, row: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(col, row, w, h);
  };

  const skin = `hsl(${(hue + 30) % 360}, 40%, 65%)`;
  const shirt = `hsl(${hue}, 70%, 50%)`;
  const shirtDark = `hsl(${hue}, 70%, 38%)`;
  const pants = `hsl(${(hue + 200) % 360}, 35%, 30%)`;

  // head
  draw(5, 1, 6, 5, skin);
  // body
  draw(4, 6, 8, 6, shirt);
  draw(4, 6, 8, 1, shirtDark); // collar shading
  // arms
  draw(2, 6, 2, 5, shirt);
  draw(12, 6, 2, 5, shirt);
  draw(2, 11, 2, 1, skin); // hands
  draw(12, 11, 2, 1, skin);
  // legs
  draw(5, 12, 3, 4, pants);
  draw(8, 12, 3, 4, pants);

  return canvas;
}

/**
 * Loads a real image and draws it onto an offscreen canvas at (up to)
 * MAX_VOXEL_GRID resolution so we can read per-pixel color/alpha. For best
 * results, export your art at its true pixel-art resolution (e.g. 16x16,
 * 32x32) rather than a large upscaled PNG — that guarantees one voxel per
 * intended pixel instead of an approximated downsample.
 */
function loadImageAsPixelCanvas(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const scale = Math.min(1, MAX_VOXEL_GRID / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = url;
  });
}

type Vec3 = [number, number, number];
interface FaceDef { normal: Vec3; corners: Vec3[]; }

// Standard unit-cube face definitions (local -0.5..0.5), CCW winding viewed from outside.
const BOX_FACES: Record<'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz', FaceDef> = {
  px: { normal: [1, 0, 0], corners: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]] },
  nx: { normal: [-1, 0, 0], corners: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]] },
  py: { normal: [0, 1, 0], corners: [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
  ny: { normal: [0, -1, 0], corners: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]] },
  pz: { normal: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
  nz: { normal: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
};

/**
 * Builds the voxel group from a pixel canvas as ONE merged geometry (one
 * draw call per character, regardless of pixel count) with a color baked
 * per vertex instead of a material per block. Internal faces between two
 * touching opaque pixels are skipped since they're never visible — this
 * keeps dense art (e.g. 150x150) fast.
 */
function buildVoxelCharacter(canvas: HTMLCanvasElement, def: CharacterDef): THREE.Group {
  const gridW = canvas.width;
  const gridH = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, gridW, gridH);

  const pixelSize = def.widthMeters / gridW;
  const blockSize = pixelSize * VOXEL_GAP;
  const cullInternalFaces = VOXEL_GAP >= 0.999; // only safe to cull when blocks actually touch

  const isOpaque = (col: number, row: number): boolean => {
    if (col < 0 || col >= gridW || row < 0 || row >= gridH) return false;
    return data[(row * gridW + col) * 4 + 3] >= ALPHA_CUTOFF;
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const addFace = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, face: FaceDef, color: THREE.Color) => {
    const base = positions.length / 3;
    for (const [ox, oy, oz] of face.corners) {
      positions.push(cx + ox * sx, cy + oy * sy, cz + oz * sz);
      normals.push(...face.normal);
      colors.push(color.r, color.g, color.b);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (let row = 0; row < gridH; row++) {
    for (let col = 0; col < gridW; col++) {
      const i = (row * gridW + col) * 4;
      if (data[i + 3] < ALPHA_CUTOFF) continue; // transparent — no voxel, this is the cutout

      const color = new THREE.Color(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      const px = (col - gridW / 2 + 0.5) * pixelSize;
      const py = (gridH / 2 - row - 0.5) * pixelSize; // image rows go top->down, world y goes up
      const sx = blockSize, sy = blockSize, sz = SPRITE_THICKNESS;

      // Front/back are a single layer of depth — always exposed.
      addFace(px, py, 0, sx, sy, sz, BOX_FACES.pz, color);
      addFace(px, py, 0, sx, sy, sz, BOX_FACES.nz, color);

      if (!cullInternalFaces || !isOpaque(col + 1, row)) addFace(px, py, 0, sx, sy, sz, BOX_FACES.px, color);
      if (!cullInternalFaces || !isOpaque(col - 1, row)) addFace(px, py, 0, sx, sy, sz, BOX_FACES.nx, color);
      if (!cullInternalFaces || !isOpaque(col, row - 1)) addFace(px, py, 0, sx, sy, sz, BOX_FACES.py, color);
      if (!cullInternalFaces || !isOpaque(col, row + 1)) addFace(px, py, 0, sx, sy, sz, BOX_FACES.ny, color);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const mesh = new THREE.Mesh(geometry, material);

  const group = new THREE.Group();
  group.add(mesh);
  group.position.set(def.x, def.y, def.z);
  if (def.name) group.name = def.name;
  return group;
}

/**
 * Builds a character sprite, either from the placeholder generator (sync)
 * or from a real image (async — resolves once the file has loaded).
 */
async function createCharacterSprite(def: CharacterDef): Promise<THREE.Group> {
  const canvas = def.imageUrl
    ? await loadImageAsPixelCanvas(def.imageUrl)
    : createPlaceholderCharacterCanvas(def.hue);
  return buildVoxelCharacter(canvas, def);
}

function createTetherLine(def: CharacterDef) {
  const startZ = def.z;
  const endZ = -ROOM_DEPTH;
  const start = new THREE.Vector3(def.x, def.y, startZ);
  const end = new THREE.Vector3(def.x, def.y, endZ);

  const geo = new THREE.BufferGeometry().setFromPoints([start, end]);

  const gridColor = new THREE.Color(0x334466);
  const startT = Math.max(0, Math.abs(startZ) / ROOM_DEPTH);
  const endT = 1.0;
  const startColor = gridColor.clone().lerp(bgColor.clone(), startT);
  const endColor = gridColor.clone().lerp(bgColor.clone(), endT);

  const colors = new Float32Array([
    startColor.r, startColor.g, startColor.b,
    endColor.r, endColor.g, endColor.b,
  ]);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true });
  scene.add(new THREE.Line(geo, mat));
}

// --- Character placement (swap in your own images via imageUrl) ---

// hue is unused once imageUrl is set — it only matters for the placeholder generator,
// left here in case you want to fall back to it (e.g. omit imageUrl temporarily).
const characters: CharacterDef[] = [
  { x: -0.14, y: -0.07, z: -0.02, widthMeters: 0.12, hue: 10, imageUrl: '/characters/1.png', name: 'char-1' },
  { x: 0.15, y: 0.06, z: 0.02, widthMeters: 0.12, hue: 200, imageUrl: '/characters/2.png', name: 'char-2' },
  { x: 0.10, y: -0.09, z: -0.09, widthMeters: 0.13, hue: 45, imageUrl: '/characters/3.png', name: 'char-3' },
  { x: -0.12, y: 0.08, z: -0.15, widthMeters: 0.14, hue: 280, imageUrl: '/characters/4.png', name: 'char-4' },
  { x: 0.02, y: -0.02, z: -0.22, widthMeters: 0.15, hue: 130, imageUrl: '/characters/5.png', name: 'char-5' },
  { x: -0.03, y: 0.05, z: -0.05, widthMeters: 0.12, hue: 320, imageUrl: '/characters/6.png', name: 'char-6' },
];

for (const def of characters) {
  createCharacterSprite(def).then((group) => scene.add(group));
  createTetherLine(def); // sync — doesn't depend on the image loading
}

// --- Lighting ---
// The voxel mesh uses MeshStandardMaterial with vertex colors, so it still
// responds to these lights — that's what gives the block sides a subtle
// shaded look rather than flat, uniform color.

const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const pointLight = new THREE.PointLight(0xffffff, 0.7, 5);
pointLight.position.set(0.2, 0.3, 0.3);
scene.add(pointLight);

// --- HUD elements ---

const eyePosEl = document.getElementById('eye-pos')!;
const statusEl = document.getElementById('status')!;
const startBtn = document.getElementById('start-btn')!;

// --- Parallax engine setup ---

const adapter = new ThreeJSAdapter({ camera, screen });

const engine = new ParallaxEngine({
  adapter,
  tracking: { smoothing: 'one-euro' },
  onTrack: (pos: EyePosition) => {
    eyePosEl.textContent = `x: ${pos.x.toFixed(3)}, y: ${pos.y.toFixed(3)}, z: ${pos.z.toFixed(3)}`;
  },
  onTrackingLost: () => {
    statusEl.textContent = 'face not detected';
  },
  onScreenChange: (s) => {
    gridRoom.updateScreen(s);
  },
});

// --- Start/stop ---

const showDemo = () => { renderer.domElement.style.visibility = 'visible'; };

const panel = new CalibrationPanel({ engine, startCollapsed: true });
const calibration = new CalibrationOverlay({
  engine,
  onDismiss: showDemo,
});
const diagnostics = new DiagnosticOverlay({ engine });

startBtn.addEventListener('click', async () => {
  startBtn.style.display = 'none';
  statusEl.textContent = 'initializing camera...';
  try {
    await engine.start();
    statusEl.textContent = 'tracking';
  } catch (err) {
    statusEl.textContent = `error: ${err instanceof Error ? err.message : err}`;
    startBtn.style.display = 'block';
  }
});

// --- Render loop ---

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

animate();

// --- Resize handler ---

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  engine.updateScreenFromViewport();
  gridRoom.rebuild();
  gridRoom.updateResolution();
});