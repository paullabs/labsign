// Pedidos de assinatura: estado em memória + as operações da tela (carimbar, enviar o PDF,
// apagar, entregar o assinado). O servidor HTTP e as tools só-da-tela do MCP passam por aqui.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, extname, join, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { LabsignError } from './errors.ts';
import { stampSignature, hasDigitalSignature } from './stamp.ts';
import { locateSignatureSpot, type AnchorInfo } from './anchors.ts';
import { fitPlacement, type Placement } from './placement.ts';
import { strokesToSignature, penOptions, inkRgb, isInk, isPen, type Stroke } from './signature.ts';
import {
  loadSignature,
  saveSignature,
  deleteSignature,
  listSignaturesForUi,
  markSignatureUsed,
  getPrefs,
  setPrefs,
  sha256,
  audit,
  type SignatureMeta,
} from './vault.ts';

export type SessionKind = 'sign' | 'pad';
export type SessionStatus = 'pending' | 'signed' | 'cancelled' | 'expired';

export interface SignResult {
  signed_file?: string;
  sha256_original?: string;
  sha256_signed?: string;
  pages?: number[];
  signature_id?: string;
  signature_label?: string;
  signatures_saved?: number;
  audit_id?: string;
  original_preserved_as_prefix?: boolean;
}

export interface Session {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  client: string;
  /** Tokens: o de abertura vai na URL que abre a tela (nunca ao modelo, se deu para abrir a tela por outro caminho); o da tela só a tela recebe. */
  openToken: string;
  viewToken: string;
  cookie: string;
  opened: boolean;
  closed: boolean;
  /** Abas abertas neste pedido (o mesmo navegador pode abrir duas): só a última a fechar encerra. */
  openPages: number;
  /** Carimbo em andamento: uma segunda confirmação (duplo clique, outra aba) é recusada. */
  signing: boolean;
  createdAt: number;
  closeOnSave: boolean;
  saved: SignatureMeta[];
  result: SignResult | null;
  // assinatura de documento
  file: string | null;
  original: Buffer | null;
  placements: Placement[] | null;
  anchor: AnchorInfo | null;
  anchorText: string | null;
  hasDigitalSignature: boolean;
  awaiting: boolean;
  uploaded: boolean;
  upload: { name: string; size: number; parts: Buffer[]; received: number } | null;
}

const sessions = new Map<string, Session>();
const bus = new EventEmitter();
bus.setMaxListeners(100);
const TTL_MS = 30 * 60 * 1000;
/** Depois de encerrado, o PDF fica na memória por 1 h (recarregar a aba) e o registro, por 24 h (labsign_status). */
const RETAIN_MS = 60 * 60 * 1000;
const FORGET_MS = 24 * 60 * 60 * 1000;
/** Pedidos abertos ao mesmo tempo: um modelo em loop não enche a memória nem a tela de abas. */
export const MAX_PENDING = 20;
const CHUNK = 512 * 1024;
export const MAX_UPLOAD = 30 * 1024 * 1024;

const token = () => randomBytes(24).toString('base64url');
export const sameToken = (a: unknown, b: unknown): boolean => {
  const A = Buffer.from(String(a ?? '')), B = Buffer.from(String(b ?? ''));
  return A.length === B.length && timingSafeEqual(A, B);
};

/**
 * closeOnSave: numa sessão de cofre ("pad"), encerrar já no primeiro "Salvar"?
 * Sim para o MCP (o agente quer saber logo); não para o CLI (a pessoa pode
 * querer salvar assinatura E rubrica antes de clicar em "Concluir").
 */
