// Sessões: corridas na confirmação, abas, limites e entradas hostis (sem rede).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, line, makeFixtures } from './helpers.ts';

// o cofre lê LABSIGN_HOME ao carregar: isolar ANTES de importar
const home = tempDir();
const out = tempDir();
process.env.LABSIGN_HOME = home;
process.env.LABSIGN_OUTPUT_DIR = out;
const sessions = await import('../src/core/sessions.ts');

const strokes = [line(10, 40, 200, 60, 20)];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fixtures: string;
before(async () => {
  fixtures = tempDir();
  await makeFixtures(fixtures);
});
after(() => [home, out, fixtures].forEach(cleanup));

function signSession() {
  const file = join(fixtures, 'normal.pdf');
  const s = sessions.prepareSignSession({ file, placements: [{ pageIndex: 1, x: 80, y: 500, width: 170 }], client: 'test' });
  const sig = sessions.uiSaveSignature(s, { label: 'Teste', strokes });
  return { s, sig, file };
}
const signedCopies = () => readdirSync(fixtures).filter((f) => f.includes('.assinado'));

test('duas confirmações ao mesmo tempo: só uma assina', async () => {
  const { s, sig } = signSession();
  const before = signedCopies().length;
  const [a, b] = await Promise.allSettled([sessions.uiConfirm(s, { signatureId: sig.id }), sessions.uiConfirm(s, { signatureId: sig.id })]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal((b as PromiseRejectedResult).reason.code, 'SESSION_CLOSED');
  assert.equal(signedCopies().length, before + 1, 'um arquivo só');
  assert.equal(s.status, 'signed');
});

test('cancelado enquanto carimbava: nada é gravado e o status não vira', async () => {
  const { s, sig } = signSession();
  const before = signedCopies().length;
  const pending = sessions.uiConfirm(s, { signatureId: sig.id });
  sessions.uiCancel(s);
  await assert.rejects(pending, { code: 'SESSION_CLOSED' });
  assert.equal(s.status, 'cancelled');
  assert.equal(signedCopies().length, before);
});

test('pedido encerrado não recebe PDF nem mexe no cofre', async () => {
  const s = sessions.createAwaitingSignSession({ client: 'test' });
  const sig = sessions.uiSaveSignature(s, { label: 'Antes', strokes });
  sessions.uiCancel(s);
  const pdf = readFileSync(join(fixtures, 'normal.pdf'));
  await assert.rejects(sessions.uiUploadChunk(s, { name: 'x.pdf', size: pdf.length, data: pdf }), { code: 'SESSION_CLOSED' });
  assert.throws(() => sessions.uiSaveSignature(s, { label: 'Depois', strokes }), { code: 'SESSION_CLOSED' });
  assert.throws(() => sessions.uiDeleteSignature(s, { id: sig.id }), { code: 'SESSION_CLOSED' });
});

test('nome do PDF recebido pela tela não sai da pasta de saída', () => {
  for (const name of ['..', '.', '../../etc/passwd', '..\\..\\x.pdf', '.oculto.pdf', '', 'a/b.pdf', 'CON']) {
    const safe = sessions.safePdfName(name);
    assert.ok(!/[/\\]/.test(safe) && !safe.startsWith('.') && safe.endsWith('.pdf'), `${JSON.stringify(name)} → ${safe}`);
  }
  assert.equal(sessions.safePdfName('..'), 'documento.pdf');
  assert.equal(sessions.safePdfName('Contrato Aluguel.pdf'), 'Contrato Aluguel.pdf');
});

test('PDF com senha (de abertura ou só de permissões) e PDF danificado são recusados com código próprio', async () => {
  const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
  const { locateSignatureSpot, assertPdfReadable } = await import('../src/core/anchors.ts');
  const encrypted = async (opts: { userPassword?: string; ownerPassword?: string }) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('CONTRATANTE', { x: 80, y: 120, size: 12, font });
    doc.encrypt({ ownerPassword: 'dono', ...opts });
    return Buffer.from(await doc.save());
  };
  const userPw = await encrypted({ userPassword: 'segredo' });
  const ownerOnly = await encrypted({}); // abre sem senha, mas tem /Encrypt: o carimbo incremental não sabe regravar
  const broken = Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n');
  for (const [bytes, code] of [[userPw, 'ENCRYPTED'], [ownerOnly, 'ENCRYPTED'], [broken, 'NOT_PDF']] as const) {
    await assert.rejects(locateSignatureSpot(bytes, 'CONTRATANTE'), { code });
    await assert.rejects(assertPdfReadable(bytes), { code });
    const s = sessions.createAwaitingSignSession({ client: 'test' });
    await assert.rejects(sessions.uiUploadChunk(s, { name: 'x.pdf', size: bytes.length, data: bytes }), { code });
    assert.equal(s.awaiting, true, 'o pedido continua esperando um PDF válido');
    sessions.uiCancel(s);
  }
});

test('traços inválidos (não numéricos, infinitos, demais) são recusados antes de virar arquivo no cofre', () => {
  const s = sessions.createSession({ kind: 'pad', client: 'test', closeOnSave: false });
  const bad: unknown[] = [
    [[['a', 1]]],
    [[[1, Infinity]]],
    [[[1, 2, 3, 4]]],
    [[{ x: 1, y: 2 }]],
    Array.from({ length: 401 }, () => [[0, 0]]),
    [Array.from({ length: 60001 }, () => [0, 0])],
    'abc',
  ];
  for (const strokes of bad) assert.throws(() => sessions.uiSaveSignature(s, { label: 'ruim', strokes: strokes as never }), { code: 'EMPTY_DRAWING' });
  assert.equal(sessions.uiSaveSignature(s, { label: 'ok', strokes: [[[0, 0, 0.5], [10, 10]]] }).label, 'ok');
  sessions.uiFinish(s);
});

test('duas abas do mesmo pedido: fechar uma não encerra; fechar a última encerra depois da carência', async () => {
  const s = sessions.createAwaitingSignSession({ client: 'test' });
  sessions.pageOpened(s);
  sessions.pageOpened(s);
  sessions.uiClose(s, 50);
  await wait(120);
  assert.equal(s.status, 'pending', 'a outra aba continua aberta');
  sessions.uiClose(s, 50);
  await wait(120);
  assert.equal(s.status, 'cancelled');
});

test('limite de pedidos abertos: um modelo em loop não enche a memória', () => {
  const created: ReturnType<typeof sessions.createAwaitingSignSession>[] = [];
  try {
    assert.throws(() => {
      for (let i = 0; i <= sessions.MAX_PENDING; i++) created.push(sessions.createAwaitingSignSession({ client: 'test' }));
    }, { code: 'TOO_MANY_OPEN' });
  } finally {
    created.forEach((s) => sessions.uiCancel(s));
  }
  assert.doesNotThrow(() => sessions.uiCancel(sessions.createAwaitingSignSession({ client: 'test' })), 'cancelados liberam a vaga');
});
