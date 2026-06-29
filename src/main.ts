import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TEX, buildParts, type PartSpec, type Rect, type Faces } from './skin';
import { buildSkinModel, type SkinModel, type PoseName, type PartName } from './model';
import { SkinEditor, type Tool, type SelectMode } from './editor';
import { STEVE_SKIN } from './steveSkin';

// ── Source skin canvas (compuesto) + texture ─────────────────────────────────
const source = document.createElement('canvas');
source.width = TEX;
source.height = TEX;
const texture = new THREE.CanvasTexture(source);
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.colorSpace = THREE.SRGBColorSpace;

function blankCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TEX; c.height = TEX;
  return c;
}

// ── 2D editor ────────────────────────────────────────────────────────────────
const editorCanvas = document.getElementById('editor') as HTMLCanvasElement;
const editor = new SkinEditor(source, editorCanvas);

// Modos de fusión (etiqueta visible -> operación de canvas), para pincel y capa.
const BLEND_MODES: { label: string; op: GlobalCompositeOperation }[] = [
  { label: 'Por defecto', op: 'source-over' },
  { label: 'Detrás',      op: 'destination-over' },
  { label: 'Multiplicar', op: 'multiply' },
  { label: 'Añadir',      op: 'lighter' },
  { label: 'Iluminar',    op: 'lighten' },
  { label: 'Oscurecer',   op: 'darken' },
  { label: 'Pantalla',    op: 'screen' },
  { label: 'Cubierta',    op: 'overlay' },
  { label: 'Diferencia',  op: 'difference' },
  { label: 'Color',       op: 'color' },
];
function fillBlendSelect(sel: HTMLSelectElement, value: GlobalCompositeOperation) {
  sel.replaceChildren();
  for (const m of BLEND_MODES) {
    const o = document.createElement('option');
    o.value = m.op; o.textContent = m.label;
    if (m.op === value) o.selected = true;
    sel.appendChild(o);
  }
}

// Recompone el compuesto (source) a partir de las capas visibles, de abajo arriba.
function recomposite() {
  const ctx = source.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, TEX, TEX);
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!l.visible) continue;
    ctx.globalCompositeOperation = i === 0 ? 'source-over' : l.blend;  // la base siempre normal
    ctx.drawImage(l.canvas, 0, 0);
  }
  ctx.globalCompositeOperation = 'source-over';
}

// Tras cualquier cambio en capas/pintura: recompone, sube a 3D y refresca UI.
function commit() {
  recomposite();
  texture.needsUpdate = true;
  model.refreshOuter();
  editor.render();
  scheduleSkinColors();
}

editor.onChange = () => { commit(); };

// Tras cambiar la selección: recalcula el contorno de líneas en el 3D.
function syncSelection() {
  model.setSelectionOutline((x, y) => editor.isSelected(x, y));
}
editor.onSelectionChange = syncSelection;

// ── 3D scene ─────────────────────────────────────────────────────────────────
const viewer = document.getElementById('viewer')!;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 20, 46);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewer.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 0.5); key.position.set(1, 1.4, 1.8); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-1.4, 0.4, -1.2); scene.add(fill);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 16, 0);
controls.enableDamping = true;
controls.minDistance = 24;
controls.maxDistance = 90;
// Izquierdo SOBRE la skin pinta; izquierdo en vacío desplaza (pan); derecho orbita.
// El pan/rotación los gestiona OrbitControls; al pintar bloqueamos su pointerdown.
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
renderer.domElement.style.cursor = 'crosshair';

let slim = false;
let model: SkinModel = buildSkinModel(texture, slim, source);
scene.add(model.group);

function rebuildModel() {
  scene.remove(model.group);
  model.dispose();
  model = buildSkinModel(texture, slim, source);
  model.setBaseVisible(baseVisible);
  model.setOuterVisible(outerVisible);
  model.setGridVisible(gridVisible);
  model.setPose(pose);
  for (const name in partVis) {
    model.setPartLayerVisible(name as PartName, 'base', partVis[name].base);
    model.setPartLayerVisible(name as PartName, 'outer', partVis[name].outer);
  }
  scene.add(model.group);
  syncSelection();
  updateBlockGuides();
}

// Contorno de cada cara (interna/externa) para diferenciar bloques en la textura 2D.
function updateBlockGuides() {
  const guides: { x: number; y: number; w: number; h: number; layer: 'base' | 'overlay' }[] = [];
  for (const part of buildParts(slim)) {
    for (const f of Object.values(part.base) as Rect[]) guides.push({ ...f, layer: 'base' });
    for (const f of Object.values(part.overlay) as Rect[]) guides.push({ ...f, layer: 'overlay' });
  }
  editor.blockGuides = guides;
  editor.render();
}

function resize() {
  const w = viewer.clientWidth, h = viewer.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewer);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  // Selección en 3D: contorno naranja fino y fijo (sin parpadeo).
  model.setSelectionVisible(editor.hasSelection());
  renderer.render(scene, camera);
});

// ── 3D painting (siempre activo, botón izquierdo) ─────────────────────────────
let painting3d = false;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// Cursor de pincel en 3D: anillo naranja sobre la superficie, del tamaño del grosor.
const brushRingGeo = new THREE.RingGeometry(0.4, 0.5, 40);
const brushRingMat = new THREE.MeshBasicMaterial({
  color: 0xF4811F, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false,
});
const brushCursor = new THREE.Mesh(brushRingGeo, brushRingMat);
brushCursor.renderOrder = 10;
brushCursor.visible = false;
scene.add(brushCursor);
// Cursor cuadrado (para el pincel cuadrado), mismo tamaño que el grosor.
const sqGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0),
  new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0),
]);
const brushCursorSq = new THREE.LineLoop(sqGeo, new THREE.LineBasicMaterial({ color: 0xF4811F, depthTest: false }));
brushCursorSq.renderOrder = 10; brushCursorSq.visible = false; brushCursorSq.frustumCulled = false;
scene.add(brushCursorSq);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpNormal = new THREE.Vector3();

