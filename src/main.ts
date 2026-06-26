import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TEX } from './skin';
import { buildSkinModel, type SkinModel } from './model';
import { SkinEditor, type Tool } from './editor';
import { STEVE_SKIN } from './steveSkin';

// ── Source skin canvas + texture ─────────────────────────────────────────────
const source = document.createElement('canvas');
source.width = TEX;
source.height = TEX;
const texture = new THREE.CanvasTexture(source);
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.colorSpace = THREE.SRGBColorSpace;

// default skin: classic Steve
const steveImg = new Image();
steveImg.onload = () => {
  const ctx = source.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, TEX, TEX);
  ctx.drawImage(steveImg, 0, 0, TEX, TEX);
  texture.needsUpdate = true;
  editor.render();
};
steveImg.src = STEVE_SKIN;

// ── 2D editor ────────────────────────────────────────────────────────────────
const editorCanvas = document.getElementById('editor') as HTMLCanvasElement;
const editor = new SkinEditor(source, editorCanvas);
editor.onChange = () => { texture.needsUpdate = true; };

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

let slim = false;
let model: SkinModel = buildSkinModel(texture, slim);
scene.add(model.group);

function rebuildModel() {
  scene.remove(model.group);
  model.dispose();
  model = buildSkinModel(texture, slim);
  model.setOuterVisible(outerVisible);
  model.setGridVisible(gridVisible);
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

// ── 3D painting ──────────────────────────────────────────────────────────────
let paint3d = false;
let painting3d = false;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function paintFromEvent(e: PointerEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  // Raycaster doesn't skip invisible meshes, so ignore hidden layers explicitly
  // and take the nearest visible face.
  const hit = raycaster.intersectObjects(model.group.children, false)
    .find(h => h.object.visible && h.uv);
  if (!hit || !hit.uv) return;
  const x = Math.floor(hit.uv.x * TEX);
  const y = Math.floor((1 - hit.uv.y) * TEX);
  if (x < 0 || y < 0 || x >= TEX || y >= TEX) return;
  editor.paintPixel(x, y);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!paint3d) return;
  if (editor.tool !== 'eyedropper') editor.pushUndo();
  painting3d = editor.tool !== 'eyedropper' && editor.tool !== 'fill';
  paintFromEvent(e);
});
renderer.domElement.addEventListener('pointermove', (e) => { if (paint3d && painting3d) paintFromEvent(e); });
window.addEventListener('pointerup', () => { painting3d = false; });

// ── UI wiring ────────────────────────────────────────────────────────────────
let outerVisible = true;
let gridVisible = false;

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

// color
const colorInput = document.getElementById('color') as HTMLInputElement;
colorInput.addEventListener('input', () => { editor.color = colorInput.value; });
editor.onColorPick = (hex) => { editor.color = hex; colorInput.value = hex; };

// swatches
const PALETTE = ['#A97C50', '#5A3A21', '#3A7E7E', '#3A467E', '#2A2A30', '#E8E8E8',
  '#C0392B', '#27AE60', '#F2AF0D', '#F4811F', '#8E44AD', '#000000'];
const swatches = document.getElementById('swatches')!;
for (const hex of PALETTE) {
  const s = document.createElement('button');
  s.className = 'swatch';
  s.style.background = hex;
  s.addEventListener('click', () => { editor.color = hex; colorInput.value = hex; });
  swatches.appendChild(s);
}

// grid
const gridChk = document.getElementById('grid') as HTMLInputElement;
gridChk.addEventListener('change', () => { editor.showGrid = gridChk.checked; editor.render(); });

// model toggle
document.querySelectorAll<HTMLButtonElement>('#model-toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#model-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    slim = btn.dataset.model === 'alex';
    rebuildModel();
  });
});

// outer layer
const outerChk = document.getElementById('layer-outer') as HTMLInputElement;
outerChk.addEventListener('change', () => { outerVisible = outerChk.checked; model.setOuterVisible(outerVisible); });

// 3D grid
const grid3dChk = document.getElementById('grid3d') as HTMLInputElement;
grid3dChk.addEventListener('change', () => { gridVisible = grid3dChk.checked; model.setGridVisible(gridVisible); });

// paint in 3D
const paint3dChk = document.getElementById('paint3d') as HTMLInputElement;
paint3dChk.addEventListener('change', () => {
  paint3d = paint3dChk.checked;
  controls.enableRotate = !paint3d;
  controls.enablePan = !paint3d;
  renderer.domElement.style.cursor = paint3d ? 'crosshair' : '';
});

// import
const importInput = document.getElementById('import') as HTMLInputElement;
document.getElementById('import-btn')!.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => {
  const file = importInput.files?.[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const ctx = source.getContext('2d')!;
    ctx.clearRect(0, 0, TEX, TEX);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, TEX, TEX);
    texture.needsUpdate = true;
    editor.render();
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
  importInput.value = '';
});

// export
document.getElementById('export-btn')!.addEventListener('click', () => {
  const a = document.createElement('a');
  a.download = 'skin.png';
  a.href = source.toDataURL('image/png');
  a.click();
});
