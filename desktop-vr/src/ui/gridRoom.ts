import * as THREE from 'three';
import type { ScreenConfig } from '../projection/types';

export interface GridRoomConfig {
  /** How far back the room extends from the screen plane (z=0), meters. Default: 1.0 */
  depth?: number;
  /** Intensity of the warm pendant light. Tune if the scene looks too dark/bright. Default: 1.2 */
  lightIntensity?: number;
  /** Floating dust particles (strong parallax depth cue). Default: true */
  particles?: boolean;
  /** Object floating IN FRONT of the screen (z > 0). Default: true */
  popOut?: boolean;
  /** Enable shadows (renderer must have shadowMap enabled, see configureRenderer). Default: true */
  shadows?: boolean;
}

function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  repeat = true,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * A lit, textured, furnished room behind the screen. Drop-in replacement for
 * GridRoom: same getGroup / updateScreen / updateResolution / getDepth API,
 * plus update(timeSeconds) for animation and static configureRenderer().
 *
 * Coordinates: screen plane at z=0, room extends to z=-depth, units = meters.
 */
export class GridRoom {
  private group = new THREE.Group();
  private screen: ScreenConfig;
  private depth: number;
  private lightIntensity: number;
  private useParticles: boolean;
  private usePopOut: boolean;
  private shadows: boolean;

  // Base textures (generated once, cloned per mesh for different repeats)
  private texWood: THREE.CanvasTexture;
  private texWall: THREE.CanvasTexture;
  private texRug: THREE.CanvasTexture;
  private texCrate: THREE.CanvasTexture;
  private texArt: THREE.CanvasTexture[];

  // Animated bits
  private popOut: THREE.Group | null = null;
  private particles: THREE.Points | null = null;
  private lamp: THREE.Group | null = null;

  constructor(screen: ScreenConfig, config: GridRoomConfig = {}) {
    this.screen = screen;
    this.depth = config.depth ?? 1.0;
    this.lightIntensity = config.lightIntensity ?? 1.2;
    this.useParticles = config.particles ?? true;
    this.usePopOut = config.popOut ?? true;
    this.shadows = config.shadows ?? true;

    this.texWood = this.makeWood();
    this.texWall = this.makeWall();
    this.texRug = this.makeRug();
    this.texCrate = this.makeCrate();
    this.texArt = [
      this.makeArt(1, ['#1b2a49', '#e76f51', '#f4a261']),
      this.makeArt(2, ['#0b3c49', '#2a9d8f', '#e9c46a']),
      this.makeArt(3, ['#2b193d', '#9d4edd', '#ff9e6d']),
    ];
    this.rebuild();
  }

  /** Call once on your WebGLRenderer so lighting/shadows look right. */
  static configureRenderer(renderer: THREE.WebGLRenderer): void {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
  }

  getGroup(): THREE.Group {
    return this.group;
  }
  getDepth(): number {
    return this.depth;
  }
  updateScreen(screen: ScreenConfig): void {
    this.screen = screen;
    this.rebuild();
  }
  /** Kept for GridRoom API compatibility (no LineMaterial here). */
  updateResolution(): void {}

  /** Call every frame (optional) for the floating object, dust and lamp sway. */
  update(timeSeconds: number): void {
    if (this.popOut) {
      this.popOut.rotation.y = timeSeconds * 0.6;
      this.popOut.rotation.x = Math.sin(timeSeconds * 0.4) * 0.3;
      this.popOut.position.y = this.popOutBaseY + Math.sin(timeSeconds * 0.9) * 0.006;
    }
    if (this.particles) {
      this.particles.position.y = Math.sin(timeSeconds * 0.15) * 0.01;
      this.particles.position.x = Math.cos(timeSeconds * 0.11) * 0.01;
    }
    if (this.lamp) {
      this.lamp.rotation.z = Math.sin(timeSeconds * 0.5) * 0.015;
    }
  }

  dispose(): void {
    this.clearGroup();
    [this.texWood, this.texWall, this.texRug, this.texCrate, ...this.texArt].forEach((t) => t.dispose());
  }

  // ---------------------------------------------------------------- build

  private popOutBaseY = 0;

