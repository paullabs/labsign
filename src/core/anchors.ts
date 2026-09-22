// Acha onde assinar procurando um texto-âncora no PDF (posições de texto via pdf.js,
// no Node, sem canvas). Devolve coordenadas VISUAIS — as mesmas que o carimbo usa.
// Sem âncora (PDF escaneado, texto diferente), propõe um lugar na última página:
// o usuário ajusta arrastando na prévia.
//
// Em contrato de verdade o rótulo aparece muitas vezes no corpo ("A CONTRATANTE pagará…")
// e o bloco de assinatura fica no fim. Por isso: o texto é remontado em linhas, a comparação
// ignora acento/caixa, e ganha a ÚLTIMA linha com cara de rótulo (começa pela âncora e é curta).
// Na mesma passada, junta todos os blocos de assinatura (CONTRATANTE, LOCATÁRIA, Testemunha 1…,
// com o nome de quem assina quando o PDF traz): é a lista "Onde assinar" da tela, para achar o
// lugar num contrato de 60 páginas sem rolar página por página.
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

/** Um lugar de assinatura do documento, para a lista "Onde assinar" da tela. */
export interface SpotInfo {
  /** Rótulo como está no PDF ("CONTRATANTE", "Pela LOCADORA", "Testemunha 1"), sem o nome que vem depois. */
  label: string;
  /** Nome de quem assina ali (depois do rótulo ou na linha de baixo), quando o PDF traz. */
  name: string | null;
  /** 1 = primeira página. */
  page: number;
  placement: Placement;
}