// Línea + puntos A/B de previsualización del degradado en el modelo 3D.
const gradLineGeo = new THREE.BufferGeometry();
gradLineGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
const gradLine = new THREE.Line(gradLineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
gradLine.renderOrder = 11; gradLine.visible = false; gradLine.frustumCulled = false;
scene.add(gradLine);
const gradPtA = new THREE.Vector3();
const gradPtB = new THREE.Vector3();
const gradMarkGeo = new THREE.SphereGeometry(0.7, 16, 12);
function makeMark() {
  const m = new THREE.Mesh(gradMarkGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
  m.renderOrder = 12; m.visible = false; m.frustumCulled = false; scene.add(m); return m;
}
const gradMarkA = makeMark(), gradMarkB = makeMark();
function gradStopColors(): [number, number, number] {
  const stops = [...editor.gradStops].sort((a, b) => a.pos - b.pos);
  return [stops[0]?.color ? hexToNum(stops[0].color) : 0xffffff,
          stops[stops.length - 1]?.color ? hexToNum(stops[stops.length - 1].color) : 0xffffff, 0];
}
function hexToNum(hex: string): number { return parseInt(hex.slice(1), 16); }
function setGradLine(a: THREE.Vector3, b: THREE.Vector3) {
  const p = gradLineGeo.attributes.position as THREE.BufferAttribute;
  p.setXYZ(0, a.x, a.y, a.z); p.setXYZ(1, b.x, b.y, b.z); p.needsUpdate = true;
  const [cA, cB] = gradStopColors();
  (gradMarkA.material as THREE.MeshBasicMaterial).color.setHex(cA);
  (gradMarkB.material as THREE.MeshBasicMaterial).color.setHex(cB);
  gradMarkA.position.copy(a); gradMarkB.position.copy(b);
}
function showGradGuides(v: boolean) { gradLine.visible = v; gradMarkA.visible = v; gradMarkB.visible = v; }

let symmetry = false;
let symAxis: 'x' | 'z' = 'x';
const mirrorRc = new THREE.Raycaster();

function normalToFace(n: THREE.Vector3): keyof Faces {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return n.x > 0 ? 'left' : 'right';
  if (ay >= ax && ay >= az) return n.y > 0 ? 'top' : 'bottom';
  return n.z > 0 ? 'front' : 'back';
}

// ¿Se puede pintar/seleccionar esta parte en la capa activa? Permite pintar la capa
// externa aunque la interna esté oculta (raycast sobre la geometría base, siempre presente).
function partPaintable(obj: THREE.Object3D): boolean {
  const part = obj.userData.part as PartSpec | undefined;
  const name = part?.name;
  if (!name) return false;
  return paintLayer === 'outer'
    ? (partVis[name]?.outer ?? true) && outerVisible
    : (partVis[name]?.base ?? true) && baseVisible;
}

function pixelFromRaycaster(rc: THREE.Raycaster): { x: number; y: number } | null {
  const hit = rc.intersectObjects(model.baseMeshes, false).find(h => h.uv && h.face && partPaintable(h.object));
  if (!hit || !hit.uv || !hit.face) return null;
  const fx = hit.uv.x * TEX, fy = (1 - hit.uv.y) * TEX;
  let x = Math.floor(fx), y = Math.floor(fy);
  // En modo externa, remapeamos el píxel base al rectángulo de la capa externa.
  if (paintLayer === 'outer') {
    const part = hit.object.userData.part as PartSpec | undefined;
    if (!part) return null;
    const faceKey = normalToFace(hit.face.normal);
    const base = part.base[faceKey], ov = part.overlay[faceKey];
    x = ov.x + Math.min(base.w - 1, Math.max(0, Math.floor(fx - base.x)));
    y = ov.y + Math.min(base.h - 1, Math.max(0, Math.floor(fy - base.y)));
  }
  if (x < 0 || y < 0 || x >= TEX || y >= TEX) return null;
  return { x, y };
}

function castFromEvent(e: PointerEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
}

function paintFromEvent(e: PointerEvent, shift = false) {
  castFromEvent(e);
  const p = pixelFromRaycaster(raycaster);
  if (p) editor.paintPixel(p.x, p.y, shift);
  // Simetría: refleja el rayo respecto al plano del eje elegido y pinta el otro lado.
  if (symmetry && (editor.tool === 'pencil' || editor.tool === 'eraser')) {
    const mo = raycaster.ray.origin.clone(), md = raycaster.ray.direction.clone();
    if (symAxis === 'x') { mo.x = -mo.x; md.x = -md.x; }
    else { mo.z = -mo.z; md.z = -md.z; }
    mirrorRc.set(mo, md.normalize());
    const pm = pixelFromRaycaster(mirrorRc);
    if (pm) editor.paintPixel(pm.x, pm.y, shift);
  }
}

// ¿El rayo del evento toca la skin visible? (para decidir pintar vs. desplazar)
function hitsSkin(e: PointerEvent): boolean {
  castFromEvent(e);
  return !!pixelFromRaycaster(raycaster);
}

// Coloca el anillo de pincel sobre el punto de la skin, orientado y a tamaño del grosor.
function updateBrushCursor(e: PointerEvent) {
  const showTool = editor.tool === 'pencil' || editor.tool === 'eraser';
  if (!showTool) { brushCursor.visible = false; brushCursorSq.visible = false; return; }
  castFromEvent(e);
  const hit = raycaster.intersectObjects(model.baseMeshes, false).find(h => h.face && partPaintable(h.object));
  if (!hit || !hit.face) { brushCursor.visible = false; brushCursorSq.visible = false; return; }
  tmpNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
  const s = Math.max(1, editor.brushSize);
  // El cursor coincide con la forma del pincel (cuadrado o círculo).
  const cur = editor.brushShape === 'circle' ? brushCursor : brushCursorSq;
  const other = editor.brushShape === 'circle' ? brushCursorSq : brushCursor;
  cur.position.copy(hit.point).addScaledVector(tmpNormal, 0.1);
  cur.quaternion.setFromUnitVectors(Z_AXIS, tmpNormal);
  cur.scale.set(s, s, 1);
  cur.visible = true;
  other.visible = false;
}

// Bbox de una capa (base/overlay) de una parte en el atlas.
function partBBox(part: PartSpec, layer: 'base' | 'overlay'): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of Object.values(part[layer]) as Rect[]) {
    minX = Math.min(minX, f.x); minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.w); maxY = Math.max(maxY, f.y + f.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Localiza la parte/cara/capa del atlas que contiene un píxel de textura.
function hitAtlas(x: number, y: number): { part: PartSpec; layer: 'base' | 'overlay'; faceKey: keyof Faces } | null {
  const inside = (r: Rect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  for (const part of buildParts(slim)) {
    for (const layer of ['base', 'overlay'] as const) {
      const faces = part[layer];
      for (const fk of Object.keys(faces) as (keyof Faces)[]) {
        if (inside(faces[fk])) return { part, layer, faceKey: fk };
      }
    }
  }
  return null;
}

// Selección desde 2D (clic en la textura) para los modos bloque/cara.
editor.onSelectPart = (x, y, mode) => {
  const hit = hitAtlas(x, y);
  if (!hit) return;
  if (mode === 'face') {
    const r = hit.part[hit.layer][hit.faceKey];
    editor.setSelectionRect(r.x, r.y, r.w, r.h);
  } else {   // part
    const r = partBBox(hit.part, hit.layer);
    editor.setSelectionRect(r.x, r.y, r.w, r.h);
  }
};

// Seleccionar en 3D: según el modo activo (bloque/cara/color/contiguo).
function selectFromEvent(e: PointerEvent) {
  castFromEvent(e);
  const hit = raycaster.intersectObjects(model.baseMeshes, false).find(h => h.uv && h.face && partPaintable(h.object));
  if (!hit || !hit.uv || !hit.face) return;
  const part = hit.object.userData.part as PartSpec | undefined;
  if (!part) return;
  const faceKey = normalToFace(hit.face.normal);
  const layer: 'base' | 'overlay' = paintLayer === 'outer' ? 'overlay' : 'base';
  const mode = editor.selectMode;
  if (mode === 'color' || mode === 'colorContiguous') {
    // texel de la CAPA activa (remapea a externa) para coger el color correcto, no el interno
    const p = pixelFromRaycaster(raycaster);
    if (!p) return;
    if (mode === 'color') editor.selectByColor(p.x, p.y);
    else editor.selectContiguous(p.x, p.y);
  }
  else if (mode === 'face') { const r = part[layer][faceKey]; editor.setSelectionRect(r.x, r.y, r.w, r.h); }
  else { const r = partBBox(part, layer); editor.setSelectionRect(r.x, r.y, r.w, r.h); }   // rect/part → bloque
}

// Punto 3D bajo el cursor (sobre la skin), para las guías del degradado.
function hitPoint(e: PointerEvent): THREE.Vector3 | null {
  castFromEvent(e);
  const hit = raycaster.intersectObjects(model.baseMeshes, false).find(h => h.uv && h.face && partPaintable(h.object));
  return hit ? hit.point.clone() : null;
}

// Degradado 3D: arrastre A→B en el espacio de pantalla, proyectado sobre el modelo.
let gradActive = false;
function applyGradient3D() {
  const layer: 'base' | 'overlay' = paintLayer === 'outer' ? 'overlay' : 'base';
  const a = gradPtA.clone().project(camera), b = gradPtB.clone().project(camera);
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby || 1e-6;
  const tmp = new THREE.Vector3();
  const samples: { x: number; y: number; t: number }[] = [];
  model.forEachTexel(layer, (ax, ay, world) => {
    tmp.copy(world).project(camera);
    const t = ((tmp.x - a.x) * abx + (tmp.y - a.y) * aby) / lenSq;
    samples.push({ x: ax, y: ay, t });
  });
  editor.applyGradientSamples(samples);
}

// Rectángulo de selección libre en 3D (marquee de pantalla).
const marquee = document.getElementById('viewer-marquee') as HTMLElement;
let mqActive = false;
let mqStart = { x: 0, y: 0 };
function mqUpdate(e: PointerEvent) {
  const r = renderer.domElement.getBoundingClientRect();
  const x0 = Math.min(mqStart.x, e.clientX) - r.left, y0 = Math.min(mqStart.y, e.clientY) - r.top;
  marquee.style.left = x0 + 'px'; marquee.style.top = y0 + 'px';
  marquee.style.width = Math.abs(e.clientX - mqStart.x) + 'px';
  marquee.style.height = Math.abs(e.clientY - mqStart.y) + 'px';
}
function mqFinish(e: PointerEvent) {
  marquee.hidden = true;
  const r = renderer.domElement.getBoundingClientRect();
  const x0 = Math.min(mqStart.x, e.clientX), y0 = Math.min(mqStart.y, e.clientY);
  const x1 = Math.max(mqStart.x, e.clientX), y1 = Math.max(mqStart.y, e.clientY);
  if (x1 - x0 < 3 && y1 - y0 < 3) return;   // clic simple sin arrastre = no hace nada (ESC borra)
  // Muestrea el rectángulo de pantalla por raycast: solo coge el texel VISIBLE al
  // frente bajo cada punto (oclusión resuelta) y de la capa activa (remapeo externa).
  const w = x1 - x0, h = y1 - y0;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / 6000)));        // ~6000 muestras máx
  const mask = new Uint8Array(TEX * TEX);
  for (let sy = y0; sy <= y1; sy += step) {
    for (let sx = x0; sx <= x1; sx += step) {
      ndc.x = ((sx - r.left) / r.width) * 2 - 1;
      ndc.y = -((sy - r.top) / r.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const p = pixelFromRaycaster(raycaster);
      if (p) mask[p.y * TEX + p.x] = 1;
    }
  }
  editor.applyMaskSelection(mask);
}

// Captura: decidimos pintar/seleccionar/degradar (y bloquear OrbitControls) o dejar orbitar.
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;               // derecho orbita (OrbitControls)
  const tool = editor.tool;
  if (tool === 'select') {
    editor.selOp = e.shiftKey ? 'add' : (e.ctrlKey || e.metaKey) ? 'subtract' : 'replace';
    if (editor.selectMode === 'rect') {     // rectángulo LIBRE por arrastre (no selecciona el bloque)
      mqActive = true; mqStart = { x: e.clientX, y: e.clientY };
      const r = renderer.domElement.getBoundingClientRect();
      marquee.style.left = (e.clientX - r.left) + 'px'; marquee.style.top = (e.clientY - r.top) + 'px';
      marquee.style.width = '0px'; marquee.style.height = '0px'; marquee.hidden = false;
      e.stopImmediatePropagation();
    } else if (hitsSkin(e)) {
      selectFromEvent(e);
      e.stopImmediatePropagation();
    }
    // clic en vacío: no borra (eso es con ESC); deja orbitar/desplazar
    return;
  }
  if (tool === 'gradient') {
    const pt = hitPoint(e);
    if (pt) {
      gradActive = true; gradPtA.copy(pt); gradPtB.copy(pt);
      setGradLine(gradPtA, gradPtB); showGradGuides(true);
      e.stopImmediatePropagation();
    }
    return;
  }
  if (!hitsSkin(e)) return;                 // vacío → desplazar (pan)
  e.stopImmediatePropagation();             // sobre la skin → pintar, sin pan
  if (tool !== 'eyedropper') editor.pushUndo();
  painting3d = tool !== 'eyedropper' && tool !== 'fill';
  paintFromEvent(e, e.shiftKey);
}, true);
renderer.domElement.addEventListener('pointermove', (e) => {
  if (painting3d) paintFromEvent(e);
  if (mqActive) mqUpdate(e);
  if (gradActive) { const pt = hitPoint(e); if (pt) { gradPtB.copy(pt); setGradLine(gradPtA, gradPtB); } }
  updateBrushCursor(e);
});
renderer.domElement.addEventListener('pointerleave', () => { brushCursor.visible = false; brushCursorSq.visible = false; });
window.addEventListener('pointerup', (e) => {
  painting3d = false;
  if (gradActive) { applyGradient3D(); gradActive = false; showGradGuides(false); }
  if (mqActive) { mqFinish(e); mqActive = false; }
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
// Sin menú contextual nativo en el editor (evita "Guardar imagen como…" sobre canvas/iconos).
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Centrar la skin en la vista (por si se desplazó con el pan y se perdió).
document.getElementById('center-cam')!.addEventListener('click', () => {
  controls.target.set(0, 16, 0);
  camera.position.set(0, 20, 46);
  controls.update();
});

// ── UI wiring ────────────────────────────────────────────────────────────────
// Capa de trabajo: 'inner' (base) pinta el cuerpo y oculta la externa para verla;
// 'outer' pinta la capa externa y deja la interna visible debajo.
let paintLayer: 'inner' | 'outer' = 'inner';
let outerVisible = false;          // arranca en interna → externa oculta
let baseVisible = true;            // visibilidad global de la capa interna
let gridVisible = false;
let pose: PoseName = 'reposo';
// Visibilidad por parte y por capa, independiente.
const partVis: Record<string, { base: boolean; outer: boolean }> = {};
for (const n of ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']) partVis[n] = { base: true, outer: true };

// Texeles visibles de la capa activa (partes activadas + capa visible), para limitar
// la selección por color a lo que de verdad se ve (no a regiones internas/ocultas).
function buildVisibleLayerMask(): Uint8Array {
  const m = new Uint8Array(TEX * TEX);
  const which: 'base' | 'overlay' = paintLayer === 'outer' ? 'overlay' : 'base';
  for (const part of buildParts(slim)) {
    const vis = paintLayer === 'outer'
      ? partVis[part.name].outer && outerVisible
      : partVis[part.name].base && baseVisible;
    if (!vis) continue;
    for (const f of Object.values(part[which]) as Rect[]) {
      for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) m[y * TEX + x] = 1;
    }
  }
  return m;
}
editor.colorRestrict = buildVisibleLayerMask;

// Mapa de simetría (texel -> su texel espejo respecto al eje) para el relleno con
// simetría: cada texel se empareja con el de la posición 3D reflejada.
function buildMirrorMap(): Int32Array | null {
  if (!symmetry) return null;
  const which: 'base' | 'overlay' = paintLayer === 'outer' ? 'overlay' : 'base';
  const keyOf = (x: number, y: number, z: number) => `${Math.round(x * 2)}|${Math.round(y * 2)}|${Math.round(z * 2)}`;
  const pos = new Map<string, number>();
  const ent: { idx: number; x: number; y: number; z: number }[] = [];
  model.forEachTexel(which, (ax, ay, world) => {
    const idx = ay * TEX + ax;
    pos.set(keyOf(world.x, world.y, world.z), idx);
    ent.push({ idx, x: world.x, y: world.y, z: world.z });
  });
  const map = new Int32Array(TEX * TEX).fill(-1);
  for (const e of ent) {
    const mx = symAxis === 'x' ? -e.x : e.x, mz = symAxis === 'z' ? -e.z : e.z;
    const m = pos.get(keyOf(mx, e.y, mz));
    if (m !== undefined) map[e.idx] = m;
  }
  return map;
}
editor.fillMirror = buildMirrorMap;

// atajos: deshacer, copiar/pegar selección, quitar selección
const TOOL_KEYS: Record<string, Tool> = { b: 'pencil', e: 'eraser', i: 'eyedropper', r: 'fill', d: 'gradient', a: 'select' };
const SELECT_MODES: SelectMode[] = ['rect', 'colorContiguous', 'color', 'part', 'face'];
window.addEventListener('keydown', (e) => {
  // No interceptar mientras se escribe en un campo.
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && k === 'c') { e.preventDefault(); editor.copySelection(); }
  else if (mod && k === 'x') { e.preventDefault(); editor.cutSelection(); }
  else if (mod && k === 'v') { e.preventDefault(); editor.pasteSelection(); }
  else if (mod) return;                                  // otros Ctrl+ no son atajos nuestros
  else if (k === 'escape') { editor.clearSelection(); }
  else if (k === 'a' && e.shiftKey) {                    // Shift+A: rota el modo de seleccionar
    selectTool('select');
    const i = (SELECT_MODES.indexOf(editor.selectMode) + 1) % SELECT_MODES.length;
    const btn = document.querySelector<HTMLButtonElement>(`#select-modes button[data-selmode="${SELECT_MODES[i]}"]`);
    btn?.click();
  }
  else if (TOOL_KEYS[k] && !e.shiftKey) { selectTool(TOOL_KEYS[k]); }
});

// ── Editor de degradado multi-stop (color + posición + opacidad, estilo Photoshop) ──
{
  const hexToRgba = (hex: string, a: number) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const bar     = document.getElementById('grad-bar')!;
  const colorIn = document.getElementById('grad-stop-color') as HTMLInputElement;
  const posIn   = document.getElementById('grad-stop-pos') as HTMLInputElement;
  const aIn     = document.getElementById('grad-stop-a') as HTMLInputElement;
  const decBtn  = document.getElementById('grad-pos-dec') as HTMLButtonElement;
  const incBtn  = document.getElementById('grad-pos-inc') as HTMLButtonElement;
  const delBtn  = document.getElementById('grad-stop-del') as HTMLButtonElement;
  let sel = 0;
  const stops = () => editor.gradStops;

  function renderGrad() {
    const ss = [...stops()].sort((a, b) => a.pos - b.pos);
    bar.style.background =
      `linear-gradient(to right, ${ss.map(s => `${hexToRgba(s.color, s.a)} ${Math.round(s.pos * 100)}%`).join(', ')}),` +
      `repeating-conic-gradient(#1b1b1e 0% 25%, #212125 0% 50%) 0 0 / 10px 10px`;
    bar.querySelectorAll('.grad-mark').forEach(m => m.remove());
    stops().forEach((s, i) => {
      const m = document.createElement('div');
      m.className = 'grad-mark' + (i === sel ? ' sel' : '');
      m.style.left = (s.pos * 100) + '%';
      m.style.background = s.color;
      m.dataset.idx = String(i);
      bar.appendChild(m);
    });
    const cur = stops()[sel];
    if (cur) {
      colorIn.value = cur.color;
      posIn.value = String(Math.round(cur.pos * 100));
      aIn.value = String(Math.round(cur.a * 100));
    }
    delBtn.disabled = stops().length <= 2;
  }
  const select = (i: number) => { sel = Math.max(0, Math.min(stops().length - 1, i)); renderGrad(); };
  const posFromEvent = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const setPos = (p: number) => { if (stops()[sel]) { stops()[sel].pos = Math.max(0, Math.min(1, p)); renderGrad(); } };

  let dragIdx = -1;
  bar.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('grad-mark')) {
      dragIdx = +t.dataset.idx!;
      select(dragIdx);
    } else {
      stops().push({ color: colorIn.value || '#ffffff', pos: posFromEvent(e), a: 1 });
      select(stops().length - 1);
    }
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', (e) => {
    if (dragIdx < 0) return;
    stops()[dragIdx].pos = posFromEvent(e);
    renderGrad();
  });
  bar.addEventListener('pointerup', () => { dragIdx = -1; });

  colorIn.addEventListener('input', () => { if (stops()[sel]) { stops()[sel].color = colorIn.value; renderGrad(); } });
  aIn.addEventListener('input', () => { if (stops()[sel]) { stops()[sel].a = Math.max(0, Math.min(100, +aIn.value)) / 100; renderGrad(); } });
  posIn.addEventListener('input', () => setPos((+posIn.value || 0) / 100));
  decBtn.addEventListener('click', () => setPos((stops()[sel]?.pos ?? 0) - 0.01));
  incBtn.addEventListener('click', () => setPos((stops()[sel]?.pos ?? 0) + 0.01));
  delBtn.addEventListener('click', () => {
    if (stops().length <= 2) return;
    stops().splice(sel, 1);
    select(Math.min(sel, stops().length - 1));
  });

  renderGrad();
}

