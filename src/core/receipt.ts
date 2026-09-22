// Comprovante de assinatura: um PDF à parte, ao lado da cópia assinada, com o que aconteceu —
// quando, onde no documento, com qual desenho — e as impressões digitais (SHA-256) do original e
// do assinado, para quem quiser conferir depois. Diz também o que ele NÃO é: não é certificado
// digital e, sozinho, não identifica quem assinou.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from '@cantoo/pdf-lib';
import { signatureToSvgPath, type Signature } from './signature.ts';
import type { Lang } from '../i18n/messages.ts';

export interface ReceiptInput {
  lang: Lang;
  documentName: string;
  pageCount: number | null;
  signedName: string;
  folder: string;
  signedAt: string;
  sha256Original: string;
  sha256Signed: string;
  places: { page: number; label: string | null }[];
  initialsPages: number;
  texts: number;
  signature: Signature | null;
  signatureLabel: string;
  registryNo: number | null;
  auditId: string | null;
  version: string;
  platform: string;
}

const T = {
  pt: {
    title: 'Comprovante de assinatura',
    document: 'Documento',
    pages: (n: number) => (n === 1 ? '1 página' : `${n} páginas`),
    signed: 'Cópia assinada',
    folder: 'Pasta',
    when: 'Assinado em',
    where: 'Onde',
    sigOn: (p: number, label: string | null) => `Assinatura na página ${p}${label ? ` (${label})` : ''}`,
    initials: (n: number) => (n === 1 ? 'Rubrica em 1 página' : `Rubrica em ${n} páginas`),
    texts: 'Local e data escritos junto da assinatura',
    drawing: 'Assinatura usada',
    shaOriginal: 'SHA-256 do original',
    shaSigned: 'SHA-256 da cópia assinada',
    registry: 'Registro',
    registryText: (n: number | null, id: string | null) =>
      `${n ? `Assinatura nº ${n} no registro de evidências deste computador` : 'Registro de evidências deste computador'}${id ? ` (entrada ${id})` : ''}`,
    tool: 'Feito com',
    how: 'Como conferir',
    howText: (name: string) =>
      `Calcule o SHA-256 do arquivo e compare com o valor acima. No Mac: shasum -a 256 "${name}". No Windows: certutil -hashfile "${name}" SHA256. Qualquer mudança no arquivo muda esse valor.`,
    what: 'O que este comprovante é',
    whatText:
      'Ele registra quando e onde o arquivo assinado foi gerado a partir do original, neste computador. A assinatura é o desenho da própria pessoa (assinatura eletrônica simples). Não é certificado digital ICP-Brasil e, sozinho, não identifica quem assinou.',
    footer: 'Gerado pelo labsign, sem internet, no computador de quem assinou.',
  },
  en: {
    title: 'Signing receipt',
    document: 'Document',
    pages: (n: number) => (n === 1 ? '1 page' : `${n} pages`),
    signed: 'Signed copy',
    folder: 'Folder',
    when: 'Signed on',
    where: 'Where',
    sigOn: (p: number, label: string | null) => `Signature on page ${p}${label ? ` (${label})` : ''}`,
    initials: (n: number) => (n === 1 ? 'Initials on 1 page' : `Initials on ${n} pages`),
    texts: 'Place and date written next to the signature',
    drawing: 'Signature used',
    shaOriginal: 'SHA-256 of the original',
    shaSigned: 'SHA-256 of the signed copy',
    registry: 'Record',
    registryText: (n: number | null, id: string | null) =>
      `${n ? `Signature no. ${n} in this computer's evidence log` : "This computer's evidence log"}${id ? ` (entry ${id})` : ''}`,
    tool: 'Made with',
    how: 'How to check',
    howText: (name: string) =>
      `Compute the file's SHA-256 and compare it with the value above. On a Mac: shasum -a 256 "${name}". On Windows: certutil -hashfile "${name}" SHA256. Any change to the file changes this value.`,
    what: 'What this receipt is',
    whatText:
      "It records when and where the signed file was produced from the original, on this computer. The signature is the person's own drawing (a simple electronic signature). It is not a qualified digital certificate and, on its own, does not identify who signed.",
    footer: 'Produced by labsign, offline, on the signer’s computer.',
  },
} as const;

const NAVY = rgb(0.082, 0.125, 0.361);
const SOFT = rgb(0.255, 0.294, 0.494);
const RULE = rgb(0.451, 0.478, 0.62);
const RED = rgb(0.741, 0.165, 0.122);

/** Só o que a fonte padrão escreve (acentos sim, emoji não). */
const printable = (font: PDFFont, text: string) => {
  const ok = new Set(font.getCharacterSet());
  return [...text].map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : '?')).join('');
};

