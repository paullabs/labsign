// O documento inteiro numa coluna que rola, página por página — mas só as páginas perto da
// vista são desenhadas (o pdf.js roda na thread principal: desenhar 60 páginas de uma vez
// travaria a tela). Todas as páginas usam a mesma escala (pontos PDF → pixels CSS), então
// páginas de tamanhos diferentes guardam a proporção entre si.
import type { PdfDoc } from './pdf-preview.ts';

export interface PageSize {
  width: number;
  height: number;
}

export interface Viewer {
  readonly count: number;
  readonly sizes: PageSize[];
  /** Pixels CSS por ponto PDF (igual em todas as páginas). */
  scale(): number;
  /** O elemento da página i (a assinatura posicionável entra dentro dele). */
  slot(i: number): HTMLElement;
  /** Página mais visível agora (0 = primeira). */
  current(): number;
  scrollToPage(i: number, opts?: { y?: number; smooth?: boolean }): void;
  zoom(): number;
  setZoom(z: number): void;
  /** Zoom em que a página atual cabe inteira na altura da vista. */
  fitPageZoom(): number;
  /** A largura disponível mudou (janela, painel, tela cheia). */
  relayout(): void;
  /** Ponto da tela → página e posição em pontos PDF (null fora das páginas). */
  pageAt(clientX: number, clientY: number): { i: number; x: number; y: number } | null;
  /** Miniatura de uma página num canvas à parte (canhoto, quadro de entrega). */
  thumb(i: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
  destroy(): void;
}

const GAP = 18; // px entre as páginas
const PAD = 20; // px de margem lateral mínima
const KEEP = 12; // páginas desenhadas guardadas na memória
export const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const MIN_ZOOM = 0.25; // "página inteira" pode pedir menos que o menor degrau

export async function createViewer(
  doc: PdfDoc,
  scroller: HTMLElement,
  { onPage, pageLabel }: { onPage: (i: number) => void; pageLabel: (i: number, total: number) => string },
): Promise<Viewer> {
  const count = doc.numPages;
  const sizes: PageSize[] = [];
  for (let i = 1; i <= count; i++) {
    const { width, height } = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ width, height });
  }
  const widest = Math.max(...sizes.map((s) => s.width));

  const inner = document.createElement('div');
  inner.className = 'folhas-inner';
  const slots = sizes.map((_, i) => {
    const el = document.createElement('div');
    el.className = 'folha';
    el.dataset.i = String(i);
    el.innerHTML = `<canvas role="img"></canvas><span class="folha-n" aria-hidden="true">${i + 1}</span>`;
    (el.firstChild as HTMLCanvasElement).setAttribute('aria-label', pageLabel(i, count));
    inner.append(el);
    return { el, canvas: el.firstChild as HTMLCanvasElement, drawn: 0, top: 0 };
  });
  scroller.replaceChildren(inner);

  let zoom = 1;
  let k = 1; // pixels CSS por ponto
  let cur = 0;
  let destroyed = false;

  function layout(): void {
    const avail = Math.max(120, scroller.clientWidth - 2 * PAD);
    k = (avail / widest) * zoom;
    let top = GAP;
    for (const [i, s] of slots.entries()) {
      const w = Math.round(sizes[i].width * k);
      const h = Math.round(sizes[i].height * k);
      s.el.style.width = `${w}px`;
      s.el.style.height = `${h}px`;
      s.top = top;
      top += h + GAP;
    }
    inner.style.minWidth = `${Math.round(widest * k) + 2 * PAD}px`;
  }

  // ---- desenho sob demanda: a página mais perto da atual primeiro, uma de cada vez
  const near = new Set<number>();
  let busy = false;
  async function pump(): Promise<void> {
    if (busy || destroyed) return;
    const todo = [...near].filter((i) => slots[i].drawn !== k).sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
    const i = todo[0];
    if (i === undefined) return;
    busy = true;
    try {
      await draw(i);
    } catch (e) {
      if ((e as Error)?.name !== 'RenderingCancelledException') console.error(e);
      slots[i].drawn = k; // não fica tentando de novo em laço
    } finally {
      busy = false;
    }
    evict();
    void pump();
  }

  async function draw(i: number): Promise<void> {
    const scale = k;
    const page = await doc.getPage(i + 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * dpr });
    const off = document.createElement('canvas');
    off.width = Math.floor(viewport.width);
    off.height = Math.floor(viewport.height);
    await page.render({ canvasContext: off.getContext('2d')!, canvas: off, viewport } as any).promise;
    if (destroyed || scale !== k) return; // o zoom mudou no meio: a próxima volta redesenha
    const c = slots[i].canvas;
    c.width = off.width;
    c.height = off.height;
    c.getContext('2d')!.drawImage(off, 0, 0);
    slots[i].drawn = scale;
    slots[i].el.classList.add('pronta');
  }

  /** Solta da memória o desenho das páginas longe da vista. */
  function evict(): void {
    const drawn = slots.map((s, i) => i).filter((i) => slots[i].drawn && !near.has(i));
    if (drawn.length <= KEEP) return;
    drawn.sort((a, b) => Math.abs(b - cur) - Math.abs(a - cur));
    for (const i of drawn.slice(0, drawn.length - KEEP)) {
      slots[i].canvas.width = slots[i].canvas.height = 0;
      slots[i].drawn = 0;
      slots[i].el.classList.remove('pronta');
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i);
        if (e.isIntersecting) near.add(i);
        else near.delete(i);
      }
      void pump();
    },
    { root: scroller, rootMargin: '120% 0px' },
  );
  for (const s of slots) io.observe(s.el);

  // ---- página atual: a que ocupa a linha a 40% da altura da vista
  function whichPage(): number {
    const line = scroller.scrollTop + scroller.clientHeight * 0.4;
    let lo = 0, hi = slots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slots[mid].top <= line) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const i = whichPage();
      if (i !== cur) {
        cur = i;
        onPage(i);
        void pump();
      }
    });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  function scrollToPage(i: number, { y, smooth = false }: { y?: number; smooth?: boolean } = {}): void {
    i = Math.min(Math.max(i, 0), count - 1);
    // com y (pontos): deixa esse ponto da página a um terço da vista — o lugar da assinatura fica à vista, com contexto acima
    const target = y == null ? slots[i].top - GAP / 2 : slots[i].top + y * k - scroller.clientHeight / 3;
    scroller.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
    if (cur !== i) {
      cur = i;
      onPage(i);
    }
  }

  function setZoom(z: number): void {
    const keep = cur;
    const offset = (scroller.scrollTop - slots[keep].top) / k; // pontos da página atual acima do topo da vista
    zoom = Math.min(Math.max(z, MIN_ZOOM), ZOOMS.at(-1)!);
    layout();
    scroller.scrollTop = slots[keep].top + offset * k;
    void pump();
  }

  function relayout(): void {
    const keep = cur;
    const offset = (scroller.scrollTop - slots[keep].top) / k;
    layout();
    scroller.scrollTop = slots[keep].top + offset * k;
    void pump();
  }

  function pageAt(clientX: number, clientY: number) {
    for (const [i, s] of slots.entries()) {
      const r = s.el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return { i, x: (clientX - r.left) / k, y: (clientY - r.top) / k };
    }
    return null;
  }

  layout();
  return {
    count,
    sizes,
    scale: () => k,
    slot: (i) => slots[i].el,
    current: () => cur,
    scrollToPage,
    zoom: () => zoom,
    setZoom,
    fitPageZoom: () => {
      const fitWidth = Math.max(120, scroller.clientWidth - 2 * PAD) / widest;
      const z = (scroller.clientHeight - 2 * GAP) / (sizes[cur].height * fitWidth);
      return Math.min(Math.max(z, MIN_ZOOM), 1);
    },
    relayout,
    pageAt,
    thumb: (i, canvas, cssWidth) => renderThumb(doc, i, canvas, cssWidth),
    destroy() {
      destroyed = true;
      io.disconnect();
      scroller.removeEventListener('scroll', onScroll);
    },
  };
}

/** Miniatura de uma página num canvas à parte (canhoto, quadro de entrega). */
export async function renderThumb(doc: PdfDoc, i: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void> {
  const page = await doc.getPage(i + 1);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${Math.round((cssWidth * base.height) / base.width)}px`;
  await page.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport } as any).promise;
}