// tools — cada herramienta enseña solo las opciones que le aplican.
function showEl(id: string, v: boolean) { const e = document.getElementById(id); if (e) (e as HTMLElement).hidden = !v; }
function updateToolUI(tool: Tool) {
  const brush = tool === 'pencil' || tool === 'eraser';
  showEl('brush-panel', tool !== 'eyedropper' && tool !== 'select');
  showEl('row-size', brush);
  showEl('row-shape', brush);
  showEl('row-feather', brush);
  showEl('row-opacity', tool === 'pencil' || tool === 'eraser' || tool === 'fill' || tool === 'gradient');
  showEl('row-blend', tool === 'pencil' || tool === 'fill');
  showEl('row-toggles', brush || tool === 'fill');   // relleno: bloquear alfa + simetría
  showEl('grad-panel', tool === 'gradient');
  showEl('select-panel', tool === 'select');
}
function selectTool(tool: Tool) {
  document.querySelectorAll<HTMLElement>('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  editor.tool = tool;
  updateToolUI(tool);
}
document.querySelectorAll<HTMLButtonElement>('.tool').forEach(btn => {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool as Tool));
});
updateToolUI(editor.tool);

// Modos de selección + acciones (copiar / pegar / quitar).
document.querySelectorAll<HTMLButtonElement>('#select-modes button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#select-modes button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editor.selectMode = btn.dataset.selmode as SelectMode;
  });
});
document.getElementById('sel-copy')!.addEventListener('click', () => editor.copySelection());
document.getElementById('sel-paste')!.addEventListener('click', () => editor.pasteSelection());
document.getElementById('sel-clear')!.addEventListener('click', () => editor.clearSelection());

