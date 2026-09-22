// Acha onde assinar procurando um texto-âncora no PDF (posições de texto via pdf.js,
// no Node, sem canvas). Devolve coordenadas VISUAIS — as mesmas que o carimbo usa.
// Sem âncora (PDF escaneado, texto diferente), propõe um lugar na última página:
// o usuário ajusta arrastando na prévia.
//
// Em contrato de verdade o rótulo aparece muitas vezes no corpo ("A CONTRATANTE pagará…")
// e o bloco de assinatura fica no fim. Por isso: o texto é remontado em linhas, a comparação
// ignora acento/caixa, e ganha a ÚLTIMA linha com cara de rótulo (começa pela âncora e é curta).
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
// registra globalThis.pdfjsWorker: o pdf.js roda o "worker" na própria thread,
// sem precisar achar o arquivo do worker em disco (necessário depois de empacotar)
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { DEFAULT_BOX, type Placement } from './placement.ts';
import { LabsignError } from './errors.ts';

export interface AnchorInfo {
  text: string | null;
  found: boolean;
  page: number;
}

export interface SignatureSpot {
  placement: Placement;
  anchor: AnchorInfo;
  pageCount: number;
}

/** Assinatura "sentada" na linha que fica logo acima do rótulo encontrado. */
export function placementAbove(anchor: { pageIndex: number; x: number; baseline: number }): Placement {
  return { pageIndex: anchor.pageIndex, x: anchor.x + 8, bottom: anchor.baseline - 18, width: DEFAULT_BOX.width, maxHeight: DEFAULT_BOX.maxHeight };
}

interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

interface ViewportLike {
  transform: number[];
  convertToViewportPoint(x: number, y: number): number[];
}

/** Sem acento, minúsculas (NFKD + remove marcas combinantes). */
const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Forma de comparação: sem acento, minúsculas, espaços colapsados. */
export const normalizeText = (s: string): string => fold(s).replace(/\s+/g, ' ').trim();

/** Âncora pronta para comparar: "Locatária:" e "LOCATARIA" viram a mesma coisa. */
const needleOf = (anchor: string): string => normalizeText(anchor).replace(/\s*:$/, '').trim();

const LABEL_SLACK = 60; // rótulo: a linha tem no máximo a âncora + isto de caracteres
const WORD_GAP = 0.15; // vão (em "em") entre pedaços que conta como espaço
const COLUMN_GAP = 3; // vão (em "em") que separa colunas (ex.: CONTRATANTE | CONTRATADA lado a lado)

interface Piece {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

/** Trecho de uma linha, já normalizado, com a posição visual de cada caractere. */
interface Segment {
  text: string;
  at: { x: number; y: number }[];
}

interface Hit {
  pageIndex: number;
  x: number;
  y: number;
}

/** Itens do pdf.js -> trechos de linha (mesma linha de base, ordenados por x, partidos em colunas). */
function pageSegments(items: TextItemLike[], viewport: ViewportLike): Segment[] {
  const [a, b, c, d] = viewport.transform;
  const flat: Piece[] = [];
  const solo: Piece[] = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue;
    const t = it.transform;
    const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
    const size = Math.hypot(t[2], t[3]) || it.height || 10;
    const piece = { str: it.str, x, y, w: Math.max(0, it.width ?? 0), size };
    // direção do texto na tela: só o que corre na horizontal se junta aos vizinhos
    const dx = a * t[0] + c * t[1], dy = b * t[0] + d * t[1];
    (dx > 0 && Math.abs(dy) <= Math.abs(dx) * 0.05 ? flat : solo).push(piece);
  }

  // linhas: mesma linha de base (com tolerância), da esquerda para a direita
  flat.sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: Piece[][] = [];
  for (const p of flat) {
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(p.y - cur[0].y) <= Math.max(1, 0.3 * Math.min(p.size, cur[0].size))) cur.push(p);
    else lines.push([p]);
  }

  const segments: Segment[] = [];
  for (const line of [...lines, ...solo.map((p) => [p])]) {
    line.sort((p, q) => p.x - q.x);
    let seg: Segment = { text: '', at: [] };
    let prev: Piece | null = null;
    let end = -Infinity;
    const push = (ch: string, x: number, y: number) => {
      if (/\s/.test(ch)) {
        if (!seg.text || seg.text.endsWith(' ')) return;
        ch = ' ';
      }
      seg.text += ch;
      seg.at.push({ x, y });
    };
    for (const p of line) {
      // negrito "falso" (o mesmo texto desenhado duas vezes, quase no mesmo lugar): conta uma vez
      if (prev && p.str === prev.str && Math.abs(p.x - prev.x) < 0.5 * p.size) continue;
      const gap = p.x - end;
      if (prev && gap > COLUMN_GAP * p.size) {
        segments.push(seg);
        seg = { text: '', at: [] };
      } else if (prev && gap > WORD_GAP * p.size) push(' ', p.x, p.y);
      const chars = [...p.str];
      chars.forEach((ch, i) => {
        const x = p.x + (p.w * i) / chars.length;
        for (const f of fold(ch)) push(f, x, p.y);
      });
      prev = p;
      end = Math.max(end, p.x + p.w);
    }
    segments.push(seg);
  }
  for (const s of segments) {
    if (s.text.endsWith(' ')) {
      s.text = s.text.slice(0, -1);
      s.at.pop();
    }
  }
  return segments.filter((s) => s.text);
}

