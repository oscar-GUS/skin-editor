import * as THREE from 'three';
import { buildParts, TEX, type Faces, type Rect, type PartSpec } from './skin';

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

export type PoseName = 'reposo' | 'andar' | 'correr' | 'saludar' | 'sentado' | 'tpose';

// Rotación [x,y,z] por articulación. Las que no aparecen quedan a 0.
const POSES: Record<PoseName, Partial<Record<string, [number, number, number]>>> = {
  reposo:  {},
  andar:   { rightArm: [0.5, 0, 0],  leftArm: [-0.5, 0, 0], rightLeg: [-0.5, 0, 0], leftLeg: [0.5, 0, 0] },
  correr:  { rightArm: [1.1, 0, 0],  leftArm: [-1.1, 0, 0], rightLeg: [-1.0, 0, 0], leftLeg: [1.0, 0, 0] },
  saludar: { leftArm: [0, 0, 2.6],   rightArm: [0.2, 0, 0] },
  sentado: { rightLeg: [-1.5, 0, 0], leftLeg: [-1.5, 0, 0], rightArm: [-0.25, 0, 0], leftArm: [-0.25, 0, 0] },
  tpose:   { rightArm: [0, 0, -1.5708], leftArm: [0, 0, 1.5708] },
};

// Articulación (hombro/cadera) de cada miembro, en coords de modelo.
function jointFor(name: string, pos: [number, number, number]): [number, number, number] | null {
  if (name === 'rightArm' || name === 'leftArm') return [pos[0], 24, 0]; // hombro
  if (name === 'rightLeg' || name === 'leftLeg') return [pos[0], 12, 0]; // cadera
  return null;
}

export const PART_NAMES = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'] as const;
export type PartName = typeof PART_NAMES[number];