export function createSession({ kind, client, closeOnSave = true }: { kind: SessionKind; client: string; closeOnSave?: boolean }): Session {
  let pending = 0;
  for (const other of sessions.values()) if (other.status === 'pending') pending++;
  if (pending >= MAX_PENDING) throw new LabsignError('TOO_MANY_OPEN', { max: MAX_PENDING });
  const s: Session = {
    id: randomBytes(6).toString('hex'),
    kind,
    status: 'pending',
    client,
    openToken: token(),
    viewToken: token(),
    cookie: token(),
    opened: false,
    closed: false,
    openPages: 0,
    signing: false,
    createdAt: Date.now(),
    closeOnSave,
    saved: [],
    result: null,
    file: null,
    original: null,
    placements: null,
    anchor: null,
    anchorText: null,
    hasDigitalSignature: false,
    awaiting: false,
    uploaded: false,
    upload: null,
  };
  sessions.set(s.id, s);
  setTimeout(() => {
    if (s.status !== 'pending') return;
    // cofre com algo salvo conta como concluído, igual ao botão "Concluir"
    if (s.kind === 'pad' && s.saved.length) uiFinish(s);
    else finish(s, 'expired', null);
  }, TTL_MS).unref();
  return s;
}

export const getSession = (id: string): Session | undefined => sessions.get(id);

/** Encerra UMA vez: depois de assinado, cancelado ou expirado, nada muda o status. */
function finish(s: Session, status: SessionStatus, result: SignResult | null): boolean {
  if (s.status !== 'pending') return false;
  s.status = status;
  s.result = result;
  s.upload = null;
  bus.emit(s.id);
  setTimeout(() => (s.original = null), RETAIN_MS).unref();
  setTimeout(() => sessions.delete(s.id), FORGET_MS).unref();
  return true;
}

/** Uma aba abriu a tela deste pedido (primeira vez ou recarregando). */
export function pageOpened(s: Session): void {
  s.opened = true;
  s.openPages++;
  s.closed = false; // recarregar dispara o aviso de "aba fechada"; reabrir desfaz
}

/** Espera LIMITADA: resolve quando a sessão termina ou quando o tempo acaba. */
export function waitForSession(id: string, ms: number): Promise<Session | undefined> {
  const s = sessions.get(id);
  if (!s || s.status !== 'pending') return Promise.resolve(s);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bus.off(id, done);
      resolve(s);
    };
    const timer = setTimeout(done, ms);
    bus.once(id, done);
  });
}

/** O que o MODELO pode saber de uma sessão. Nunca inclui tokens da tela nem desenho. */
export function publicState(s: Session | undefined) {
  if (!s) return { status: 'unknown' as const };
  return {
    request_id: s.id,
    kind: s.kind,
    status: s.status,
    ...(s.kind === 'sign' && s.awaiting ? { awaiting_document: true } : {}),
    ...(s.kind === 'sign' && s.anchor ? { anchor_found: s.anchor.found } : {}),
    ...(s.result ?? {}),
  };
}

/** contrato.pdf -> contrato.assinado.pdf (ou .assinado-2.pdf ...): nunca sobrescreve. */
export function nextOutputPath(file: string): string {
  const ext = extname(file);
  const stem = join(dirname(file), basename(file, ext));
  let out = `${stem}.assinado${ext}`;
  for (let n = 2; existsSync(out); n++) out = `${stem}.assinado-${n}${ext}`;
  return out;
}

export const outputDir = (): string => {
  const dir = process.env.LABSIGN_OUTPUT_DIR || join(homedir(), 'Downloads');
  return existsSync(dir) ? dir : homedir();
};

/** Pasta para mostrar na tela: ~/Downloads em vez de /Users/fulano/Downloads. */
const folderLabel = (dir: string): string => {
  const home = homedir();
  return dir === home || dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
};

