import { TEX } from './skin';

export type Tool = 'pencil' | 'eraser' | 'eyedropper' | 'fill' | 'gradient' | 'select';

// 2D pixel editor. Escribe sobre la CAPA ACTIVA (`target`) y muestra/lee el
// resultado COMPUESTO (`source`, lo que se ve). El cuentagotas saca el color del
// compuesto; lápiz/borrador/relleno actúan solo sobre la capa activa.
export class SkinEditor {
  readonly source: HTMLCanvasElement;       // compuesto (display + cuentagotas)
  private sctx: CanvasRenderingContext2D;
  private target: HTMLCanvasElement;        // capa activa (destino de la pintura)
  private tctx: CanvasRenderingContext2D;
  private display: HTMLCanvasElement;
  private dctx: CanvasRenderingContext2D;
  private scale = 8;

  tool: Tool = 'pencil';
  color = '#A97C50';
  showGrid = true;

  // Pincel
  brushSize = 1;                                   // lado del cuadrado (px)
  feather = 0;                                     // 0..1 difuminado (caída de alfa hacia los bordes)
  brushOpacity = 1;                                // 0..1 alfa del trazo
  brushBlend: GlobalCompositeOperation = 'source-over';
  lockAlpha = false;                               // pintar solo sobre píxeles existentes
  private strokePainted = new Set<number>();       // píxeles ya tocados en el trazo

  // Degradado
  gradColorA = '#A97C50';
  gradColorB = '#3A467E';

  // Selección (zona de trabajo) + portapapeles
  selection: { x: number; y: number; w: number; h: number } | null = null;
  private clipboard: ImageData | null = null;

  // Cursor (para previsualizar el grosor) y arrastre (degradado/selección)
  private hover: { x: number; y: number } | null = null;
  private dragA: { x: number; y: number } | null = null;
  private dragB: { x: number; y: number } | null = null;

  private undoStack: { canvas: HTMLCanvasElement; img: ImageData }[] = [];
  private undoLimit = 60;

  onChange: () => void = () => {};
  onColorPick: (hex: string) => void = () => {};
  onUse: (hex: string) => void = () => {};   // color aplicado (lápiz/relleno) -> recientes

  constructor(source: HTMLCanvasElement, display: HTMLCanvasElement) {
    this.source = source;
    this.sctx = source.getContext('2d')!;
    this.target = source;                    // se sustituye con setTarget()
    this.tctx = this.sctx;
    this.display = display;
    this.dctx = display.getContext('2d')!;
    display.width = TEX * this.scale;
    display.height = TEX * this.scale;

    let painting = false;
    let dragging = false;
    const toTex = (e: PointerEvent) => {
      const rect = display.getBoundingClientRect();
      const x = Math.floor(((e.clientX - rect.left) / rect.width) * TEX);
      const y = Math.floor(((e.clientY - rect.top) / rect.height) * TEX);
      return { x: Math.max(0, Math.min(TEX - 1, x)), y: Math.max(0, Math.min(TEX - 1, y)) };
    };
    const isDrag = () => this.tool === 'gradient' || this.tool === 'select';

    display.addEventListener('pointerdown', (e) => {
      const p = toTex(e);
      display.setPointerCapture(e.pointerId);
      if (isDrag()) {
        dragging = true;
        this.dragA = p; this.dragB = p;
        this.render();
      } else {
        if (this.tool !== 'eyedropper') this.pushUndo();
        painting = this.tool !== 'eyedropper' && this.tool !== 'fill';
        this.paintPixel(p.x, p.y);
      }
    });
    display.addEventListener('pointermove', (e) => {
      const p = toTex(e);
      this.hover = p;
      if (painting) this.paintPixel(p.x, p.y);
      else if (dragging) { this.dragB = p; this.render(); }
      else this.render();   // previsualizar el grosor del pincel
    });
    const finishDrag = () => {
      if (dragging && this.dragA && this.dragB) {
        if (this.tool === 'gradient') this.applyGradient(this.dragA, this.dragB);
        else this.setSelectionFromDrag(this.dragA, this.dragB);
      }
      dragging = false; this.dragA = null; this.dragB = null;
    };
    display.addEventListener('pointerup', () => { painting = false; finishDrag(); });
    display.addEventListener('pointerleave', () => { painting = false; this.hover = null; finishDrag(); this.render(); });

    this.render();
  }

