// Geometria do posicionamento — compartilhada pelo servidor e pela tela (sem dependências de Node).
// Coordenadas VISUAIS em pontos PDF: origem no canto superior esquerdo da página exibida.
//
// "Moldura" (frame) é o espaço reservado para a assinatura. A assinatura entra nela sem
// distorcer (contain), alinhada à esquerda e embaixo (senta na linha) ou em cima.
// Trocar de assinatura não mexe na moldura; arrastar e redimensionar mexem.

export const DEFAULT_BOX = { width: 170, maxHeight: 55 } as const;
export const MIN_WIDTH = 24;

/** Posição proposta: pela base (senta na linha) ou pelo topo (posição explícita). */
export interface Placement {
  pageIndex: number;
  x: number;
  y?: number;
  bottom?: number;
  width?: number;
  maxHeight?: number;
}

export interface Frame {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  align: 'bottom' | 'top';
}

export interface Box {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSize {
  width: number;
  height: number;
}

export function frameFromPlacement(p: Placement): Frame {
  const w = p.width ?? DEFAULT_BOX.width;
  if (p.bottom != null) {
    const h = p.maxHeight ?? DEFAULT_BOX.maxHeight;
    return { pageIndex: p.pageIndex, x: p.x, y: p.bottom - h, w, h, align: 'bottom' };
  }
  return { pageIndex: p.pageIndex, x: p.x, y: p.y ?? 0, w, h: p.maxHeight ?? Infinity, align: 'top' };
}

/** Retângulo que a assinatura (altura/largura = aspect) ocupa dentro da moldura. */
export function boxInFrame(f: Frame, aspect: number): Box {
  const width = Math.min(f.w, f.h / aspect);
  const height = width * aspect;
  const y = f.align === 'bottom' ? f.y + f.h - height : f.y;
  return { pageIndex: f.pageIndex, x: f.x, y, width, height };
}

export const fitPlacement = (p: Placement, aspect: number): Box => boxInFrame(frameFromPlacement(p), aspect);

/** Desloca a moldura para a assinatura caber inteira na página. */
export function clampFrame(f: Frame, aspect: number, page: PageSize): Frame {
  const b = boxInFrame(f, aspect);
  const dx = Math.min(Math.max(b.x, 0), Math.max(0, page.width - b.width)) - b.x;
  const dy = Math.min(Math.max(b.y, 0), Math.max(0, page.height - b.height)) - b.y;
  return { ...f, x: f.x + dx, y: f.y + dy };
}

/** Alça no canto inferior direito: o canto superior esquerdo da assinatura fica parado. */
export function resizeFrame(f: Frame, aspect: number, newWidth: number): Frame {
  const b = boxInFrame(f, aspect);
  return { ...f, x: b.x, y: b.y, w: newWidth, h: newWidth * aspect };
}

/** Teclado (+/−): escala mantendo a base (assinatura continua sentada na linha). */
export function scaleFrame(f: Frame, k: number): Frame {
  const h = f.h * k;
  return { ...f, w: f.w * k, h, y: f.align === 'bottom' ? f.y + f.h - h : f.y };
}