/** Quebra o texto em linhas que cabem na largura. Palavras sem espaço (caminhos, hashes) quebram no meio. */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of printable(font, text).split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    cur = word;
    while (font.widthOfTextAtSize(cur, size) > width) {
      let cut = cur.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(cur.slice(0, cut), size) > width) cut--;
      out.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function makeReceipt(r: ReceiptInput): Promise<Uint8Array> {
  const t = T[r.lang];
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} — ${r.signedName}`);
  doc.setProducer(`labsign ${r.version}`);
  doc.setCreator('labsign');
  const page: PDFPage = doc.addPage([595.28, 841.89]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const M = 56;
  const W = 595.28 - 2 * M;
  const LABEL_W = 150;
  let y = 841.89 - 64;

  // cabeçalho: nome, título e o número do registro em vermelho (como a numeradora do talão)
  page.drawText('labsign', { x: M, y, size: 11, font: bold, color: NAVY });
  if (r.registryNo) {
    const no = `Nº ${String(r.registryNo).padStart(4, '0')}`;
    page.drawText(no, { x: M + W - bold.widthOfTextAtSize(no, 12), y, size: 12, font: bold, color: RED });
  }
  y -= 34;
  page.drawText(printable(bold, t.title), { x: M, y, size: 20, font: bold, color: NAVY });
  y -= 18;
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 1, color: RULE });
  y -= 22;

  // linhas do formulário: rótulo à esquerda, valor à direita, uma pauta embaixo de cada
  const row = (label: string, values: string[], font = regular, size = 10.5) => {
    const lines = values.flatMap((v) => wrap(font, v, size, W - LABEL_W));
    page.drawText(printable(bold, label.toUpperCase()), { x: M, y, size: 8, font: bold, color: SOFT });
    for (const [i, line] of lines.entries()) page.drawText(line, { x: M + LABEL_W, y: y - i * (size + 4), size, font, color: NAVY });
    y -= Math.max(1, lines.length) * (size + 4) + 6;
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: M + W, y: y + 2 }, thickness: 0.5, color: RULE });
    y -= 14;
  };

  const when = new Date(r.signedAt);
  const local = when.toLocaleString(r.lang === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'long', timeStyle: 'medium' });
  const offset = -when.getTimezoneOffset();
  const tz = `UTC${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  row(t.document, [`${r.documentName}${r.pageCount ? ` (${t.pages(r.pageCount)})` : ''}`]);
  row(t.signed, [r.signedName]);
  row(t.folder, [r.folder]);
  row(t.when, [`${local} (${tz})`, when.toISOString()]);
  row(t.where, [...r.places.map((p) => t.sigOn(p.page, p.label)), ...(r.initialsPages ? [t.initials(r.initialsPages)] : []), ...(r.texts ? [t.texts] : [])]);

  // o desenho usado, sentado numa linha, como no papel
  page.drawText(printable(bold, t.drawing.toUpperCase()), { x: M, y, size: 8, font: bold, color: SOFT });
  page.drawText(printable(regular, r.signatureLabel), { x: M, y: y - 14, size: 10.5, font: regular, color: NAVY });
  if (r.signature && r.signature.width > 0) {
    // o SVG tem y para baixo a partir do ponto dado: o topo do desenho fica logo acima da linha do rótulo
    const k = Math.min(200, r.signature.width) / r.signature.width;
    const top = y + 6;
    page.drawSvgPath(signatureToSvgPath(r.signature), { x: M + LABEL_W, y: top, scale: k, color: NAVY, borderWidth: 0 });
    y -= Math.max(28, r.signature.height * k + 2);
  } else y -= 28;
  page.drawLine({ start: { x: M, y: y + 2 }, end: { x: M + W, y: y + 2 }, thickness: 0.5, color: RULE });
  y -= 14;

  // 64 caracteres numa linha só (dá para copiar e colar para conferir)
  row(t.shaOriginal, [r.sha256Original], mono, 8.5);
  row(t.shaSigned, [r.sha256Signed], mono, 8.5);
  row(t.registry, [t.registryText(r.registryNo, r.auditId)]);
  row(t.tool, [`labsign ${r.version} · ${r.platform}`]);

  // como conferir e o que ele é — em texto corrido, sem letra miúda
  const para = (title: string, text: string) => {
    y -= 6;
    page.drawText(printable(bold, title), { x: M, y, size: 10.5, font: bold, color: NAVY });
    y -= 15;
    for (const line of wrap(regular, text, 9.5, W)) {
      page.drawText(line, { x: M, y, size: 9.5, font: regular, color: SOFT });
      y -= 13;
    }
    y -= 6;
  };
  para(t.how, t.howText(r.signedName));
  para(t.what, t.whatText);
  page.drawText(printable(regular, t.footer), { x: M, y: 40, size: 8, font: regular, color: SOFT });
  return doc.save();
}
