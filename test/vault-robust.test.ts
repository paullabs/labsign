// Cofre à prova de tropeços: arquivo corrompido não derruba a lista, config estranho vira padrão,
// linha cortada no log não trava a auditoria, processos concorrentes não bifurcam a cadeia,
// e o carimbo respeita CropBox ∩ MediaBox (como o pdf.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, chmodSync, existsSync, mkdtempSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { PDFDocument, PDFName, degrees } from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { tempDir as mkTemp, cleanup, line, POPPLER, renderPage, inkBox } from './helpers.ts';

const temps: string[] = [];
const tempDir = () => {
  const d = mkTemp();
  temps.push(d);
  return d;
};
after(() => temps.forEach(cleanup));

// o cofre lê LABSIGN_HOME ao carregar: isolar ANTES de importar.
// A pasta já existe (e com 0750): o labsign não deve mexer nas permissões dela.
const home = tempDir();
chmodSync(home, 0o750);
process.env.LABSIGN_HOME = home;
const vault = await import('../src/core/vault.ts');
const { strokesToSignature } = await import('../src/core/signature.ts');
const { stampSignature, visualPageSize, signatureMatrix } = await import('../src/core/stamp.ts');

const strokes = [line(10, 40, 200, 60, 20)];
const sigDir = join(home, 'signatures');
const POSIX = process.platform !== 'win32';

test('LABSIGN_HOME que já existia mantém as permissões; pasta criada pelo labsign fica 0700', { skip: !POSIX && 'permissões POSIX' }, async () => {
  vault.saveSignature({ label: 'Primeira', strokes });
  assert.equal(statSync(home).mode & 0o777, 0o750);
  const fresh = join(mkdtempSync(join(home, 'child-')), 'novo', 'cofre');
  const { code } = await runChild(fresh, `v.audit({ event: 'hello' });`);
  assert.equal(code, 0);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
});

test('gravações atômicas: nada de temporário largado, tudo 0600', { skip: !POSIX && 'permissões POSIX' }, () => {
  const meta = vault.saveSignature({ label: 'Atômica', strokes });
  vault.markSignatureUsed(meta.id);
  vault.setPrefs({ ink: 'black' });
  for (const dir of [home, sigDir]) assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], dir);
  for (const f of [`${meta.id}.json`, `${meta.id}.svg`]) assert.equal(statSync(join(sigDir, f)).mode & 0o777, 0o600, f);
  assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  assert.ok(vault.loadSignature(meta.id).lastUsedAt);
});

test('id sorteado que já existe: sorteia outro, nunca sobrescreve', () => {
  const victim = vault.saveSignature({ label: 'Não pode sumir', strokes });
  const before = readFileSync(join(sigDir, `${victim.id}.json`), 'utf8');
  const original = crypto.randomUUID;
  let forced = 0;
  crypto.randomUUID = ((...args: Parameters<typeof original>) => (forced++ < 3 ? `${victim.id}-0000-4000-8000-000000000000` : original(...args))) as typeof original;
  syncBuiltinESMExports();
  try {
    const next = vault.saveSignature({ label: 'Nova', strokes });
    assert.ok(forced > 3, 'o id repetido foi sorteado');
    assert.notEqual(next.id, victim.id);
  } finally {
    crypto.randomUUID = original;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(join(sigDir, `${victim.id}.json`), 'utf8'), before);
  assert.equal(vault.loadSignature(victim.id).label, 'Não pode sumir');
});

test('assinatura corrompida ou incompleta não derruba a lista', () => {
  const ok = vault.saveSignature({ label: 'Boa', strokes });
  writeFileSync(join(sigDir, 'deadbeef.json'), '{"id":"deadbeef","label":"Cort');
  writeFileSync(join(sigDir, 'cafebabe.json'), JSON.stringify({ id: 'cafebabe', label: 'Sem traços', strokes: 'nope' }));
  writeFileSync(join(sigDir, 'abad1dea.json'), 'null');
  writeFileSync(join(sigDir, 'feedf00d.json'), '');
  writeFileSync(join(sigDir, '0badf00d.json'), JSON.stringify({ label: 'Sem data', strokes })); // sem id/kind/createdAt: completa
  const list = vault.listSignatures();
  const ids = list.map((s) => s.id);
  assert.ok(ids.includes(ok.id) && ids.includes('0badf00d'));
  for (const bad of ['deadbeef', 'cafebabe', 'abad1dea', 'feedf00d']) assert.ok(!ids.includes(bad), bad);
  const filled = list.find((s) => s.id === '0badf00d')!;
  assert.equal(filled.kind, 'signature');
  assert.ok(Number.isFinite(Date.parse(filled.createdAt)));
  assert.ok(vault.listSignaturesForUi().every((s) => Array.isArray(s.strokes) && s.strokes.length));
  assert.throws(() => vault.loadSignature('deadbeef'), /not found/);
  assert.equal(vault.loadSignature('0badf00d').label, 'Sem data');
});

