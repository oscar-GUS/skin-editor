import { TEX } from './skin';

export type Tool = 'pencil' | 'eraser' | 'eyedropper' | 'fill' | 'gradient' | 'select';
// Modos de la herramienta seleccionar.
export type SelectMode = 'rect' | 'colorContiguous' | 'color' | 'part' | 'face';
export interface GradStop { color: string; pos: number; a: number }

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
  selectMode: SelectMode = 'rect';
  color = '#A97C50';
  showGrid = true;
  // Guías de bloque (contorno de cada cara) para diferenciar bloques en la textura 2D.
  blockGuides: { x: number; y: number; w: number; h: number; layer: 'base' | 'overlay' }[] = [];

  // Pincel
  brushSize = 1;                                   // lado del cuadrado/diámetro (px)
  brushShape: 'square' | 'circle' = 'square';      // forma de la punta
  feather = 0;                                     // 0..1 difuminado (anchura del borde suave)
  brushOpacity = 1;                                // 0..1 alfa del trazo
  brushBlend: GlobalCompositeOperation = 'source-over';
  lockAlpha = false;                               // pintar solo sobre píxeles existentes
  private strokePainted = new Set<number>();       // píxeles ya tocados en el trazo
  private lineFrom: { x: number; y: number } | null = null;   // ancla para línea recta (shift)
  private fillTolerance = 32;                       // tolerancia del relleno (suma de canales)
  // Buffer de trazo para el difuminado: cobertura máxima por píxel a lo largo del
  // trazo sostenido, recompuesta desde un snapshot → trazo suave y CONSTANTE.
  private strokeCov: Float32Array | null = null;
  private strokeBase: ImageData | null = null;     // capa activa al empezar el trazo
  private strokeUnder: ImageData | null = null;    // compuesto al empezar el trazo

  // Degradado multi-stop (color + posición 0..1 + opacidad, estilo Photoshop)
  gradStops: GradStop[] = [
    { color: '#A97C50', pos: 0, a: 1 },
    { color: '#3A467E', pos: 1, a: 1 },
  ];

  // Selección: rectángulo simple y/o máscara por píxel (color/contiguo).
  selection: { x: number; y: number; w: number; h: number } | null = null;
  private selMask: Uint8Array | null = null;
  selOp: 'replace' | 'add' | 'subtract' = 'replace';   // shift=sumar, ctrl=restar
  private clipboard: ImageData | null = null;

  // Cursor (para previsualizar el grosor) y arrastre (degradado/selección)
  private hover: { x: number; y: number } | null = null;
  private dragA: { x: number; y: number } | null = null;
  private dragB: { x: number; y: number } | null = null;

  private undoStack: { canvas: HTMLCanvasElement; img: ImageData }[] = [];
  private undoLimit = 60;

  // Marching ants animadas (2D): fase del trazo discontinuo.
  private antPhase = 0;
  private antsRAF = 0;

  onChange: () => void = () => {};
  onColorPick: (hex: string) => void = () => {};
  onUse: (hex: string) => void = () => {};   // color aplicado (lápiz/relleno) -> recientes
  onSelectionChange: () => void = () => {};  // la selección ha cambiado (para el 3D)
  onSelectPart: (x: number, y: number, mode: SelectMode) => void = () => {};  // parte/cara -> main

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

    display.addEventListener('pointerdown', (e) => {
      const p = toTex(e);
      display.setPointerCapture(e.pointerId);
      if (this.tool === 'select') {
        // shift = sumar zona · ctrl/cmd = restar · sin modificador = reemplazar
        this.selOp = e.shiftKey ? 'add' : (e.ctrlKey || e.metaKey) ? 'subtract' : 'replace';
        if (this.selectMode === 'rect') { dragging = true; this.dragA = p; this.dragB = p; this.render(); }
        else if (this.selectMode === 'color') this.selectByColor(p.x, p.y);
        else if (this.selectMode === 'colorContiguous') this.selectContiguous(p.x, p.y);
        else this.onSelectPart(p.x, p.y, this.selectMode);   // part / face los resuelve main (necesita el atlas)
        return;
      }
      if (this.tool === 'gradient') { dragging = true; this.dragA = p; this.dragB = p; this.render(); return; }
      if (this.tool !== 'eyedropper') this.pushUndo();
      painting = this.tool !== 'eyedropper' && this.tool !== 'fill';
      this.paintPixel(p.x, p.y, e.shiftKey);
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
    const snap = this.tctx.getImageData(0, 0, TEX, TEX);
    this.undoStack.push({ canvas: this.target, img: snap });
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
    // ¿Trazo con difuminado en modo normal? → activa el buffer de cobertura.
    if (this.tool === 'pencil' && this.feather > 0 && this.brushSize > 1 &&
        this.brushBlend === 'source-over' && !this.lockAlpha) {
      this.strokeCov = new Float32Array(TEX * TEX);
      this.strokeBase = snap;
      this.strokeUnder = this.sctx.getImageData(0, 0, TEX, TEX);
    } else {
      this.strokeCov = null; this.strokeBase = null; this.strokeUnder = null;
    }
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return;
    snap.canvas.getContext('2d')!.putImageData(snap.img, 0, 0);
    this.onChange();
    this.render();
  }

  paintPixel(x: number, y: number, shift = false) {
    // Degradado y selección se gestionan aparte (por arrastre/clic).
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
      // shift + clic = línea recta desde el último punto pintado.
      if (shift && this.lineFrom) this.strokeLine(this.lineFrom, { x, y });
      else this.stamp(x, y);
      if (this.tool !== 'eraser') this.onUse(this.color);
    }
    this.onChange();
    this.render();
  }

  // Alfa de un píxel del pincel según forma y difuminado. null = fuera de la punta.
  // El difuminado mantiene el centro SÓLIDO y sólo suaviza el borde (anchura=feather).
  private brushAlpha(dx: number, dy: number): number | null {
    const size = this.brushSize;
    if (size <= 1) return 1;
    const half = size / 2;
    const nx = dx + 0.5 - half, ny = dy + 0.5 - half;
    let d: number;
    if (this.brushShape === 'circle') {
      d = Math.hypot(nx, ny) / half;
      if (d > 1) return null;                       // fuera del círculo
    } else {
      d = Math.max(Math.abs(nx), Math.abs(ny)) / half;   // distancia "cuadrada"
    }
    if (this.feather <= 0) return 1;
    const core = Math.pow(1 - this.feather, 1.4);   // radio sólido (encoge rápido al subir difuminado)
    if (d <= core) return 1;
    const t = Math.min(1, Math.max(0, (d - core) / (1 - core)));
    const a = 1 - t * t * (3 - 2 * t);              // caída suave (smoothstep) hacia el borde
    return a <= 0 ? null : a;
  }

  // Sello del pincel sobre la capa activa.
  // El DIFUMINADO mezcla el color del pincel con lo que ya se ve debajo y escribe
  // OPACO (no baja la transparencia), por eso se ve igual en la textura 2D y en el 3D.
  private stamp(cx: number, cy: number) {
    const size = this.brushSize;
    const start = -Math.floor((size - 1) / 2);
    // Trazo con difuminado: acumula cobertura máxima y recompón desde el snapshot.
    if (this.strokeCov) { this.stampStroke(cx, cy); this.lineFrom = { x: cx, y: cy }; return; }
    const erase = this.tool === 'eraser';
    const ctx = this.tctx;
    // ¿Se puede difuminar mezclando con el compuesto? (modo normal, sin borrar)
    const blendFeather = !erase && this.brushBlend === 'source-over';
    let comp: Uint8ClampedArray | null = null;
    let cox = 0, coy = 0, cw = 0;
    if (blendFeather && this.feather > 0 && size > 1) {
      cox = Math.max(0, cx + start); coy = Math.max(0, cy + start);
      const x2 = Math.min(TEX, cx + start + size), y2 = Math.min(TEX, cy + start + size);
      cw = x2 - cox; const ch = y2 - coy;
      if (cw > 0 && ch > 0) comp = this.sctx.getImageData(cox, coy, cw, ch).data;
    }
    const [br, bg, bb] = hexToRgb(this.color);
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
        const fa = this.brushAlpha(dx, dy);
        if (fa === null) continue;
        const a = (erase ? 1 : this.brushOpacity) * fa;
        if (a <= 0) continue;
        this.strokePainted.add(k);
        // Borde difuminado: si hay color visible debajo, mézclalo y escribe opaco.
        if (a < 1 && comp) {
          const ci = ((y - coy) * cw + (x - cox)) * 4;
          if (comp[ci + 3] > 0) {
            const r = Math.round(br * a + comp[ci]     * (1 - a));
            const g = Math.round(bg * a + comp[ci + 1] * (1 - a));
            const b = Math.round(bb * a + comp[ci + 2] * (1 - a));
            ctx.globalAlpha = 1;
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x, y, 1, 1);
            ctx.fillStyle = this.color;
            continue;
          }
        }
        ctx.globalAlpha = a;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.restore();
    this.lineFrom = { x: cx, y: cy };              // ancla para la siguiente línea recta
  }

  // Sello difuminado: acumula la cobertura máxima del pincel (no repinta más flojo)
  // y recompone la capa entera desde el snapshot → trazo suave y uniforme.
  private stampStroke(cx: number, cy: number) {
    const size = this.brushSize;
    const start = -Math.floor((size - 1) / 2);
    const cov = this.strokeCov!;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = cx + start + dx, y = cy + start + dy;
        if (x < 0 || y < 0 || x >= TEX || y >= TEX) continue;
        if (!this.inSel(x, y)) continue;
        const fa = this.brushAlpha(dx, dy);
        if (fa === null) continue;
        const a = this.brushOpacity * fa;
        const k = y * TEX + x;
        if (a > cov[k]) cov[k] = a;                // cobertura máxima
      }
    }
    this.renderStroke();
  }

  // Recompone la capa activa = snapshot + color del pincel mezclado por cobertura.
  private renderStroke() {
    const cov = this.strokeCov!, base = this.strokeBase!, under = this.strokeUnder!;
    const out = this.tctx.createImageData(TEX, TEX);
    out.data.set(base.data);
    const [cr, cg, cb] = hexToRgb(this.color);
    const bd = base.data, ud = under.data, od = out.data;
    for (let k = 0; k < TEX * TEX; k++) {
      const c = cov[k];
      if (c <= 0) continue;
      const i = k * 4;
      // color de fondo a mezclar: lo visible debajo (compuesto) si lo hay, si no la propia capa
      const hasUnder = ud[i + 3] > 0;
      const ur = hasUnder ? ud[i]     : bd[i];
      const ug = hasUnder ? ud[i + 1] : bd[i + 1];
      const ub = hasUnder ? ud[i + 2] : bd[i + 2];
      od[i]     = Math.round(cr * c + ur * (1 - c));
      od[i + 1] = Math.round(cg * c + ug * (1 - c));
      od[i + 2] = Math.round(cb * c + ub * (1 - c));
      // opaco si hay piel debajo (se ve igual en 3D); si no, semitransparente por cobertura
      od[i + 3] = hasUnder ? 255 : Math.max(bd[i + 3], Math.round(c * 255));
    }
    this.tctx.putImageData(out, 0, 0);
  }

  // Línea recta (Bresenham) sellando el pincel a lo largo del recorrido.
  private strokeLine(a: { x: number; y: number }, b: { x: number; y: number }) {
    let x0 = a.x, y0 = a.y;
    const x1 = b.x, y1 = b.y;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.stamp(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  // Relleno sobre la capa activa (contigüidad con tolerancia, para no dejar motas).
  private floodFill(x: number, y: number) {
    const img = this.tctx.getImageData(0, 0, TEX, TEX);
    const data = img.data;
    const idx = (px: number, py: number) => (py * TEX + px) * 4;
    const start = idx(x, y);
    const tr = data[start], tg = data[start + 1], tb = data[start + 2], ta = data[start + 3];
    const fill = hexToRgb(this.color);
    const fa = Math.round(this.brushOpacity * 255);
    const tol = this.fillTolerance;
    const matches = (i: number) =>
      Math.abs(data[i] - tr) + Math.abs(data[i + 1] - tg) +
      Math.abs(data[i + 2] - tb) + Math.abs(data[i + 3] - ta) <= tol;
    if (Math.abs(tr - fill[0]) + Math.abs(tg - fill[1]) + Math.abs(tb - fill[2]) + Math.abs(ta - fa) === 0) return;

    const seen = new Uint8Array(TEX * TEX);
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cy < 0 || cx >= TEX || cy >= TEX) continue;
      const k = cy * TEX + cx;
      if (seen[k]) continue;
      if (!this.inSel(cx, cy)) continue;           // el relleno no sale de la selección
      const i = idx(cx, cy);
      if (!matches(i)) continue;
      seen[k] = 1;
      data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fa;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    this.tctx.putImageData(img, 0, 0);
  }

  // ¿El píxel está dentro de la selección activa? (sin selección, todo vale)
  private inSel(x: number, y: number): boolean {
    if (this.selMask) return x >= 0 && y >= 0 && x < TEX && y < TEX && this.selMask[y * TEX + x] === 1;
    const s = this.selection;
    return !s || (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
  }
  isSelected(x: number, y: number): boolean { return this.inSel(x, y); }
  hasSelection(): boolean { return !!(this.selection || this.selMask); }

  // Dibuja la punta del pincel (forma + difuminado) a tamaño real, `cell` px por píxel.
  drawBrushPreview(ctx: CanvasRenderingContext2D, cell: number) {
    const size = this.brushSize;
    const w = size * cell;
    ctx.canvas.width = w; ctx.canvas.height = w;
    ctx.clearRect(0, 0, w, w);
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const a = this.brushAlpha(dx, dy);
        if (a === null) continue;
        ctx.fillStyle = `rgba(244,129,31,${a})`;
        ctx.fillRect(dx * cell, dy * cell, cell, cell);
      }
    }
  }

  // Aplica el degradado A→B desde fuera (p. ej. arrastrando sobre el modelo 3D).
  applyGradientBetween(a: { x: number; y: number }, b: { x: number; y: number }) { this.applyGradient(a, b); }

  // Degradado lineal multi-stop A→B sobre la capa activa (o la selección).
  private applyGradient(a: { x: number; y: number }, b: { x: number; y: number }) {
    const stops = [...this.gradStops].sort((s1, s2) => s1.pos - s2.pos);
    if (stops.length === 0) return;
    this.pushUndo();
    const ctx = this.tctx;
    const r = this.selection ?? { x: 0, y: 0, w: TEX, h: TEX };
    const g = ctx.createLinearGradient(a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5);
    for (const st of stops) g.addColorStop(Math.max(0, Math.min(1, st.pos)), hexToRgba(st.color, st.a));
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.globalCompositeOperation = this.lockAlpha ? 'source-atop' : 'source-over';
    ctx.globalAlpha = this.brushOpacity;
    ctx.fillStyle = g;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
    for (const st of stops) this.onUse(st.color);
    this.onChange(); this.render();
  }

  // ── Selección ──────────────────────────────────────────────────────────────
  private commitSelection() { this.render(); this.startAnts(); this.onSelectionChange(); }

  // Máscara de la selección actual (rect o máscara) como array; vacía si no hay.
  private currentMask(): Uint8Array {
    const m = new Uint8Array(TEX * TEX);
    if (this.selMask) m.set(this.selMask);
    else if (this.selection) {
      const s = this.selection;
      for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) m[y * TEX + x] = 1;
    }
    return m;
  }

  private rectMask(x: number, y: number, w: number, h: number): Uint8Array {
    const m = new Uint8Array(TEX * TEX);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++)
      if (xx >= 0 && yy >= 0 && xx < TEX && yy < TEX) m[yy * TEX + xx] = 1;
    return m;
  }

  private setSelectionFromDrag(a: { x: number; y: number }, b: { x: number; y: number }) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x) + 1, h = Math.abs(b.y - a.y) + 1;
    if (this.selOp === 'replace') {
      this.selMask = null;
      this.selection = (w <= 1 && h <= 1) ? null : { x, y, w, h };   // clic simple = quitar
      this.commitSelection();
    } else {
      this.setMask(this.rectMask(x, y, w, h));
    }
  }

  clearSelection() { this.selection = null; this.selMask = null; this.stopAnts(); this.render(); this.onSelectionChange(); }

  // Fija la selección a un rectángulo concreto (parte/cara, desde 2D o 3D).
  setSelectionRect(x: number, y: number, w: number, h: number) {
    x = Math.round(x); y = Math.round(y); w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (this.selOp === 'replace') {
      this.selMask = null;
      this.selection = { x, y, w, h };
      this.commitSelection();
    } else {
      this.setMask(this.rectMask(x, y, w, h));
    }
  }

  // Selección por máscara (color/contiguo/rect combinado). Aplica sumar/restar y bbox.
  private setMask(mask: Uint8Array) {
    if (this.selOp !== 'replace') {
      const cur = this.currentMask();
      for (let i = 0; i < mask.length; i++) {
        mask[i] = this.selOp === 'add' ? (mask[i] || cur[i] ? 1 : 0)
                                       : (cur[i] && !mask[i] ? 1 : 0);   // restar
      }
    }
    let minX = TEX, minY = TEX, maxX = -1, maxY = -1, any = false;
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
      if (mask[y * TEX + x]) { any = true; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    }
    if (!any) { this.clearSelection(); return; }
    this.selMask = mask;
    this.selection = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    this.commitSelection();
  }

  // Todos los píxeles del compuesto con exactamente el mismo color.
  selectByColor(x: number, y: number) {
    const img = this.sctx.getImageData(0, 0, TEX, TEX).data;
    const i0 = (y * TEX + x) * 4;
    if (img[i0 + 3] === 0) { if (this.selOp === 'replace') this.clearSelection(); return; }
    const r = img[i0], g = img[i0 + 1], b = img[i0 + 2];
    const mask = new Uint8Array(TEX * TEX);
    for (let k = 0; k < TEX * TEX; k++) {
      const i = k * 4;
      if (img[i + 3] !== 0 && img[i] === r && img[i + 1] === g && img[i + 2] === b) mask[k] = 1;
    }
    this.setMask(mask);
  }

  // Zona contigua del mismo color (flood) en el compuesto.
  selectContiguous(x: number, y: number) {
    const img = this.sctx.getImageData(0, 0, TEX, TEX).data;
    const i0 = (y * TEX + x) * 4;
    const tr = img[i0], tg = img[i0 + 1], tb = img[i0 + 2], ta = img[i0 + 3];
    const mask = new Uint8Array(TEX * TEX);
    const seen = new Uint8Array(TEX * TEX);
    const stack = [[x, y]];
    const match = (i: number) => Math.abs(img[i] - tr) + Math.abs(img[i + 1] - tg) + Math.abs(img[i + 2] - tb) + Math.abs(img[i + 3] - ta) <= 16;
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cy < 0 || cx >= TEX || cy >= TEX) continue;
      const k = cy * TEX + cx;
      if (seen[k]) continue;
      if (!match(k * 4)) continue;
      seen[k] = 1; mask[k] = 1;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    this.setMask(mask);
  }

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

  // Pinta SOLO el borde de la selección (naranja) en un contexto 64×64, para el 3D:
  // un contorno fino sobre los texeles del límite, no un relleno que tape la zona.
  fillSelectionMask(ctx: CanvasRenderingContext2D) {
    ctx.clearRect(0, 0, TEX, TEX);
    if (!this.hasSelection()) return;
    ctx.fillStyle = 'rgba(244,129,31,1)';
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
      if (!this.inSel(x, y)) continue;
      // texel del borde = seleccionado con algún vecino (4-conexo) fuera de la selección
      if (!this.inSel(x - 1, y) || !this.inSel(x + 1, y) || !this.inSel(x, y - 1) || !this.inSel(x, y + 1)) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  // ── Marching ants (2D) ───────────────────────────────────────────────────────
  private startAnts() {
    if (!this.hasSelection()) { this.stopAnts(); return; }
    if (this.antsRAF) return;
    const tick = () => {
      if (!this.hasSelection()) { this.antsRAF = 0; return; }
      this.antPhase = (this.antPhase + 0.6) % 7;
      this.render();
      this.antsRAF = requestAnimationFrame(tick);
    };
    this.antsRAF = requestAnimationFrame(tick);
  }
  private stopAnts() { if (this.antsRAF) { cancelAnimationFrame(this.antsRAF); this.antsRAF = 0; } }

  // Traza el contorno de la selección (rect o máscara) con trazo discontinuo animado.
  private strokeSelection(ctx: CanvasRenderingContext2D, s: number) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineDashOffset = -this.antPhase;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(244,129,31,0.95)';
    if (this.selMask) {
      ctx.beginPath();
      const m = this.selMask;
      const on = (x: number, y: number) => x >= 0 && y >= 0 && x < TEX && y < TEX && m[y * TEX + x] === 1;
      for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
        if (!on(x, y)) continue;
        if (!on(x, y - 1)) { ctx.moveTo(x * s, y * s); ctx.lineTo((x + 1) * s, y * s); }
        if (!on(x, y + 1)) { ctx.moveTo(x * s, (y + 1) * s); ctx.lineTo((x + 1) * s, (y + 1) * s); }
        if (!on(x - 1, y)) { ctx.moveTo(x * s, y * s); ctx.lineTo(x * s, (y + 1) * s); }
        if (!on(x + 1, y)) { ctx.moveTo((x + 1) * s, y * s); ctx.lineTo((x + 1) * s, (y + 1) * s); }
      }
      ctx.stroke();
    } else if (this.selection) {
      const r = this.selection;
      ctx.strokeRect(r.x * s + 0.5, r.y * s + 0.5, r.w * s - 1, r.h * s - 1);
    }
    ctx.restore();
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

    // Guías de bloque: contorno de cada cara (interna en azulado, externa en naranja).
    for (const g of this.blockGuides) {
      ctx.strokeStyle = g.layer === 'overlay' ? 'rgba(244,129,31,0.5)' : 'rgba(90,180,210,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(g.x * s + 0.5, g.y * s + 0.5, g.w * s - 1, g.h * s - 1);
    }

    if (this.hasSelection()) this.strokeSelection(ctx, s);

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
        const sorted = [...this.gradStops].sort((s1, s2) => s1.pos - s2.pos);
        const cA = sorted[0]?.color ?? '#fff', cB = sorted[sorted.length - 1]?.color ?? '#fff';
        for (const [p, col] of [[a, cA], [b, cB]] as const) {
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

    // ── Previsualización del pincel: relleno tenue + contorno del grosor + núcleo sólido ─
    if (this.hover && (this.tool === 'pencil' || this.tool === 'eraser')) {
      const size = this.brushSize;
      const start = -Math.floor((size - 1) / 2);
      const left = (this.hover.x + start) * s, top = (this.hover.y + start) * s, side = size * s;
      const col = this.tool === 'eraser' ? '255,255,255' : '244,129,31';
      ctx.save();
      // celdas reales (footprint) con su alfa
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const fa = this.brushAlpha(dx, dy);
          if (fa === null) continue;
          const x = this.hover.x + start + dx, y = this.hover.y + start + dy;
          if (x < 0 || y < 0 || x >= TEX || y >= TEX) continue;
          ctx.fillStyle = `rgba(${col},${0.35 * fa})`;
          ctx.fillRect(x * s, y * s, s, s);
        }
      }
      // contorno del tamaño del pincel
      ctx.lineWidth = 1.5; ctx.strokeStyle = `rgba(${col},0.95)`;
      if (this.brushShape === 'circle' && size > 1) {
        ctx.beginPath(); ctx.arc(left + side / 2, top + side / 2, side / 2, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeRect(left + 0.5, top + 0.5, side - 1, side - 1);
      }
      // núcleo sólido (donde termina el difuminado)
      if (this.feather > 0 && size > 1) {
        const core = (1 - this.feather);
        const cs = side * core;
        ctx.setLineDash([3, 2]); ctx.strokeStyle = `rgba(${col},0.6)`;
        if (this.brushShape === 'circle') {
          ctx.beginPath(); ctx.arc(left + side / 2, top + side / 2, cs / 2, 0, Math.PI * 2); ctx.stroke();
        } else {
          ctx.strokeRect(left + (side - cs) / 2, top + (side - cs) / 2, cs, cs);
        }
      }
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
function hexToRgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
