// Minecraft Java 64×64 skin layout + default skin generation.

export const TEX = 64;

export type Rect = { x: number; y: number; w: number; h: number };
export type Faces = { top: Rect; bottom: Rect; right: Rect; front: Rect; left: Rect; back: Rect };

// All body boxes share the same atlas unwrap, parameterised by the
// top-left origin of the block and the box dimensions (w, h, d in px).
export function boxFaces(ox: number, oy: number, w: number, h: number, d: number): Faces {
  return {
    top:    { x: ox + d,         y: oy,     w,    h: d },
    bottom: { x: ox + d + w,     y: oy,     w,    h: d },
    right:  { x: ox,             y: oy + d, w: d, h },
    front:  { x: ox + d,         y: oy + d, w,    h },
    left:   { x: ox + d + w,     y: oy + d, w: d, h },
    back:   { x: ox + d + w + d, y: oy + d, w,    h },
  };
}

export interface PartSpec {
  name: string;
  size: [number, number, number]; // w, h, d
  pos: [number, number, number];  // centre in model space (px units)
  base: Faces;
  overlay: Faces;
}

export function buildParts(slim: boolean): PartSpec[] {
  const aw = slim ? 3 : 4;          // arm width
  const ax = slim ? 5.5 : 6;        // arm centre offset from body centre
  return [
    { name: 'head',     size: [8, 8, 8],  pos: [0, 28, 0],  base: boxFaces(0, 0, 8, 8, 8),    overlay: boxFaces(32, 0, 8, 8, 8) },
    { name: 'body',     size: [8, 12, 4], pos: [0, 18, 0],  base: boxFaces(16, 16, 8, 12, 4), overlay: boxFaces(16, 32, 8, 12, 4) },
    { name: 'rightArm', size: [aw, 12, 4], pos: [-ax, 18, 0], base: boxFaces(40, 16, aw, 12, 4), overlay: boxFaces(40, 32, aw, 12, 4) },
    { name: 'leftArm',  size: [aw, 12, 4], pos: [ax, 18, 0],  base: boxFaces(32, 48, aw, 12, 4), overlay: boxFaces(48, 48, aw, 12, 4) },
    { name: 'rightLeg', size: [4, 12, 4], pos: [-2, 6, 0],   base: boxFaces(0, 16, 4, 12, 4),  overlay: boxFaces(0, 32, 4, 12, 4) },
    { name: 'leftLeg',  size: [4, 12, 4], pos: [2, 6, 0],    base: boxFaces(16, 48, 4, 12, 4), overlay: boxFaces(0, 48, 4, 12, 4) },
  ];
}

// ── Default skin ─────────────────────────────────────────────────────────────
const SKIN = '#A97C50';
const SKIN_SHADE = '#9A6F46';
const HAIR = '#5A3A21';
const SHIRT = '#3A7E7E';
const PANTS = '#3A467E';
const SHOE = '#2A2A30';
const EYE_W = '#E8E8E8';
const EYE_B = '#3A4A8A';

function fillFaces(ctx: CanvasRenderingContext2D, f: Faces, color: string) {
  ctx.fillStyle = color;
  for (const r of [f.top, f.bottom, f.right, f.front, f.left, f.back]) {
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

export function createDefaultSkin(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TEX;
  c.height = TEX;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, TEX, TEX);

  const p = buildParts(false);
  const head = p[0].base, body = p[1].base, rArm = p[2].base, lArm = p[3].base, rLeg = p[4].base, lLeg = p[5].base;

  // Head: skin, hair on top + back + upper sides, eyes on front
  fillFaces(ctx, head, SKIN);
  ctx.fillStyle = HAIR;
  ctx.fillRect(head.top.x, head.top.y, head.top.w, head.top.h);
  ctx.fillRect(head.back.x, head.back.y, head.back.w, 3);
  ctx.fillRect(head.right.x, head.right.y, head.right.w, 2);
  ctx.fillRect(head.left.x, head.left.y, head.left.w, 2);
  ctx.fillRect(head.front.x, head.front.y, head.front.w, 2); // hair fringe
  // eyes (front face is 8×8 at head.front)
  const fx = head.front.x, fy = head.front.y;
  px(ctx, fx + 1, fy + 4, EYE_W); px(ctx, fx + 2, fy + 4, EYE_B);
  px(ctx, fx + 5, fy + 4, EYE_B); px(ctx, fx + 6, fy + 4, EYE_W);

  // Body: shirt
  fillFaces(ctx, body, SHIRT);
  // Arms: skin, short sleeve (shirt) on top portion
  fillFaces(ctx, rArm, SKIN);
  fillFaces(ctx, lArm, SKIN);
  ctx.fillStyle = SHIRT;
  for (const a of [rArm, lArm]) {
    ctx.fillRect(a.front.x, a.front.y, a.front.w, 4);
    ctx.fillRect(a.back.x, a.back.y, a.back.w, 4);
    ctx.fillRect(a.right.x, a.right.y, a.right.w, 4);
    ctx.fillRect(a.left.x, a.left.y, a.left.w, 4);
    ctx.fillRect(a.top.x, a.top.y, a.top.w, a.top.h);
  }
  // hands
  ctx.fillStyle = SKIN_SHADE;
  for (const a of [rArm, lArm]) ctx.fillRect(a.bottom.x, a.bottom.y, a.bottom.w, a.bottom.h);

  // Legs: pants, shoes at the bottom
  fillFaces(ctx, rLeg, PANTS);
  fillFaces(ctx, lLeg, PANTS);
  ctx.fillStyle = SHOE;
  for (const l of [rLeg, lLeg]) {
    ctx.fillRect(l.bottom.x, l.bottom.y, l.bottom.w, l.bottom.h);
    ctx.fillRect(l.front.x, l.front.y + l.front.h - 2, l.front.w, 2);
    ctx.fillRect(l.back.x, l.back.y + l.back.h - 2, l.back.w, 2);
    ctx.fillRect(l.right.x, l.right.y + l.right.h - 2, l.right.w, 2);
    ctx.fillRect(l.left.x, l.left.y + l.left.h - 2, l.left.w, 2);
  }

  return c;
}