// ── Colores recientes (10 slots; el último usado primero) ────────────────────
const RECENTS_MAX = 10;
const recents: string[] = [];
const recentsEl = document.getElementById('recents')!;
function addRecent(hex: string) {
  hex = hex.toLowerCase();
  const i = recents.indexOf(hex);
  if (i !== -1) recents.splice(i, 1);
  recents.unshift(hex);
  if (recents.length > RECENTS_MAX) recents.length = RECENTS_MAX;
  renderRecents();
}
function renderRecents() {
  recentsEl.replaceChildren();
  for (let i = 0; i < RECENTS_MAX; i++) {
    const hex = recents[i];
    const b = document.createElement('button');
    if (hex) {
      b.className = 'recent filled';
      b.style.background = hex;
      b.title = hex;
      b.addEventListener('click', () => setColor(hex, false));
      dragColor(b, () => hex);
    } else {
      b.className = 'recent empty';
      b.disabled = true;
    }
    recentsEl.appendChild(b);
  }
}
renderRecents();

// ── Color (selector de cualquier color) ──────────────────────────────────────
const colorInput = document.getElementById('color') as HTMLInputElement;
function setColor(hex: string, recent = true) {
  hex = hex.toLowerCase();
  editor.color = hex;
  colorInput.value = hex;
  if (recent) addRecent(hex);
}
colorInput.addEventListener('input', () => setColor(colorInput.value));
// Cuentagotas (2D / 3D): toma el color y pasa directo a pincel para pintar.
editor.onColorPick = (hex) => { setColor(hex); selectTool('pencil'); };
editor.onUse = (hex) => addRecent(hex);         // lápiz / relleno

