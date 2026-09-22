// Prévia de página com PDF.js rodando na thread principal: sem Worker (a CSP da página
// local e o iframe de MCP Apps não permitem). O PDF.js 6 não usa eval. Build "legacy" =
// polyfills para Safari e navegadores um pouco mais antigos.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'; // registra globalThis.pdfjsWorker → "fake worker"

export type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

export interface PageView {
  scale: number;
  width: number;
  height: number;
}

export function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  return pdfjs.getDocument({ data: bytes, useWasm: false, enableXfa: false, verbosity: 0 }).promise;
}

export function createPageRenderer(doc: PdfDoc, canvas: HTMLCanvasElement) {
  const sizes = new Map<number, { width: number; height: number }>();
  let running: { cancel(): void; promise: Promise<void> } | null = null;
  let seq = 0;

  async function size(index: number) {
    if (!sizes.has(index)) {
      const { width, height } = (await doc.getPage(index + 1)).getViewport({ scale: 1 });
      sizes.set(index, { width, height });
    }
    return sizes.get(index)!;
  }

  /** Renderiza a página na largura CSS pedida. Devolve a escala e o tamanho em pontos, ou null se uma renderização mais nova passou na frente. */
  async function render(index: number, cssWidth: number): Promise<PageView | null> {
    const mine = ++seq;
    if (running) {
      running.cancel();
      await running.promise.catch(() => {});
    }
    if (mine !== seq) return null;
    const page = await doc.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = cssWidth / base.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * dpr });
    // desenha fora da tela e troca no fim: a página não pisca ao redimensionar
    const off = document.createElement('canvas');
    off.width = Math.floor(viewport.width);
    off.height = Math.floor(viewport.height);
    running = page.render({ canvasContext: off.getContext('2d')!, canvas: off, viewport }) as unknown as { cancel(): void; promise: Promise<void> };
    try {
      await running.promise;
    } catch (e) {
      if ((e as Error)?.name === 'RenderingCancelledException') return null;
      throw e;
    } finally {
      running = null;
    }
    if (mine !== seq) return null;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d')!.drawImage(off, 0, 0);
    canvas.style.width = `${base.width * scale}px`;
    canvas.style.height = `${base.height * scale}px`;
    return { scale, width: base.width, height: base.height };
  }

  return { size, render, pageCount: doc.numPages };
}
