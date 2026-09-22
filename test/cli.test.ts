// O CLI montado: versão, ajuda nos dois idiomas, lista, doctor e a migração do cofre do protótipo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempDir, cleanup, line } from './helpers.ts';
import { strokesToSignature } from '../src/core/signature.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../dist/labsign.js');
const run = (args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, LABSIGN_NO_OPEN: '1', ...env } });

test('versão e ajuda em português e inglês', () => {
  assert.match(run(['--version']).trim(), /^\d+\.\d+\.\d+$/);
  assert.match(run(['--help'], { LABSIGN_LANG: 'pt' }), /assine PDFs com a sua assinatura/);
  assert.match(run(['--help'], { LABSIGN_LANG: 'en' }), /sign PDFs with your own signature/);
});

test('lista vazia e doctor com cofre isolado', () => {
  const home = tempDir();
  try {
    assert.match(run(['list'], { LABSIGN_HOME: home, LABSIGN_LANG: 'pt' }), /Nenhuma assinatura salva/);
    const out = run(['doctor'], { LABSIGN_HOME: home, LABSIGN_LANG: 'en' });
    assert.match(out, /Audit log intact/);
    assert.match(out, /Screen built: ok/);
    assert.match(out, /claude mcp add labsign/);
    assert.match(out, /nothing was changed/);
  } finally {
    cleanup(home);
  }
});

test('arquivo que não existe ou não é PDF: mensagem clara na língua da pessoa, sem abrir tela', () => {
  const home = tempDir();
  const fail = (args: string[], lang: string) => {
    try {
      run(args, { LABSIGN_HOME: home, LABSIGN_LANG: lang });
    } catch (e) {
      const err = e as { status: number; stderr: string };
      return { status: err.status, stderr: err.stderr };
    }
    assert.fail(`labsign ${args.join(' ')} deveria falhar`);
  };
  try {
    const notPdf = join(home, 'nota.txt');
    writeFileSync(notPdf, 'não sou um PDF');
    const missing = fail(['sign', join(home, 'sumiu.pdf')], 'pt');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Arquivo não encontrado: .*sumiu\.pdf/);
    assert.match(fail(['sign', join(home, 'sumiu.pdf')], 'en').stderr, /File not found: .*sumiu\.pdf/);
    assert.match(fail(['sign', notPdf], 'pt').stderr, /não é um PDF/);
    assert.match(fail(['sign', home], 'en').stderr, /not a PDF/);
  } finally {
    cleanup(home);
  }
});

test('argumentos: flag antes do arquivo vale; flag desconhecida ou sem valor é erro 64', () => {
  const home = tempDir();
  const fail = (args: string[]) => {
    try {
      run(args, { LABSIGN_HOME: home, LABSIGN_LANG: 'pt' });
    } catch (e) {
      return e as { status: number; stderr: string };
    }
    return assert.fail(`labsign ${args.join(' ')} deveria falhar`);
  };
  try {
    // o arquivo depois da flag é lido (e não existe): prova que ele não foi ignorado a favor da tela de "escolha o PDF"
    const after = fail(['sign', '--anchor', 'CONTRATADO', join(home, 'sumiu.pdf')]);
    assert.equal(after.status, 1);
    assert.match(after.stderr, /Arquivo não encontrado: .*sumiu\.pdf/);
    for (const args of [['sign', '--bogus', 'x.pdf'], ['sign', 'x.pdf', '--anchor'], ['sign', 'a.pdf', 'b.pdf']]) {
      const bad = fail(args);
      assert.equal(bad.status, 64, args.join(' '));
      assert.match(bad.stderr, /Não entendi o comando/);
    }
    assert.match(run(['-v']).trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    cleanup(home);
  }
});

test('primeira execução traz uma cópia do cofre do protótipo (e só uma vez)', () => {
  const fakeHome = tempDir();
  try {
    const spike = join(fakeHome, '.labsign-spike/signatures');
    mkdirSync(spike, { recursive: true });
    const strokes = [line(0, 0, 100, 30)];
    const record = { id: 'abcdef12', label: 'Assinatura do protótipo', kind: 'assinatura', createdAt: new Date().toISOString(), strokes, signature: strokesToSignature(strokes) };
    writeFileSync(join(spike, 'abcdef12.json'), JSON.stringify(record));
    const first = run(['list'], { HOME: fakeHome, LABSIGN_LANG: 'pt', LABSIGN_HOME: '' });
    assert.match(first, /Trouxe 1 assinatura/);
    assert.match(first, /Assinatura do protótipo/);
    assert.equal(statSync(join(fakeHome, '.labsign')).mode & 0o777, 0o700, 'cofre só do dono');
    assert.ok(existsSync(join(spike, 'abcdef12.json')), 'o original do protótipo fica onde estava');
    assert.doesNotMatch(run(['list'], { HOME: fakeHome, LABSIGN_LANG: 'pt', LABSIGN_HOME: '' }), /Trouxe/);
  } finally {
    cleanup(fakeHome);
  }
});