// ── Arrastrar colores: de paletas/recientes/skin al selector, o a la skin ─────
// Soltar un color en la skin = bote de pintura (rellena la selección o toda la skin).
function dragColor(el: HTMLElement, getHex: () => string) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData('text/x-color', getHex());
    e.dataTransfer!.effectAllowed = 'copy';
  });
}
function colorFromDrop(e: DragEvent): string | null {
  const c = e.dataTransfer?.getData('text/x-color');
  if (!c) return null;
  return /^#?[0-9a-f]{6}$/i.test(c) ? (c[0] === '#' ? c.toLowerCase() : '#' + c.toLowerCase()) : null;
}
function dropTarget(el: HTMLElement, onSkin: boolean) {
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/x-color')) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    const hex = colorFromDrop(e);
    if (!hex) return;
    e.preventDefault(); e.stopPropagation();
    setColor(hex);
    if (onSkin) editor.fillArea();   // soltar sobre la skin = rellenar
  });
}
dropTarget(colorInput, false);
dropTarget(editorCanvas, true);
dropTarget(viewer, true);
dragColor(colorInput, () => editor.color);

// swatches base
const PALETTE = ['#A97C50', '#5A3A21', '#3A7E7E', '#3A467E', '#2A2A30', '#E8E8E8',
  '#C0392B', '#27AE60', '#F2AF0D', '#F4811F', '#8E44AD', '#000000'];
const swatches = document.getElementById('swatches')!;
for (const hex of PALETTE) {
  const s = document.createElement('button');
  s.className = 'swatch';
  s.style.background = hex;
  s.addEventListener('click', () => setColor(hex));
  dragColor(s, () => hex);
  swatches.appendChild(s);
}

// grid 2D
const gridChk = document.getElementById('grid') as HTMLInputElement;
gridChk.addEventListener('change', () => { editor.showGrid = gridChk.checked; editor.render(); });

// ── Pincel: grosor, densidad, opacidad, fusión, bloquear alfa, simetría ──────
const brushSizeInput = document.getElementById('brush-size') as HTMLInputElement;
const brushSizeVal = document.getElementById('brush-size-val')!;

// Mini-preview del pincel a la izquierda del slider (tamaño/forma/difuminado reales).
const brushPrev = document.getElementById('brush-preview') as HTMLElement;
const brushPrevCtx = (document.getElementById('brush-preview-cv') as HTMLCanvasElement).getContext('2d')!;
const brushPrevLbl = document.getElementById('brush-preview-lbl')!;
let brushPrevTimer = 0;
function showBrushPreview() {
  editor.drawBrushPreview(brushPrevCtx, 12);
  brushPrevLbl.textContent = editor.brushSize + ' px';
  brushPrev.hidden = false;
  const r = brushSizeInput.getBoundingClientRect();
  brushPrev.style.left = Math.max(8, r.left - brushPrev.offsetWidth - 14) + 'px';
  brushPrev.style.top = (r.top + r.height / 2 - brushPrev.offsetHeight / 2) + 'px';
  clearTimeout(brushPrevTimer);
  brushPrevTimer = window.setTimeout(() => { brushPrev.hidden = true; }, 1200);
}

brushSizeInput.addEventListener('input', () => {
  editor.brushSize = +brushSizeInput.value;
  brushSizeVal.textContent = brushSizeInput.value + ' px';
  showBrushPreview();
});