/** O que a tela precisa para se desenhar. */
export function uiState(s: Session) {
  let document = null;
  if (s.kind === 'sign') {
    document = s.awaiting
      ? { awaiting: true, maxBytes: MAX_UPLOAD, outputDir: outputDir(), outputDirLabel: folderLabel(outputDir()) }
      : {
          name: basename(s.file!),
          outputName: basename(nextOutputPath(s.file!)),
          outputDir: dirname(s.file!),
          outputDirLabel: folderLabel(dirname(s.file!)),
          uploaded: s.uploaded, // veio pela tela: não há original no disco
          bytes: s.original?.length ?? 0, // encerrado há mais de 1 h: o PDF já saiu da memória
          hasDigitalSignature: s.hasDigitalSignature,
          anchor: s.anchor,
          placements: s.placements,
        };
  }
  return {
    kind: s.kind,
    status: s.status,
    result: s.status === 'pending' ? null : publicState(s),
    document,
    signatures: listSignaturesForUi(),
    prefs: getPrefs(),
  };
}

// ---------------------------------------------------------------- abertura
/** Lê o PDF do disco com erros claros — antes de qualquer outra coisa (âncoras, prévia) tocar nos bytes. */
export function readPdf(file: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new LabsignError('FILE_NOT_FOUND', { file });
    if (code === 'EISDIR') throw new LabsignError('NOT_PDF');
    throw e;
  }
  checkPdf(bytes);
  return bytes;
}

/** Cabeçalho de PDF. Criptografia e PDF danificado são vistos ao abrir com o pdf.js (anchors.ts). */
function checkPdf(bytes: Buffer): void {
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new LabsignError('NOT_PDF');
}

export function prepareSignSession({
  file,
  bytes = readPdf(file),
  placements,
  anchor = null,
  client,
}: {
  file: string;
  bytes?: Buffer;
  placements: Placement[];
  anchor?: AnchorInfo | null;
  client: string;
}): Session {
  const s = createSession({ kind: 'sign', client });
  s.file = file;
  s.original = bytes; // a prévia mostra exatamente os bytes que serão assinados
  s.placements = placements;
  s.anchor = anchor;
  s.hasDigitalSignature = hasDigitalSignature(bytes);
  return s;
}

/**
 * Pedido de assinatura ainda sem documento: a tela vai pedir o PDF.
 * (O Claude não repassa anexos da conversa para tools; no ChatGPT o repasse falha às vezes.)
 */
export function createAwaitingSignSession({ anchorText, client }: { anchorText?: string | null; client: string }): Session {
  const s = createSession({ kind: 'sign', client });
  s.awaiting = true;
  s.anchorText = anchorText || 'CONTRATANTE';
  return s;
}

/** Nome do PDF recebido pela tela, seguro para gravar na pasta de saída: sem separadores, sem ".." nem nome oculto. */
export const safePdfName = (name: unknown): string => {
  const base =
    basename(String(name || ''))
      .replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .slice(0, 120) || 'documento.pdf';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
};

/** A tela ainda pode mexer no cofre? Pedido aberto — ou cofre que já avisou o modelo no primeiro "Salvar". */
function assertOpen(s: Session): void {
  if (s.status === 'pending' || (s.kind === 'pad' && s.status === 'signed')) return;
  throw new LabsignError('SESSION_CLOSED', { status: s.status });
}

// ---------------------------------------------------------------- operações da tela
export function documentBytes(s: Session): Buffer {
  if (s.kind !== 'sign' || !s.original) throw new LabsignError('NO_DOCUMENT');
  return s.original;
}

function chunkOf(bytes: Buffer, offset: unknown, length: unknown) {
  const start = Math.max(0, Math.min(Number(offset) || 0, bytes.length));
  const end = Math.min(bytes.length, start + Math.min(Number(length) || CHUNK, CHUNK));
  return { total: bytes.length, offset: start, data: bytes.subarray(start, end).toString('base64') };
}

export const uiDocumentChunk = (s: Session, { offset, length }: { offset?: number; length?: number } = {}) => chunkOf(documentBytes(s), offset, length);

