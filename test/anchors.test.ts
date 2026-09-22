// Âncora: o rótulo do bloco de assinatura (no fim) vence as menções no corpo do contrato;
// rótulo partido em pedaços, acento e caixa não atrapalham; sem âncora, última página.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from '@cantoo/pdf-lib';
import { locateSignatureSpot } from '../src/core/anchors.ts';
import { makeFixtures, tempDir, cleanup } from './helpers.ts';

const A4: [number, number] = [595.28, 841.89];

type Draw = (page: PDFPage, fonts: { font: PDFFont; bold: PDFFont }) => void;

/** PDF de teste: uma função de desenho por página. */
async function pdf(...pages: Draw[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const draw of pages) draw(doc.addPage(A4), { font, bold });
  return doc.save();
}

/** Onde a assinatura deve sentar para um rótulo desenhado em (x, y) do PDF (página sem rotação). */
const expectedFor = (pageIndex: number, x: number, y: number) => ({ pageIndex, x: x + 8, bottom: Math.round(A4[1] - y) - 18 });

function assertNear(spot: Awaited<ReturnType<typeof locateSignatureSpot>>, want: { pageIndex: number; x: number; bottom: number }) {
  const { pageIndex, x, bottom } = spot.placement;
  assert.equal(pageIndex, want.pageIndex, 'página');
  assert.ok(Math.abs(x - want.x) <= 1.5, `x ${x} ≠ ${want.x}`);
  assert.ok(Math.abs((bottom ?? NaN) - want.bottom) <= 1.5, `base ${bottom} ≠ ${want.bottom}`);
}

const body = (lines: string[], top = 770): Draw => (page, { font }) => lines.forEach((l, i) => page.drawText(l, { x: 70, y: top - i * 16, size: 11, font }));

test('menções no corpo (página 1) perdem para o rótulo do bloco de assinatura (fim da página 2)', async () => {
  const bytes = await pdf(
    body(['A CONTRATANTE pagará à CONTRATADA o valor mensal combinado,', 'CONTRATANTE e CONTRATADA elegem o foro da comarca.']),
    (page, fonts) => {
      body(['Obrigações da CONTRATANTE: manter os dados atualizados e pagar em dia,', 'conforme a cláusula anterior, sob pena de multa.'])(page, fonts);
      page.drawText('CONTRATANTE: Maria Exemplo', { x: 90, y: 160, size: 10, font: fonts.bold });
    },
  );
  const spot = await locateSignatureSpot(bytes, 'CONTRATANTE');
  assert.equal(spot.anchor.found, true);
  assert.equal(spot.anchor.page, 2);
  assert.equal(spot.pageCount, 2);
  assertNear(spot, expectedFor(1, 90, 160));
});

test('rótulo vence mesmo com menção no corpo depois dele; colunas lado a lado contam como rótulos', async () => {
  const bytes = await pdf(
    body(['A CONTRATADA entregará o serviço no prazo.']),
    (page, { bold }) => {
      page.drawText('CONTRATANTE', { x: 70, y: 200, size: 10, font: bold });
      page.drawText('CONTRATADA', { x: 320, y: 200, size: 10, font: bold });
    },
    body(['ANEXO I - a CONTRATADA declara que leu e concorda com tudo.']),
  );
  assertNear(await locateSignatureSpot(bytes, 'CONTRATADA'), expectedFor(1, 320, 200));
  assertNear(await locateSignatureSpot(bytes, 'CONTRATANTE:'), expectedFor(1, 70, 200)); // ':' final da âncora é ignorado
});

test('sem nenhum rótulo, vale a última ocorrência de qualquer tipo', async () => {
  const bytes = await pdf(body(['A CONTRATANTE pagará o valor combinado.']), body(['Assinam a CONTRATANTE e a CONTRATADA.'], 300));
  const spot = await locateSignatureSpot(bytes, 'contratante');
  assert.equal(spot.anchor.found, true);
  assert.equal(spot.anchor.page, 2);
  assert.equal(spot.placement.pageIndex, 1);
  assert.equal(spot.placement.bottom, Math.round(A4[1] - 300) - 18);
  assert.ok(spot.placement.x > 78, 'no início da palavra, não no início da linha');
});

test('rótulo partido em dois pedaços na mesma linha é encontrado', async () => {
  const bytes = await pdf((page, { font, bold }) => {
    page.drawText('Mais um texto qualquer.', { x: 70, y: 700, size: 11, font });
    page.drawText('CONTRA', { x: 70, y: 180, size: 10, font: bold }); // fontes diferentes: o pdf.js não junta
    page.drawText('TANTE: Maria', { x: 70 + bold.widthOfTextAtSize('CONTRA', 10), y: 180, size: 10, font });
  });
  const spot = await locateSignatureSpot(bytes, 'CONTRATANTE');
  assert.equal(spot.anchor.found, true);
  assertNear(spot, expectedFor(0, 70, 180));
});

test('acento e caixa não importam (nos dois sentidos)', async () => {
  const plain = await pdf((page, { bold }) => page.drawText('LOCATARIA', { x: 100, y: 150, size: 10, font: bold }));
  const spot = await locateSignatureSpot(plain, 'Locatária');
  assert.equal(spot.anchor.found, true);
  assert.equal(spot.anchor.text, 'Locatária');
  assertNear(spot, expectedFor(0, 100, 150));

  const accented = await pdf((page, { font }) => page.drawText('Locatária: João', { x: 100, y: 150, size: 10, font }));
  assertNear(await locateSignatureSpot(accented, 'LOCATARIA'), expectedFor(0, 100, 150));
});

