import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TEX } from './skin';
import { buildSkinModel, type SkinModel, type PoseName, type PartName } from './model';
import { SkinEditor, type Tool } from './editor';
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

// Recompone el compuesto (source) a partir de las capas visibles, de abajo arriba.
function recomposite() {
  const ctx = source.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, TEX, TEX);
  for (const l of layers) if (l.visible) ctx.drawImage(l.canvas, 0, 0);
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
// Pintar siempre activo: izquierdo pinta, derecho orbita, rueda/medio hace zoom.
controls.enablePan = false;
controls.mouseButtons = { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
renderer.domElement.style.cursor = 'crosshair';

let slim = false;
let model: SkinModel = buildSkinModel(texture, slim, source);
scene.add(model.group);

function rebuildModel() {
  scene.remove(model.group);
  model.dispose();
  model = buildSkinModel(texture, slim, source);
  model.setOuterVisible(outerVisible);
  model.setGridVisible(gridVisible);
  model.setPose(pose);
  for (const name in partVisible) model.setPartVisible(name as PartName, partVisible[name]);
  scene.add(model.group);
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
  renderer.render(scene, camera);
});

// ── 3D painting (siempre activo, botón izquierdo) ─────────────────────────────
let painting3d = false;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function paintFromEvent(e: PointerEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(model.baseMeshes, false)
    .find(h => h.object.visible && h.uv);
  if (!hit || !hit.uv) return;
  const x = Math.floor(hit.uv.x * TEX);
  const y = Math.floor((1 - hit.uv.y) * TEX);
  if (x < 0 || y < 0 || x >= TEX || y >= TEX) return;
  editor.paintPixel(x, y);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;               // izquierdo pinta; derecho orbita
  if (editor.tool !== 'eyedropper') editor.pushUndo();
  painting3d = editor.tool !== 'eyedropper' && editor.tool !== 'fill';
  paintFromEvent(e);
});
renderer.domElement.addEventListener('pointermove', (e) => { if (painting3d) paintFromEvent(e); });
window.addEventListener('pointerup', () => { painting3d = false; });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// ── UI wiring ────────────────────────────────────────────────────────────────
let outerVisible = true;
let gridVisible = false;
let pose: PoseName = 'reposo';
const partVisible: Record<string, boolean> = {};

// undo (Ctrl/Cmd+Z)
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    editor.undo();
  }
});

// tools
document.querySelectorAll<HTMLButtonElement>('.tool').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editor.tool = btn.dataset.tool as Tool;
  });
});

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
editor.onColorPick = (hex) => setColor(hex);   // cuentagotas (2D / 3D)
editor.onUse = (hex) => addRecent(hex);         // lápiz / relleno

// swatches base
const PALETTE = ['#A97C50', '#5A3A21', '#3A7E7E', '#3A467E', '#2A2A30', '#E8E8E8',
  '#C0392B', '#27AE60', '#F2AF0D', '#F4811F', '#8E44AD', '#000000'];
const swatches = document.getElementById('swatches')!;
for (const hex of PALETTE) {
  const s = document.createElement('button');
  s.className = 'swatch';
  s.style.background = hex;
  s.addEventListener('click', () => setColor(hex));
  swatches.appendChild(s);
}

// grid 2D
const gridChk = document.getElementById('grid') as HTMLInputElement;
gridChk.addEventListener('change', () => { editor.showGrid = gridChk.checked; editor.render(); });

// ── Capas (estilo Photoshop) ─────────────────────────────────────────────────
interface Layer { id: number; name: string; canvas: HTMLCanvasElement; visible: boolean; }
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
    eye.addEventListener('click', (ev) => { ev.stopPropagation(); l.visible = !l.visible; renderLayers(); commit(); });

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
  }
}

function addLayer() {
  const id = nextId++;
  layers.push({ id, name: `Capa ${id}`, canvas: blankCanvas(), visible: true });
  setActive(id);
  commit();
}

function deleteLayer(id: number) {
  const i = layers.findIndex(l => l.id === id);
  if (i <= 0) return;                       // la base no se borra
  layers.splice(i, 1);
  if (activeId === id) activeId = layers[layers.length - 1].id;
  setActive(activeId);
  commit();
}

function moveLayer(id: number, dir: number) {
  const i = layers.findIndex(l => l.id === id);
  const j = i + dir;
  if (i <= 0 || j <= 0 || j >= layers.length) return;   // la base se queda abajo
  [layers[i], layers[j]] = [layers[j], layers[i]];
  renderLayers();
  commit();
}

document.getElementById('layer-add')!.addEventListener('click', addLayer);

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

// outer layer (capa exterior del 3D)
const outerChk = document.getElementById('layer-outer') as HTMLInputElement;
outerChk.addEventListener('change', () => { outerVisible = outerChk.checked; model.setOuterVisible(outerVisible); });

// 3D grid
const grid3dChk = document.getElementById('grid3d') as HTMLInputElement;
grid3dChk.addEventListener('change', () => { gridVisible = grid3dChk.checked; model.setGridVisible(gridVisible); });

// poses
const poseSel = document.getElementById('pose') as HTMLSelectElement;
poseSel.addEventListener('change', () => { pose = poseSel.value as PoseName; model.setPose(pose); });

// mostrar/ocultar partes del cuerpo (para pintar interiores, etc.)
document.querySelectorAll<HTMLButtonElement>('#parts button').forEach(btn => {
  const name = btn.dataset.part as PartName;
  partVisible[name] = true;
  btn.addEventListener('click', () => {
    const v = !btn.classList.contains('active');
    btn.classList.toggle('active', v);
    partVisible[name] = v;
    model.setPartVisible(name, v);
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

// ── Init: capa base con la skin Steve por defecto ────────────────────────────
layers = [{ id: 0, name: 'Skin base', canvas: blankCanvas(), visible: true }];
setActive(0);
applyStevePreset();
renderLayers();
