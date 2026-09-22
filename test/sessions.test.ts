// Sessões: corridas na confirmação, abas, limites e entradas hostis (sem rede).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, line, makeFixtures } from './helpers.ts';

// o cofre lê LABSIGN_HOME ao carregar: isolar ANTES de importar
const home = tempDir();
const out = tempDir();
const trash = tempDir();
process.env.LABSIGN_HOME = home;
process.env.LABSIGN_OUTPUT_DIR = out;
process.env.LABSIGN_NO_OPEN = '1'; // nada de abrir Finder, e-mail ou navegador de verdade
process.env.LABSIGN_TRASH_DIR = trash; // "Lixeira" de mentira
const sessions = await import('../src/core/sessions.ts');

const strokes = [line(10, 40, 200, 60, 20)];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fixtures: string;
before(async () => {
  fixtures = tempDir();
  await makeFixtures(fixtures);
});
after(() => [home, out, trash, fixtures].forEach(cleanup));

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

test('remover o documento: o pedido volta a esperar um PDF e o arquivo continua no disco', async () => {
  const { s, file } = signSession();
  assert.equal(s.history.at(-1)?.event, 'document');
  const r = sessions.uiRemoveDocument(s);
  assert.deepEqual(r, { removed: true, name: 'normal.pdf' });
  assert.equal(s.awaiting, true);
  assert.equal(s.original, null);
  assert.ok(existsSync(file), 'o original não é apagado');
  assert.equal(sessions.uiState(s).document?.awaiting, true);
  assert.equal(s.history.at(-1)?.event, 'removed');
  // trocar: chega outro PDF pela tela, com a lista de lugares
  const pdf = readFileSync(join(fixtures, 'normal.pdf'));
  await sessions.uiUploadChunk(s, { name: 'certo.pdf', size: pdf.length, data: pdf });
  const doc = sessions.uiState(s).document as any;
  assert.equal(doc.name, 'certo.pdf');
  assert.deepEqual(doc.spots.map((x: any) => x.label), ['CONTRATANTE', 'CONTRATADO']);
  assert.equal(doc.pages, 2);
  sessions.uiCancel(s);
  assert.throws(() => sessions.uiRemoveDocument(s), { code: 'SESSION_CLOSED' });
});

test('salvar uma cópia em…: a janela do sistema escolhe o lugar; nunca substitui arquivo nenhum', async () => {
  const { s, sig, file } = signSession();
  assert.throws(() => sessions.uiSaveCopy(s), { code: 'NOT_SIGNED_YET' });
  await sessions.uiConfirm(s, { signatureId: sig.id });
  const dest = join(out, 'copia escolhida');
  process.env.LABSIGN_FAKE_SAVE_AS = dest;
  try {
    const started = sessions.uiSaveCopy(s, { prompt: 'Salvar' });
    assert.equal(started.state, 'running');
    const job = await sessions.uiSaveJob(s, { wait_ms: 5000 });
    assert.equal(job.state, 'done');
    assert.equal((job as any).file, `${dest}.pdf`, 'ganha .pdf');
    assert.ok(readFileSync(`${dest}.pdf`).equals(readFileSync(s.result!.signed_file!)));
    assert.equal(s.history.at(-1)?.event, 'saved_copy');

    // escolher um nome que já existe (aqui, o próprio original) não substitui nada: vira "-2"
    const originalBytes = readFileSync(file);
    process.env.LABSIGN_FAKE_SAVE_AS = file;
    sessions.uiSaveCopy(s);
    const renamed = await sessions.uiSaveJob(s, { wait_ms: 5000 });
    assert.equal(renamed.state, 'done');
    assert.equal((renamed as any).renamed, true);
    assert.equal((renamed as any).file, file.replace(/\.pdf$/, '-2.pdf'));
    assert.ok(readFileSync(file).equals(originalBytes), 'o original continua igual');
    process.env.LABSIGN_FAKE_SAVE_AS = `${dest}.pdf`;
    sessions.uiSaveCopy(s);
    assert.equal((await sessions.uiSaveJob(s, { wait_ms: 5000 }) as any).file, `${dest}-2.pdf`, 'a cópia anterior também não é substituída');

    process.env.LABSIGN_FAKE_SAVE_AS = '';
    sessions.uiSaveCopy(s);
    assert.equal((await sessions.uiSaveJob(s, { wait_ms: 5000 })).state, 'cancelled');
  } finally {
    delete process.env.LABSIGN_FAKE_SAVE_AS;
  }
});

test('entregar: só depois de assinar; e-mail por app que não existe é recusado; nada abre em teste', async () => {
  const { s, sig } = signSession();
  await assert.rejects(sessions.uiDeliver(s, { action: 'open' }), { code: 'NOT_SIGNED_YET' });
  await sessions.uiConfirm(s, { signatureId: sig.id });
  const opened = await sessions.uiDeliver(s, { action: 'open' });
  assert.equal(opened.done, false, 'LABSIGN_NO_OPEN');
  await assert.rejects(sessions.uiDeliver(s, { action: 'mail', client: 'default' as any }), process.platform === 'linux' ? () => true : { code: 'DELIVERY_UNAVAILABLE' });
  const gmail = await sessions.uiDeliver(s, { action: 'mail', client: 'gmail', subject: 'Assinado', body: 'Segue.' });
  assert.equal((gmail as any).guided, true);
  const wa = await sessions.uiDeliver(s, { action: 'whatsapp', phone: '+55 (11) 91234-5678', text: 'Segue' });
  assert.ok(['app', 'web'].includes((wa as any).via));
  const events = s.history.map((h) => h.event);
  for (const e of ['created', 'document', 'signed']) assert.ok(events.includes(e as any), e);
  for (const e of ['opened_file', 'mail', 'whatsapp']) assert.ok(!events.includes(e as any), `${e}: nada abriu, nada entra no histórico`);
});

