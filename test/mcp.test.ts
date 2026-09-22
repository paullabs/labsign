// De ponta a ponta contra o pacote montado (dist/labsign.js mcp): um cliente MCP roteirizado
// se passa por dois tipos de app de chat —
//   A) sem tela embutida (Claude Code CLI, Codex CLI): página local + espera limitada
//   B) com MCP Apps (Claude Desktop, Cursor…): tela embutida + tools só-da-tela
// O "humano" é simulado por chamadas HTTP com cookie (A) ou pelas tools da tela (B).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { makeFixtures, tempDir, cleanup, line } from './helpers.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.LABSIGN_BIN || join(root, 'dist/labsign.js'); // LABSIGN_BIN: testar um pacote montado (.mcpb aberto) fora do repositório
const STROKES = [line(20, 120, 140, 40), line(140, 40, 190, 130), line(190, 130, 330, 60), line(30, 150, 360, 150)];
const UI_EXT = { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } };

let fixtures: string;
before(async () => {
  assert.ok(existsSync(BIN), 'rode "npm run build" antes');
  fixtures = tempDir();
  await makeFixtures(fixtures);
});
after(() => cleanup(fixtures));

async function connect(capabilities: Record<string, unknown>, waitMs: number, env: Record<string, string> = {}, work = tempDir()) {
  mkdirSync(join(work, 'saida'), { recursive: true });
  const file = join(work, 'contrato.pdf');
  copyFileSync(join(fixtures, 'normal.pdf'), file);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    env: { ...process.env, LABSIGN_NO_OPEN: '1', LABSIGN_HOME: join(work, 'vault'), LABSIGN_OUTPUT_DIR: join(work, 'saida'), LABSIGN_WAIT_MS: String(waitMs), ...env } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'labsign-test', version: '0' }, { capabilities });
  await client.connect(transport);
  return { client, file, work };
}

/** Abre a página como o humano: primeira abertura ganha cookie e token. */
async function openAsHuman(url: string) {
  const res = await fetch(url);
  const html = await res.text();
  const base = new URL(url).origin;
  const human = { 'x-labsign-view': /"viewToken":"([^"]+)"/.exec(html)?.[1] ?? '', cookie: res.headers.get('set-cookie')!.split(';')[0], origin: base };
  return { res, human, base };
}

