// Cofre local de assinaturas + preferências + log de auditoria encadeado por hash.
// Tudo em ~/.labsign (ou LABSIGN_HOME), com permissões só do dono (0700/0600).
// Gravações são atômicas (temporário + rename) e o log é serializado entre processos:
// o servidor MCP do Claude Desktop e o CLI podem mexer no cofre ao mesmo tempo.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  appendFileSync,
  chmodSync,
  rmSync,
  copyFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  fstatSync,
  readSync,
  statSync,
} from 'node:fs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { LabsignError } from './errors.ts';
import { strokesToSignature, signatureToSvg, isInk, isPen, DEFAULT_INK, DEFAULT_PEN, type Signature, type Stroke, type Ink, type Pen } from './signature.ts';

const DEFAULT_HOME = join(homedir(), '.labsign');
export const HOME = process.env.LABSIGN_HOME || DEFAULT_HOME;
const SIG_DIR = join(HOME, 'signatures');
const AUDIT = join(HOME, 'audit.jsonl');
const CONFIG = join(HOME, 'config.json');
const SPIKE_HOME = join(homedir(), '.labsign-spike'); // cofre do protótipo (Fase 0)

export interface SignatureRecord {
  id: string;
  label: string;
  kind: string;
  createdAt: string;
  lastUsedAt?: string;
  strokes: Stroke[];
  signature: Signature;
}

export interface SignatureMeta {
  id: string;
  label: string;
  kind: string;
  createdAt: string;
  lastUsedAt?: string;
}

export type DrawMode = 'drag' | 'click';
export interface Prefs {
  drawMode: DrawMode;
  ink: Ink;
  pen: Pen;
}

/** Avisos para quem estiver no terminal (ex.: migração do cofre do protótipo). */
export const notices: { migrated?: { n: number; from: string } } = {};

const isDefaultHome = resolve(HOME) === resolve(DEFAULT_HOME);
const ID_RE = /^[a-f0-9]{8}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function ensure(): void {
  const fresh = !existsSync(SIG_DIR);
  const created = !existsSync(HOME);
  mkdirSync(SIG_DIR, { recursive: true, mode: 0o700 });
  // 0700 só numa pasta que o labsign criou agora, ou no cofre padrão:
  // um LABSIGN_HOME que já existia é do usuário, e as permissões dele ficam como estão
  if (created || isDefaultHome) chmodSync(HOME, 0o700);
  // primeira vez no cofre padrão: traz uma cópia das assinaturas do protótipo, se houver
  if (fresh && isDefaultHome && existsSync(join(SPIKE_HOME, 'signatures'))) {
    const files = readdirSync(join(SPIKE_HOME, 'signatures')).filter((f) => /^[a-f0-9]{8}\.(json|svg)$/.test(f));
    for (const f of files) copyFileSync(join(SPIKE_HOME, 'signatures', f), join(SIG_DIR, f));
    for (const f of files) chmodSync(join(SIG_DIR, f), 0o600);
    const n = files.filter((f) => f.endsWith('.json')).length;
    if (n) notices.migrated = { n, from: SPIKE_HOME };
  }
}

