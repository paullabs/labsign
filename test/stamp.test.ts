// Carimbo: oráculo independente — renderiza com o poppler e confere nos PIXELS se a tinta caiu
// no retângulo pedido, em pé e sem espelhar, em páginas normais, rotacionadas e com origem deslocada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
