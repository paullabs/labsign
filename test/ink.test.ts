// Cor e espessura escolhidas na tela saem de fato no PDF: renderiza com o poppler e mede a tinta.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strokesToSignature, penOptions, inkRgb, inkHex, INKS, type Ink, type Pen } from '../src/core/signature.ts';
import { stampSignature } from '../src/core/stamp.ts';
import { makeFixtures, renderPage, tempDir, cleanup, POPPLER } from './helpers.ts';

let dir: string;
before(async () => {
  dir = tempDir();
  await makeFixtures(dir);
});
after(() => cleanup(dir));

const wave = [Array.from({ length: 60 }, (_, i) => [10 + i * 5, 40 + Math.sin(i / 4) * 22, 0.5] as [number, number, number])];
const place = [{ pageIndex: 0, x: 120, y: 420, width: 300 }]; // área em branco da página 1

async function stamp(pen: Pen, ink: Ink) {
  const { bytes } = await stampSignature({ pdfBytes: readFileSync(join(dir, 'normal.pdf')), signature: strokesToSignature(wave, penOptions(pen)), placements: place, color: inkRgb(ink) });
  const out = join(dir, `${pen}-${ink}.pdf`);
  writeFileSync(out, bytes);
  // região da assinatura a 144 dpi (2 px por ponto)
  const img = renderPage(out, 1, 144);
  let n = 0;
  const solid = [0, 0, 0];
  let solidN = 0;
  for (let y = 830; y < 1040; y++)
    for (let x = 230; x < 860; x++) {
      const i = (y * img.w + x) * 3;
      const lum = (img.px[i] + img.px[i + 1] + img.px[i + 2]) / 3;
      if (lum < 200) n++;
      if (lum < 120) {
        solid[0] += img.px[i];
        solid[1] += img.px[i + 1];
        solid[2] += img.px[i + 2];
        solidN++;
      }
    }
  return { n, rgb: solid.map((v) => Math.round(v / Math.max(1, solidN))) };
}

test('traço grosso deixa bem mais tinta que o fino (mesma largura de caixa)', { skip: !POPPLER && 'poppler não instalado' }, async () => {
  const fine = await stamp('fine', 'black');
  const bold = await stamp('bold', 'black');
  assert.ok(bold.n > fine.n * 1.6, `fino ${fine.n} px · grosso ${bold.n} px`);
});

for (const ink of Object.keys(INKS) as Ink[]) {
  test(`a cor "${ink}" sai no PDF como ${inkHex(ink)}`, { skip: !POPPLER && 'poppler não instalado' }, async () => {
    const { rgb } = await stamp('bold', ink);
    const want = [1, 3, 5].map((i) => parseInt(inkHex(ink).slice(i, i + 2), 16));
    const dist = Math.hypot(...rgb.map((v, i) => v - want[i]));
    assert.ok(dist < 18, `medido rgb(${rgb.join(', ')}) · distância ${dist.toFixed(1)}`);
  });
}

test('cor ou espessura desconhecida cai no padrão (azul-marinho, médio)', () => {
  assert.equal(inkHex('rosa'), INKS.navy);
  assert.equal(penOptions('enorme').size, 5);
});
