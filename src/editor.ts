import { TEX } from './skin';

export type Tool = 'pencil' | 'eraser' | 'eyedropper' | 'fill';

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
  brushDensity = 1;                                // 0..1 cobertura (scatter)
  brushOpacity = 1;                                // 0..1 alfa del trazo
  brushBlend: GlobalCompositeOperation = 'source-over';
  lockAlpha = false;                               // pintar solo sobre píxeles existentes
  private strokePainted = new Set<number>();       // píxeles ya tocados en el trazo

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
    const handle = (e: PointerEvent) => {
      const rect = display.getBoundingClientRect();
      const x = Math.floor(((e.clientX - rect.left) / rect.width) * TEX);
      const y = Math.floor(((e.clientY - rect.top) / rect.height) * TEX);
      if (x < 0 || y < 0 || x >= TEX || y >= TEX) return;
      this.paintPixel(x, y);
    };
    display.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'eyedropper') this.pushUndo();
      painting = this.tool !== 'eyedropper' && this.tool !== 'fill';
      display.setPointerCapture(e.pointerId);
      handle(e);
    });
    display.addEventListener('pointermove', (e) => { if (painting) handle(e); });
    display.addEventListener('pointerup', () => { painting = false; });
    display.addEventListener('pointerleave', () => { painting = false; });

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
    const ctx = this.tctx;
    ctx.save();
    if (this.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
    } else {
      ctx.globalCompositeOperation = this.lockAlpha ? 'source-atop' : this.brushBlend;
      ctx.globalAlpha = this.brushOpacity;
      ctx.fillStyle = this.color;
    }
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = cx + start + dx, y = cy + start + dy;
        if (x < 0 || y < 0 || x >= TEX || y >= TEX) continue;
        const k = y * TEX + x;
        if (this.strokePainted.has(k)) continue;
        if (this.brushDensity < 1 && Math.random() > this.brushDensity) continue;
        this.strokePainted.add(k);
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
      const i = idx(cx, cy);
      if (data[i] !== target[0] || data[i + 1] !== target[1] || data[i + 2] !== target[2] || data[i + 3] !== target[3]) continue;
      data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = a;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    this.tctx.putImageData(img, 0, 0);
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
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
