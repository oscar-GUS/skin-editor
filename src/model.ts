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
  setSelectionOutline(isSelected: (x: number, y: number) => boolean): void;  // recalcula el contorno de selección
  setSelectionVisible(v: boolean): void;  // muestra/oculta el contorno de selección
  forEachTexel(layer: 'base' | 'overlay', cb: (ax: number, ay: number, world: THREE.Vector3, normal: THREE.Vector3) => void): void;
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

export function buildSkinModel(texture: THREE.Texture, slim: boolean, source: HTMLCanvasElement): SkinModel {
  const group = new THREE.Group();
  const baseMeshes: THREE.Mesh[] = [];
  const pivots: Record<string, THREE.Group> = {};
  const reg: Record<string, {
    base: THREE.Mesh; outer: THREE.Mesh; grid: THREE.Mesh; gridOuter: THREE.Mesh;
    selLines: THREE.LineSegments; baseGeo: THREE.BoxGeometry; outerGeo: THREE.BoxGeometry;
    part: PartSpec; overlay: Faces;
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
  // Capa externa: doble cara (se ve la textura por delante y por detrás de cada píxel),
  // alpha-test alto para bordes nítidos y depthWrite para no ver líneas a través.
  // Capa externa: SÓLIDA (lo pintado se ve opaco, no transparente), doble cara.
  const outerMat = new THREE.MeshStandardMaterial({
    map: texture, roughness: 1, metalness: 0,
    transparent: true, opacity: 1, alphaTest: 0.5, side: THREE.DoubleSide, depthWrite: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  // Material para caras de la capa exterior SIN contenido: no dibuja nada.
  const hiddenMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const gridMat = new THREE.MeshBasicMaterial({
    map: getGridTexture(), transparent: true, depthWrite: false,
  });
  // Selección: contorno con LÍNEAS finas (no relleno), del grosor de un trazo,
  // visible a través del modelo para apreciarse en todas las caras.
  const selMat = new THREE.LineBasicMaterial({ color: 0xF4811F, transparent: true, depthTest: false });
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

    // Selección: contorno de líneas (se rellena en setSelectionOutline).
    const selGeo = new THREE.BufferGeometry();
    const selLines = new THREE.LineSegments(selGeo, selMat);
    selLines.position.set(...local); selLines.visible = false; selLines.renderOrder = 5;
    selLines.frustumCulled = false;
    container.add(selLines);
    disposables.push(selGeo);

    reg[part.name] = {
      base: baseMesh, outer: outerMesh, grid: gridMesh, gridOuter: gridOuterMesh,
      selLines, baseGeo, outerGeo, part: part as PartSpec, overlay: part.overlay,
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
    for (const name in reg) reg[name].selLines.visible = selVisible;
  }

  // Genera las aristas del contorno de selección sobre las caras (texeles del borde),
  // como líneas finas. Cada cara se enmarca por su perímetro → bloque = caja fina.
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpN = new THREE.Vector3();
  const p0 = new THREE.Vector3(), pX = new THREE.Vector3(), pY = new THREE.Vector3();
  function buildOutline(isSelected: (x: number, y: number) => boolean) {
    for (const name in reg) {
      const { selLines, baseGeo, outerGeo, part } = reg[name];
      const verts: number[] = [];
      const addFaces = (geo: THREE.BoxGeometry, faces: Faces) => {
        const pos = geo.attributes.position as THREE.BufferAttribute;
        FACE_ORDER.forEach((fk, fi) => {
          const R = faces[fk];
          p0.fromBufferAttribute(pos, fi * 4 + 0);                 // esquina atlas (R.x, R.y)
          pX.fromBufferAttribute(pos, fi * 4 + 1).sub(p0);         // dirección ancho
          pY.fromBufferAttribute(pos, fi * 4 + 2).sub(p0);         // dirección alto
          tmpN.copy(pX).cross(pY).normalize().multiplyScalar(0.04); // separa de la superficie
          const at = (ci: number, cj: number, out: THREE.Vector3) =>
            out.copy(p0).addScaledVector(pX, ci / R.w).addScaledVector(pY, cj / R.h).add(tmpN);
          const sel = (i: number, j: number) =>
            i >= 0 && j >= 0 && i < R.w && j < R.h && isSelected(R.x + i, R.y + j);
          const seg = (cax: number, cay: number, cbx: number, cby: number) => {
            at(cax, cay, tmpA); at(cbx, cby, tmpB);
            verts.push(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z);
          };
          for (let j = 0; j < R.h; j++) for (let i = 0; i < R.w; i++) {
            if (!sel(i, j)) continue;
            if (!sel(i, j - 1)) seg(i, j, i + 1, j);           // arriba
            if (!sel(i, j + 1)) seg(i, j + 1, i + 1, j + 1);   // abajo
            if (!sel(i - 1, j)) seg(i, j, i, j + 1);           // izquierda
            if (!sel(i + 1, j)) seg(i + 1, j, i + 1, j + 1);   // derecha
          }
        });
      };
      addFaces(baseGeo, part.base);
      addFaces(outerGeo, part.overlay);
      const g = selLines.geometry;
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.computeBoundingSphere();
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
    // Recorre el centro de cada texel de una capa dando su posición en el MUNDO 3D.
    forEachTexel(layer, cb) {
      for (const name in reg) {
        const { base, outer, baseGeo, outerGeo, part } = reg[name];
        const mesh = layer === 'overlay' ? outer : base;
        const geo = layer === 'overlay' ? outerGeo : baseGeo;
        const faces = layer === 'overlay' ? part.overlay : part.base;
        mesh.updateWorldMatrix(true, false);
        const pos = geo.attributes.position as THREE.BufferAttribute;
        FACE_ORDER.forEach((fk, fi) => {
          const R = faces[fk];
          p0.fromBufferAttribute(pos, fi * 4 + 0);
          pX.fromBufferAttribute(pos, fi * 4 + 1).sub(p0);
          pY.fromBufferAttribute(pos, fi * 4 + 2).sub(p0);
          tmpN.copy(pX).cross(pY).normalize().transformDirection(mesh.matrixWorld);  // normal en mundo
          for (let j = 0; j < R.h; j++) for (let i = 0; i < R.w; i++) {
            tmpA.copy(p0).addScaledVector(pX, (i + 0.5) / R.w).addScaledVector(pY, (j + 0.5) / R.h);
            mesh.localToWorld(tmpA);
            cb(R.x + i, R.y + j, tmpA, tmpN);
          }
        });
      }
    },
    setSelectionOutline(isSelected) { buildOutline(isSelected); },
    setSelectionVisible(v: boolean) { if (selVisible === v) return; selVisible = v; refreshSelVisibility(); },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