  // Cambia la capa activa sobre la que se pinta.
  setTarget(canvas: HTMLCanvasElement) {
    this.target = canvas;
    this.tctx = canvas.getContext('2d', { willReadFrequently: true })!;
  }

  pushUndo() {
    this.strokePainted.clear();                    // empieza un trazo nuevo
    this.undoStack.push({ canvas: this.target, img: this.tctx.getImageData(0, 0, TEX, TEX) });
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return;
    snap.canvas.getContext('2d')!.putImageData(snap.img, 0, 0);
    this.onChange();
    this.render();
  }

  paintPixel(x: number, y: number) {
    // Degradado y selección se gestionan aparte (por arrastre); aquí no pintan.
    if (this.tool === 'gradient' || this.tool === 'select') return;
    if (this.tool === 'eyedropper') {
      const d = this.sctx.getImageData(x, y, 1, 1).data;   // del compuesto
      if (d[3] === 0) return;
      this.onColorPick(rgbToHex(d[0], d[1], d[2]));
      return;
    }
    if (this.tool === 'fill') {
      this.floodFill(x, y);
      this.onUse(this.color);
    } else {
      this.stamp(x, y);
      if (this.tool !== 'eraser') this.onUse(this.color);
    }
    this.onChange();
    this.render();
  }