// forma del pincel (cuadrado / círculo)
document.querySelectorAll<HTMLButtonElement>('#brush-shape button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#brush-shape button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editor.brushShape = btn.dataset.shape as 'square' | 'circle';
    showBrushPreview();
  });
});

const brushDensityInput = document.getElementById('brush-density') as HTMLInputElement;
const brushDensityVal = document.getElementById('brush-density-val')!;
brushDensityInput.addEventListener('input', () => {
  editor.feather = +brushDensityInput.value / 100;   // difuminado
  brushDensityVal.textContent = brushDensityInput.value + '%';
  showBrushPreview();
});

const brushOpacityInput = document.getElementById('brush-opacity') as HTMLInputElement;
const brushOpacityVal = document.getElementById('brush-opacity-val')!;
brushOpacityInput.addEventListener('input', () => {
  editor.brushOpacity = +brushOpacityInput.value / 100;
  brushOpacityVal.textContent = brushOpacityInput.value + '%';
});

const brushBlendSel = document.getElementById('brush-blend') as HTMLSelectElement;
fillBlendSelect(brushBlendSel, 'source-over');
brushBlendSel.addEventListener('change', () => { editor.brushBlend = brushBlendSel.value as GlobalCompositeOperation; });

const lockAlphaChk = document.getElementById('lock-alpha') as HTMLInputElement;
lockAlphaChk.addEventListener('change', () => { editor.lockAlpha = lockAlphaChk.checked; });

const symChk = document.getElementById('symmetry') as HTMLInputElement;
symChk.addEventListener('change', () => { symmetry = symChk.checked; });
document.querySelectorAll<HTMLButtonElement>('#sym-axis button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#sym-axis button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    symAxis = btn.dataset.axis as 'x' | 'z';
  });
});

// ── Capas (estilo Photoshop) ─────────────────────────────────────────────────
interface Layer { id: number; name: string; canvas: HTMLCanvasElement; visible: boolean; blend: GlobalCompositeOperation; }
let layers: Layer[] = [];     // índice 0 = base (abajo); el último = arriba del todo
let activeId = 0;
let nextId = 1;
const baseImage = blankCanvas();   // base "limpia" para resetear

const layersEl = document.getElementById('layers')!;

function activeLayer(): Layer { return layers.find(l => l.id === activeId) ?? layers[0]; }

function setActive(id: number) {
  activeId = id;
  editor.setTarget(activeLayer().canvas);
  renderLayers();
}

function renderLayers() {
  layersEl.replaceChildren();
  // De arriba (último) hacia abajo (base), como Photoshop.
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const isBase = i === 0;
    const row = document.createElement('div');
    row.className = 'layer-row' + (l.id === activeId ? ' active' : '');

    const eye = document.createElement('button');
    eye.className = 'layer-eye' + (l.visible ? '' : ' off');
    eye.title = l.visible ? 'Ocultar' : 'Mostrar';
    eye.textContent = l.visible ? '👁' : '🚫';
    eye.addEventListener('click', (ev) => { ev.stopPropagation(); pushHistory(); l.visible = !l.visible; renderLayers(); commit(); });

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = l.name;

    const up = document.createElement('button');
    up.className = 'layer-mini'; up.textContent = '▲'; up.title = 'Subir';
    up.disabled = i >= layers.length - 1;
    up.addEventListener('click', (ev) => { ev.stopPropagation(); moveLayer(l.id, +1); });

    const down = document.createElement('button');
    down.className = 'layer-mini'; down.textContent = '▼'; down.title = 'Bajar';
    down.disabled = i <= 1;   // no se puede bajar por debajo de la base
    down.addEventListener('click', (ev) => { ev.stopPropagation(); moveLayer(l.id, -1); });

    const del = document.createElement('button');
    del.className = 'layer-mini layer-del'; del.textContent = '🗑'; del.title = 'Eliminar';
    del.disabled = isBase;
    del.addEventListener('click', (ev) => { ev.stopPropagation(); deleteLayer(l.id); });

    row.append(eye, name, up, down, del);
    row.addEventListener('click', () => setActive(l.id));
    layersEl.appendChild(row);

    // Fila de modo de fusión de la capa (la base siempre va normal).
    if (!isBase) {
      const blendSel = document.createElement('select');
      blendSel.className = 'layer-blend';
      fillBlendSelect(blendSel, l.blend);
      blendSel.title = 'Modo de fusión de la capa';
      blendSel.addEventListener('click', (ev) => ev.stopPropagation());
      blendSel.addEventListener('change', () => { pushHistory(); l.blend = blendSel.value as GlobalCompositeOperation; commit(); });
      layersEl.appendChild(blendSel);
    }
  }
}

function addLayer() {
  pushHistory();
  const id = nextId++;
  layers.push({ id, name: `Capa ${id}`, canvas: blankCanvas(), visible: true, blend: 'source-over' });
  setActive(id);
  commit();
}

function deleteLayer(id: number) {
  const i = layers.findIndex(l => l.id === id);
  if (i <= 0) return;                       // la base no se borra
  pushHistory();
  layers.splice(i, 1);
  if (activeId === id) activeId = layers[layers.length - 1].id;
  setActive(activeId);
  commit();
}

function moveLayer(id: number, dir: number) {
  const i = layers.findIndex(l => l.id === id);
  const j = i + dir;
  if (i <= 0 || j <= 0 || j >= layers.length) return;   // la base se queda abajo
  pushHistory();
  [layers[i], layers[j]] = [layers[j], layers[i]];
  renderLayers();
  commit();
}

document.getElementById('layer-add')!.addEventListener('click', addLayer);

// ── Historial global (Ctrl+Z): pintura, capas, selección, etc. ───────────────
interface Snap {
  layers: { id: number; name: string; visible: boolean; blend: GlobalCompositeOperation; data: ImageData }[];
  activeId: number; nextId: number; sel: ReturnType<SkinEditor['getSelState']>;
}
const history: Snap[] = [];
const HIST_MAX = 60;
let restoring = false;
function snapshot(): Snap {
  return {
    layers: layers.map(l => ({ id: l.id, name: l.name, visible: l.visible, blend: l.blend, data: l.canvas.getContext('2d')!.getImageData(0, 0, TEX, TEX) })),
    activeId, nextId, sel: editor.getSelState(),
  };
}
function pushHistory() { if (restoring) return; history.push(snapshot()); if (history.length > HIST_MAX) history.shift(); }
function undo() {
  const s = history.pop();
  if (!s) return;
  restoring = true;
  layers = s.layers.map(ls => {
    const c = blankCanvas();
    c.getContext('2d')!.putImageData(ls.data, 0, 0);
    return { id: ls.id, name: ls.name, canvas: c, visible: ls.visible, blend: ls.blend };
  });
  activeId = s.activeId; nextId = s.nextId;
  editor.setTarget(activeLayer().canvas);
  editor.setSelState(s.sel);
  renderLayers();
  commit();
  restoring = false;
}
editor.onBeforeChange = pushHistory;

