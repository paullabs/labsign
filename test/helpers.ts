// Utilitários de teste: PDFs de exemplo (sem dados reais), oráculo por pixels (poppler) e pastas temporárias.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb, degrees, type PDFPage } from '@cantoo/pdf-lib';
import forge from 'node-forge';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';

export const tempDir = (prefix = 'labsign-test-') => mkdtempSync(join(tmpdir(), prefix));
export const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

export function has(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
export const POPPLER = has('pdftoppm');
export const PDFSIG = has('pdfsig');

const A4: [number, number] = [595.28, 841.89];

/** Alvos (coordenadas visuais) usados pelos testes de carimbo. */
export const TARGETS = {
  normal: [{ pageIndex: 1, x: 80, y: 548, width: 180 }],
  rotated: [
    { pageIndex: 0, x: 500, y: 430, width: 200 },
    { pageIndex: 1, x: 330, y: 650, width: 200 },
    { pageIndex: 2, x: 90, y: 120, width: 200 },
  ],
  offset: [
    { pageIndex: 0, x: 300, y: 640, width: 190 },
    { pageIndex: 1, x: 520, y: 380, width: 190 },
  ],
  signed: [{ pageIndex: 1, x: 330, y: 548, width: 180 }],
};

function toUser(page: PDFPage, vx: number, vy: number): [number, number] {
  const { x: cx, y: cy, width: W, height: H } = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  if (rot === 0) return [cx + vx, cy + H - vy];
  if (rot === 90) return [cx + vy, cy + vx];
  if (rot === 180) return [cx + W - vx, cy + vy];
  return [cx + W - vy, cy + H - vx];
}

async function contract(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.addPage(A4);
  p1.drawText('CONTRATO DE PRESTAÇÃO DE SERVIÇOS', { x: 70, y: 770, size: 15, font: bold });
  ['CLÁUSULA 1 - OBJETO. Documento de teste do labsign.', 'Nenhum dado aqui é real.'].forEach((line, i) => p1.drawText(line, { x: 70, y: 720 - i * 20, size: 11, font }));
  const p2 = doc.addPage(A4);
  p2.drawText('E, por estarem justas e contratadas, as partes assinam o presente.', { x: 70, y: 770, size: 11, font });
  const lineY = A4[1] - 610;
  for (const [x, label, name] of [
    [70, 'CONTRATANTE', 'Maria Exemplo da Silva'],
    [320, 'CONTRATADO', 'Empresa Exemplo Ltda.'],
  ] as const) {
    p2.drawLine({ start: { x, y: lineY }, end: { x: x + 200, y: lineY }, thickness: 0.7, color: rgb(0, 0, 0) });
    p2.drawText(label, { x, y: lineY - 15, size: 10, font: bold });
    p2.drawText(name, { x, y: lineY - 29, size: 10, font });
  }
  return doc;
}

function fakeScanPng(w: number, h: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w, 236);
    row[0] = 0;
    if (y > 70 && y < h - 260 && y % 22 < 7) for (let x = 60; x < w - 60 - ((y * 37) % 140); x++) row[1 + x] = 70 + ((x * 13 + y * 7) % 60);
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function selfSignedP12(passphrase: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  const attrs = [{ name: 'commonName', value: 'Contraparte Ficticia (teste labsign)' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/** Gera os PDFs de exemplo em `dir`: normal, rotacionado, deslocado (escaneado) e já assinado digitalmente. */
export async function makeFixtures(dir: string, { signed = false } = {}) {
  const normal = await contract();
  writeFileSync(join(dir, 'normal.pdf'), await normal.save({ useObjectStreams: false }));

  const rotated = await PDFDocument.create();
  const font = await rotated.embedFont(StandardFonts.Helvetica);
  [90, 180, 270].forEach((rot) => {
    const page = rotated.addPage(A4);
    page.setRotation(degrees(rot));
    const [x, y] = toUser(page, 60, 80);
    page.drawText(`Pagina com /Rotate ${rot}`, { x, y, size: 13, font, rotate: degrees(rot) });
  });
  writeFileSync(join(dir, 'rotated.pdf'), await rotated.save());

  const offset = await PDFDocument.create();
  const png = await offset.embedPng(fakeScanPng(555, 782));
  [0, 270].forEach((rot) => {
    const page = offset.addPage([595, 842]);
    page.setMediaBox(20, 30, 595, 842);
    page.setCropBox(40, 60, 555, 782);
    page.setRotation(degrees(rot));
    page.drawImage(png, { x: 40, y: 60, width: 555, height: 782 });
  });
  writeFileSync(join(dir, 'offset.pdf'), await offset.save());

  if (signed) {
    const withPlaceholder = plainAddPlaceholder({
      pdfBuffer: Buffer.from(await (await contract()).save({ useObjectStreams: false })),
      reason: 'Assinatura digital da contraparte (teste)',
      contactInfo: 'teste@example.com',
      name: 'Contraparte Ficticia',
      location: 'Sao Paulo',
    });
    writeFileSync(join(dir, 'signed.pdf'), await new SignPdf().sign(withPlaceholder, new P12Signer(selfSignedP12('labsign'), { passphrase: 'labsign' })));
  }
}

/** Renderiza uma página com o poppler e devolve os pixels (RGB). */
export function renderPage(pdfPath: string, pageNumber: number, dpi = 72) {
  const base = join(tempDir('labsign-render-'), 'p');
  execFileSync('pdftoppm', ['-r', String(dpi), '-cropbox', '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile', pdfPath, base]);
  const buf = readFileSync(`${base}.ppm`);
  let pos = 0;
  const tok = () => {
    while (buf[pos] === 0x0a || buf[pos] === 0x20) pos++;
    let s = '';
    while (buf[pos] !== 0x0a && buf[pos] !== 0x20) s += String.fromCharCode(buf[pos++]);
    return s;
  };
  if (tok() !== 'P6') throw new Error('unexpected ppm');
  const w = Number(tok()), h = Number(tok());
  tok();
  pos++;
  return { w, h, px: buf.subarray(pos) };
}

/** Caixa da tinta que satisfaz `isInk` (em pixels = pontos, a 72 dpi). */
export function inkBox(img: ReturnType<typeof renderPage>, isInk: (r: number, g: number, b: number) => boolean) {
  const { w, h, px } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (!isInk(px[i], px[i + 1], px[i + 2])) continue;
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, n };
}

export const line = (x1: number, y1: number, x2: number, y2: number, n = 30): [number, number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, 0.5]);