/** p vem depois de q na ordem de leitura (página; de cima para baixo; da esquerda para a direita)? */
function later(p: Hit, q: Hit | null): boolean {
  if (!q) return true;
  if (p.pageIndex !== q.pageIndex) return p.pageIndex > q.pageIndex;
  return Math.abs(p.y - q.y) > 1 ? p.y > q.y : p.x > q.x;
}

/** Rótulo: a linha começa pela âncora (palavra inteira) e é curta — ex.: "CONTRATANTE: Maria". */
function labelStart(text: string, needle: string): number {
  const lead = /^[^\p{L}\p{N}]*/u.exec(text)?.[0].length ?? 0; // ignora "____", "- ", "(" antes do rótulo
  const body = text.slice(lead);
  if (!body.startsWith(needle) || body.length > needle.length + LABEL_SLACK) return -1;
  return /[\p{L}\p{N}]/u.test(body[needle.length] ?? '') ? -1 : lead;
}

/**
 * Abre com o pdf.js e recusa o que o carimbo não saberia regravar: PDF com senha (o pdf.js pede a senha)
 * ou só com senha de permissões (abre, mas /Encrypt está lá — o salvamento incremental não sabe cifrar).
 * PDF danificado vira NOT_PDF em vez de um erro interno.
 */
async function openReadable(pdfBytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    if ((await doc.getPermissions()) !== null) throw new LabsignError('ENCRYPTED');
    return { task, doc };
  } catch (e) {
    await task.destroy();
    if (e instanceof LabsignError) throw e;
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new LabsignError('ENCRYPTED');
    if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'UnknownErrorException') throw new LabsignError('NOT_PDF');
    throw e;
  }
}

/** Só confere se o PDF abre e não é criptografado (caminho sem âncora, com posição explícita). */
export async function assertPdfReadable(pdfBytes: Uint8Array): Promise<void> {
  await (await openReadable(pdfBytes)).task.destroy();
}

export async function locateSignatureSpot(pdfBytes: Uint8Array, anchorText?: string | null): Promise<SignatureSpot> {
  const { task, doc } = await openReadable(pdfBytes);
  try {
    const needle = needleOf(anchorText ?? '');
    if (needle) {
      // de trás para frente: a primeira página (do fim) com um rótulo já é a resposta;
      // sem rótulo em lugar nenhum, vale a última ocorrência de qualquer tipo
      let chosen: Hit | null = null;
      for (let n = doc.numPages; n >= 1; n--) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        const { items } = await page.getTextContent();
        let label: Hit | null = null;
        let any: Hit | null = null;
        for (const seg of pageSegments(items as TextItemLike[], viewport)) {
          const i = labelStart(seg.text, needle);
          if (i >= 0) {
            const hit = { pageIndex: n - 1, ...seg.at[i] };
            if (later(hit, label)) label = hit;
          }
          const j = seg.text.lastIndexOf(needle);
          if (j >= 0) {
            const hit = { pageIndex: n - 1, ...seg.at[j] };
            if (later(hit, any)) any = hit;
          }
        }
        if (label) {
          chosen = label;
          break;
        }
        chosen ??= any;
      }
      if (chosen) {
        const anchor = { pageIndex: chosen.pageIndex, x: Math.round(chosen.x), baseline: Math.round(chosen.y) };
        return { placement: placementAbove(anchor), anchor: { text: anchorText ?? null, found: true, page: chosen.pageIndex + 1 }, pageCount: doc.numPages };
      }
    }
    const last = await doc.getPage(doc.numPages);
    const { width, height } = last.getViewport({ scale: 1 });
    return {
      placement: {
        pageIndex: doc.numPages - 1,
        x: Math.round((width - DEFAULT_BOX.width) / 2),
        bottom: Math.round(height - 96),
        width: DEFAULT_BOX.width,
        maxHeight: DEFAULT_BOX.maxHeight,
      },
      anchor: { text: anchorText || null, found: false, page: doc.numPages },
      pageCount: doc.numPages,
    };
  } finally {
    await task.destroy();
  }
}