test('sem ocorrência: proposta na última página, found=false', async () => {
  const bytes = await pdf(body(['Nada a ver aqui.']), body(['Nem aqui.']), body(['Fim.']));
  for (const anchor of ['TESTEMUNHA', null, '  ', ':']) {
    const spot = await locateSignatureSpot(bytes, anchor);
    assert.equal(spot.anchor.found, false);
    assert.equal(spot.anchor.page, 3);
    assert.equal(spot.pageCount, 3);
    assert.deepEqual(spot.placement, { pageIndex: 2, x: Math.round((A4[0] - 170) / 2), bottom: Math.round(A4[1] - 96), width: 170, maxHeight: 55 });
  }
});

test('lista "Onde assinar": todos os blocos, com o nome de quem assina, sem as frases do corpo', async () => {
  const bytes = await pdf(
    body([
      'CONTRATANTE: PAULO EXEMPLO, brasileiro, casado, empresário, portador do RG nº 0000,',
      'A CONTRATANTE pagará à CONTRATADA o valor mensal combinado,',
      'CONTRATANTE e CONTRATADA elegem o foro da comarca.',
    ]),
    (page, { font, bold }) => {
      const at = (text: string, x: number, y: number, f = font) => page.drawText(text, { x, y, size: 10, font: f });
      at('______________________________', 70, 300);
      at('CONTRATANTE', 70, 285, bold);
      at('Maria Exemplo da Silva', 70, 271);
      at('______________________________', 320, 300);
      at('Pela CONTRATADA:', 320, 285, bold);
      at('EMPRESA EXEMPLO LTDA.', 320, 271);
      at('TESTEMUNHAS:', 70, 220, bold);
      at('Testemunha 1', 70, 150, bold);
      at('Nome: João Teste', 70, 136);
      at('CPF: 000.000.000-00', 70, 122);
      at('Testemunha 2', 320, 150, bold);
      at('Nome: Ana Teste', 320, 136);
    },
  );
  const spot = await locateSignatureSpot(bytes, 'CONTRATANTE');
  assert.deepEqual(
    spot.spots.map((s) => [s.label, s.name, s.page]),
    [
      ['CONTRATANTE', 'Maria Exemplo da Silva', 2],
      ['Pela CONTRATADA', 'EMPRESA EXEMPLO LTDA.', 2],
      ['Testemunha 1', 'João Teste', 2],
      ['Testemunha 2', 'Ana Teste', 2],
    ],
  );
  assertNear(spot, expectedFor(1, 70, 285));
  assert.deepEqual(spot.spots[0].placement, spot.placement, 'a âncora escolhida é o mesmo lugar da lista');
});

test('nome entre a linha e o rótulo: a assinatura senta acima do nome; âncora que não é papel entra na lista', async () => {
  const bytes = await pdf((page, { font, bold }) => {
    page.drawText('________________________', { x: 100, y: 240, size: 10, font });
    page.drawText('Joana Exemplo', { x: 100, y: 226, size: 10, font });
    page.drawText('LOCATÁRIA', { x: 100, y: 212, size: 10, font: bold });
    page.drawText('Visto do corretor', { x: 330, y: 212, size: 10, font: bold });
  });
  const spot = await locateSignatureSpot(bytes, 'LOCATARIA');
  assert.deepEqual(spot.spots[0], { label: 'LOCATÁRIA', name: 'Joana Exemplo', page: 1, placement: { ...expectedFor(0, 100, 226), width: 170, maxHeight: 55 } });
  assertNear(spot, expectedFor(0, 100, 226));
  const custom = await locateSignatureSpot(bytes, 'Visto do corretor');
  assert.ok(custom.spots.some((s) => s.label === 'Visto do corretor' && s.page === 1));
  assertNear(custom, expectedFor(0, 330, 212));
});

test('PDF sem texto (escaneado): lista vazia, proposta na última página', async () => {
  const spot = await locateSignatureSpot(await pdf(() => {}, () => {}), 'CONTRATANTE');
  assert.deepEqual(spot.spots, []);
  assert.equal(spot.anchor.found, false);
  assert.equal(spot.placement.pageIndex, 1);
});

let dir: string;
before(async () => {
  dir = tempDir();
  await makeFixtures(dir);
});
after(() => cleanup(dir));

test('fixtures: contrato de exemplo e páginas com /Rotate (texto em pé na tela)', async () => {
  const normal = await locateSignatureSpot(readFileSync(join(dir, 'normal.pdf')), 'CONTRATANTE');
  assert.deepEqual(normal.placement, { pageIndex: 1, x: 78, bottom: 607, width: 170, maxHeight: 55 });
  const other = await locateSignatureSpot(readFileSync(join(dir, 'normal.pdf')), 'CONTRATADO');
  assert.deepEqual(other.placement, { pageIndex: 1, x: 328, bottom: 607, width: 170, maxHeight: 55 });
  const rotated = readFileSync(join(dir, 'rotated.pdf'));
  for (const [i, rot] of [90, 180, 270].entries()) {
    const spot = await locateSignatureSpot(rotated, `Pagina com /Rotate ${rot}`);
    assert.equal(spot.anchor.found, true, `/Rotate ${rot}`);
    assertNear(spot, { pageIndex: i, x: 68, bottom: 80 - 18 });
  }
});
