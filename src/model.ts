import * as THREE from 'three';
import { buildParts, TEX, type Faces, type Rect } from './skin';

// Geometry face order in three.js BoxGeometry groups: px, nx, py, ny, pz, nz.
// We map: +X→left, -X→right, +Y→top, -Y→bottom, +Z→front, -Z→back.
const FACE_ORDER: (keyof Faces)[] = ['left', 'right', 'top', 'bottom', 'front', 'back'];

function setFaceUV(uv: THREE.BufferAttribute, faceIndex: number, r: Rect) {
  const x0 = r.x / TEX;
  const x1 = (r.x + r.w) / TEX;
  const y0 = 1 - r.y / TEX;        // top edge in UV space (v up)
  const y1 = 1 - (r.y + r.h) / TEX; // bottom edge
  const i = faceIndex * 4;
  // BoxGeometry per-face vertex uv order: TL, TR, BL, BR
  uv.setXY(i + 0, x0, y0);
  uv.setXY(i + 1, x1, y0);
  uv.setXY(i + 2, x0, y1);
  uv.setXY(i + 3, x1, y1);
}

function applyUV(geo: THREE.BoxGeometry, faces: Faces) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  FACE_ORDER.forEach((k, fi) => setFaceUV(uv, fi, faces[k]));
  uv.needsUpdate = true;
}

export interface SkinModel {
  group: THREE.Group;
  setOuterVisible(v: boolean): void;
  setGridVisible(v: boolean): void;
  dispose(): void;
}

// Texture with a 1px-per-skin-pixel grid (64×64 cells), used as an overlay so
// the lines line up with the skin pixels on every face.
let gridTextureCache: THREE.Texture | null = null;
function getGridTexture(): THREE.Texture {
  if (gridTextureCache) return gridTextureCache;
  const size = 1024;          // 16 px per skin pixel
  const cell = size / TEX;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= TEX; i++) {
    const p = Math.round(i * cell) + 0.5;
    ctx.moveTo(p, 0); ctx.lineTo(p, size);
    ctx.moveTo(0, p); ctx.lineTo(size, p);
  }
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  gridTextureCache = tex;
  return tex;
}

export function buildSkinModel(texture: THREE.Texture, slim: boolean): SkinModel {
  const group = new THREE.Group();
  const outer: THREE.Mesh[] = [];
  const grid: THREE.Mesh[] = [];
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  const baseMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
  const outerMat = new THREE.MeshStandardMaterial({
    map: texture, roughness: 1, metalness: 0,
    transparent: true, alphaTest: 0.01, side: THREE.DoubleSide, depthWrite: false,
  });
  const gridMat = new THREE.MeshBasicMaterial({
    map: getGridTexture(), transparent: true, depthWrite: false,
  });
  disposables.push(baseMat, outerMat, gridMat);

  for (const part of buildParts(slim)) {
    const [w, h, d] = part.size;

    const baseGeo = new THREE.BoxGeometry(w, h, d);
    applyUV(baseGeo, part.base);
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.set(...part.pos);
    group.add(baseMesh);
    disposables.push(baseGeo);

    const outerGeo = new THREE.BoxGeometry(w + 1, h + 1, d + 1);
    applyUV(outerGeo, part.overlay);
    const outerMesh = new THREE.Mesh(outerGeo, outerMat);
    outerMesh.position.set(...part.pos);
    group.add(outerMesh);
    outer.push(outerMesh);
    disposables.push(outerGeo);

    // grid overlay: same UVs as the base, slightly inflated to avoid z-fighting
    const gridGeo = new THREE.BoxGeometry(w + 0.06, h + 0.06, d + 0.06);
    applyUV(gridGeo, part.base);
    const gridMesh = new THREE.Mesh(gridGeo, gridMat);
    gridMesh.position.set(...part.pos);
    gridMesh.visible = false;
    gridMesh.renderOrder = 2;
    group.add(gridMesh);
    grid.push(gridMesh);
    disposables.push(gridGeo);
  }

  return {
    group,
    setOuterVisible(v: boolean) { outer.forEach(m => (m.visible = v)); },
    setGridVisible(v: boolean) { grid.forEach(m => (m.visible = v)); },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