test('A) app sem tela embutida: página local, espera limitada e as travas de segurança', async () => {
  const { client, file, work } = await connect({}, 2500);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['labsign_sign_document', 'labsign_status', 'labsign_list_signatures', 'labsign_manage_signatures']) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => n.startsWith('labsign_view_')), 'tools só-da-tela não existem sem MCP Apps');

    const t0 = Date.now();
    const r: any = await client.callTool({ name: 'labsign_sign_document', arguments: { file, anchor_text: 'CONTRATANTE' } });
    const st = r.structuredContent;
    assert.equal(st.status, 'pending');
    assert.ok(Date.now() - t0 >= 2400 && Date.now() - t0 < 6000, 'espera limitada');
    assert.equal(st.anchor_found, true);
    assert.match(st.url, /^http:\/\/127\.0\.0\.1:\d+\/s\//);
    assert.ok(!JSON.stringify(r).includes('viewToken'), 'o token da tela não vai para o modelo');

    const api = (base: string, name: string, headers: Record<string, string> = {}, body: unknown = {}) =>
      fetch(`${base}/api/${st.request_id}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const base0 = new URL(st.url).origin;
    assert.equal((await api(base0, 'confirm', {}, { signatureId: 'aaaaaaaa' })).status, 401, 'sem token');

    const { res, human, base } = await openAsHuman(st.url);
    assert.equal(res.status, 200);
    assert.equal((await fetch(st.url)).status, 409, 'uso único');
    assert.equal((await api(base, 'state', { 'x-labsign-view': human['x-labsign-view'] })).status, 401, 'token sem cookie');
    assert.equal((await api(base, 'state', { ...human, origin: 'https://evil.example' })).status, 403, 'origem estranha');
    const forged = await new Promise<number>((resolve) => {
      const u = new URL(st.url);
      request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, headers: { host: 'evil.example' } }, (x) => resolve(x.statusCode!)).end();
    });
    assert.equal(forged, 403, 'Host forjado (DNS rebinding)');

    const doc = Buffer.from(await (await api(base, 'document', human)).arrayBuffer());
    assert.ok(doc.equals(readFileSync(file)), 'a prévia recebe os bytes exatos');
    const ui = await (await api(base, 'state', human)).json();
    assert.deepEqual(ui.prefs, { drawMode: 'drag', ink: 'navy', pen: 'medium' });
    assert.equal(ui.document.outputName, 'contrato.assinado.pdf');
    assert.equal((await api(base, 'signed_document', human)).status, 400, 'baixar antes de assinar');

    const saved = await (await api(base, 'save_signature', human, { label: 'Assinatura de teste', strokes: STROKES })).json();
    const out = await (await api(base, 'confirm', human, { signatureId: saved.id, ink: 'blue', pen: 'bold' })).json();
    assert.equal(out.status, 'signed');
    const orig = readFileSync(file);
    assert.ok(readFileSync(out.signed_file).subarray(0, orig.length).equals(orig), 'original como prefixo');
    assert.equal((await api(base, 'confirm', human, { signatureId: saved.id })).status, 400, 'não assina duas vezes');
    const signed = Buffer.from(await (await api(base, 'signed_document', human)).arrayBuffer());
    assert.ok(signed.equals(readFileSync(out.signed_file)));
    const reveal = await (await api(base, 'reveal', human)).json();
    assert.deepEqual(reveal, { revealed: false, file: out.signed_file });

    // aviso de aba fechada (sendBeacon não manda cabeçalho: token no corpo, só para "close")
    const beacon = (name: string, token: string) => fetch(`${base}/api/${st.request_id}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: human.cookie, origin: base }, body: JSON.stringify({ view_token: token }) });
    assert.equal((await beacon('signed_document', human['x-labsign-view'])).status, 401);
    assert.equal((await beacon('close', 'x')).status, 401);
    assert.equal((await beacon('close', human['x-labsign-view'])).status, 200);

    const status: any = await client.callTool({ name: 'labsign_status', arguments: { request_id: st.request_id } });
    assert.equal(status.structuredContent.status, 'signed');
    const list: any = await client.callTool({ name: 'labsign_list_signatures', arguments: {} });
    assert.ok(!/svg|strokes|outlines/.test(JSON.stringify(list)), 'a lista do modelo não traz desenho');
    assert.ok(list.structuredContent.signatures[0].lastUsedAt);

    const auditLog = readFileSync(join(work, 'vault/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const signedEntry = auditLog.find((e) => e.event === 'document_signed');
    assert.equal(signedEntry.ink, 'blue');
    assert.equal(signedEntry.placements[0].page, 2);
    assert.ok(auditLog.some((e) => e.event === 'session_reopen_blocked'));
    assert.ok(auditLog.every((e, i) => i === 0 || e.prev === auditLog[i - 1].hash), 'cadeia de hash');

    // sem âncora no PDF: abre mesmo assim e avisa
    const miss: any = await client.callTool({ name: 'labsign_sign_document', arguments: { file, anchor_text: 'TEXTO QUE NAO EXISTE' } });
    assert.equal(miss.structuredContent.anchor_found, false);
    assert.match(miss.content[0].text, /drag it into place/);
  } finally {
    await client.close();
    cleanup(work);
  }
});