/** Grava tudo ou nada: temporário na mesma pasta (0600) + rename, que é atômico no mesmo disco. */
function writeAtomic(file: string, data: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const isPoint = (p: unknown): boolean => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const isStrokes = (v: unknown): v is Stroke[] => Array.isArray(v) && v.every((s) => Array.isArray(s) && s.every(isPoint)) && v.some((s) => s.length > 0);
const isSignature = (v: unknown): v is Signature => isObject(v) && Number.isFinite(v.width) && Number.isFinite(v.height) && Array.isArray(v.outlines);
const isDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** Lê um registro do disco. Corrompido ou sem traços: null (fica de fora); campos faltando: padrão. */
function readRecord(id: string): SignatureRecord | null {
  const file = join(SIG_DIR, `${id}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // ilegível, vazio (reserva de um save em andamento) ou apagado no meio da listagem
  }
  if (!isObject(raw) || !isStrokes(raw.strokes)) return null;
  const strokes = raw.strokes;
  let createdAt = isDate(raw.createdAt) ? raw.createdAt : '';
  if (!createdAt) {
    try {
      createdAt = statSync(file).mtime.toISOString();
    } catch {
      createdAt = new Date(0).toISOString();
    }
  }
  return {
    id, // o nome do arquivo manda: é por ele que se carrega e se apaga
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : 'Assinatura',
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'signature',
    createdAt,
    ...(isDate(raw.lastUsedAt) ? { lastUsedAt: raw.lastUsedAt } : {}),
    strokes,
    signature: isSignature(raw.signature) ? raw.signature : strokesToSignature(strokes),
  };
}

function readRecords(): SignatureRecord[] {
  if (!existsSync(SIG_DIR)) ensure();
  const records: SignatureRecord[] = [];
  for (const f of readdirSync(SIG_DIR)) {
    const m = /^([a-f0-9]{8})\.json$/.exec(f);
    const record = m && readRecord(m[1]);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function loadSignature(id: string): SignatureRecord {
  if (!ID_RE.test(String(id))) throw new LabsignError('INVALID_ID');
  if (!existsSync(join(SIG_DIR, `${id}.json`))) throw new LabsignError('SIGNATURE_NOT_FOUND');
  // corrompido: a lista já não o mostra, então para quem pede é como se não existisse
  const record = readRecord(id);
  if (!record) throw new LabsignError('SIGNATURE_NOT_FOUND');
  return record;
}

/** Metadados apenas — é isto que o MODELO pode ver. */
export function listSignatures(): SignatureMeta[] {
  return readRecords().map(({ id, label, kind, createdAt, lastUsedAt }) => ({ id, label, kind, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}) }));
}

/** Com os traços crus — é isto que só a tela (o humano) vê; ela redesenha na cor e espessura escolhidas. */
export function listSignaturesForUi() {
  return readRecords().map(({ id, label, kind, createdAt, lastUsedAt, strokes }) => ({ id, label, kind, createdAt, lastUsedAt: lastUsedAt ?? null, strokes }));
}

export function saveSignature({ label, kind = 'signature', strokes }: { label?: string; kind?: string; strokes: Stroke[] }): SignatureMeta {
  ensure();
  const signature = strokesToSignature(strokes);
  // rótulo único: "Assinatura", "Assinatura 2", ... — dois iguais ficam indistinguíveis na lista e na auditoria
  const taken = new Set(listSignatures().map((s) => s.label));
  const base = String(label ?? '').trim().slice(0, 56) || 'Assinatura';
  let unique = base;
  for (let n = 2; taken.has(unique); n++) unique = `${base} ${n}`;
  // id novo: 'wx' reserva o nome atomicamente; se já existe (colisão), sorteia outro — nunca sobrescreve
  let id = '';
  for (let tries = 1; ; tries++) {
    id = randomUUID().slice(0, 8);
    try {
      closeSync(openSync(join(SIG_DIR, `${id}.json`), 'wx', 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || tries >= 50) throw e;
    }
  }
  const record: SignatureRecord = { id, label: unique, kind: String(kind).slice(0, 24), createdAt: new Date().toISOString(), strokes, signature };
  try {
    // a reserva (vazia) é trocada pelo conteúdo de uma vez; quem listar no meio só a ignora
    writeAtomic(join(SIG_DIR, `${id}.json`), JSON.stringify(record));
    writeAtomic(join(SIG_DIR, `${id}.svg`), signatureToSvg(signature));
  } catch (e) {
    for (const ext of ['json', 'svg']) rmSync(join(SIG_DIR, `${id}.${ext}`), { force: true });
    throw e;
  }
  return { id, label: record.label, kind: record.kind, createdAt: record.createdAt };
}

/** Apagar é só pela tela (gesto humano); o modelo não tem tool para isso. */
export function deleteSignature(id: string): { id: string; label: string } {
  const record = loadSignature(id);
  for (const ext of ['json', 'svg']) rmSync(join(SIG_DIR, `${id}.${ext}`), { force: true });
  return { id, label: record.label };
}

export function markSignatureUsed(id: string): void {
  const record = loadSignature(id);
  record.lastUsedAt = new Date().toISOString();
  writeAtomic(join(SIG_DIR, `${id}.json`), JSON.stringify(record));
}

// Preferências da tela ficam no cofre: a porta do servidor muda a cada sessão,
// então o armazenamento do navegador não sobreviveria. "Segurar e arrastar" é o padrão.
const DEFAULT_PREFS: Prefs = { drawMode: 'drag', ink: DEFAULT_INK, pen: DEFAULT_PEN };

/** config.json ausente, ilegível ou que não é um objeto (ex.: "null"): vale o padrão. */
function readConfig(): Record<string, unknown> {
  try {
    const config: unknown = JSON.parse(readFileSync(CONFIG, 'utf8'));
    return isObject(config) ? config : {};
  } catch {
    return {};
  }
}

export function getPrefs(): Prefs {
  const prefs = readConfig().prefs;
  const saved: Partial<Record<keyof Prefs, unknown>> = isObject(prefs) ? prefs : {};
  return {
    drawMode: saved.drawMode === 'click' ? 'click' : DEFAULT_PREFS.drawMode,
    ink: isInk(saved.ink) ? saved.ink : DEFAULT_PREFS.ink,
    pen: isPen(saved.pen) ? saved.pen : DEFAULT_PREFS.pen,
  };
}

export function setPrefs(input: Partial<Record<keyof Prefs, unknown>> | undefined): Prefs {
  ensure();
  const prefs = getPrefs();
  if (input?.drawMode === 'click' || input?.drawMode === 'drag') prefs.drawMode = input.drawMode;
  if (isInk(input?.ink)) prefs.ink = input.ink;
  if (isPen(input?.pen)) prefs.pen = input.pen;
  writeAtomic(CONFIG, JSON.stringify({ ...readConfig(), prefs }, null, 2));
  return prefs;
}

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export interface AuditEntry {
  ts: string;
  event: string;
  prev: string;
  hash: string;
  [key: string]: unknown;
}

const GENESIS = '0'.repeat(64);
const AUDIT_LOCK = `${AUDIT}.lock`;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

/** Espera síncrona curta (o log é síncrono de ponta a ponta). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * "Ler a última linha + acrescentar" sob uma trava exclusiva entre processos: sem ela,
 * dois processos leem a mesma última linha e o encadeamento bifurca.
 */
function withAuditLock<T>(fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(AUDIT_LOCK, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        // trava largada por um processo que morreu segurando: vence depois de alguns segundos
        if (Date.now() - statSync(AUDIT_LOCK).mtimeMs > LOCK_STALE_MS) {
          rmSync(AUDIT_LOCK, { force: true });
          continue;
        }
      } catch {
        continue; // foi liberada entre o open e o stat: tenta de novo
      }
      // quem segura leva milissegundos; passou do prazo, registra assim mesmo —
      // perder o registro (ou travar a assinatura) é pior, e se bifurcar o verifyAuditChain acusa
      if (Date.now() > deadline) break;
      pause(2 + Math.floor(Math.random() * 6));
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      rmSync(AUDIT_LOCK, { force: true });
    }
  }
}

/** Hash de uma linha do log, se ela for uma entrada legível. */
function lineHash(line: string): string | null {
  try {
    const entry: unknown = JSON.parse(line);
    return isObject(entry) && typeof entry.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash) ? entry.hash : null;
  } catch {
    return null;
  }
}

/**
 * Onde encadear: o hash da última linha legível (uma linha cortada por queda de energia
 * não pode travar o log para sempre) e se o arquivo termina no meio de uma linha.
 */
function auditTail(): { prev: string; cut: boolean } {
  if (!existsSync(AUDIT)) return { prev: GENESIS, cut: false };
  const fd = openSync(AUDIT, 'r');
  try {
    const size = fstatSync(fd).size;
    if (!size) return { prev: GENESIS, cut: false };
    // o log só cresce: lê o fim; se nenhuma linha legível couber nele, lê tudo
    for (let span = Math.min(size, 64 * 1024); ; span = size) {
      const buf = Buffer.alloc(span);
      readSync(fd, buf, 0, span, size - span);
      const cut = buf[span - 1] !== 0x0a;
      const lines = buf.toString('utf8').split('\n');
      if (span < size) lines.shift(); // a primeira pode ter começado antes do trecho lido
      for (let i = lines.length - 1; i >= 0; i--) {
        const hash = lineHash(lines[i]);
        if (hash) return { prev: hash, cut };
      }
      if (span === size) return { prev: GENESIS, cut };
    }
  } finally {
    closeSync(fd);
  }
}

/** Log só-de-acréscimo; cada linha carrega o hash da anterior (adulteração fica evidente). */
export function audit(event: Record<string, unknown> & { event: string }): AuditEntry {
  ensure();
  return withAuditLock(() => {
    const { prev, cut } = auditTail();
    const body = { ts: new Date().toISOString(), ...event, prev };
    const entry = { ...body, hash: sha256(JSON.stringify(body)) } as AuditEntry;
    // linha cortada no fim: a nova entrada começa numa linha própria (a cortada continua acusada)
    appendFileSync(AUDIT, (cut ? '\n' : '') + JSON.stringify(entry) + '\n', { mode: 0o600 });
    return entry;
  });
}

export function verifyAuditChain(): { ok: boolean; entries: number } {
  if (!existsSync(AUDIT)) return { ok: true, entries: 0 };
  const lines = readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean);
  let prev = GENESIS;
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return { ok: false, entries: lines.length }; // linha ilegível (cortada ou adulterada): a cadeia não fecha
    }
    if (!isObject(entry)) return { ok: false, entries: lines.length };
    const { hash, ...body } = entry;
    if (body.prev !== prev || sha256(JSON.stringify(body)) !== hash) return { ok: false, entries: lines.length };
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}
