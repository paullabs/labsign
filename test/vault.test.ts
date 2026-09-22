// Cofre e sessões (sem rede): rótulos únicos, preferências, apagar, auditoria e o ciclo de vida da tela.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, line } from './helpers.ts';

// o cofre lê LABSIGN_HOME ao carregar: isolar ANTES de importar
const home = tempDir();
process.env.LABSIGN_HOME = home;
const vault = await import('../src/core/vault.ts');
const sessions = await import('../src/core/sessions.ts');

const strokes = [line(10, 40, 200, 60, 20)];

test('rótulo repetido ou vazio vira único', () => {
  const s = sessions.createSession({ kind: 'pad', client: 'test', closeOnSave: false });
  const a = sessions.uiSaveSignature(s, { label: 'Assinatura', strokes });
  const b = sessions.uiSaveSignature(s, { label: 'Assinatura', strokes });
  const c = sessions.uiSaveSignature(s, { label: '   ', strokes });
  assert.deepEqual([a.label, b.label, c.label], ['Assinatura', 'Assinatura 2', 'Assinatura 3']);
});

test('o modelo só vê metadados; a tela recebe os traços', () => {
  const forModel = JSON.stringify(vault.listSignatures());
  assert.ok(!/strokes|outlines|svg/.test(forModel));
  assert.ok(vault.listSignaturesForUi().every((s) => Array.isArray(s.strokes) && s.strokes.length));
});

test('desenho vazio é recusado', () => {
  const s = sessions.createSession({ kind: 'pad', client: 'test' });
  assert.throws(() => sessions.uiSaveSignature(s, { strokes: [] }), /empty/);
  assert.throws(() => sessions.uiSaveSignature(s, { strokes: [[]] as any }), /empty/);
});

test('cofre: CLI continua aberto até "Concluir"; MCP encerra no primeiro salvar', () => {
  const cli = sessions.createSession({ kind: 'pad', client: 'cli', closeOnSave: false });
  sessions.uiSaveSignature(cli, { label: 'A', strokes });
  sessions.uiSaveSignature(cli, { label: 'B', strokes });
  assert.equal(cli.status, 'pending');
  const end = sessions.uiFinish(cli) as any;
  assert.equal(end.status, 'signed');
  assert.equal(end.signatures_saved, 2);
  const mcp = sessions.createSession({ kind: 'pad', client: 'mcp' });
  sessions.uiSaveSignature(mcp, { label: 'C', strokes });
  assert.equal(mcp.status, 'signed');
  const empty = sessions.createSession({ kind: 'pad', client: 'cli', closeOnSave: false });
  assert.equal((sessions.uiFinish(empty) as any).status, 'cancelled');
});

test('preferências: padrão segurar-e-arrastar/azul-marinho/médio; persistem; inválidas são ignoradas', () => {
  assert.deepEqual(vault.getPrefs(), { drawMode: 'drag', ink: 'navy', pen: 'medium' });
  vault.setPrefs({ drawMode: 'click', ink: 'blue', pen: 'bold' });
  vault.setPrefs({ drawMode: 'nope', ink: 'pink', pen: 'huge' });
  assert.deepEqual(vault.getPrefs(), { drawMode: 'click', ink: 'blue', pen: 'bold' });
});

test('apagar do cofre: some, audita e não apaga duas vezes', () => {
  const s = sessions.createSession({ kind: 'pad', client: 'test', closeOnSave: false });
  const victim = sessions.uiSaveSignature(s, { label: 'Para apagar', strokes });
  sessions.uiDeleteSignature(s, { id: victim.id });
  assert.ok(!vault.listSignatures().some((x) => x.id === victim.id));
  assert.throws(() => sessions.uiDeleteSignature(s, { id: victim.id }), /not found/);
  assert.throws(() => sessions.uiDeleteSignature(s, { id: '../../etc' }), /invalid signature id/);
  const log = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.at(-1).event, 'signature_deleted');
});

test('auditoria encadeada confere — e acusa adulteração', async () => {
  assert.equal(vault.verifyAuditChain().ok, true);
  const { writeFileSync } = await import('node:fs');
  const file = join(home, 'audit.jsonl');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('"Para apagar"', '"Outro nome"'));
  assert.equal(vault.verifyAuditChain().ok, false);
  writeFileSync(file, original);
});

test('fechar a aba libera quem espera (após a carência); sem aviso, o limite de tempo encerra', async () => {
  const s = sessions.createSession({ kind: 'pad', client: 'test' });
  const t0 = Date.now();
  setTimeout(() => sessions.uiClose(s), 100);
  await sessions.waitForClose(s.id, 5000, 150);
  const closed = Date.now() - t0;
  assert.ok(closed >= 240 && closed < 1200, `${closed} ms`);
  const t1 = Date.now();
  await sessions.waitForClose(sessions.createSession({ kind: 'pad', client: 'test' }).id, 300, 150);
  const timeout = Date.now() - t1;
  assert.ok(timeout >= 290 && timeout < 1000, `${timeout} ms`);
});

test('aba fechada com o pedido aberto: encerra depois da carência (e recarregar não conta)', async () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const sign = sessions.createAwaitingSignSession({ client: 'test' });
  sessions.uiClose(sign, 100);
  setTimeout(() => (sign.closed = false), 40); // recarregou: o GET reabre antes da carência
  await wait(200);
  assert.equal(sign.status, 'pending');
  sessions.uiClose(sign, 100);
  await wait(200);
  assert.equal(sign.status, 'cancelled', 'fechar sem assinar cancela: o CLI e o modelo param de esperar');

  const pad = sessions.createSession({ kind: 'pad', client: 'test', closeOnSave: false });
  sessions.uiSaveSignature(pad, { label: 'Salva antes de fechar', strokes });
  sessions.uiClose(pad, 100);
  await wait(200);
  assert.equal(pad.status, 'signed', 'o que já foi salvo no cofre conta como concluído');
  assert.equal((sessions.publicState(pad) as Record<string, unknown>).signatures_saved, 1);
});

test('recarregar a página não encerra; fechar de verdade encerra', async () => {
  const s = sessions.createSession({ kind: 'pad', client: 'test' });
  let ended = false;
  sessions.waitForClose(s.id, 3000, 300).then(() => (ended = true));
  setTimeout(() => sessions.uiClose(s), 100); // pagehide do recarregamento
  setTimeout(() => (s.closed = false), 200); // a página reabriu (o servidor faz isso no GET)
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(ended, false);
  sessions.uiClose(s);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(ended, true);
});
