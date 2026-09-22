// Quadro de desenho da assinatura.
//
// Dois jeitos de escrever com mouse/trackpad:
//   "drag" (padrão):  clássico — desenha enquanto o botão está pressionado.
//   "click":          um clique abaixa a caneta, mover desenha, outro clique levanta.
//                     Segurar e arrastar também funciona — o que decide é o gesto.
// Dedo e caneta (stylus) sempre desenham ao encostar, nos dois modos.
import { getStroke } from 'perfect-freehand';
import { STROKE_OPTIONS, type Stroke } from '../core/signature.ts';

const GUIDE = 'rgba(20, 24, 40, 0.2)';
const CLICK_SLOP = 5; // px: até aqui entre apertar e soltar, é clique (não arrasto)

interface LiveStroke {
  pen: boolean;
  points: [number, number, number][];
}

export interface PadState {
  count: number;
  writing: boolean;
  sticky: boolean;
}

export interface Pad {
  undo(): void;
  clear(): void;
  redraw(): void;
  finishStroke(): void;
  count(): number;
  strokes(): Stroke[];
}

function outlinePath(outline: number[][]): Path2D {
  const p = new Path2D();
  const n = outline.length;
  if (n < 3) return p;
  p.moveTo((outline[0][0] + outline[1][0]) / 2, (outline[0][1] + outline[1][1]) / 2);
  for (let i = 1; i <= n; i++) {
    const c = outline[i % n], e = outline[(i + 1) % n];
    p.quadraticCurveTo(c[0], c[1], (c[0] + e[0]) / 2, (c[1] + e[1]) / 2);
  }
  p.closePath();
  return p;
}

/** getInk/getSize: cor e espessura atuais — as mesmas que vão para o PDF. */
export function createPad(
  canvas: HTMLCanvasElement,
  { getMode, getInk, getSize, onChange }: { getMode: () => 'drag' | 'click'; getInk: () => string; getSize: () => number; onChange: (s: PadState) => void },
): Pad {
  const ctx = canvas.getContext('2d')!;
  let strokes: LiveStroke[] = [];
  let current: LiveStroke | null = null; // traço em andamento
  let sticky = false; // caneta presa: abaixada por um clique, esperando o próximo
  let press: { x: number; y: number; id: number } | null = null; // botão pressionado agora
  let active: number | null = null; // o ponteiro dono do traço; outro dedo ou a palma apoiada não mexem nele

  const emit = () => onChange({ count: strokes.length, writing: Boolean(current), sticky });
  const rect = () => canvas.getBoundingClientRect();
  const opts = (s: LiveStroke, last: boolean) => ({ ...STROKE_OPTIONS, size: getSize(), simulatePressure: !s.pen, last });
  const within = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  // com o ponteiro capturado, o arrasto continua fora do quadro: o traço para na borda
  const pt = (e: PointerEvent): [number, number, number] => {
    const r = rect();
    return [within(e.clientX - r.left, r.width), within(e.clientY - r.top, r.height), e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5];
  };
  const mine = (e: PointerEvent) => e.pointerId === active;
  const clickMode = (e: PointerEvent) => getMode() === 'click' && e.pointerType === 'mouse';

  function draw(): void {
    const { width, height } = rect();
    ctx.clearRect(0, 0, width, height);
    // linha de base com "×": só guia visual, não entra na assinatura
    const y = Math.round(height * 0.72) + 0.5;
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, y);
    ctx.lineTo(width - 22, y);
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(12, y - 10);
    ctx.lineTo(20, y - 2);
    ctx.moveTo(20, y - 10);
    ctx.lineTo(12, y - 2);
    ctx.stroke();
    ctx.fillStyle = getInk();
    for (const s of strokes) ctx.fill(outlinePath(getStroke(s.points, opts(s, true))));
    if (current) ctx.fill(outlinePath(getStroke(current.points, opts(current, false))));
  }

  function fit(): void {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = rect();
    if (!width || !height) return;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function begin(e: PointerEvent): void {
    current = { pen: e.pointerType === 'pen', points: [pt(e)] };
    active = e.pointerId;
    sticky = false;
  }

  function end(e?: PointerEvent): void {
    if (!current) return;
    if (e) current.points.push(pt(e)); // o último ponto pode chegar só no evento que encerra
    strokes.push(current);
    current = null;
    active = null;
    press = null;
    sticky = false;
    draw();
    emit();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (current && !mine(e)) return; // já há um traço de outro ponteiro
    canvas.focus({ preventScroll: true });
    if (current && sticky) return end(e); // segundo clique: levanta a caneta
    begin(e);
    press = { x: e.clientX, y: e.clientY, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
    draw();
    emit();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!current || !mine(e)) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) current.points.push(pt(ev));
    draw();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP;
    press = null;
    if (!current) return;
    if (clickMode(e) && !moved) {
      sticky = true; // foi um clique: a caneta continua abaixada até o próximo
      emit();
      return;
    }
    end(e);
  });

  canvas.addEventListener('pointercancel', (e) => {
    if (mine(e)) end();
  });
  // captura perdida com o botão ainda pressionado (o pointerup não vai chegar): encerra o traço.
  // Depois de um pointerup normal `press` já é null — no "clique para escrever" a caneta segue abaixada.
  canvas.addEventListener('lostpointercapture', (e) => {
    if (press && e.pointerId === press.id) end();
  });
  // saiu do quadro com a caneta presa: levanta, para não riscar ao voltar
  canvas.addEventListener('pointerleave', (e) => {
    if (current && sticky && mine(e)) end();
  });
  // trocou de janela (Cmd+Tab) no meio do traço: a caneta não pode ficar abaixada esperando
  window.addEventListener('blur', () => end());
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) {
      e.preventDefault();
      end();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    }
  });

  new ResizeObserver(fit).observe(canvas);
  fit();

  function undo(): void {
    if (current) end();
    strokes.pop();
    draw();
    emit();
  }

  function clear(): void {
    current = null;
    active = null;
    sticky = false;
    press = null;
    strokes = [];
    draw();
    emit();
  }

  return {
    undo,
    clear,
    redraw: draw, // cor ou espessura mudaram
    finishStroke: () => end(),
    count: () => strokes.length,
    strokes: () => strokes.map((s) => s.points.map(([x, y, p]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100] as [number, number, number])),
  };
}