export interface SkinModel {
  group: THREE.Group;
  baseMeshes: THREE.Mesh[];
  setOuterVisible(v: boolean): void;
  setBaseVisible(v: boolean): void;
  setGridVisible(v: boolean): void;
  setPartLayerVisible(name: PartName, layer: 'base' | 'outer', v: boolean): void;
  setPose(name: PoseName): void;
  refreshOuter(): void;          // recalcula qué capas exteriores están vacías
  refreshSelection(): void;      // la textura de selección cambió
  setSelectionVisible(v: boolean): void;  // parpadeo de la selección (marching ants 3D)
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

export function buildSkinModel(texture: THREE.Texture, slim: boolean, source: HTMLCanvasElement, selCanvas: HTMLCanvasElement): SkinModel {
  const group = new THREE.Group();
  const baseMeshes: THREE.Mesh[] = [];
  const pivots: Record<string, THREE.Group> = {};
  const reg: Record<string, {
    base: THREE.Mesh; outer: THREE.Mesh; grid: THREE.Mesh; gridOuter: THREE.Mesh;
    selBase: THREE.Mesh; selOuter: THREE.Mesh; overlay: Faces;
  }> = {};
  // Visibilidad independiente por parte y por capa (interna=base / externa=outer).
  const partBaseVisible:  Record<string, boolean> = {};
  const partOuterVisible: Record<string, boolean> = {};
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  // Base: alpha-tested + doble cara. El difuminado se escribe opaco (mezclado con
  // lo de debajo), así que se ve en el 3D; al borrar (alpha 0) deja hueco real.
  const baseMat = new THREE.MeshStandardMaterial({
    map: texture, roughness: 1, metalness: 0,
    alphaTest: 0.5, side: THREE.DoubleSide,
  });
  // Capa externa: cara frontal sólo (FrontSide) — evita el borde fantasma que
  // creaban las caras traseras vistas a través de las transparentes.
  const outerMat = new THREE.MeshStandardMaterial({
    map: texture, roughness: 1, metalness: 0,
    transparent: true, alphaTest: 0.01, side: THREE.FrontSide, depthWrite: false,
  });
  // Material para caras de la capa exterior SIN contenido: no dibuja nada.
  const hiddenMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const gridMat = new THREE.MeshBasicMaterial({
    map: getGridTexture(), transparent: true, depthWrite: false,
  });
  // Selección: textura naranja (selCanvas) sobre los texeles seleccionados.
  const selTex = new THREE.CanvasTexture(selCanvas);
  selTex.magFilter = THREE.NearestFilter; selTex.minFilter = THREE.NearestFilter;
  selTex.colorSpace = THREE.SRGBColorSpace;
  const selMat = new THREE.MeshBasicMaterial({
    map: selTex, transparent: true, alphaTest: 0.01, depthWrite: false, depthTest: false,
  });
  disposables.push(baseMat, outerMat, hiddenMat, gridMat, selMat);

  for (const part of buildParts(slim)) {
    const [w, h, d] = part.size;

    // Las extremidades cuelgan de un pivote en la articulación para poder posar.
    const joint = jointFor(part.name, part.pos);
    let container: THREE.Object3D = group;
    let local: [number, number, number] = part.pos;
    if (joint) {
      const pivot = new THREE.Group();
      pivot.position.set(joint[0], joint[1], joint[2]);
      group.add(pivot);
      pivots[part.name] = pivot;
      container = pivot;
      local = [part.pos[0] - joint[0], part.pos[1] - joint[1], part.pos[2] - joint[2]];
    }

    const baseGeo = new THREE.BoxGeometry(w, h, d);
    applyUV(baseGeo, part.base);
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.set(...local);
    baseMesh.userData.part = part as PartSpec;
    container.add(baseMesh);
    baseMeshes.push(baseMesh);
    disposables.push(baseGeo);

    const outerGeo = new THREE.BoxGeometry(w + 1, h + 1, d + 1);
    applyUV(outerGeo, part.overlay);
    // Material por cara (6 grupos del box, en orden FACE_ORDER) para poder ocultar
    // individualmente las caras de la capa exterior que no tengan contenido.
    const outerMesh = new THREE.Mesh(outerGeo, FACE_ORDER.map(() => outerMat));
    outerMesh.position.set(...local);
    container.add(outerMesh);
    disposables.push(outerGeo);

    // Cuadrícula interna (UVs de la base) y externa (UVs del overlay).
    const gridGeo = new THREE.BoxGeometry(w + 0.06, h + 0.06, d + 0.06);
    applyUV(gridGeo, part.base);
    const gridMesh = new THREE.Mesh(gridGeo, gridMat);
    gridMesh.position.set(...local); gridMesh.visible = false; gridMesh.renderOrder = 2;
    container.add(gridMesh);
    disposables.push(gridGeo);

    const gridOuterGeo = new THREE.BoxGeometry(w + 1.08, h + 1.08, d + 1.08);
    applyUV(gridOuterGeo, part.overlay);
    const gridOuterMesh = new THREE.Mesh(gridOuterGeo, gridMat);
    gridOuterMesh.position.set(...local); gridOuterMesh.visible = false; gridOuterMesh.renderOrder = 2;
    container.add(gridOuterMesh);
    disposables.push(gridOuterGeo);

    // Selección (interna + externa), un pelín más infladas para quedar por encima.
    const selBaseGeo = new THREE.BoxGeometry(w + 0.12, h + 0.12, d + 0.12);
    applyUV(selBaseGeo, part.base);
    const selBaseMesh = new THREE.Mesh(selBaseGeo, selMat);
    selBaseMesh.position.set(...local); selBaseMesh.visible = false; selBaseMesh.renderOrder = 4;
    container.add(selBaseMesh);
    disposables.push(selBaseGeo);

    const selOuterGeo = new THREE.BoxGeometry(w + 1.14, h + 1.14, d + 1.14);
    applyUV(selOuterGeo, part.overlay);
    const selOuterMesh = new THREE.Mesh(selOuterGeo, selMat);
    selOuterMesh.position.set(...local); selOuterMesh.visible = false; selOuterMesh.renderOrder = 4;
    container.add(selOuterMesh);
    disposables.push(selOuterGeo);

    reg[part.name] = {
      base: baseMesh, outer: outerMesh, grid: gridMesh, gridOuter: gridOuterMesh,
      selBase: selBaseMesh, selOuter: selOuterMesh, overlay: part.overlay,
    };
    partBaseVisible[part.name] = true;
    partOuterVisible[part.name] = true;
  }

  let outerVisible = true;   // global: la capa externa se oculta al trabajar en interna
  let baseVisible = true;    // global: visibilidad de la capa interna
  let gridVisible = false;
  let selVisible = false;    // parpadeo de la selección
  const srcCtx = source.getContext('2d', { willReadFrequently: true })!;

  function rectHasContent(img: ImageData, r: { x: number; y: number; w: number; h: number }): boolean {
    for (let yy = r.y; yy < r.y + r.h; yy++) {
      for (let xx = r.x; xx < r.x + r.w; xx++) {
        if (img.data[(yy * TEX + xx) * 4 + 3] !== 0) return true;
      }
    }
    return false;
  }

  function refreshOuter() {
    const img = srcCtx.getImageData(0, 0, TEX, TEX);
    for (const name in reg) {
      const { outer, gridOuter, overlay } = reg[name];
      const mats = outer.material as THREE.Material[];
      let alguna = false;
      FACE_ORDER.forEach((k, i) => {
        const has = rectHasContent(img, overlay[k]);
        mats[i] = has ? outerMat : hiddenMat;
        if (has) alguna = true;
      });
      outer.visible = partOuterVisible[name] && outerVisible && alguna;
      // La cuadrícula externa es una guía: visible aunque la capa esté vacía (solo líneas).
      gridOuter.visible = gridVisible && partOuterVisible[name] && outerVisible;
      // La interior se oculta mientras se ve la exterior (no solapar dos cuadrículas).
      reg[name].grid.visible = gridVisible && baseVisible && partBaseVisible[name] && !outerVisible;
    }
    refreshSelVisibility();
  }

  function refreshSelVisibility() {
    for (const name in reg) {
      const r = reg[name];
      r.selBase.visible = selVisible && baseVisible && partBaseVisible[name];
      r.selOuter.visible = selVisible && outerVisible && partOuterVisible[name];
    }
  }

  return {
    group,
    baseMeshes,
    setOuterVisible(v: boolean) { outerVisible = v; refreshOuter(); },
    setBaseVisible(v: boolean) {
      baseVisible = v;
      for (const name in reg) {
        reg[name].base.visible = v && partBaseVisible[name];
        reg[name].grid.visible = v && partBaseVisible[name] && gridVisible && !outerVisible;
      }
      refreshSelVisibility();
    },
    setGridVisible(v: boolean) {
      gridVisible = v;
      for (const name in reg) {
        reg[name].grid.visible = v && baseVisible && partBaseVisible[name] && !outerVisible;
      }
      refreshOuter();   // recalcula la cuadrícula externa
    },
    setPartLayerVisible(name: PartName, layer: 'base' | 'outer', v: boolean) {
      if (!(name in reg)) return;
      if (layer === 'base') {
        partBaseVisible[name] = v;
        reg[name].base.visible = v && baseVisible;
        reg[name].grid.visible = v && baseVisible && gridVisible && !outerVisible;
        reg[name].selBase.visible = v && baseVisible && selVisible;
      } else {
        partOuterVisible[name] = v;
        refreshOuter();
      }
    },
    setPose(name: PoseName) {
      const p = POSES[name] ?? {};
      for (const k in pivots) {
        const r = p[k] ?? [0, 0, 0];
        pivots[k].rotation.set(r[0], r[1], r[2]);
      }
    },
    refreshOuter,
    refreshSelection() { selTex.needsUpdate = true; },
    setSelectionVisible(v: boolean) { if (selVisible === v) return; selVisible = v; refreshSelVisibility(); },
    dispose() {
      selTex.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
