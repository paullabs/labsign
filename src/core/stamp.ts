// Carimbo vetorial de assinatura em PDF.
//
// O chamador fala em coordenadas VISUAIS: pontos PDF, origem no canto superior
// esquerdo da página como ela é exibida (depois de /Rotate e do CropBox).
// Aqui isso vira uma matriz afim para o espaço do usuário do PDF.
// Sempre em save incremental: o original fica intacto como prefixo do arquivo
// (e assinaturas digitais de terceiros continuam válidas).
import {
  PDFDocument,
  type PDFPage,
  type PDFOperator,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  setFillingRgbColor,
  moveTo,
  appendBezierCurve,
  closePath,
  fill,
} from '@cantoo/pdf-lib';
import { LabsignError } from './errors.ts';
import type { Signature } from './signature.ts';

export interface StampPlacement {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
}

/** O PDF já carrega assinatura digital (criptográfica)? */
export const hasDigitalSignature = (pdfBytes: Uint8Array): boolean => Buffer.from(pdfBytes).includes('/ByteRange');

function normRotation(angle: number): number {
  return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** [x0, y0, x1, y1] com x0 < x1 e y0 < y1 (caixas podem vir invertidas no PDF). */
function corners({ x, y, width, height }: Rect): [number, number, number, number] {
  return [Math.min(x, x + width), Math.min(y, y + height), Math.max(x, x + width), Math.max(y, y + height)];
}

/**
 * Área visível da página: CropBox ∩ MediaBox, como o pdf.js (e o poppler) fazem.
 * O pdf-lib devolve o CropBox cru; um CropBox maior que o MediaBox deslocaria o carimbo.
 */
export function pageViewBox(page: PDFPage): Rect {
  let [mx0, my0, mx1, my1] = corners(page.getMediaBox());
  if (!(mx1 > mx0 && my1 > my0)) [mx0, my0, mx1, my1] = [0, 0, 612, 792]; // MediaBox inválido: carta, como o pdf.js
  const [cx0, cy0, cx1, cy1] = corners(page.getCropBox());
  const x0 = Math.max(mx0, cx0), y0 = Math.max(my0, cy0), x1 = Math.min(mx1, cx1), y1 = Math.min(my1, cy1);
  // interseção vazia (CropBox fora do MediaBox): vale o MediaBox
  if (!(x1 > x0 && y1 > y0)) return { x: mx0, y: my0, width: mx1 - mx0, height: my1 - my0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Tamanho da página como o usuário a vê, em pontos. */
export function visualPageSize(page: PDFPage): { width: number; height: number } {
  const { width, height } = pageViewBox(page);
  const rot = normRotation(page.getRotation().angle);
  return rot === 90 || rot === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Matriz [a b c d e f] que leva o espaço da assinatura (y para baixo, unidades do desenho)
 * para o espaço do usuário do PDF, de modo que ela apareça em pé no retângulo visual (vx, vy)
 * com escala k.
 */
export function signatureMatrix(page: PDFPage, vx: number, vy: number, k: number): [number, number, number, number, number, number] {
  const { x: cx, y: cy, width: W, height: H } = pageViewBox(page);
  switch (normRotation(page.getRotation().angle)) {
    case 90:
      return [0, k, k, 0, cx + vy, cy + vx];
    case 180:
      return [-k, 0, 0, k, cx + W - vx, cy + vy];
    case 270:
      return [0, -k, -k, 0, cx + W - vy, cy + H - vx];
    default:
      return [k, 0, 0, -k, cx + vx, cy + H - vy];
  }
}

/** Polígono de contorno -> operadores de caminho suave (quadráticas convertidas em cúbicas exatas). */
function outlineOperators(outline: number[][]): PDFOperator[] {
  const n = outline.length;
  if (n < 3) return [];
  const mid = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const ops: PDFOperator[] = [];
  let cur = mid(outline[0], outline[1]);
  ops.push(moveTo(cur[0], cur[1]));
  for (let i = 1; i <= n; i++) {
    const ctrl = outline[i % n];
    const end = mid(ctrl, outline[(i + 1) % n]);
    ops.push(
      appendBezierCurve(
        cur[0] + (2 / 3) * (ctrl[0] - cur[0]),
        cur[1] + (2 / 3) * (ctrl[1] - cur[1]),
        end[0] + (2 / 3) * (ctrl[0] - end[0]),
        end[1] + (2 / 3) * (ctrl[1] - end[1]),
        end[0],
        end[1],
      ),
    );
    cur = end;
  }
  ops.push(closePath());
  return ops;
}

export interface StampOptions {
  pdfBytes: Uint8Array;
  signature: Signature;
  placements: StampPlacement[];
  mode?: 'incremental' | 'rewrite';
  color?: [number, number, number];
  password?: string;
}

export async function stampSignature({ pdfBytes, signature, placements, mode = 'incremental', color = [0.05, 0.1, 0.35], password }: StampOptions) {
  const incremental = mode === 'incremental';
  const doc = await PDFDocument.load(pdfBytes, { forIncrementalUpdate: incremental, password });
  const pages = doc.getPages();

  for (const p of placements) {
    const page = pages[p.pageIndex];
    if (!page) throw new LabsignError('PAGE_MISSING', { page: p.pageIndex + 1 });
    const k = p.width / signature.width;
    // a posição vem da tela (o humano arrastou) — ainda assim, nada fora da página
    const { width: W, height: H } = visualPageSize(page);
    const h = signature.height * k;
    const TOL = 1;
    if (![p.x, p.y, p.width].every(Number.isFinite) || p.x < -TOL || p.y < -TOL || p.x + p.width > W + TOL || p.y + h > H + TOL) {
      throw new LabsignError('OUT_OF_PAGE', { page: p.pageIndex + 1 });
    }
    const [a, b, c, d, e, f] = signatureMatrix(page, p.x, p.y, k);
    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f), setFillingRgbColor(...color)];
    // um fill por traço: traços que se cruzam nunca se cancelam (regra nonzero)
    for (const outline of signature.outlines) {
      const path = outlineOperators(outline);
      if (path.length) ops.push(...path, fill());
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }

  const bytes = incremental ? await doc.save() : await doc.save({ rewrite: true });
  return { bytes, mode };
}