// ── Skin base: presets, subir la tuya y resetear ─────────────────────────────
// Fija la imagen base (limpia para resetear) y la pinta en la capa base.
function setBaseSkin(src: CanvasImageSource) {
  const bi = baseImage.getContext('2d')!;
  bi.imageSmoothingEnabled = false;
  bi.clearRect(0, 0, TEX, TEX);
  bi.drawImage(src, 0, 0, TEX, TEX);
  const bl = layers[0].canvas.getContext('2d')!;
  bl.imageSmoothingEnabled = false;
  bl.clearRect(0, 0, TEX, TEX);
  bl.drawImage(baseImage, 0, 0);
  commit();
}

function setSlim(v: boolean) {
  if (slim === v) return;
  slim = v;
  document.querySelectorAll<HTMLButtonElement>('#model-toggle button').forEach(b =>
    b.classList.toggle('active', (b.dataset.model === 'alex') === v));
  rebuildModel();
}

// Resetea: quita las capas de usuario y restaura la base a la skin base actual.
function resetAll() {
  layers = [layers[0]];
  const bl = layers[0].canvas.getContext('2d')!;
  bl.clearRect(0, 0, TEX, TEX);
  bl.drawImage(baseImage, 0, 0);
  setActive(0);
  commit();
}

function applyStevePreset() {
  const img = new Image();
  img.onload = () => { setBaseSkin(img); };
  img.src = STEVE_SKIN;
  setSlim(false);
}

document.querySelectorAll<HTMLButtonElement>('#skin-presets button[data-skin]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#skin-presets button[data-skin]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.skin === 'steve') applyStevePreset();
  });
});
document.getElementById('skin-reset')!.addEventListener('click', resetAll);

// model toggle (ancho de brazos)
document.querySelectorAll<HTMLButtonElement>('#model-toggle button').forEach(btn => {
  btn.addEventListener('click', () => setSlim(btn.dataset.model === 'alex'));
});

// Capa de trabajo (HUD del visor): filas tipo Photoshop con ojo de visibilidad.
// Clic en la fila = elegir capa a pintar (y mostrarla). Clic en el ojo = ver/ocultar.
function setEye(which: 'inner' | 'outer', on: boolean) {
  const eye = document.querySelector(`#layer-toggle .hud-eye[data-eye="${which}"]`);
  if (eye) eye.classList.toggle('off', !on);
}
function setPaintLayer(layer: 'inner' | 'outer') {
  paintLayer = layer;
  document.querySelectorAll<HTMLElement>('#layer-toggle .hud-layer-row').forEach(r =>
    r.classList.toggle('active', r.dataset.layer === layer));
  // Elegir capa a pintar solo activa ESA capa; la visibilidad de la otra no se toca.
  if (layer === 'outer') { outerVisible = true; model.setOuterVisible(true); setEye('outer', true); }
  else { baseVisible = true; model.setBaseVisible(true); setEye('inner', true); }
  syncPartHud();
}
document.querySelectorAll<HTMLElement>('#layer-toggle .hud-layer-row').forEach(row => {
  row.addEventListener('click', () => setPaintLayer(row.dataset.layer as 'inner' | 'outer'));
});
document.querySelectorAll<HTMLButtonElement>('#layer-toggle .hud-eye').forEach(eye => {
  eye.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const which = eye.dataset.eye as 'inner' | 'outer';
    const on = eye.classList.contains('off');   // estaba apagado → encender
    eye.classList.toggle('off', on ? false : true);
    if (which === 'outer') { outerVisible = on; model.setOuterVisible(on); }
    else { baseVisible = on; model.setBaseVisible(on); }
  });
});

// Refleja en la silueta del HUD la visibilidad de la capa activa para cada parte.
function syncPartHud() {
  document.querySelectorAll<SVGElement>('#parts-hud [data-part]').forEach(el => {
    const name = el.dataset.part as PartName;
    const v = paintLayer === 'outer' ? partVis[name].outer : partVis[name].base;
    el.classList.toggle('active', v);
  });
}

// 3D grid
const grid3dChk = document.getElementById('grid3d') as HTMLInputElement;
grid3dChk.addEventListener('change', () => { gridVisible = grid3dChk.checked; model.setGridVisible(gridVisible); });

// Fondo del visor (color o imagen), como en el visor de schematics.
const bgColor = document.getElementById('bg-color') as HTMLInputElement;
const bgImageInput = document.getElementById('bg-image') as HTMLInputElement;
let bgImageUrl: string | null = null;
function clearBgImage() { if (bgImageUrl) { URL.revokeObjectURL(bgImageUrl); bgImageUrl = null; } }
bgColor.addEventListener('input', () => { clearBgImage(); viewer.style.background = bgColor.value; });
document.getElementById('bg-image-btn')!.addEventListener('click', () => bgImageInput.click());
bgImageInput.addEventListener('change', () => {
  const f = bgImageInput.files?.[0];
  if (!f) return;
  clearBgImage();
  bgImageUrl = URL.createObjectURL(f);
  viewer.style.background = `#000 url("${bgImageUrl}") center / cover no-repeat`;
  bgImageInput.value = '';
});
document.getElementById('bg-reset')!.addEventListener('click', () => { clearBgImage(); viewer.style.background = ''; bgColor.value = '#0D0D0F'; });

// poses
const poseSel = document.getElementById('pose') as HTMLSelectElement;
poseSel.addEventListener('change', () => { pose = poseSel.value as PoseName; model.setPose(pose); });

// mostrar/ocultar partes del cuerpo — HUD con silueta de skin (abajo-izquierda)
document.querySelectorAll<SVGElement>('#parts-hud [data-part]').forEach(el => {
  const name = el.dataset.part as PartName;
  el.addEventListener('click', () => {
    const layer: 'base' | 'outer' = paintLayer === 'outer' ? 'outer' : 'base';
    const v = !(layer === 'base' ? partVis[name].base : partVis[name].outer);
    if (layer === 'base') partVis[name].base = v; else partVis[name].outer = v;
    el.classList.toggle('active', v);
    model.setPartLayerVisible(name, layer, v);
  });
});