/** Recebe um bloco do PDF. Quando chega o último: valida, guarda na memória e propõe onde assinar. */
export async function uiUploadChunk(s: Session, { name, size, offset = 0, data }: { name?: string; size: number; offset?: number; data: Buffer | string }) {
  if (s.status !== 'pending') throw new LabsignError('SESSION_CLOSED', { status: s.status });
  if (s.kind !== 'sign' || !s.awaiting) throw new LabsignError('NOT_AWAITING');
  size = Number(size);
  if (!Number.isInteger(size) || size < 5) throw new LabsignError('UPLOAD_EMPTY');
  if (size > MAX_UPLOAD) throw new LabsignError('UPLOAD_TOO_BIG', { mb: MAX_UPLOAD / 1024 / 1024 });
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'base64');
  if (Number(offset) === 0 || !s.upload) s.upload = { name: safePdfName(name), size, parts: [], received: 0 };
  const u = s.upload;
  if (u.size !== size || Number(offset) !== u.received) throw new LabsignError('UPLOAD_OUT_OF_ORDER');
  if (u.received + chunk.length > size) throw new LabsignError('UPLOAD_OVERFLOW');
  u.parts.push(chunk);
  u.received += chunk.length;
  if (u.received < size) return { received: u.received, total: size, done: false };

  const bytes = Buffer.concat(u.parts);
  s.upload = null;
  checkPdf(bytes);
  const { placement, anchor } = await locateSignatureSpot(bytes, s.anchorText);
  if (s.status !== 'pending') throw new LabsignError('SESSION_CLOSED', { status: s.status }); // cancelado enquanto lia o PDF
  s.original = bytes;
  s.file = join(outputDir(), u.name); // só para nomear a saída: o original não é gravado em lugar nenhum
  s.placements = [placement];
  s.anchor = anchor;
  s.hasDigitalSignature = hasDigitalSignature(bytes);
  s.awaiting = false;
  s.uploaded = true;
  audit({ event: 'document_received', name: u.name, bytes: bytes.length, sha256: sha256(bytes), client: s.client });
  return { received: size, total: size, done: true };
}

export const uiSetPrefs = (_s: Session, prefs: Record<string, unknown>) => setPrefs(prefs);

/** Traços como a tela manda: listas de pontos [x, y, pressão?] com números finitos, em quantidade razoável. */
const MAX_STROKES = 400;
const MAX_POINTS = 60000;
function checkStrokes(strokes: unknown): asserts strokes is Stroke[] {
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > MAX_STROKES) throw new LabsignError('EMPTY_DRAWING');
  let points = 0;
  for (const st of strokes) {
    if (!Array.isArray(st) || !st.length) throw new LabsignError('EMPTY_DRAWING');
    points += st.length;
    if (points > MAX_POINTS) throw new LabsignError('EMPTY_DRAWING');
    for (const p of st) {
      if (!Array.isArray(p) || p.length < 2 || p.length > 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e5)) throw new LabsignError('EMPTY_DRAWING');
    }
  }
}

export function uiSaveSignature(s: Session, { label, kind, strokes }: { label?: string; kind?: string; strokes: Stroke[] }) {
  assertOpen(s);
  checkStrokes(strokes);
  const meta = saveSignature({ label, kind, strokes });
  audit({ event: 'signature_created', signature: meta.id, label: meta.label, client: s.client });
  s.saved.push(meta);
  if (s.kind === 'pad' && s.closeOnSave && s.status === 'pending') finish(s, 'signed', { signature_id: meta.id, signature_label: meta.label, signatures_saved: 1 });
  return meta;
}

export function uiDeleteSignature(s: Session, { id }: { id: string }) {
  assertOpen(s);
  const gone = deleteSignature(id);
  s.saved = s.saved.filter((m) => m.id !== id);
  audit({ event: 'signature_deleted', signature: gone.id, label: gone.label, client: s.client });
  return gone;
}

/** Botão "Concluir" do cofre: encerra com o que foi salvo (ou cancela, se nada foi). */
export function uiFinish(s: Session) {
  if (s.status === 'pending') {
    const last = s.saved.at(-1);
    if (s.kind === 'pad' && last) finish(s, 'signed', { signature_id: last.id, signature_label: last.label, signatures_saved: s.saved.length });
    else finish(s, 'cancelled', null);
  }
  return publicState(s);
}