  private clearGroup(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach((mat) => {
          (mat as THREE.MeshStandardMaterial).map?.dispose();
          mat.dispose();
        });
      }
    });
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    this.popOut = null;
    this.particles = null;
    this.lamp = null;
  }

  rebuild(): void {
    this.clearGroup();
    const { halfW: hW, halfH: hH } = this.computeVisibleRect();
    const d = this.depth;

    this.buildShell(hW, hH, d);
    this.buildFurniture(hW, hH, d);
    this.buildPictures(hW, hH, d);
    this.buildLights(hW, hH, d);
    if (this.useParticles) this.buildParticles(hW, hH, d);
    if (this.usePopOut) this.buildPopOut(hW, hH);
  }

  private tex(base: THREE.CanvasTexture, rx: number, ry: number): THREE.Texture {
    const t = base.clone();
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    return t;
  }

  private add<T extends THREE.Object3D>(obj: T, cast = true, receive = true): T {
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = this.shadows && cast;
        o.receiveShadow = this.shadows && receive;
      }
    });
    this.group.add(obj);
    return obj;
  }

  private buildShell(hW: number, hH: number, d: number): void {
    const std = (map: THREE.Texture, rough = 0.9) =>
      new THREE.MeshStandardMaterial({ map, roughness: rough, metalness: 0 });

    // Floor (wood planks run along depth)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(hW * 2, d),
      std(this.tex(this.texWood, (hW * 2) / 0.6, d / 0.6), 0.55),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -hH, -d / 2);
    this.add(floor, false, true);

    // Ceiling
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(hW * 2, d),
      new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 1 }),
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, hH, -d / 2);
    this.add(ceil, false, true);

    // Side walls (striped wallpaper)
    const mkSide = (sign: 1 | -1) => {
      const w = new THREE.Mesh(
        new THREE.PlaneGeometry(d, hH * 2),
        std(this.tex(this.texWall, d / 0.24, 1)),
      );
      w.rotation.y = sign * (Math.PI / 2);
      w.position.set(-sign * hW, 0, -d / 2);
      this.add(w, false, true);
    };
    mkSide(1); // left, faces right
    mkSide(-1); // right, faces left

    // Back wall
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(hW * 2, hH * 2),
      std(this.tex(this.texWall, (hW * 2) / 0.24, 1)),
    );
    back.position.set(0, 0, -d);
    this.add(back, false, true);

    // Baseboards
    const bh = Math.min(0.04, hH * 0.12);
    const boardMat = new THREE.MeshStandardMaterial({ color: 0xf1ece2, roughness: 0.6 });
    const bb = new THREE.Mesh(new THREE.BoxGeometry(hW * 2, bh, 0.012), boardMat);
    bb.position.set(0, -hH + bh / 2, -d + 0.006);
    this.add(bb);
    for (const s of [-1, 1]) {
      const sb = new THREE.Mesh(new THREE.BoxGeometry(0.012, bh, d), boardMat);
      sb.position.set(s * (hW - 0.006), -hH + bh / 2, -d / 2);
      this.add(sb);
    }
  }

  private buildFurniture(hW: number, hH: number, d: number): void {
    // Rug
    const rugW = Math.min(hW * 1.1, 0.5);
    const rug = new THREE.Mesh(
      new THREE.PlaneGeometry(rugW, d * 0.55),
      new THREE.MeshStandardMaterial({ map: this.tex(this.texRug, 1, 1), roughness: 1 }),
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, -hH + 0.001, -d * 0.5);
    this.add(rug, false, true);

    // Crate (left, mid-depth)
    const c = hH * 0.4;
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(c, c, c),
      new THREE.MeshStandardMaterial({ map: this.tex(this.texCrate, 1, 1), roughness: 0.8 }),
    );
    crate.position.set(-hW * 0.55, -hH + c / 2, -d * 0.35);
    crate.rotation.y = 0.45;
    this.add(crate);

    // Smaller crate stacked on the first
    const c2 = c * 0.55;
    const crate2 = new THREE.Mesh(new THREE.BoxGeometry(c2, c2, c2), crate.material);
    crate2.position.set(-hW * 0.55, -hH + c + c2 / 2, -d * 0.35);
    crate2.rotation.y = -0.2;
    this.add(crate2);

    // Pedestal + glossy sphere (right, deeper)
    const pedH = hH * 0.55;
    const ped = new THREE.Mesh(
      new THREE.CylinderGeometry(hH * 0.13, hH * 0.16, pedH, 32),
      new THREE.MeshStandardMaterial({ color: 0xd9d3c7, roughness: 0.7 }),
    );
    ped.position.set(hW * 0.5, -hH + pedH / 2, -d * 0.55);
    this.add(ped);

    const r = hH * 0.2;
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(r, 48, 32),
      new THREE.MeshStandardMaterial({ color: 0x5b9bd5, roughness: 0.25, metalness: 0.15 }),
    );
    ball.position.set(hW * 0.5, -hH + pedH + r, -d * 0.55);
    this.add(ball);

    // Columns near the back corners (strong depth cue)
    const colMat = new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.75 });
    for (const s of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(hH * 0.09, hH * 0.1, hH * 2, 32), colMat);
      col.position.set(s * hW * 0.82, 0, -d * 0.88);
      this.add(col);
    }
  }

  private buildPictures(hW: number, hH: number, d: number): void {
    const frame = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, rotY: number) => {
      const g = new THREE.Group();
      const f = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.02, h + 0.02, 0.012),
        new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.5 }),
      );
      const art = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }),
      );
      art.position.z = 0.007;
      g.add(f, art);
      g.position.set(x, y, z);
      g.rotation.y = rotY;
      this.add(g, true, false);
    };

    const pw = hH * 0.55;
    const ph = pw * 1.25;
    const clone = (i: number) => this.tex(this.texArt[i], 1, 1);
    frame(clone(0), pw, ph, -hW * 0.35, hH * 0.2, -d + 0.008, 0);
    frame(clone(1), pw, ph, hW * 0.35, hH * 0.2, -d + 0.008, 0);
    frame(clone(2), pw, ph, -hW + 0.008, hH * 0.15, -d * 0.55, Math.PI / 2);
  }

  private buildLights(hW: number, hH: number, d: number): void {
    this.group.add(new THREE.HemisphereLight(0xfff1dd, 0x2a1c10, 0.55));
    this.group.add(new THREE.AmbientLight(0xffffff, 0.18));

    // Hanging pendant lamp = the main (shadow-casting) light
    const lampZ = -d * 0.5;
    const cordLen = hH * 0.55;
    const lamp = new THREE.Group();
    lamp.position.set(0, hH, lampZ); // pivot at ceiling for sway
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0015, 0.0015, cordLen, 6),
      new THREE.MeshBasicMaterial({ color: 0x111111 }),
    );
    cord.position.y = -cordLen / 2;
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(hH * 0.07, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffe2a8 }),
    );
    bulb.position.y = -cordLen;
    const light = new THREE.PointLight(0xffd9a0, this.lightIntensity, 0, 2);
    light.position.y = -cordLen;
    light.castShadow = this.shadows;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.near = 0.02;
    light.shadow.far = d * 3;
    light.shadow.bias = -0.0005;
    lamp.add(cord, bulb, light);
    this.group.add(lamp);
    this.lamp = lamp;

    // Soft fill near the viewer so the front of the room isn't black
    const fill = new THREE.PointLight(0xcfe0ff, this.lightIntensity * 0.35, 0, 2);
    fill.position.set(0, hH * 0.4, 0.3);
    this.group.add(fill);
  }

  private buildParticles(hW: number, hH: number, d: number): void {
    const n = 220;
    const rand = rng(42);
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rand() * 2 - 1) * hW;
      pos[i * 3 + 1] = (rand() * 2 - 1) * hH;
      pos[i * 3 + 2] = -d + rand() * (d + 0.08);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xfff2d0,
        size: 0.004,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    this.group.add(pts);
    this.particles = pts;
  }

  private buildPopOut(hW: number, hH: number): void {
    const r = hH * 0.2;
    const g = new THREE.Group();
    const solid = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r, 0),
      new THREE.MeshStandardMaterial({
        color: 0xffa94d,
        emissive: 0x7a3b00,
        emissiveIntensity: 0.6,
        roughness: 0.3,
        flatShading: true,
      }),
    );
    const wire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r * 1.02, 0),
      new THREE.MeshBasicMaterial({ color: 0xfff1d6, wireframe: true, transparent: true, opacity: 0.5 }),
    );
    g.add(solid, wire);
    // Keep it close enough to feel like it leaves the screen, but well inside
    // the near plane (ThreeJSAdapter default near = 0.05m, eye is ~0.4-0.7m away).
    this.popOutBaseY = -hH * 0.1;
    g.position.set(hW * 0.1, this.popOutBaseY, 0.06);
    this.add(g, true, false);
    this.popOut = g;
  }

  private computeVisibleRect(): { halfW: number; halfH: number } {
    const screenAR = this.screen.widthMeters / this.screen.heightMeters;
    const viewportAR = window.innerWidth / window.innerHeight;
    let halfW = this.screen.widthMeters / 2;
    let halfH = this.screen.heightMeters / 2;
    if (viewportAR > screenAR) halfW *= viewportAR / screenAR;
    else if (viewportAR < screenAR) halfH *= screenAR / viewportAR;
    return { halfW, halfH };
  }

  // ------------------------------------------------------------- textures

  private makeWood(): THREE.CanvasTexture {
    return canvasTexture(512, 512, (ctx, w, h) => {
      const rand = rng(7);
      const planks = 8;
      const pw = w / planks;
      for (let i = 0; i < planks; i++) {
        const l = 28 + rand() * 10;
        ctx.fillStyle = `hsl(${24 + rand() * 6}, 45%, ${l}%)`;
        ctx.fillRect(i * pw, 0, pw, h);
        for (let k = 0; k < 18; k++) {
          ctx.strokeStyle = `rgba(40,20,5,${0.05 + rand() * 0.1})`;
          ctx.lineWidth = 1;
          const x = i * pw + rand() * pw;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + (rand() - 0.5) * 6, h);
          ctx.stroke();
        }
        // staggered plank end seam
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(i * pw, rand() * h, pw, 2);
        ctx.fillRect(i * pw, 0, 2, h);
      }
    });
  }

  private makeWall(): THREE.CanvasTexture {
    return canvasTexture(256, 256, (ctx, w, h) => {
      const rand = rng(3);
      ctx.fillStyle = '#b8a58c';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.07)';
      ctx.fillRect(0, 0, w / 2, h);
      for (let i = 0; i < 2500; i++) {
        ctx.fillStyle = `rgba(${rand() > 0.5 ? '255,255,255' : '0,0,0'},0.03)`;
        ctx.fillRect(rand() * w, rand() * h, 2, 2);
      }
    });
  }

  private makeRug(): THREE.CanvasTexture {
    return canvasTexture(
      256,
      512,
      (ctx, w, h) => {
        ctx.fillStyle = '#7a1f2b';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#e6c88a';
        ctx.lineWidth = 8;
        ctx.strokeRect(14, 14, w - 28, h - 28);
        ctx.lineWidth = 3;
        ctx.strokeRect(30, 30, w - 60, h - 60);
        ctx.fillStyle = '#e6c88a';
        for (let i = 0; i < 5; i++) {
          const cy = 90 + i * 85;
          ctx.beginPath();
          ctx.moveTo(w / 2, cy - 28);
          ctx.lineTo(w / 2 + 28, cy);
          ctx.lineTo(w / 2, cy + 28);
          ctx.lineTo(w / 2 - 28, cy);
          ctx.closePath();
          ctx.fill();
        }
      },
      false,
    );
  }

  private makeCrate(): THREE.CanvasTexture {
    return canvasTexture(
      256,
      256,
      (ctx, w, h) => {
        ctx.fillStyle = '#a87b45';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#5a3a18';
        ctx.lineWidth = 22;
        ctx.strokeRect(11, 11, w - 22, h - 22);
        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(w, h);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 2;
        for (let y = 40; y < h; y += 40) {
          ctx.beginPath();
          ctx.moveTo(22, y);
          ctx.lineTo(w - 22, y);
          ctx.stroke();
        }
      },
      false,
    );
  }

  private makeArt(seed: number, [sky, hill, sun]: string[]): THREE.CanvasTexture {
    return canvasTexture(
      256,
      320,
      (ctx, w, h) => {
        const rand = rng(seed * 11);
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, sky);
        g.addColorStop(1, sun);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = sun;
        ctx.beginPath();
        ctx.arc(w * (0.3 + rand() * 0.4), h * 0.45, 34, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hill;
        for (let k = 0; k < 3; k++) {
          ctx.globalAlpha = 0.5 + k * 0.25;
          ctx.beginPath();
          ctx.moveTo(0, h);
          const base = h * (0.62 + k * 0.1);
          for (let x = 0; x <= w; x += 16) ctx.lineTo(x, base - Math.sin(x * 0.03 + k + seed) * 24 * rand());
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
      false,
    );
  }
}