test('config.json inválido ("null", lista, prefs nulo, lixo): preferências padrão', () => {
  const defaults = { drawMode: 'drag', ink: 'navy', pen: 'medium', panel: 'm', fill: { city: '', name: '', doc: '' }, rubrica: { dx: 40, dy: 56, w: 58, withSigned: false } };
  for (const content of ['null', '[1,2]', '{"prefs":null}', '{"prefs":"x"}', '42', '{nope']) {
    writeFileSync(join(home, 'config.json'), content);
    assert.deepEqual(vault.getPrefs(), defaults, content);
  }
  writeFileSync(join(home, 'config.json'), 'null');
  assert.deepEqual(vault.setPrefs({ pen: 'bold' }), { ...defaults, pen: 'bold' });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { prefs: { ...defaults, pen: 'bold' } });
});

test('última linha do log cortada (queda de energia): a auditoria continua, e a verificação acusa', () => {
  const file = join(home, 'audit.jsonl');
  const a = vault.audit({ event: 'antes' });
  const b = vault.audit({ event: 'antes 2' });
  assert.equal(vault.verifyAuditChain().ok, true);
  appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), event: 'cortada', prev: b.hash }).slice(0, 40)); // sem '\n'
  const c = vault.audit({ event: 'depois' });
  assert.equal(c.prev, b.hash, 'encadeia na última linha legível');
  assert.notEqual(c.prev, a.hash);
  const lines = readFileSync(file, 'utf8').split('\n');
  assert.deepEqual(JSON.parse(lines.at(-2)!), c, 'a nova entrada fica numa linha própria');
  const d = vault.audit({ event: 'depois 2' });
  assert.equal(d.prev, c.hash);
  assert.deepEqual(vault.verifyAuditChain(), { ok: false, entries: lines.filter(Boolean).length + 1 });
});