export function uiCancel(s: Session) {
  if (s.status === 'pending') finish(s, 'cancelled', null);
  return publicState(s);
}

function sanitizePlacements(list: unknown) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 500) throw new LabsignError('INVALID_PLACEMENT');
  return list.map((p) => {
    const q = { pageIndex: Number(p?.pageIndex), x: Number(p?.x), y: Number(p?.y), width: Number(p?.width) };
    if (!Number.isInteger(q.pageIndex) || q.pageIndex < 0 || ![q.x, q.y, q.width].every(Number.isFinite) || q.width < 10 || q.width > 2000) {
      throw new LabsignError('INVALID_PLACEMENT');
    }
    return q;
  });
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Carimba. placements (opcional) é a posição final que o humano ajustou na prévia;
 * sem ela, usa a posição proposta. ink/pen: cor e espessura escolhidas (padrão: preferências).
 */
export async function uiConfirm(s: Session, { signatureId, placements, ink, pen }: { signatureId: string; placements?: unknown; ink?: unknown; pen?: unknown }) {
  if (s.kind !== 'sign') throw new LabsignError('NOT_A_SIGN_SESSION');
  if (s.status !== 'pending' || s.signing) throw new LabsignError('SESSION_CLOSED', { status: s.signing ? 'signing' : s.status });
  if (s.awaiting || !s.original || !s.file || !s.placements) throw new LabsignError('NO_DOCUMENT');
  const prefs = getPrefs();
  const inkKey = ink ?? prefs.ink;
  const penKey = pen ?? prefs.pen;
  if (!isInk(inkKey)) throw new LabsignError('INVALID_INK');
  if (!isPen(penKey)) throw new LabsignError('INVALID_PEN');
  const record = loadSignature(signatureId);
  // recalculada dos traços crus: a espessura escolhida vale no PDF, não só na tela
  const signature = strokesToSignature(record.strokes, penOptions(penKey));
  const aspect = signature.height / signature.width;
  const chosen = Array.isArray(placements) && placements.length ? sanitizePlacements(placements) : s.placements.map((p) => fitPlacement(p, aspect));
  const original = s.original;
  const file = s.file;

  s.signing = true; // daqui até gravar há um await: uma segunda confirmação não pode passar pelo mesmo caminho
  try {
    const { bytes } = await stampSignature({ pdfBytes: original, signature, placements: chosen, mode: 'incremental', color: inkRgb(inkKey) });
    // cancelado, expirado ou aba fechada enquanto carimbava: não grava nada
    if (s.status !== 'pending') throw new LabsignError('SESSION_CLOSED', { status: s.status });
    const outPath = nextOutputPath(file);
    writeFileSync(outPath, bytes, { flag: 'wx' }); // 'wx': falha em vez de sobrescrever, mesmo numa corrida

    // o arquivo já existe: daqui em diante nada pode deixar o pedido pendurado (uma nova tentativa geraria "-2")
    const pages = [...new Set(chosen.map((p) => p.pageIndex + 1))];
    let auditId: string | undefined;
    try {
      markSignatureUsed(record.id);
      auditId = audit({
        event: 'document_signed',
        file: s.uploaded ? null : file,
        received_as: s.uploaded ? basename(file) : undefined,
        output: outPath,
        sha256_original: sha256(original),
        sha256_signed: sha256(bytes),
        signature: record.id,
        label: record.label,
        ink: inkKey,
        pen: penKey,
        pages,
        placements: chosen.map((p) => ({ page: p.pageIndex + 1, x: r1(p.x), y: r1(p.y), width: r1(p.width) })),
        client: s.client,
      }).hash.slice(0, 12);
    } catch (e) {
      console.error('[labsign] assinado, mas o registro de auditoria falhou:', (e as Error)?.message ?? e);
    }
    finish(s, 'signed', {
      signed_file: outPath,
      sha256_original: sha256(original),
      sha256_signed: sha256(bytes),
      pages,
      signature_label: record.label,
      audit_id: auditId,
      original_preserved_as_prefix: true,
    });
    return publicState(s);
  } finally {
    s.signing = false;
  }
}

