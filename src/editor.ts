import { TEX } from './skin';

export type Tool = 'pencil' | 'eraser' | 'eyedropper' | 'fill' | 'gradient' | 'select' | 'move';
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
  // Pegado flotante: se posiciona arrastrando antes de confirmar (Enter / clic fuera).
  private floating: { img: ImageData; canvas: HTMLCanvasElement; x: number; y: number } | null = null;
  private floatGrab: { dx: number; dy: number } | null = null;
  // Herramienta mover: el flotante procede de la propia selección (recorte de la
  // capa activa) y se confirma al soltar, volcándolo sobre la MISMA capa.
  private floatingIsMove = false;
  private moveOrigin = { x: 0, y: 0 };
  private moveApplied = { x: 0, y: 0 };   // desplazamiento de selección ya aplicado durante el arrastre

  // Cursor (para previsualizar el grosor) y arrastre (degradado/selección)
  private hover: { x: number; y: number } | null = null;
  private dragA: { x: number; y: number } | null = null;
  private dragB: { x: number; y: number } | null = null;

  // Marching ants animadas (2D): fase del trazo discontinuo.
  private antPhase = 0;
  private antsRAF = 0;

  onChange: () => void = () => {};
  onColorPick: (hex: string) => void = () => {};
  onUse: (hex: string) => void = () => {};   // color aplicado (lápiz/relleno) -> recientes
  onSelectionChange: () => void = () => {};  // la selección ha cambiado (para el 3D)
  onSelectPart: (x: number, y: number, mode: SelectMode) => void = () => {};  // parte/cara -> main
  // Confirmar pegado: main lo vuelca en una CAPA NUEVA en la posición elegida.
  onPasteCommit: ((img: ImageData, x: number, y: number) => void) | null = null;
  onBeforeChange: () => void = () => {};      // antes de cualquier cambio -> historial global (main)
  // Limita las selecciones por color a los texeles visibles de la capa activa (lo pone main).
  colorRestrict: (() => Uint8Array | null) | null = null;
  // Mapa de simetría (texel -> su texel espejo) para el relleno con simetría (lo pone main).
  fillMirror: (() => Int32Array | null) | null = null;

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
      // Pegado flotante: arrastrar dentro = mover · clic fuera = confirmar posición.
      if (this.floating && !this.floatingIsMove) {
        const f = this.floating;
        const inside = p.x >= f.x && p.x < f.x + f.img.width && p.y >= f.y && p.y < f.y + f.img.height;
        if (inside) { this.floatGrab = { dx: p.x - f.x, dy: p.y - f.y }; display.setPointerCapture(e.pointerId); }
        else this.commitPaste();
        return;
      }
      display.setPointerCapture(e.pointerId);
      // Mover: coge los píxeles seleccionados y los arrastra (confirma al soltar).
      if (this.tool === 'move') {
        if (this.hasSelection() && this.inSel(p.x, p.y)) this.beginMove(p);
        return;
      }
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
      if (this.floating && this.floatGrab) {
        this.setFloatPos(p.x - this.floatGrab.dx, p.y - this.floatGrab.dy);
        return;
      }
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
    display.addEventListener('pointerup', () => {
      if (this.floating) {
        if (this.floatingIsMove) this.commitMove();   // mover: confirma al soltar
        else this.floatGrab = null;
        return;
      }
      painting = false; finishDrag();
    });
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
    this.onBeforeChange();                          // guarda estado para el Ctrl+Z global
    const snap = this.tctx.getImageData(0, 0, TEX, TEX);
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

  // Estado de selección para el historial (guardar/restaurar).
  getSelState(): { selection: { x: number; y: number; w: number; h: number } | null; selMask: Uint8Array | null } {
    return { selection: this.selection ? { ...this.selection } : null, selMask: this.selMask ? this.selMask.slice() : null };
  }
  setSelState(s: { selection: { x: number; y: number; w: number; h: number } | null; selMask: Uint8Array | null }) {
    this.selection = s.selection ? { ...s.selection } : null;
    this.selMask = s.selMask ? s.selMask.slice() : null;
    if (this.hasSelection()) this.startAnts(); else this.stopAnts();
    this.render(); this.onSelectionChange();
  }

  // Corta la selección: copia y borra los píxeles seleccionados de la capa activa.
  cutSelection() {
    if (!this.hasSelection()) return;
    this.copySelection();
    this.onBeforeChange();
    const img = this.tctx.getImageData(0, 0, TEX, TEX);
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
      if (this.inSel(x, y)) { const i = (y * TEX + x) * 4; img.data[i + 3] = 0; }
    }
    this.tctx.putImageData(img, 0, 0);
    this.onChange(); this.render();
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
    if (this.tool === 'fill') { this.fillArea(); return; }   // rellena la selección o toda la skin
    // shift + clic = línea recta desde el último punto pintado.
    if (shift && this.lineFrom) this.strokeLine(this.lineFrom, { x, y });
    else this.stamp(x, y);
    if (this.tool !== 'eraser') this.onUse(this.color);
    this.onChange();
    this.render();
  }

  // Bote de pintura: rellena la SELECCIÓN si la hay; si no, toda la skin (capa activa).
  // Respeta opacidad, modo de fusión y bloqueo de alfa, y aplica simetría si está activa.
  fillArea() {
    this.pushUndo();
    const region = this.hasSelection() ? this.currentMask() : (this.colorRestrict?.() ?? null);
    const mirror = this.fillMirror?.() ?? null;
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = TEX;
    const id = tmp.getContext('2d')!.createImageData(TEX, TEX);
    const [r, g, b] = hexToRgb(this.color);
    const set = (k: number) => { const i = k * 4; id.data[i] = r; id.data[i + 1] = g; id.data[i + 2] = b; id.data[i + 3] = 255; };
    for (let k = 0; k < TEX * TEX; k++) {
      if (region && !region[k]) continue;
      set(k);
      if (mirror) { const m = mirror[k]; if (m >= 0) set(m); }   // simetría: pinta también el espejo
    }
    tmp.getContext('2d')!.putImageData(id, 0, 0);
    const ctx = this.tctx;
    ctx.save();
    ctx.globalCompositeOperation = this.lockAlpha ? 'source-atop' : this.brushBlend;
    ctx.globalAlpha = this.brushOpacity;
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    this.onUse(this.color); this.onChange(); this.render();
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

  // Color del degradado (multi-stop) en la posición t∈[0,1]. Devuelve [r,g,b,a 0..255].
  gradientColorAt(t: number): [number, number, number, number] {
    const stops = [...this.gradStops].sort((s1, s2) => s1.pos - s2.pos);
    if (stops.length === 0) return [0, 0, 0, 0];
    t = Math.max(0, Math.min(1, t));
    if (t <= stops[0].pos) { const [r, g, b] = hexToRgb(stops[0].color); return [r, g, b, Math.round(stops[0].a * 255)]; }
    const last = stops[stops.length - 1];
    if (t >= last.pos) { const [r, g, b] = hexToRgb(last.color); return [r, g, b, Math.round(last.a * 255)]; }
    for (let i = 0; i < stops.length - 1; i++) {
      const s0 = stops[i], s1 = stops[i + 1];
      if (t >= s0.pos && t <= s1.pos) {
        const f = s1.pos === s0.pos ? 0 : (t - s0.pos) / (s1.pos - s0.pos);
        const c0 = hexToRgb(s0.color), c1 = hexToRgb(s1.color);
        return [
          Math.round(c0[0] + (c1[0] - c0[0]) * f),
          Math.round(c0[1] + (c1[1] - c0[1]) * f),
          Math.round(c0[2] + (c1[2] - c0[2]) * f),
          Math.round((s0.a + (s1.a - s0.a) * f) * 255),
        ];
      }
    }
    const [r, g, b] = hexToRgb(last.color); return [r, g, b, Math.round(last.a * 255)];
  }

  // Aplica el degradado por MUESTRAS (cada texel con su t), para el degradado 3D
  // proyectado: el patrón fluye por el modelo como se ve, no por rectángulo de atlas.
  applyGradientSamples(samples: { x: number; y: number; t: number }[]) {
    if (samples.length === 0) return;
    this.pushUndo();
    const img = this.tctx.getImageData(0, 0, TEX, TEX);
    const d = img.data;
    for (const s of samples) {
      if (s.x < 0 || s.y < 0 || s.x >= TEX || s.y >= TEX) continue;
      if (!this.inSel(s.x, s.y)) continue;
      const i = (s.y * TEX + s.x) * 4;
      if (this.lockAlpha && d[i + 3] === 0) continue;
      const [r, g, b, a] = this.gradientColorAt(s.t);
      const op = this.brushOpacity * (a / 255);
      if (op <= 0) continue;
      const inv = 1 - op;
      d[i]     = Math.round(r * op + d[i] * inv);
      d[i + 1] = Math.round(g * op + d[i + 1] * inv);
      d[i + 2] = Math.round(b * op + d[i + 2] * inv);
      d[i + 3] = Math.max(d[i + 3], Math.round(op * 255));
    }
    this.tctx.putImageData(img, 0, 0);
    for (const st of this.gradStops) this.onUse(st.color);
    this.onChange(); this.render();
  }

  // Selección por máscara desde fuera (p. ej. rectángulo libre proyectado del 3D).
  applyMaskSelection(mask: Uint8Array) { this.onBeforeChange(); this.setMask(mask); }

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
    this.onBeforeChange();
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

  private resetSelection() { this.selection = null; this.selMask = null; this.stopAnts(); this.render(); this.onSelectionChange(); }
  clearSelection() { this.onBeforeChange(); this.resetSelection(); }

  // Fija la selección a un rectángulo concreto (parte/cara, desde 2D o 3D).
  setSelectionRect(x: number, y: number, w: number, h: number) {
    this.onBeforeChange();
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
    if (!any) { this.resetSelection(); return; }
    this.selMask = mask;
    this.selection = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    this.commitSelection();
  }

  // Todos los píxeles del compuesto con exactamente el mismo color.
  selectByColor(x: number, y: number) {
    this.onBeforeChange();
    const img = this.sctx.getImageData(0, 0, TEX, TEX).data;
    const i0 = (y * TEX + x) * 4;
    const allow = this.colorRestrict?.() ?? null;   // región de la capa activa visible
    const mask = new Uint8Array(TEX * TEX);
    // La transparencia cuenta como un color: clic en vacío → todos los texeles vacíos.
    if (img[i0 + 3] === 0) {
      for (let k = 0; k < TEX * TEX; k++) {
        if (allow && !allow[k]) continue;
        if (img[k * 4 + 3] === 0) mask[k] = 1;
      }
      this.setMask(mask);
      return;
    }
    const r = img[i0], g = img[i0 + 1], b = img[i0 + 2];
    const tol = 12;                                  // tolerancia: coge variaciones imperceptibles
    for (let k = 0; k < TEX * TEX; k++) {
      if (allow && !allow[k]) continue;
      const i = k * 4;
      if (img[i + 3] !== 0 && Math.abs(img[i] - r) + Math.abs(img[i + 1] - g) + Math.abs(img[i + 2] - b) <= tol) mask[k] = 1;
    }
    this.setMask(mask);
  }

  // Zona contigua del mismo color (flood) en el compuesto.
  selectContiguous(x: number, y: number) {
    this.onBeforeChange();
    const img = this.sctx.getImageData(0, 0, TEX, TEX).data;
    const i0 = (y * TEX + x) * 4;
    const tr = img[i0], tg = img[i0 + 1], tb = img[i0 + 2], ta = img[i0 + 3];
    const mask = new Uint8Array(TEX * TEX);
    const seen = new Uint8Array(TEX * TEX);
    const allow = this.colorRestrict?.() ?? null;   // no salir de los texeles visibles de la capa
    const stack = [[x, y]];
    const match = (i: number) => Math.abs(img[i] - tr) + Math.abs(img[i + 1] - tg) + Math.abs(img[i + 2] - tb) + Math.abs(img[i + 3] - ta) <= 16;
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cy < 0 || cx >= TEX || cy >= TEX) continue;
      const k = cy * TEX + cx;
      if (seen[k]) continue;
      if (allow && !allow[k]) continue;
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

  isFloating(): boolean { return !!this.floating; }

  // Inicia un pegado FLOTANTE: el contenido aparece sobre la skin y se reposiciona
  // arrastrándolo; se confirma con Enter / clic fuera, o se cancela con Escape.
  pasteSelection() {
    if (!this.clipboard) return;
    if (this.floating) this.commitPaste();
    const img = this.clipboard;
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    const s = this.selection;
    const x = Math.max(0, Math.min(TEX - img.width,  s ? s.x : Math.floor((TEX - img.width) / 2)));
    const y = Math.max(0, Math.min(TEX - img.height, s ? s.y : Math.floor((TEX - img.height) / 2)));
    this.floating = { img, canvas, x, y };
    this.startAnts();
    this.render();
  }

  // Confirma el pegado: lo vuelca en una capa nueva (si main lo gestiona) o en la
  // capa activa, en la posición actual del flotante.
  commitPaste() {
    if (!this.floating) return;
    const f = this.floating;
    this.floating = null; this.floatGrab = null;
    if (this.onPasteCommit) this.onPasteCommit(f.img, f.x, f.y);
    else { this.pushUndo(); this.tctx.putImageData(f.img, f.x, f.y); this.onChange(); }
    if (!this.hasSelection()) this.stopAnts();
    this.render();
  }

  cancelPaste() {
    if (!this.floating) return;
    this.floating = null; this.floatGrab = null; this.floatingIsMove = false;
    if (!this.hasSelection()) this.stopAnts();
    this.render();
  }

  // ── Mover selección ──────────────────────────────────────────────────────────
  // Coge los píxeles seleccionados de la capa activa (los recorta a un flotante y
  // los borra de la capa), para arrastrarlos y soltarlos en otra posición.
  private beginMove(p: { x: number; y: number }) {
    const s = this.selection;
    if (!s) return;
    this.onBeforeChange();
    const src = this.tctx.getImageData(0, 0, TEX, TEX);
    const canvas = document.createElement('canvas');
    canvas.width = s.w; canvas.height = s.h;
    const cctx = canvas.getContext('2d')!;
    const img = cctx.createImageData(s.w, s.h);
    // Recorta SOLO los texeles de la máscara (no todo el bbox) al flotante.
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const sx = s.x + x, sy = s.y + y;
      if (!this.inSel(sx, sy)) continue;
      const si = (sy * TEX + sx) * 4, di = (y * s.w + x) * 4;
      img.data[di] = src.data[si]; img.data[di + 1] = src.data[si + 1];
      img.data[di + 2] = src.data[si + 2]; img.data[di + 3] = src.data[si + 3];
    }
    cctx.putImageData(img, 0, 0);
    // Borra los texeles cogidos de la capa activa.
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++)
      if (this.inSel(x, y)) src.data[(y * TEX + x) * 4 + 3] = 0;
    this.tctx.putImageData(src, 0, 0);
    this.onChange();
    this.floating = { img, canvas, x: s.x, y: s.y };
    this.floatGrab = { dx: p.x - s.x, dy: p.y - s.y };
    this.floatingIsMove = true;
    this.moveOrigin = { x: s.x, y: s.y };
    this.moveApplied = { x: 0, y: 0 };
    this.startAnts();
    this.render();
  }

  // Posiciona el flotante (esquina sup-izq deseada, se recorta al lienzo). Si es un
  // movimiento, arrastra también la selección para que su contorno (incluido el del
  // 3D) muestre en vivo dónde van a caer los píxeles.
  private setFloatPos(nx: number, ny: number) {
    const f = this.floating;
    if (!f) return;
    f.x = Math.max(0, Math.min(TEX - f.img.width, nx));
    f.y = Math.max(0, Math.min(TEX - f.img.height, ny));
    if (this.floatingIsMove) {
      const dx = (f.x - this.moveOrigin.x) - this.moveApplied.x;
      const dy = (f.y - this.moveOrigin.y) - this.moveApplied.y;
      if (dx || dy) {
        this.shiftSelection(dx, dy);
        this.moveApplied.x += dx; this.moveApplied.y += dy;
        this.onSelectionChange();   // refresca el contorno de preview (2D y 3D)
      }
    }
    this.render();
  }

  // Vuelca el flotante de movimiento sobre la MISMA capa (composición normal, solo
  // píxeles opacos). La selección ya viajó con el arrastre.
  private commitMove() {
    if (!this.floating) return;
    const f = this.floating;
    this.floating = null; this.floatGrab = null; this.floatingIsMove = false;
    this.tctx.drawImage(f.canvas, f.x, f.y);
    this.onChange();
    this.commitSelection();
  }

  // ── API de movimiento desde la vista 3D (le pasan el texel bajo el cursor) ────
  isMoving(): boolean { return this.floatingIsMove; }
  beginMoveAt(x: number, y: number): boolean {
    if (this.tool !== 'move' || !this.hasSelection() || !this.inSel(x, y)) return false;
    this.beginMove({ x, y });
    return true;
  }
  moveFloatTo(x: number, y: number) {
    if (!this.floating || !this.floatGrab || !this.floatingIsMove) return;
    this.setFloatPos(x - this.floatGrab.dx, y - this.floatGrab.dy);
  }
  endMove() { if (this.floating && this.floatingIsMove) this.commitMove(); }

  private shiftSelection(dx: number, dy: number) {
    if (this.selMask) {
      const nm = new Uint8Array(TEX * TEX);
      for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
        if (!this.selMask[y * TEX + x]) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < TEX && ny < TEX) nm[ny * TEX + nx] = 1;
      }
      this.selMask = nm;
    }
    if (this.selection) this.selection = { ...this.selection, x: this.selection.x + dx, y: this.selection.y + dy };
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
    if (!this.hasSelection() && !this.floating) { this.stopAnts(); return; }
    if (this.antsRAF) return;
    const tick = () => {
      if (!this.hasSelection() && !this.floating) { this.antsRAF = 0; return; }
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

    // Mientras se mueve, la selección viaja como flotante: no dibujar su contorno en origen.
    if (this.hasSelection() && !this.floatingIsMove) this.strokeSelection(ctx, s);

    // ── Pegado flotante: contenido + borde animado en la posición actual ─────
    if (this.floating) {
      const f = this.floating;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(f.canvas, f.x * s, f.y * s, f.img.width * s, f.img.height * s);
      ctx.save();
      ctx.setLineDash([4, 3]); ctx.lineDashOffset = -this.antPhase;
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(244,129,31,0.95)';
      ctx.strokeRect(f.x * s + 0.5, f.y * s + 0.5, f.img.width * s - 1, f.img.height * s - 1);
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
      // Contorno del footprint REAL de píxeles (traza el borde de las celdas que se
      // pintan), fino y pegado al pixelado — igual de delgado en círculo y cuadrado.
      const traceFootprint = (inside: (dx: number, dy: number) => boolean) => {
        ctx.beginPath();
        for (let dy = 0; dy < size; dy++) {
          for (let dx = 0; dx < size; dx++) {
            if (!inside(dx, dy)) continue;
            const x = (this.hover!.x + start + dx) * s, y = (this.hover!.y + start + dy) * s;
            if (!inside(dx, dy - 1)) { ctx.moveTo(x, y); ctx.lineTo(x + s, y); }
            if (!inside(dx, dy + 1)) { ctx.moveTo(x, y + s); ctx.lineTo(x + s, y + s); }
            if (!inside(dx - 1, dy)) { ctx.moveTo(x, y); ctx.lineTo(x, y + s); }
            if (!inside(dx + 1, dy)) { ctx.moveTo(x + s, y); ctx.lineTo(x + s, y + s); }
          }
        }
        ctx.stroke();
      };
      const inFoot = (dx: number, dy: number) =>
        dx >= 0 && dy >= 0 && dx < size && dy < size && this.brushAlpha(dx, dy) !== null;
      ctx.lineWidth = 1.5; ctx.strokeStyle = `rgba(${col},0.95)`;
      ctx.setLineDash([]);
      traceFootprint(inFoot);
      // Núcleo sólido (donde termina el difuminado): borde de las celdas 100% opacas.
      if (this.feather > 0 && size > 1) {
        const inCore = (dx: number, dy: number) =>
          dx >= 0 && dy >= 0 && dx < size && dy < size && this.brushAlpha(dx, dy) === 1;
        ctx.setLineDash([3, 2]); ctx.strokeStyle = `rgba(${col},0.6)`;
        traceFootprint(inCore);
        ctx.setLineDash([]);
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
