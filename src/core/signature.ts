// Traços crus -> assinatura vetorial (contornos preenchidos), recortada no bbox.
// Roda igual no Node e no navegador: a tela e o carimbo usam a mesma conta.
import { getStroke } from 'perfect-freehand';

/** Um ponto do traço: [x, y, pressão?] em pixels do quadro de desenho. */
export type Point = [number, number, number?];
export type Stroke = Point[];

export interface Signature {
  width: number;
  height: number;
  /** Um polígono de contorno por traço, já deslocado para o canto (0, 0). */
  outlines: number[][][];
}

export interface StrokeOptions {
  size: number;
  thinning: number;
  smoothing: number;
  streamline: number;
  simulatePressure: boolean;
  last: boolean;
}

export const STROKE_OPTIONS: StrokeOptions = {
  size: 5,
  thinning: 0.6,
  smoothing: 0.55,
  streamline: 0.45,
  simulatePressure: true,
  last: true,
};

// Tinta e traço escolhidos na tela. O cofre guarda os traços crus, então a mesma
// assinatura pode ser carimbada em qualquer cor e espessura sem redesenhar.
export const PENS = { fine: 3.2, medium: 5, bold: 7.5 } as const;
export const INKS = { navy: '#0d1a59', blue: '#1f3fa8', black: '#161616' } as const;
export type Pen = keyof typeof PENS;
export type Ink = keyof typeof INKS;
export const DEFAULT_PEN: Pen = 'medium';
export const DEFAULT_INK: Ink = 'navy';

export const isPen = (v: unknown): v is Pen => typeof v === 'string' && Object.hasOwn(PENS, v);
export const isInk = (v: unknown): v is Ink => typeof v === 'string' && Object.hasOwn(INKS, v);
export const penOptions = (pen: unknown): StrokeOptions => ({ ...STROKE_OPTIONS, size: PENS[isPen(pen) ? pen : DEFAULT_PEN] });
export const inkHex = (ink: unknown): string => INKS[isInk(ink) ? ink : DEFAULT_INK];
/** '#0d1a59' -> [r, g, b] em 0..1, como o PDF espera */
export const inkRgb = (ink: unknown): [number, number, number] => {
  const hex = inkHex(ink);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
};

const r2 = (v: number) => Math.round(v * 100) / 100;

export function strokesToSignature(strokes: Stroke[], options: StrokeOptions = STROKE_OPTIONS): Signature {
  const raw = strokes.filter((s) => s.length > 0).map((s) => getStroke(s as number[][], options));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const outline of raw) {
    for (const [x, y] of outline) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) throw new Error('empty signature');
  return {
    width: r2(maxX - minX),
    height: r2(maxY - minY),
    outlines: raw.map((o) => o.map(([x, y]) => [r2(x - minX), r2(y - minY)])),
  };
}

/** Caminho SVG com curvas suaves (prévia na tela e .svg no cofre). */
export function signatureToSvgPath(signature: Signature): string {
  let d = '';
  for (const o of signature.outlines) {
    const n = o.length;
    if (n < 3) continue;
    d += `M${r2((o[0][0] + o[1][0]) / 2)} ${r2((o[0][1] + o[1][1]) / 2)}`;
    for (let i = 1; i <= n; i++) {
      const c = o[i % n];
      const e = o[(i + 1) % n];
      d += `Q${r2(c[0])} ${r2(c[1])} ${r2((c[0] + e[0]) / 2)} ${r2((c[1] + e[1]) / 2)}`;
    }
    d += 'Z';
  }
  return d;
}

export function signatureToSvg(signature: Signature, color = INKS.navy): string {
  const { width, height } = signature;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><path d="${signatureToSvgPath(signature)}" fill="${color}"/></svg>`;
}
