import { TEX } from './skin';

export type Tool = 'pencil' | 'eraser' | 'eyedropper' | 'fill';

// 2D pixel editor over the source skin canvas. Renders a zoomed view with a
// grid onto a display canvas; edits write straight into the source canvas.
export class SkinEditor {
  readonly source: HTMLCanvasElement;       // 64×64 skin pixels (texture source)
  private sctx: CanvasRenderingContext2D;
  private display: HTMLCanvasElement;
  private dctx: CanvasRenderingContext2D;
  private scale = 8;

  tool: Tool = 'pencil';
  color = '#A97C50';
  showGrid = true;

  private undoStack: ImageData[] = [];
  private undoLimit = 60;

  onChange: () => void = () => {};
  onColorPick: (hex: string) => void = () => {};
  onUse: (hex: string) => void = () => {};   // color aplicado (lápiz/relleno) -> recientes

  constructor(source: HTMLCanvasElement, display: HTMLCanvasElement) {
    this.source = source;
    this.sctx = source.getContext('2d')!;
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

  pushUndo() {
    this.undoStack.push(this.sctx.getImageData(0, 0, TEX, TEX));
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.sctx.putImageData(snap, 0, 0);
    this.onChange();
    this.render();
  }

  paintPixel(x: number, y: number) {
    if (this.tool === 'eyedropper') {
      const d = this.sctx.getImageData(x, y, 1, 1).data;
      if (d[3] === 0) return;
      this.onColorPick(rgbToHex(d[0], d[1], d[2]));
      return;
    }
    if (this.tool === 'eraser') {
      this.sctx.clearRect(x, y, 1, 1);
    } else if (this.tool === 'fill') {
      this.floodFill(x, y);
      this.onUse(this.color);
    } else {
      this.sctx.fillStyle = this.color;
      this.sctx.fillRect(x, y, 1, 1);
      this.onUse(this.color);
    }
    this.onChange();
    this.render();
  }

  private floodFill(x: number, y: number) {
    const img = this.sctx.getImageData(0, 0, TEX, TEX);
    const data = img.data;
    const idx = (px: number, py: number) => (py * TEX + px) * 4;
    const start = idx(x, y);
    const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
    const fill = hexToRgb(this.color);
    if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === 255) return;

    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cy < 0 || cx >= TEX || cy >= TEX) continue;
      const i = idx(cx, cy);
      if (data[i] !== target[0] || data[i + 1] !== target[1] || data[i + 2] !== target[2] || data[i + 3] !== target[3]) continue;
      data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = 255;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    this.sctx.putImageData(img, 0, 0);
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