export interface SignatureSpot {
  placement: Placement;
  anchor: AnchorInfo;
  pageCount: number;
  /** Todos os blocos de assinatura achados, na ordem de leitura (o escolhido entre eles, se houver). */
  spots: SpotInfo[];
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
  /** O mesmo trecho como está no PDF (acento e caixa), para mostrar na tela. */
  raw: string;
  /** Tamanho da letra (pontos). */
  size: number;
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
  const blank = (): Segment => ({ text: '', at: [], raw: '', size: 0 });
  for (const line of [...lines, ...solo.map((p) => [p])]) {
    line.sort((p, q) => p.x - q.x);
    let seg = blank();
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
    const pushRaw = (ch: string) => {
      if (/\s/.test(ch)) {
        if (!seg.raw || seg.raw.endsWith(' ')) return;
        ch = ' ';
      }
      seg.raw += ch;
    };
    for (const p of line) {
      // negrito "falso" (o mesmo texto desenhado duas vezes, quase no mesmo lugar): conta uma vez
      if (prev && p.str === prev.str && Math.abs(p.x - prev.x) < 0.5 * p.size) continue;
      const gap = p.x - end;
      if (prev && gap > COLUMN_GAP * p.size) {
        segments.push(seg);
        seg = blank();
      } else if (prev && gap > WORD_GAP * p.size) {
        push(' ', p.x, p.y);
        pushRaw(' ');
      }
      const chars = [...p.str];
      chars.forEach((ch, i) => {
        const x = p.x + (p.w * i) / chars.length;
        for (const f of fold(ch)) push(f, x, p.y);
        pushRaw(ch);
      });
      seg.size = Math.max(seg.size, p.size);
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
    s.raw = s.raw.trimEnd();
  }
  return segments.filter((s) => s.text);
}

// ---------------------------------------------------------------- blocos de assinatura
// Papéis que rotulam um bloco de assinatura em contratos (sem acento, minúsculas). Só o
// singular: "TESTEMUNHAS:" é o título da seção, não o lugar onde alguém assina.
const ROLES = [
  'contratante', 'contratada', 'contratado', 'locador', 'locadora', 'locatario', 'locataria', 'fiador', 'fiadora',
  'testemunha', 'interveniente', 'anuente', 'comprador', 'compradora', 'vendedor', 'vendedora', 'promitente compradora',
  'promitente comprador', 'promitente vendedora', 'promitente vendedor', 'outorgante', 'outorgada', 'outorgado',
  'cedente', 'cessionaria', 'cessionario', 'devedora', 'devedor', 'credora', 'credor', 'empregadora', 'empregador',
  'empregada', 'empregado', 'prestadora', 'prestador', 'tomadora', 'tomador', 'avalista', 'mutuante', 'mutuaria',
  'mutuario', 'comodante', 'comodataria', 'comodatario', 'doadora', 'doador', 'donataria', 'donatario', 'arrendadora',
  'arrendador', 'arrendataria', 'arrendatario', 'franqueadora', 'franqueador', 'franqueada', 'franqueado',
  'licenciante', 'licenciada', 'licenciado', 'inquilina', 'inquilino', 'proprietaria', 'proprietario', 'assinatura',
  'signature', 'signed by', 'witness', 'landlord', 'tenant', 'buyer', 'seller', 'client', 'contractor', 'consultant',
  'employer', 'employee', 'guarantor', 'lessor', 'lessee', 'licensor', 'licensee', 'purchaser', 'supplier',
].sort((a, b) => b.length - a.length); // "promitente compradora" antes de "comprador"
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// "Pela CONTRATANTE", "1ª Testemunha", "Testemunha 2", "CONTRATANTE: Maria"
const ROLE_RE = new RegExp(
  String.raw`^(?:(?:pela|pelo|p\/|por|a|o)\s+)?(?:(\d{1,2})\s*[ao]?\.?\s+)?(${ROLES.map(escapeRe).join('|')})(?![\p{L}\p{N}])(?:\s*(?:n[o.]?\s*)?(\d{1,2})(?![\p{N}]))?`,
  'u',
);
const NOT_A_NAME = /^(cpf|cnpj|rg|oab|crc|crm|crea|cep|end(ereco)?|data|local|e-?mail|tel|fone)\b/;
const MAX_SPOTS = 12;

interface RoleHit {
  key: string;
  label: string;
  name: string | null;
  pageIndex: number;
  x: number;
  /** Linha de base do rótulo (identifica o bloco). */
  y: number;
  /** Linha de base sobre a qual a assinatura senta logo acima (o rótulo, ou o nome acima dele). */
  anchorY: number;
}

const CONNECTORS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'y', 'di', 'du', 'del', 'van', 'von', 'la', 'le', '&']);
/** "Maria Exemplo da Silva", "EMPRESA EXEMPLO LTDA." — e não "pagará à CONTRATADA o valor…". */
function nameLike(s: string): boolean {
  const words = s.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 9 && words.every((w) => CONNECTORS.has(w.toLowerCase()) || /^[\p{Lu}\p{N}("]/u.test(w));
}

/** O trecho é o rótulo de um bloco de assinatura? Devolve onde o rótulo começa e o que ele diz. */
function roleOf(seg: Segment): { start: number; key: string; label: string; rest: string } | null {
  const lead = /^[^\p{L}\p{N}]*/u.exec(seg.text)?.[0].length ?? 0; // "____", "(", "- " antes do rótulo
  const body = seg.text.slice(lead);
  const m = ROLE_RE.exec(body);
  if (!m || body.length > m[0].length + LABEL_SLACK) return null;
  // o mesmo número de palavras no texto original: o rótulo como está no PDF, com acento e caixa
  const words = m[0].trim().split(' ').length;
  const rawWords = seg.raw.replace(/^[^\p{L}\p{N}]*/u, '').split(' ');
  const labelRaw = rawWords.slice(0, words).join(' ');
  const restRaw = rawWords.slice(words).join(' ');
  const rest = restRaw.replace(/^[\s:\-–—.]+/, '').trim();
  // depois do rótulo só pode vir um nome ("CONTRATANTE: Maria"), não o resto de uma frase do corpo do contrato
  const separated = /[:\-–—]$/.test(labelRaw) || /^\s*[:\-–—]/.test(restRaw);
  if (rest && !nameLike(rest) && !(separated && rest.length <= 40)) return null;
  const label = labelRaw.replace(/[:\-–—]+$/, '').trim();
  // "Assinatura do Locatário": o complemento faz parte do rótulo, não é um nome
  if (!separated && /^(assinatura|signature)$/.test(m[2]) && /^(do|da|de|dos|das|of)\s/i.test(rest)) {
    return { start: lead, key: normalizeText(`${label} ${rest}`), label: `${label} ${rest}`.replace(/[:\-–—]+$/, '').slice(0, 60), rest: '' };
  }
  return { start: lead, key: `${m[2]}${m[1] ?? m[3] ?? ''}`, label, rest };
}

/** Linha curta com cara de nome, logo abaixo (ou logo acima) do rótulo e alinhada com ele. */
function nameNear(segments: Segment[], seg: Segment, x: number, y: number, dir: 1 | -1): Segment | null {
  const size = seg.size || 10;
  let best: Segment | null = null;
  for (const s of segments) {
    if (s === seg || !s.at.length) continue;
    const dy = (s.at[0].y - y) * dir;
    if (dy < 0.6 * size || dy > 2.8 * size || Math.abs(s.at[0].x - x) > 36) continue;
    const text = s.raw.replace(/^nome\s*:\s*/i, '').trim();
    if (text.length < 3 || text.length > 70 || /^[_.\s]+$/.test(text) || NOT_A_NAME.test(fold(text)) || ROLE_RE.test(fold(text))) continue;
    if (!best || Math.abs(s.at[0].y - y) < Math.abs(best.at[0].y - y)) best = s;
  }
  return best;
}

/** Blocos de assinatura de uma página. */
function pageRoles(segments: Segment[], pageIndex: number): RoleHit[] {
  const hits: RoleHit[] = [];
  for (const seg of segments) {
    const r = roleOf(seg);
    if (!r) continue;
    const at = seg.at[r.start];
    let name: string | null = r.rest.length >= 3 && r.rest.length <= 70 ? r.rest : null;
    let anchorY = at.y;
    if (!name) {
      const below = nameNear(segments, seg, at.x, at.y, 1);
      const above = below ? null : nameNear(segments, seg, at.x, at.y, -1);
      name = (below ?? above)?.raw.replace(/^nome\s*:\s*/i, '').trim() ?? null;
      // nome entre a linha e o rótulo ("____ / Maria / CONTRATANTE"): a assinatura senta acima do nome
      if (above) anchorY = above.at[0].y;
    }
    hits.push({ key: r.key, label: r.label, name, pageIndex, x: at.x, y: at.y, anchorY });
  }
  return hits;
}

const spotOf = (h: RoleHit): SpotInfo => ({
  label: h.label,
  name: h.name,
  page: h.pageIndex + 1,
  placement: placementAbove({ pageIndex: h.pageIndex, x: Math.round(h.x), baseline: Math.round(h.anchorY) }),
});

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
    // Uma passada por todas as páginas: o ÚLTIMO rótulo com a âncora (o bloco de assinatura fica no fim),
    // a última ocorrência de qualquer tipo (plano B) e o último bloco de cada papel (a lista "Onde assinar").
    let label: (Hit & { raw: string }) | null = null;
    let any: Hit | null = null;
    const roles = new Map<string, RoleHit>();
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      const segments = pageSegments(items as TextItemLike[], viewport);
      for (const hit of pageRoles(segments, n - 1)) {
        const prev = roles.get(hit.key);
        if (!prev || later(hit, prev)) roles.set(hit.key, hit);
      }
      if (!needle) continue;
      for (const seg of segments) {
        const i = labelStart(seg.text, needle);
        if (i >= 0) {
          const hit = { pageIndex: n - 1, ...seg.at[i], raw: seg.raw };
          if (later(hit, label)) label = hit;
        }
        const j = seg.text.lastIndexOf(needle);
        if (j >= 0) {
          const hit = { pageIndex: n - 1, ...seg.at[j] };
          if (later(hit, any)) any = hit;
        }
      }
    }
    const blocks = [...roles.values()].sort((a, b) => (later(a, b) ? 1 : -1)).slice(-MAX_SPOTS);
    const spots = blocks.map(spotOf);

    const chosen = label ?? any;
    if (chosen) {
      // o rótulo da âncora costuma ser um dos blocos: usa a mesma posição da lista (que considera o nome acima do rótulo)
      const same = label && blocks.findIndex((b) => b.pageIndex === label!.pageIndex && Math.abs(b.x - label!.x) < 2 && Math.abs(b.y - label!.y) < 2);
      let placement: Placement;
      if (label && same !== null && same >= 0) placement = spots[same].placement;
      else {
        placement = placementAbove({ pageIndex: chosen.pageIndex, x: Math.round(chosen.x), baseline: Math.round(chosen.y) });
        // âncora que não é um papel conhecido ("Assinatura do Locatário"): entra na lista também
        if (label) {
          const text = label.raw.replace(/^[^\p{L}\p{N}]*/u, '').trim().slice(0, 60);
          spots.push({ label: text, name: null, page: label.pageIndex + 1, placement });
          spots.sort((a, b) => a.page - b.page || (a.placement.bottom ?? 0) - (b.placement.bottom ?? 0) || a.placement.x - b.placement.x);
        }
      }
      return { placement, anchor: { text: anchorText ?? null, found: true, page: chosen.pageIndex + 1 }, pageCount: doc.numPages, spots };
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
      spots,
    };
  } finally {
    await task.destroy();
  }
}