// ── Colores presentes en la skin ─────────────────────────────────────────────
const skinColorsEl = document.getElementById('skin-colors')!;
let skinColorsTimer = 0;
function scheduleSkinColors() {
  clearTimeout(skinColorsTimer);
  skinColorsTimer = window.setTimeout(updateSkinColors, 120);
}
function updateSkinColors() {
  const img = source.getContext('2d')!.getImageData(0, 0, TEX, TEX).data;
  const seen = new Set<string>();
  const list: string[] = [];
  for (let i = 0; i < img.length; i += 4) {
    if (img[i + 3] === 0) continue;
    const hex = '#' + [img[i], img[i + 1], img[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
    if (seen.has(hex)) continue;
    seen.add(hex);
    list.push(hex);
    if (list.length >= 64) break;
  }
  skinColorsEl.replaceChildren();
  for (const hex of list) {
    const b = document.createElement('button');
    b.className = 'skin-color';
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => setColor(hex));
    dragColor(b, () => hex);
    skinColorsEl.appendChild(b);
  }
}

// ── Importar / exportar ───────────────────────────────────────────────────────
// Importar una skin la pone como skin base (limpia las capas de usuario).
function loadSkin(file: File) {
  const img = new Image();
  img.onload = () => {
    layers = [layers[0]];
    setActive(0);
    setBaseSkin(img);
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
}
const importInput = document.getElementById('import') as HTMLInputElement;
document.getElementById('skin-upload')!.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => {
  const file = importInput.files?.[0];
  if (file) loadSkin(file);
  importInput.value = '';
});

// export — exporta el compuesto (todas las capas aplanadas).
document.getElementById('export-btn')!.addEventListener('click', () => {
  recomposite();
  const a = document.createElement('a');
  a.download = 'skin.png';
  a.href = source.toDataURL('image/png');
  a.click();
});

// ── Imagen de referencia (abajo-derecha) para sacar colores con el cuentagotas ──
const refPanel = document.getElementById('ref-panel')!;
const refCanvas = document.getElementById('ref-canvas') as HTMLCanvasElement;
const refCtx = refCanvas.getContext('2d', { willReadFrequently: true })!;
const importImageInput = document.getElementById('import-image') as HTMLInputElement;

document.getElementById('import-img-btn')!.addEventListener('click', () => importImageInput.click());
importImageInput.addEventListener('change', () => {
  const file = importImageInput.files?.[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const cap = 512; // resolución interna acotada; se muestra escalada por CSS
    const sc = Math.min(1, cap / Math.max(img.width, img.height));
    refCanvas.width = Math.max(1, Math.round(img.width * sc));
    refCanvas.height = Math.max(1, Math.round(img.height * sc));
    refCtx.imageSmoothingEnabled = false;
    refCtx.clearRect(0, 0, refCanvas.width, refCanvas.height);
    refCtx.drawImage(img, 0, 0, refCanvas.width, refCanvas.height);
    refPanel.hidden = false;
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
  importImageInput.value = '';
});
document.getElementById('ref-close')!.addEventListener('click', () => { refPanel.hidden = true; });

// Arrastrar el panel de referencia por su cabecera.
const refHead = refPanel.querySelector('.ref-head') as HTMLElement;
let refDrag: { x: number; y: number; left: number; top: number } | null = null;
refHead.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('#ref-close')) return;
  refDrag = { x: e.clientX, y: e.clientY, left: refPanel.offsetLeft, top: refPanel.offsetTop };
  refPanel.style.right = 'auto';
  refPanel.style.bottom = 'auto';
  refPanel.style.left = refDrag.left + 'px';
  refPanel.style.top = refDrag.top + 'px';
  refHead.setPointerCapture(e.pointerId);
});
refHead.addEventListener('pointermove', (e) => {
  if (!refDrag) return;
  refPanel.style.left = (refDrag.left + e.clientX - refDrag.x) + 'px';
  refPanel.style.top = (refDrag.top + e.clientY - refDrag.y) + 'px';
});
refHead.addEventListener('pointerup', () => { refDrag = null; });

// Clic en la imagen de referencia = cuentagotas (siempre toma el color).
refCanvas.addEventListener('pointerdown', (e) => {
  const rect = refCanvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * refCanvas.width);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * refCanvas.height);
  if (x < 0 || y < 0 || x >= refCanvas.width || y >= refCanvas.height) return;
  const d = refCtx.getImageData(x, y, 1, 1).data;
  if (d[3] === 0) return;
  setColor('#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''));
});

// ── Drag & drop: soltar una skin (imagen) sobre la página la carga ────────────
const dropOverlay = document.getElementById('drop-overlay')!;
let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const file = Array.from(e.dataTransfer?.files ?? []).find(f => f.type.startsWith('image/'));
  if (file) loadSkin(file);
});

// ── Redimensionar columnas laterales (arrastre, responsive con centro mínimo) ─
{
  const layout = document.getElementById('layout')!;
  // minLeft: que entre en una línea el botón de importar imagen de referencia.
  // minRight: ancho suficiente para que la fila de herramientas no oculte la última.
  const minLeft = 250, maxLeft = 480, minRight = 300, maxRight = 520, minCenter = 320;
  const cssVar = (name: string) => parseFloat(getComputedStyle(layout).getPropertyValue(name));
  const drag = (handle: HTMLElement, side: 'left' | 'right') => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = layout.getBoundingClientRect();
        if (side === 'left') {
          const right = cssVar('--right-w') || 320;
          let w = Math.max(minLeft, Math.min(maxLeft, ev.clientX - r.left));
          if (r.width - w - right < minCenter) w = r.width - right - minCenter;
          layout.style.setProperty('--left-w', w + 'px');
        } else {
          const left = cssVar('--left-w') || 300;
          let w = Math.max(minRight, Math.min(maxRight, r.right - ev.clientX));
          if (r.width - w - left < minCenter) w = r.width - left - minCenter;
          layout.style.setProperty('--right-w', w + 'px');
        }
        resize();
      };
      const up = () => {
        handle.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        resize();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  };
  drag(document.getElementById('resize-left') as HTMLElement, 'left');
  drag(document.getElementById('resize-right') as HTMLElement, 'right');
}

// ── Intercambiar la textura 2D con la vista 3D (2D al centro para trabajar) ───
{
  let swapped = false;
  const swapBtn = document.getElementById('swap-views') as HTMLButtonElement;
  const ed2d = document.querySelector('.editor2d-wrap') as HTMLElement;
  const partsHud = document.getElementById('parts-hud') as HTMLElement;
  const colCenter = document.querySelector('.col-center') as HTMLElement;
  swapBtn.addEventListener('click', () => {
    const vParent = viewer.parentNode!, vNext = viewer.nextSibling;
    const eParent = ed2d.parentNode!, eNext = ed2d.nextSibling;
    eParent.insertBefore(viewer, eNext);
    vParent.insertBefore(ed2d, vNext);
    swapped = !swapped;
    document.body.classList.toggle('views-swapped', swapped);
    // El HUD de partes/capas se queda en la esquina inferior-izquierda de la columna central.
    if (swapped) colCenter.appendChild(partsHud); else viewer.appendChild(partsHud);
    swapBtn.textContent = swapped ? '⇆ Vista 3D' : '⇆ Centrar 2D';
    resize();
  });
}

// ── Init: capa base con la skin Steve por defecto ────────────────────────────
layers = [{ id: 0, name: 'Skin base', canvas: blankCanvas(), visible: true, blend: 'source-over' }];
setActive(0);
applyStevePreset();
renderLayers();
updateBlockGuides();
model.setOuterVisible(outerVisible);   // por defecto trabajamos en interna → externa oculta







