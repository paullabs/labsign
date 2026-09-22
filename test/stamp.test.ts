// Carimbo: oráculo independente — renderiza com o poppler e confere nos PIXELS se a tinta caiu
// no retângulo pedido, em pé e sem espelhar, em páginas normais, rotacionadas e com origem deslocada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { strokesToSignature } from '../src/core/signature.ts';
import { stampSignature, hasDigitalSignature } from '../src/core/stamp.ts';
import { makeFixtures, renderPage, inkBox, tempDir, cleanup, TARGETS, POPPLER, PDFSIG, line } from './helpers.ts';

let dir: string;
before(async () => {
  dir = tempDir();
  await makeFixtures(dir, { signed: true });
});
after(() => cleanup(dir));

// linha de base embaixo + risco vertical no alto à esquerda: se sair espelhada ou de ponta-cabeça, aparece
const signature = strokesToSignature([line(10, 90, 290, 90, 40), line(20, 10, 20, 50, 40)], { size: 6, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true });
const BLUE: [number, number, number] = [0, 0, 1];
const isBlue = (r: number, g: number, b: number) => b > 140 && r < 110 && g < 110;

function checkPlacement(pdfPath: string, p: { pageIndex: number; x: number; y: number; width: number }) {
  const img = renderPage(pdfPath, p.pageIndex + 1);
  const box = inkBox(img, isBlue);
  assert.ok(box, 'nenhuma tinta encontrada');
  const expectedH = (p.width / signature.width) * signature.height;
  assert.ok(Math.abs(box.x - p.x) <= 2.5 && Math.abs(box.y - p.y) <= 2.5, `posição ${box.x},${box.y} ≠ ${p.x},${p.y}`);
  assert.ok(Math.abs(box.w - p.width) <= 3.5 && Math.abs(box.h - expectedH) <= 3.5, `tamanho ${box.w}x${box.h}`);
  // em pé: a linha de base (terço de baixo) tem bem mais tinta que o terço de cima; sem espelho: o risco fica à esquerda
  const count = (x0: number, y0: number, x1: number, y1: number) => {
    let n = 0;
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const i = (y * img.w + x) * 3;
      if (isBlue(img.px[i], img.px[i + 1], img.px[i + 2])) n++;
    }
    return n;
  };
  const bottom = count(box.x, box.y + (2 * box.h) / 3, box.x + box.w - 1, box.y + box.h - 1);
  const top = count(box.x, box.y, box.x + box.w - 1, box.y + box.h / 3);
  assert.ok(bottom > top * 3, 'de ponta-cabeça');
  assert.ok(count(box.x, box.y, box.x + box.w / 2, box.y + box.h / 2) > 0 && count(box.x + box.w / 2 + 1, box.y, box.x + box.w - 1, box.y + box.h / 2) === 0, 'espelhado');
}

for (const name of ['normal', 'rotated', 'offset'] as const) {
  for (const mode of ['incremental', 'rewrite'] as const) {
    test(`${name} [${mode}]: tinta no lugar, em pé e sem espelhar`, { skip: !POPPLER && 'poppler (pdftoppm) não instalado' }, async () => {
      const pdfBytes = readFileSync(join(dir, `${name}.pdf`));
      const { bytes } = await stampSignature({ pdfBytes, signature, placements: TARGETS[name], mode, color: BLUE });
      const out = join(dir, `${name}.${mode}.out.pdf`);
      writeFileSync(out, bytes);
      for (const p of TARGETS[name]) checkPlacement(out, p);
    });
  }
  test(`${name}: save incremental deixa o original intacto como prefixo`, async () => {
    const pdfBytes = readFileSync(join(dir, `${name}.pdf`));
    const { bytes } = await stampSignature({ pdfBytes, signature, placements: TARGETS[name] });
    assert.ok(Buffer.from(bytes).subarray(0, pdfBytes.length).equals(pdfBytes));
  });
}

test('detecta assinatura digital existente', () => {
  assert.equal(hasDigitalSignature(readFileSync(join(dir, 'signed.pdf'))), true);
  assert.equal(hasDigitalSignature(readFileSync(join(dir, 'normal.pdf'))), false);
});