  // Sello del pincel sobre la capa activa: tamaño, densidad, opacidad, fusión y
  // bloqueo de alfa. No repinta un pixel ya tocado en el mismo trazo.
  private stamp(cx: number, cy: number) {
    const size = this.brushSize;
    const start = -Math.floor((size - 1) / 2);
    const mid = (size - 1) / 2;             // centro del pincel en coords locales
    const radio = mid + 0.0001;
    const erase = this.tool === 'eraser';
    const ctx = this.tctx;
    ctx.save();
    if (erase) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
    } else {
      ctx.globalCompositeOperation = this.lockAlpha ? 'source-atop' : this.brushBlend;
      ctx.fillStyle = this.color;
    }
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = cx + start + dx, y = cy + start + dy;
        if (x < 0 || y < 0 || x >= TEX || y >= TEX) continue;
        if (!this.inSel(x, y)) continue;           // limitar a la zona seleccionada
        const k = y * TEX + x;
        if (this.strokePainted.has(k)) continue;
        // Difuminado: el alfa cae hacia los bordes del pincel.
        let a = erase ? 1 : this.brushOpacity;
        if (this.feather > 0 && size > 1) {
          const dist = Math.hypot(dx - mid, dy - mid) / radio;          // 0 centro → 1 borde
          a *= Math.max(0, 1 - this.feather * Math.min(1, dist));
        }
        if (a <= 0) continue;
        this.strokePainted.add(k);
        ctx.globalAlpha = a;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.restore();
  }

  // Relleno sobre la capa activa (contigüidad según los píxeles de esa capa).
  private floodFill(x: number, y: number) {
    const img = this.tctx.getImageData(0, 0, TEX, TEX);
    const data = img.data;
    const idx = (px: number, py: number) => (py * TEX + px) * 4;
    const start = idx(x, y);
    const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
    const fill = hexToRgb(this.color);
    const a = Math.round(this.brushOpacity * 255);
    if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === a) return;

    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cy < 0 || cx >= TEX || cy >= TEX) continue;
      if (!this.inSel(cx, cy)) continue;           // el relleno no sale de la selección
      const i = idx(cx, cy);
      if (data[i] !== target[0] || data[i + 1] !== target[1] || data[i + 2] !== target[2] || data[i + 3] !== target[3]) continue;
      data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = a;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    this.tctx.putImageData(img, 0, 0);
  }

  // ¿El píxel está dentro de la selección activa? (sin selección, todo vale)
  private inSel(x: number, y: number): boolean {
    const s = this.selection;
    return !s || (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
  }

  // Degradado lineal de A→B (color A a color B) sobre la capa activa (o la selección).
  private applyGradient(a: { x: number; y: number }, b: { x: number; y: number }) {
    this.pushUndo();
    const ctx = this.tctx;
    const r = this.selection ?? { x: 0, y: 0, w: TEX, h: TEX };
    const g = ctx.createLinearGradient(a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5);
    g.addColorStop(0, this.gradColorA);
    g.addColorStop(1, this.gradColorB);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.globalCompositeOperation = this.lockAlpha ? 'source-atop' : 'source-over';
    ctx.globalAlpha = this.brushOpacity;
    ctx.fillStyle = g;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
    this.onUse(this.gradColorA); this.onUse(this.gradColorB);
    this.onChange(); this.render();
  }

  private setSelectionFromDrag(a: { x: number; y: number }, b: { x: number; y: number }) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x) + 1, h = Math.abs(b.y - a.y) + 1;
    this.selection = (w <= 1 && h <= 1) ? null : { x, y, w, h };   // clic simple = quitar selección
    this.render();
  }

  clearSelection() { this.selection = null; this.render(); }

  // Copia los píxeles de la selección (de la capa activa) al portapapeles.
  copySelection() {
    const s = this.selection;
    if (!s) return;
    this.clipboard = this.tctx.getImageData(s.x, s.y, s.w, s.h);
  }

  // Pega el portapapeles en el origen de la selección actual (o en 0,0).
  pasteSelection() {
    if (!this.clipboard) return;
    const s = this.selection;
    this.pushUndo();
    this.tctx.putImageData(this.clipboard, s ? s.x : 0, s ? s.y : 0);
    this.onChange(); this.render();
  }

  render() {
    const s = this.scale;
    const ctx = this.dctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.display.width, this.display.height);
    // checkerboard for transparency
    const cell = s;
    for (let gy = 0; gy < TEX; gy++) {
      for (let gx = 0; gx < TEX; gx++) {
        ctx.fillStyle = (gx + gy) % 2 ? '#1b1b1e' : '#212125';
        ctx.fillRect(gx * cell, gy * cell, cell, cell);
      }
    }
    ctx.drawImage(this.source, 0, 0, this.display.width, this.display.height);

    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= TEX; i++) {
        ctx.moveTo(i * s + 0.5, 0); ctx.lineTo(i * s + 0.5, this.display.height);
        ctx.moveTo(0, i * s + 0.5); ctx.lineTo(this.display.width, i * s + 0.5);
      }
      ctx.stroke();
    }

    // ── Selección (marquee) ──────────────────────────────────────────────────
    if (this.selection) {
      const r = this.selection;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(244,129,31,0.95)';
      ctx.strokeRect(r.x * s + 0.5, r.y * s + 0.5, r.w * s - 1, r.h * s - 1);
      ctx.restore();
    }

    // ── Arrastre en curso (degradado: línea A→B · selección: rectángulo) ─────
    if (this.dragA && this.dragB) {
      const a = this.dragA, b = this.dragB;
      ctx.save();
      if (this.tool === 'gradient') {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo((a.x + 0.5) * s, (a.y + 0.5) * s);
        ctx.lineTo((b.x + 0.5) * s, (b.y + 0.5) * s);
        ctx.stroke();
        for (const [p, col] of [[a, this.gradColorA], [b, this.gradColorB]] as const) {
          ctx.fillStyle = col; ctx.strokeStyle = '#fff';
          ctx.beginPath(); ctx.arc((p.x + 0.5) * s, (p.y + 0.5) * s, 4, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        }
      } else {
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x) + 1, h = Math.abs(b.y - a.y) + 1;
        ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(244,129,31,0.95)';
        ctx.strokeRect(x * s + 0.5, y * s + 0.5, w * s - 1, h * s - 1);
      }
      ctx.restore();
    }

    // ── Previsualización del grosor del pincel (cursor) ──────────────────────
    if (this.hover && (this.tool === 'pencil' || this.tool === 'eraser')) {
      const size = this.brushSize;
      const start = -Math.floor((size - 1) / 2);
      const x = (this.hover.x + start), y = (this.hover.y + start);
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.tool === 'eraser' ? 'rgba(255,255,255,0.9)' : 'rgba(244,129,31,0.95)';
      ctx.strokeRect(x * s + 0.5, y * s + 0.5, size * s - 1, size * s - 1);
      ctx.restore();
    }
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