test('desfazer: a cópia assinada vai para a Lixeira, o registro ganha uma linha e o pedido reabre', async () => {
  const { s, sig, file } = signSession();
  const first = await sessions.uiConfirm(s, { signatureId: sig.id });
  const signedFile = (first as any).signed_file as string;
  const no = sessions.uiState(s).registryNo;
  assert.ok(typeof no === 'number' && no >= 1);
  const r = await sessions.uiUndo(s);
  assert.equal(r.status, 'pending');
  assert.equal(r.trashed, true);
  assert.ok(!existsSync(signedFile), 'saiu da pasta');
  assert.ok(existsSync(join(trash, signedFile.split(/[\\/]/).pop()!)), 'está na Lixeira');
  assert.ok(existsSync(file), 'o original continua');
  assert.equal(s.history.at(-1)?.event, 'undone');
  const log = readFileSync(join(home, 'audit.jsonl'), 'utf8');
  assert.match(log, /"event":"signature_undone"/);
  // assina de novo com o mesmo documento
  const again = await sessions.uiConfirm(s, { signatureId: sig.id });
  assert.equal(again.status, 'signed');
  assert.ok(existsSync((again as any).signed_file));
  await assert.rejects(sessions.uiUndo(sessions.createAwaitingSignSession({ client: 'test' })), { code: 'NOT_SIGNED_YET' });
});

test('terminal depois de assinar: desfazer na tela reabre (e o terminal espera de novo); fechar a aba encerra', async () => {
  const { s, sig } = signSession();
  await sessions.uiConfirm(s, { signatureId: sig.id });
  const waiting = sessions.waitAfterSigned(s.id, 5000, 50);
  await sessions.uiUndo(s);
  assert.equal(await waiting, 'reopened');
  await sessions.uiConfirm(s, { signatureId: sig.id });
  sessions.pageOpened(s);
  const closing = sessions.waitAfterSigned(s.id, 5000, 50);
  sessions.uiClose(s, 50);
  assert.equal(await closing, 'closed');
  assert.equal(await sessions.waitAfterSigned(s.id, 200, 50), 'closed');
});

test('vários lugares, rubrica e local e data num salvamento só; comprovante ao lado, sem substituir nada; desfazer leva os dois', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  await import('../src/core/anchors.ts');
  const textOf = async (path: string) => {
    const task = getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 });
    const doc = await task.promise;
    let all = '';
    for (let i = 1; i <= doc.numPages; i++) all += ((await (await doc.getPage(i)).getTextContent()).items as any[]).map((it) => it.str).join(' ') + '\n';
    await task.destroy();
    return all;
  };
  const { s, sig } = signSession();
  const rubrica = sessions.uiSaveSignature(s, { label: 'Rubrica', kind: 'rubrica', strokes: [line(0, 0, 30, 20, 10)] });
  const out: any = await sessions.uiConfirm(s, {
    signatureId: sig.id,
    placements: [{ pageIndex: 1, x: 80, y: 500, width: 150 }, { pageIndex: 0, x: 80, y: 300, width: 120 }],
    initials: { signatureId: rubrica.id, placements: [{ pageIndex: 0, x: 500, y: 780, width: 40 }] },
    texts: [{ pageIndex: 1, x: 80, y: 460, size: 10, lines: ['São Paulo, 22 de setembro de 2026', 'Maria Exemplo'] }],
  });
  assert.deepEqual(out.pages, [2, 1]);
  assert.equal(out.initials_pages, 1);
  assert.equal(out.texts, 1);
  assert.match(await textOf(out.signed_file), /São Paulo, 22 de setembro de 2026/);
  const entry = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'document_signed').at(-1);
  assert.deepEqual(entry.initials.pages, [1]);
  assert.deepEqual(entry.texts, [{ page: 2, lines: 2 }], 'o registro guarda onde, não o texto');

  const rec = await sessions.uiReceipt(s, { lang: 'pt' });
  assert.match(rec.name, /\.assinado.*\.comprovante\.pdf$/);
  const receiptText = await textOf(rec.file);
  assert.match(receiptText, /Comprovante de assinatura/);
  assert.ok(receiptText.includes(out.sha256_signed), 'SHA-256 do assinado no comprovante');
  assert.match(receiptText, /Rubrica em 1 página/);
  assert.equal(rec.again, false);
  const again = await sessions.uiReceipt(s, { lang: 'pt' });
  assert.equal(again.file, rec.file, 'o segundo clique abre o mesmo comprovante, sem espalhar cópias pela pasta');
  assert.equal(again.again, true);

  await sessions.uiUndo(s);
  assert.ok(!existsSync(out.signed_file) && !existsSync(rec.file), 'a cópia e o comprovante dela vão para a Lixeira');
  await assert.rejects(sessions.uiConfirm(s, { signatureId: sig.id, texts: [{ pageIndex: 0, x: 10, y: 10, size: 40, lines: ['grande demais'] }] }), { code: 'INVALID_PLACEMENT' });

  // assinar de novo depois de desfazer: comprovante novo, não o da cópia que foi para a Lixeira
  await sessions.uiConfirm(s, { signatureId: sig.id, placements: [{ pageIndex: 0, x: 80, y: 300, width: 120 }] });
  const rec2 = await sessions.uiReceipt(s, { lang: 'en' });
  assert.equal(rec2.again, false);
  assert.match(await textOf(rec2.file), /Signing receipt/);
});