// ---------------------------------------------------------------- entrega do documento assinado
function signedPath(s: Session): string {
  if (s.kind !== 'sign' || s.status !== 'signed' || !s.result?.signed_file) throw new LabsignError('NOT_SIGNED_YET');
  return s.result.signed_file;
}

export const signedBytes = (s: Session): Buffer => readFileSync(signedPath(s));
export const uiSignedChunk = (s: Session, { offset, length }: { offset?: number; length?: number } = {}) => ({
  ...chunkOf(signedBytes(s), offset, length),
  name: basename(signedPath(s)),
});

/** Abre a pasta com o arquivo assinado selecionado (Finder, Explorer ou o gerenciador de arquivos). */
export async function uiReveal(s: Session) {
  const file = signedPath(s);
  if (process.env.LABSIGN_NO_OPEN === '1') return { revealed: false, file };
  const win = process.platform === 'win32';
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', ['-R', file]] : win ? ['explorer.exe', [`/select,"${file}"`]] : ['xdg-open', [dirname(file)]];
  // o Explorer não entende o argumento que o Node monta ("/select,C:\...\com espaço"): vai como está
  const revealed = await startDetached(cmd, args, { windowsVerbatimArguments: win });
  return { revealed, file };
}

/**
 * Dispara um programa (navegador, gerenciador de arquivos) sem esperar por ele.
 * Comando inexistente (xdg-open ausente no Linux/WSL) chega como evento 'error': sem ouvinte, derrubaria o processo.
 */
export function startDetached(cmd: string, args: string[], extra: { windowsVerbatimArguments?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...extra });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------- fim da tela
/** Carência depois do aviso de aba fechada: recarregar a página reabre a sessão antes disso. */
export const CLOSE_GRACE_MS = 3000;
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Uma aba fechou (ou recarregou). Quando a última fecha, quem esperava pode encerrar. */
export function uiClose(s: Session, graceMs = CLOSE_GRACE_MS) {
  s.openPages = Math.max(0, s.openPages - 1);
  if (s.openPages > 0) return { closed: false }; // outra aba do mesmo pedido continua aberta
  s.closed = true;
  bus.emit(`close:${s.id}`);
  // Aba fechada com o pedido ainda aberto: passada a carência, encerra como o botão "Concluir"
  // (cofre com algo salvo → concluído; o resto → cancelado). Assim nem o CLI nem o modelo ficam esperando à toa.
  clearTimeout(closeTimers.get(s.id));
  if (s.status === 'pending')
    closeTimers.set(
      s.id,
      setTimeout(() => {
        closeTimers.delete(s.id);
        if (s.closed) uiFinish(s);
      }, graceMs).unref(),
    );
  return { closed: true };
}

function onceClosed(id: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bus.off(`close:${id}`, done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    bus.once(`close:${id}`, done);
  });
}

/**
 * Depois de assinar, a tela ainda serve para baixar/enviar: espera ela fechar (com limite).
 * Recarregar a página também dispara o aviso de fechamento — por isso, depois do aviso,
 * espera um pouco e só encerra se a página não tiver sido reaberta.
 */
export async function waitForClose(id: string, ms: number, graceMs = CLOSE_GRACE_MS): Promise<void> {
  const s = sessions.get(id);
  const deadline = Date.now() + ms;
  while (s && Date.now() < deadline) {
    if (!s.closed) await onceClosed(id, deadline - Date.now());
    if (!s.closed) return; // estourou o limite
    await new Promise((r) => setTimeout(r, Math.min(graceMs, Math.max(0, deadline - Date.now()))));
    if (s.closed) return; // fechou de verdade
  }
}