test('assinatura digital de terceiros continua válida (incremental) e é destruída numa reescrita', { skip: !PDFSIG && 'poppler (pdfsig) não instalado' }, async () => {
  const pdfsig = (p: string) => {
    try {
      return execFileSync('pdfsig', [p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e: any) {
      return String(e.stdout ?? e.message);
    }
  };
  const pdfBytes = readFileSync(join(dir, 'signed.pdf'));
  for (const mode of ['incremental', 'rewrite'] as const) {
    const { bytes } = await stampSignature({ pdfBytes, signature, placements: TARGETS.signed, mode });
    const out = join(dir, `signed.${mode}.out.pdf`);
    writeFileSync(out, bytes);
    assert.equal(/Signature is Valid/.test(pdfsig(out)), mode === 'incremental', mode);
  }
});

test('posição fora da página é recusada', async () => {
  const pdfBytes = readFileSync(join(dir, 'normal.pdf'));
  await assert.rejects(stampSignature({ pdfBytes, signature, placements: [{ pageIndex: 1, x: 500, y: 100, width: 170 }] }), /outside page 2/);
  await assert.rejects(stampSignature({ pdfBytes, signature, placements: [{ pageIndex: 9, x: 10, y: 10, width: 50 }] }), /page 10 does not exist/);
});

test('assinatura, rubrica e texto (local e data) no mesmo salvamento incremental; texto em pé e no lugar, até em página girada', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  await import('../src/core/anchors.ts'); // registra o "worker" do pdf.js na própria thread
  for (const name of ['normal', 'rotated'] as const) {
    const pdfBytes = readFileSync(join(dir, `${name}.pdf`));
    const initials = strokesToSignature([line(10, 10, 60, 40, 10)]);
    const target = { pageIndex: name === 'normal' ? 1 : 0, x: 80, y: 120 };
    const { bytes } = await stampSignature({
      pdfBytes,
      groups: [
        { signature, placements: TARGETS[name].slice(0, 1) },
        { signature: initials, placements: [{ pageIndex: 0, x: 500, y: 760, width: 40 }].filter(() => name === 'normal') },
      ],
      texts: [{ ...target, size: 10, lines: ['São Paulo, 22 de setembro de 2026', 'Maria Exemplo · CPF 000.000.000-00 😀'] }],
    });
    assert.ok(Buffer.from(bytes).subarray(0, pdfBytes.length).equals(pdfBytes), 'original como prefixo');
    const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    const doc = await task.promise;
    const page = await doc.getPage(target.pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    const items = (await page.getTextContent()).items as any[];
    const hit = items.find((it) => it.str?.includes('São Paulo, 22 de setembro de 2026'));
    assert.ok(hit, `${name}: texto encontrado`);
    assert.ok(items.some((it) => it.str?.includes('CPF 000.000.000-00 ?')), 'caractere que a fonte não tem vira "?"');
    const [x, y] = vp.convertToViewportPoint(hit.transform[4], hit.transform[5]);
    assert.ok(Math.abs(x - target.x) < 1.5 && Math.abs(y - (target.y + 10 * 0.95)) < 1.5, `${name}: posição ${x},${y}`);
    // em pé na tela: a direção do texto, levada para a vista, aponta para a direita
    const [ax, ay] = vp.convertToViewportPoint(hit.transform[4] + hit.transform[0], hit.transform[5] + hit.transform[1]);
    assert.ok(ax - x > 0.5 && Math.abs(ay - y) < 0.5, `${name}: texto em pé`);
    await task.destroy();
  }
  await assert.rejects(stampSignature({ pdfBytes: readFileSync(join(dir, 'normal.pdf')), groups: [], texts: [{ pageIndex: 0, x: 520, y: 100, size: 12, lines: ['texto comprido demais para caber aqui'] }] }), /outside page 1/);
});

test('vários lugares (rubrica em todas as páginas): o desenho entra uma vez no arquivo, até com recursos divididos entre as páginas', { skip: !POPPLER && 'poppler (pdftoppm) não instalado' }, async () => {
  // páginas que apontam para um só dicionário de recursos, como exportam alguns editores de texto
  const src = await PDFDocument.create();
  const resources = src.context.register(src.context.obj({ ProcSet: ['PDF', 'Text'] }));
  for (let i = 0; i < 4; i++) src.addPage([595, 842]).node.set(PDFName.of('Resources'), resources);
  const pdfBytes = await src.save({ useObjectStreams: false });
  const placements = [0, 1, 2, 3].map((pageIndex) => ({ pageIndex, x: 470, y: 720, width: 80 }));
  const { bytes } = await stampSignature({ pdfBytes, groups: [{ signature, placements, color: BLUE }], texts: [{ pageIndex: 3, x: 80, y: 100, size: 10, lines: ['São Paulo'], color: [0, 0, 0] }] }); // texto em preto: a borda suavizada do azul-marinho passaria por tinta azul
  assert.ok(Buffer.from(bytes).subarray(0, pdfBytes.length).equals(pdfBytes), 'original como prefixo');
  const added = Buffer.from(bytes).subarray(pdfBytes.length).toString('latin1');
  assert.equal(added.match(/\/Subtype\s*\/Form/g)?.length, 1, 'um desenho só, referenciado pelas páginas');
  const out = join(dir, 'shared-resources.out.pdf');
  writeFileSync(out, bytes);
  for (const p of placements) checkPlacement(out, p);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  await import('../src/core/anchors.ts');
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const page = await (await task.promise).getPage(4);
  assert.ok(((await page.getTextContent()).items as any[]).some((it) => it.str?.includes('São Paulo')), 'texto com a fonte nos recursos divididos');
  await task.destroy();
});