/** Roda um trecho com o cofre importado como `v`, noutro processo, com o LABSIGN_HOME dado. */
function runChild(labsignHome: string, code: string, env: Record<string, string> = {}) {
  const url = new URL('../src/core/vault.ts', import.meta.url).href;
  const script = `const v = await import(${JSON.stringify(url)});\n${code}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...env, LABSIGN_HOME: labsignHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on('close', (c) => resolve({ code: c, out, err })));
}

test('3 processos acrescentando ao mesmo tempo: a cadeia não bifurca', async () => {
  const shared = tempDir();
  const N = 200;
  const loop = `const n = Number(process.env.N); for (let i = 0; i < n; i++) v.audit({ event: 'concorrencia', proc: process.env.P, i });`;
  const results = await Promise.all(['a', 'b', 'c'].map((P) => runChild(shared, loop, { N: String(N), P })));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const entries = readFileSync(join(shared, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.length, 3 * N);
  assert.equal(new Set(entries.map((e) => e.prev)).size, entries.length, 'nenhum prev repetido');
  assert.equal(existsSync(join(shared, 'audit.jsonl.lock')), false, 'trava liberada');
  const check = await runChild(shared, `process.stdout.write(JSON.stringify(v.verifyAuditChain()));`);
  assert.deepEqual(JSON.parse(check.out), { ok: true, entries: 3 * N });
});

test('trava abandonada (processo morreu segurando) vence e não trava a auditoria', () => {
  const lock = join(home, 'audit.jsonl.lock');
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const t0 = Date.now();
  vault.audit({ event: 'depois da trava velha' });
  assert.ok(Date.now() - t0 < 1000, 'não esperou o prazo inteiro');
  assert.equal(existsSync(lock), false);
});

test('trava recente de outro processo: espera ~2 s e registra mesmo assim', () => {
  const lock = join(home, 'audit.jsonl.lock');
  writeFileSync(lock, '');
  const t0 = Date.now();
  const entry = vault.audit({ event: 'com trava presa' });
  const waited = Date.now() - t0;
  assert.ok(waited >= 1900 && waited < 4000, `${waited} ms`);
  assert.equal(entry.event, 'com trava presa');
  assert.equal(existsSync(lock), true, 'não apaga a trava que não é sua');
  rmSync(lock);
});

// --- CropBox maior que o MediaBox: o pdf.js recorta pela interseção; o carimbo precisa fazer igual ---

/** Oráculo: o pdf.js diz onde cada ponto visual cai no espaço do usuário. */
async function pdfjsPages(bytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push((await doc.getPage(n)).getViewport({ scale: 1 }));
  await task.destroy();
  return pages;
}

test('CropBox maior que o MediaBox (e invertido, e parcialmente fora): matriz e tamanho batem com o pdf.js', async () => {
  const doc = await PDFDocument.create();
  const setups: [string, (p: ReturnType<typeof doc.addPage>) => void][] = [
    ['maior', (p) => p.setCropBox(-50, -50, 695, 942)],
    ['invertido', (p) => p.node.set(PDFName.of('CropBox'), doc.context.obj([645, 892, -50, -50]))],
    ['parcial', (p) => p.setCropBox(300, -100, 600, 600)],
    ['fora', (p) => p.setCropBox(2000, 2000, 100, 100)],
  ];
  const cases: { name: string; rot: number }[] = [];
  for (const [name, setCrop] of setups)
    for (const rot of [0, 90, 180, 270]) {
      const page = doc.addPage([595, 842]);
      setCrop(page);
      page.setRotation(degrees(rot));
      cases.push({ name, rot });
    }
  const bytes = await doc.save();
  const viewports = await pdfjsPages(bytes);
  const pages = (await PDFDocument.load(bytes)).getPages();
  const [vx, vy, k] = [60, 90, 0.5];
  cases.forEach(({ name, rot }, i) => {
    const label = `${name} /Rotate ${rot}`;
    const vp = viewports[i];
    assert.deepEqual(visualPageSize(pages[i]), { width: vp.width, height: vp.height }, label);
    const [a, b, c, d, e, f] = signatureMatrix(pages[i], vx, vy, k);
    // (0,0) da assinatura -> ponto visual (vx, vy); +x -> direita; +y -> para baixo
    const near = (p: number[], q: number[]) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
    assert.ok(near([e, f], vp.convertToPdfPoint(vx, vy)), `${label}: origem`);
    assert.ok(near([e + a, f + b], vp.convertToPdfPoint(vx + k, vy)), `${label}: eixo x`);
    assert.ok(near([e + c, f + d], vp.convertToPdfPoint(vx, vy + k)), `${label}: eixo y`);
  });
});

test('CropBox maior que o MediaBox: a tinta cai onde a tela mostrou (poppler)', { skip: !POPPLER && 'poppler (pdftoppm) não instalado' }, async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).setCropBox(-50, -50, 695, 942);
  const pdfBytes = await doc.save();
  const signature = strokesToSignature([line(10, 90, 290, 90, 40), line(20, 10, 20, 50, 40)], { size: 6, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true });
  const target = { pageIndex: 0, x: 120, y: 300, width: 180 };
  const { bytes } = await stampSignature({ pdfBytes, signature, placements: [target], color: [0, 0, 1] });
  const out = join(tempDir(), 'crop.pdf');
  writeFileSync(out, bytes);
  const img = renderPage(out, 1);
  assert.deepEqual([img.w, img.h], [595, 842], 'o poppler também recorta pela interseção');
  const box = inkBox(img, (r, g, bl) => bl > 140 && r < 110 && g < 110);
  assert.ok(box, 'nenhuma tinta encontrada');
  assert.ok(Math.abs(box.x - target.x) <= 2.5 && Math.abs(box.y - target.y) <= 2.5, `posição ${box.x},${box.y} ≠ ${target.x},${target.y}`);
});