test('A) com o navegador aberto, o modelo nunca recebe o link com token (um agente com terminal não assina sozinho)', { skip: process.platform === 'win32' && 'navegador falso em shell script' }, async () => {
  const work = tempDir();
  // "navegador" de mentira: anota a URL que recebeu, como a pessoa veria na barra de endereço
  const browser = join(work, 'navegador.sh');
  writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > "${join(work, 'aberta.txt')}"\n`, { mode: 0o755 });
  const { client, file } = await connect({}, 800, { LABSIGN_NO_OPEN: '0', LABSIGN_BROWSER: browser }, work);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('labsign_open_in_browser'));
    const r: any = await client.callTool({ name: 'labsign_sign_document', arguments: { file } });
    const seen = JSON.stringify([r.content, r.structuredContent]);
    assert.equal(r.structuredContent.ui, 'browser');
    assert.ok(!/[?&]t=/.test(seen), 'sem token no que o modelo vê');
    assert.match(r.content[0].text, /never open, fetch or call the local labsign page/);

    // o modelo tenta abrir a URL que recebeu: sem o cookie do navegador da pessoa, nada feito
    assert.equal((await fetch(r.structuredContent.url)).status, 404);
    // a pessoa abre pelo navegador (o link com token); a URL sem token reabre só nele
    const opened = readFileSync(join(work, 'aberta.txt'), 'utf8');
    assert.match(opened, /\?t=/);
    const { res, human } = await openAsHuman(opened);
    assert.equal(res.status, 200);
    assert.equal((await fetch(r.structuredContent.url, { headers: { cookie: human.cookie } })).status, 200, 'recarregar/reabrir no mesmo navegador');

    // painel que não apareceu: o modelo pede para abrir no navegador — de novo sem token para ele
    const id = r.structuredContent.request_id;
    const busy: any = await client.callTool({ name: 'labsign_open_in_browser', arguments: { request_id: id } });
    assert.match(busy.content[0].text, /already open/, 'aba aberta: não abre outra (modelo em loop)');
    const base = new URL(opened).origin;
    // a página foi aberta duas vezes acima (abertura + reabertura): fecha as duas "abas"
    for (let i = 0; i < 2; i++) await fetch(`${base}/api/${id}/close`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: human.cookie, origin: base }, body: JSON.stringify({ view_token: human['x-labsign-view'] }) });
    const again: any = await client.callTool({ name: 'labsign_open_in_browser', arguments: { request_id: id } });
    assert.ok(!/[?&]t=/.test(JSON.stringify([again.content, again.structuredContent])));
    assert.match(again.content[0].text, /Opened the labsign page/, 'aba fechada: abre de novo');
  } finally {
    await client.close();
    cleanup(work);
  }
});

test('A) PDF anexado só na conversa: a página recebe o arquivo e a cópia vai para Downloads', async () => {
  const { client, work } = await connect({}, 500);
  try {
    const r: any = await client.callTool({ name: 'labsign_sign_document', arguments: { anchor_text: 'CONTRATADO' } });
    assert.equal(r.structuredContent.awaiting_document, true);
    assert.match(r.content[0].text, /asking for the PDF/);
    const { human, base } = await openAsHuman(r.structuredContent.url);
    const api = (name: string, init: RequestInit = {}) => fetch(`${base}/api/${r.structuredContent.request_id}/${name}`, { method: 'POST', ...init, headers: { ...human, ...((init.headers as Record<string, string>) ?? {}) } });
    const json = { 'content-type': 'application/json' };
    const sig = await (await api('save_signature', { headers: json, body: JSON.stringify({ strokes: STROKES }) })).json();
    const early = await api('confirm', { headers: json, body: JSON.stringify({ signatureId: sig.id }) });
    assert.equal(early.status, 400);
    assert.equal((await early.json()).error, 'NO_DOCUMENT');
    const notPdf = await api('upload_document', { headers: { 'content-type': 'application/pdf', 'x-labsign-filename': 'foto.pdf' }, body: Buffer.from('isto não é um pdf') });
    assert.equal((await notPdf.json()).error, 'NOT_PDF');
    const pdf = readFileSync(join(fixtures, 'normal.pdf'));
    const up = await (await api('upload_document', { headers: { 'content-type': 'application/pdf', 'x-labsign-filename': encodeURIComponent('../../etc/Contrato Aluguel.pdf') }, body: pdf })).json();
    assert.equal(up.done, true);
    const st = await (await api('state', { headers: json, body: '{}' })).json();
    assert.equal(st.document.name, 'Contrato Aluguel.pdf', 'nome sem caminho');
    assert.equal(st.document.uploaded, true);
    const done = await (await api('confirm', { headers: json, body: JSON.stringify({ signatureId: sig.id }) })).json();
    assert.equal(done.signed_file, join(work, 'saida', 'Contrato Aluguel.assinado.pdf'));
    assert.ok(!existsSync(join(work, 'saida', 'Contrato Aluguel.pdf')), 'o original enviado não é gravado');
    const received = readFileSync(join(work, 'vault/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.event === 'document_received');
    assert.equal(received.sha256, createHash('sha256').update(pdf).digest('hex'));
  } finally {
    await client.close();
    cleanup(work);
  }
});

test('B) app com MCP Apps: tela embutida, tools só-da-tela e token fora do alcance do modelo', async () => {
  const { client, file, work } = await connect({ extensions: UI_EXT }, 45000);
  try {
    const tools = (await client.listTools()).tools;
    const sign = tools.find((t) => t.name === 'labsign_sign_document')!;
    assert.equal((sign._meta as any)?.ui?.resourceUri, 'ui://labsign/sign.html');
    const viewTools = tools.filter((t) => t.name.startsWith('labsign_view_'));
    assert.equal(viewTools.length, 11);
    assert.ok(viewTools.every((t) => JSON.stringify((t._meta as any).ui.visibility) === '["app"]'));
    assert.ok(!tools.filter((t) => !t.name.startsWith('labsign_view_')).some((t) => /delete|confirm|signed|reveal/.test(t.name)), 'o modelo não apaga, não confirma, não baixa');

    const res: any = await client.readResource({ uri: 'ui://labsign/sign.html' });
    assert.equal(res.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok(!/<script[^>]+src=|<link[^>]+href=/i.test(res.contents[0].text), 'HTML autossuficiente');

    const t0 = Date.now();
    const r: any = await client.callTool({ name: 'labsign_sign_document', arguments: { file, anchor_text: 'CONTRATADO' } });
    assert.ok(Date.now() - t0 < 3000 && r.structuredContent.status === 'pending', 'não bloqueia');
    const token = r._meta?.labsign?.viewToken;
    assert.ok(token && !JSON.stringify([r.content, r.structuredContent]).includes(token), 'token só em _meta');
    assert.ok(!/[?&]t=/.test(JSON.stringify([r.content, r.structuredContent])), 'nem o link que abre a tela');
    assert.match(r.content[0].text, /labsign_open_in_browser/, 'plano B se o painel não aparecer');
    assert.match(r.content[0].text, /request_id="[a-f0-9]{12}"/, 'request_id repetido no texto (plano B)');

    const view = (name: string, args: Record<string, unknown> = {}, tk = token) => client.callTool({ name: `labsign_view_${name}`, arguments: { request_id: r.structuredContent.request_id, view_token: tk, ...args } }) as Promise<any>;
    assert.equal((await view('confirm', { signatureId: 'aaaaaaaa' }, 'inventado')).isError, true);
    const chunks: Buffer[] = [];
    for (let offset = 0, total = 1; offset < total; ) {
      const part = (await view('document', { offset, length: 1000 })).structuredContent;
      total = part.total;
      chunks.push(Buffer.from(part.data, 'base64'));
      offset += chunks.at(-1)!.length;
    }
    assert.ok(Buffer.concat(chunks).equals(readFileSync(file)), 'a tela remonta o PDF em blocos');

    const saved = (await view('save_signature', { label: 'Rubrica', strokes: STROKES })).structuredContent;
    const extra = (await view('save_signature', { label: 'Descartada', strokes: STROKES })).structuredContent;
    assert.equal((await view('delete_signature', { id: extra.id })).isError, undefined, 'apagar pela tela');
    const outside = await view('confirm', { signatureId: saved.id, placements: [{ pageIndex: 1, x: 520, y: 700, width: 170 }] });
    assert.equal(JSON.parse(outside.content[0].text).error, 'OUT_OF_PAGE', 'erro com código para a tela traduzir');
    const badInk = await view('confirm', { signatureId: saved.id, ink: 'rosa' });
    assert.equal(JSON.parse(badInk.content[0].text).error, 'INVALID_INK');
    const done = (await view('confirm', { signatureId: saved.id, placements: [{ pageIndex: 1, x: 300, y: 500, width: 150 }], ink: 'black', pen: 'fine' })).structuredContent;
    assert.equal(done.status, 'signed');
    const entry = readFileSync(join(work, 'vault/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.event === 'document_signed');
    assert.deepEqual(entry.placements, [{ page: 2, x: 300, y: 500, width: 150 }]);
    assert.deepEqual([entry.ink, entry.pen], ['black', 'fine']);
    const late = await view('delete_signature', { id: saved.id });
    assert.equal(JSON.parse(late.content[0].text).error, 'SESSION_CLOSED', 'pedido encerrado não mexe mais no cofre');
    assert.equal(JSON.parse((await view('state', {}, 'inventado')).content[0].text).error, 'UNAUTHORIZED', 'erro de token também com código');

    // PDF anexado na conversa: sobe em blocos pela tool da tela
    const up: any = await client.callTool({ name: 'labsign_sign_document', arguments: {} });
    const upView = (args: Record<string, unknown>) => client.callTool({ name: 'labsign_view_upload_document', arguments: { request_id: up.structuredContent.request_id, view_token: up._meta.labsign.viewToken, ...args } }) as Promise<any>;
    const pdf = readFileSync(join(fixtures, 'normal.pdf'));
    let last: any = null;
    for (let offset = 0; offset < pdf.length; offset += 1000) last = await upView({ name: 'recebido.pdf', size: pdf.length, offset, data: pdf.subarray(offset, offset + 1000).toString('base64') });
    assert.equal(last.structuredContent.done, true);
    assert.equal((await upView({ name: 'x.pdf', size: 10, offset: 5, data: 'AAAA' })).isError, true, 'bloco fora de ordem');
  } finally {
    await client.close();
    cleanup(work);
  }
});
