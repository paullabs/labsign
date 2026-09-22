// Pedidos de assinatura: estado em memória + as operações da tela (carimbar, enviar o PDF,
// apagar, entregar o assinado). O servidor HTTP e as tools só-da-tela do MCP passam por aqui.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, extname, join, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { LabsignError, errorPayload, type ErrorPayload } from './errors.ts';
import { stampSignature, hasDigitalSignature, type StampText } from './stamp.ts';
import { makeReceipt } from './receipt.ts';
import { langFrom } from '../i18n/messages.ts';
import { VERSION } from '../version.ts';
import { locateSignatureSpot, type AnchorInfo, type SpotInfo } from './anchors.ts';
import {
  deliveryOptions,
  openFile,
  revealFile,
  openUrl,
  copyFileToClipboard,
  saveAsDialog,
  copyTo,
  mailWithAttachment,
  gmailComposeUrl,
  whatsappUrl,
  moveToTrash,
  type MailClient,
} from './deliver.ts';
import { fitPlacement, type Placement } from './placement.ts';
import { strokesToSignature, penOptions, inkRgb, isInk, isPen, type Stroke, type Pen } from './signature.ts';
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
  countAuditEvents,
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
  /** Onde a assinatura entrou, com o rótulo do bloco quando é um dos da lista ("CONTRATANTE"). */
  places?: { page: number; label: string | null }[];
  /** Em quantas páginas entrou a rubrica. */
  initials_pages?: number;
  /** Textos escritos junto (local e data). */
  texts?: number;
}

/** Uma linha do histórico da tela ("assinado às 14:32", "e-mail aberto no Apple Mail"). A tela traduz pelo evento. */
export interface HistoryEntry {
  at: string;
  event: 'created' | 'document' | 'removed' | 'signed' | 'undone' | 'saved_copy' | 'opened_file' | 'revealed' | 'copied' | 'mail' | 'whatsapp' | 'receipt';
  detail?: Record<string, string | number>;
}

/** "Salvar uma cópia em…": a janela do sistema espera a pessoa; a tela acompanha pelo estado da tarefa. */
export interface SaveJob {
  id: number;
  state: 'running' | 'done' | 'cancelled' | 'error';
  file?: string;
  name?: string;
  folder?: string;
  /** O nome escolhido já existia: a cópia ganhou outro nome ("-2") em vez de substituir. */
  renamed?: boolean;
  error?: ErrorPayload;
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
  /** Blocos de assinatura achados no documento (a lista "Onde assinar" da tela). */
  spots: SpotInfo[];
  pageCount: number | null;
  history: HistoryEntry[];
  job: SaveJob | null;
  /** Número desta assinatura no registro do computador (depois de assinar). */
  registryNo: number | null;
  /** Temporizadores de expiração: desfazer a assinatura reabre o pedido e os rearma. */
  timers: ReturnType<typeof setTimeout>[];
  /** O que a IA sugeriu ao abrir (a pessoa pediu rubrica, local e data): a tela já começa com isso ligado. */
  hints: { initials: boolean; placeDate: boolean };
  /** Com que desenho e traço foi assinado (para o comprovante). */
  signedWith: { signatureId: string; pen: Pen } | null;
  /** Comprovante já gerado para esta assinatura. */
  receipt: string | null;
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
    spots: [],
    pageCount: null,
    history: [],
    job: null,
    registryNo: null,
    timers: [],
    hints: { initials: false, placeDate: false },
    signedWith: null,
    receipt: null,
  };
  sessions.set(s.id, s);
  note(s, 'created');
  armTtl(s);
  return s;
}

/** Pedido esquecido aberto expira (cofre com algo salvo conta como concluído, igual ao botão "Concluir"). */
function armTtl(s: Session): void {
  s.timers.push(
    setTimeout(() => {
      if (s.status !== 'pending') return;
      if (s.kind === 'pad' && s.saved.length) uiFinish(s);
      else finish(s, 'expired', null);
    }, TTL_MS).unref(),
  );
}

const note = (s: Session, event: HistoryEntry['event'], detail?: HistoryEntry['detail']) => {
  s.history.push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) });
  if (s.history.length > 100) s.history.splice(1, s.history.length - 100); // guarda o começo e o recente
};

export const getSession = (id: string): Session | undefined => sessions.get(id);

/** Encerra UMA vez: depois de assinado, cancelado ou expirado, nada muda o status. */
function finish(s: Session, status: SessionStatus, result: SignResult | null): boolean {
  if (s.status !== 'pending') return false;
  s.status = status;
  s.result = result;
  s.upload = null;
  bus.emit(s.id);
  s.timers.push(setTimeout(() => (s.original = null), RETAIN_MS).unref(), setTimeout(() => sessions.delete(s.id), FORGET_MS).unref());
  return true;
}

/** Desfazer a assinatura: o pedido volta a ficar aberto, com o mesmo documento. */
function reopen(s: Session): void {
  for (const t of s.timers) clearTimeout(t);
  s.timers = [];
  s.status = 'pending';
  s.result = null;
  s.registryNo = null;
  s.job = null;
  s.signedWith = null;
  s.receipt = null;
  bus.emit(s.id);
  armTtl(s);
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
          spots: s.spots,
          pages: s.pageCount,
          hints: s.hints,
        };
  }
  return {
    kind: s.kind,
    status: s.status,
    result: s.status === 'pending' ? null : publicState(s),
    document,
    signatures: listSignaturesForUi(),
    prefs: getPrefs(),
    history: s.history,
    ...(s.kind === 'sign'
      ? {
          delivery: deliveryOptions(),
          // número desta assinatura no registro do computador (a próxima, enquanto não assina)
          registryNo: s.registryNo ?? safeCount() + 1,
          job: s.job,
          receipt: s.receipt && existsSync(s.receipt) ? basename(s.receipt) : null,
        }
      : {}),
  };
}

const safeCount = (): number => {
  try {
    return countAuditEvents('document_signed');
  } catch {
    return 0;
  }
};

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
  spots = [],
  pageCount = null,
  client,
}: {
  file: string;
  bytes?: Buffer;
  placements: Placement[];
  anchor?: AnchorInfo | null;
  spots?: SpotInfo[];
  pageCount?: number | null;
  client: string;
}): Session {
  const s = createSession({ kind: 'sign', client });
  s.file = file;
  s.original = bytes; // a prévia mostra exatamente os bytes que serão assinados
  s.placements = placements;
  s.anchor = anchor;
  s.spots = spots;
  s.pageCount = pageCount;
  s.hasDigitalSignature = hasDigitalSignature(bytes);
  note(s, 'document', { name: basename(file), ...(pageCount ? { pages: pageCount } : {}) });
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
  const { placement, anchor, spots, pageCount } = await locateSignatureSpot(bytes, s.anchorText);
  if (s.status !== 'pending') throw new LabsignError('SESSION_CLOSED', { status: s.status }); // cancelado enquanto lia o PDF
  s.original = bytes;
  s.file = join(outputDir(), u.name); // só para nomear a saída: o original não é gravado em lugar nenhum
  s.placements = [placement];
  s.anchor = anchor;
  s.spots = spots;
  s.pageCount = pageCount;
  s.hasDigitalSignature = hasDigitalSignature(bytes);
  s.awaiting = false;
  s.uploaded = true;
  note(s, 'document', { name: u.name, pages: pageCount });
  audit({ event: 'document_received', name: u.name, bytes: bytes.length, sha256: sha256(bytes), client: s.client });
  return { received: size, total: size, done: true };
}

/**
 * "Remover" / "Trocar" o documento: o pedido volta a esperar um PDF. Só tira o documento desta tela —
 * o arquivo no computador fica onde está. (A cópia assinada que a tela gerar depois vai para a pasta de saída.)
 */
export function uiRemoveDocument(s: Session) {
  if (s.kind !== 'sign') throw new LabsignError('NOT_A_SIGN_SESSION');
  if (s.status !== 'pending' || s.signing) throw new LabsignError('SESSION_CLOSED', { status: s.signing ? 'signing' : s.status });
  if (s.awaiting) return { removed: false };
  const name = s.file ? basename(s.file) : '';
  s.anchorText ??= s.anchor?.text ?? 'CONTRATANTE';
  Object.assign(s, { original: null, file: null, placements: null, anchor: null, spots: [], pageCount: null, hasDigitalSignature: false, awaiting: true, uploaded: false, upload: null });
  note(s, 'removed', { name });
  try {
    audit({ event: 'document_removed', name, client: s.client });
  } catch (e) {
    console.error('[labsign] documento removido, mas o registro de auditoria falhou:', (e as Error)?.message ?? e);
  }
  return { removed: true, name };
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

/** Textos para escrever na página (local e data, nome, CPF): poucos, curtos, dentro de uma página. */
function sanitizeTexts(list: unknown): StampText[] {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 4) throw new LabsignError('INVALID_PLACEMENT');
  return list.map((t) => {
    const q = { pageIndex: Number(t?.pageIndex), x: Number(t?.x), y: Number(t?.y), size: Number(t?.size ?? 10) };
    const lines: string[] = Array.isArray(t?.lines) ? t.lines.slice(0, 4).map((l: unknown) => String(l ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 120)) : [];
    if (!Number.isInteger(q.pageIndex) || q.pageIndex < 0 || ![q.x, q.y, q.size].every(Number.isFinite) || q.size < 6 || q.size > 24 || !lines.some((l) => l.trim())) {
      throw new LabsignError('INVALID_PLACEMENT');
    }
    return { ...q, lines };
  });
}

/** Cada lugar assinado, com o rótulo do bloco da lista quando cai nele. */
function placeLabels(s: Session, placements: { pageIndex: number; x: number; y: number; width: number }[]) {
  return placements.map((p) => {
    // o bloco cuja linha (a base proposta) fica logo abaixo do topo da assinatura, na mesma coluna
    const spot = s.spots.find((sp) => {
      const base = sp.placement.bottom ?? sp.placement.y ?? 0;
      return sp.placement.pageIndex === p.pageIndex && Math.abs(sp.placement.x - p.x) < 80 && base >= p.y - 20 && base <= p.y + 160;
    });
    return { page: p.pageIndex + 1, label: spot?.label ?? null };
  });
}

/**
 * Carimba. placements (opcional) é a posição final que o humano ajustou na prévia — um ou mais lugares;
 * sem ela, usa a posição proposta. initials: a rubrica (outro desenho do cofre) em várias páginas.
 * texts: local e data (e nome/CPF) escritos na página. Tudo num salvamento incremental só.
 * ink/pen: cor e espessura escolhidas (padrão: preferências).
 */
export async function uiConfirm(
  s: Session,
  { signatureId, placements, ink, pen, initials, texts }: { signatureId: string; placements?: unknown; ink?: unknown; pen?: unknown; initials?: { signatureId?: string; placements?: unknown } | null; texts?: unknown },
) {
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
  const initialsRecord = initials ? loadSignature(String(initials.signatureId ?? '')) : null;
  const initialsPlacements = initials ? sanitizePlacements(initials.placements) : [];
  const writing = sanitizeTexts(texts);
  const color = inkRgb(inkKey);
  const original = s.original;
  const file = s.file;

  s.signing = true; // daqui até gravar há um await: uma segunda confirmação não pode passar pelo mesmo caminho
  try {
    const { bytes } = await stampSignature({
      pdfBytes: original,
      groups: [
        { signature, placements: chosen, color },
        ...(initialsRecord ? [{ signature: strokesToSignature(initialsRecord.strokes, penOptions(penKey)), placements: initialsPlacements, color }] : []),
      ],
      texts: writing,
      mode: 'incremental',
      color,
    });
    // cancelado, expirado ou aba fechada enquanto carimbava: não grava nada
    if (s.status !== 'pending') throw new LabsignError('SESSION_CLOSED', { status: s.status });
    const outPath = nextOutputPath(file);
    writeFileSync(outPath, bytes, { flag: 'wx' }); // 'wx': falha em vez de sobrescrever, mesmo numa corrida

    // o arquivo já existe: daqui em diante nada pode deixar o pedido pendurado (uma nova tentativa geraria "-2")
    const pages = [...new Set(chosen.map((p) => p.pageIndex + 1))];
    const places = placeLabels(s, chosen);
    const initialsPages = [...new Set(initialsPlacements.map((p) => p.pageIndex + 1))];
    let auditId: string | undefined;
    try {
      markSignatureUsed(record.id);
      if (initialsRecord) markSignatureUsed(initialsRecord.id);
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
        // rubrica e textos: o que entrou e onde (o conteúdo dos textos fica só no PDF, não no registro)
        ...(initialsRecord ? { initials: { signature: initialsRecord.id, label: initialsRecord.label, pages: initialsPages } } : {}),
        ...(writing.length ? { texts: writing.map((t) => ({ page: t.pageIndex + 1, lines: t.lines.length })) } : {}),
        client: s.client,
      }).hash.slice(0, 12);
    } catch (e) {
      console.error('[labsign] assinado, mas o registro de auditoria falhou:', (e as Error)?.message ?? e);
    }
    s.registryNo = safeCount();
    s.signedWith = { signatureId: record.id, pen: penKey };
    note(s, 'signed', { name: basename(outPath), page: pages[0], folder: folderLabel(dirname(outPath)), ...(pages.length > 1 ? { places: pages.length } : {}), ...(initialsPages.length ? { initials: initialsPages.length } : {}) });
    finish(s, 'signed', {
      signed_file: outPath,
      sha256_original: sha256(original),
      sha256_signed: sha256(bytes),
      pages,
      places,
      ...(initialsPages.length ? { initials_pages: initialsPages.length } : {}),
      ...(writing.length ? { texts: writing.length } : {}),
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
  const revealed = await revealFile(file);
  if (revealed) note(s, 'revealed');
  return { revealed, file };
}

export type DeliverAction = 'open' | 'reveal' | 'copy' | 'mail' | 'whatsapp';

/**
 * Entrega pelo computador. O servidor faz o que o painel do chat não faz: anexar num e-mail novo
 * (Apple Mail, Outlook), pôr o arquivo na área de transferência, abrir o Gmail ou o WhatsApp com o
 * arquivo à mão (copiado e à vista na pasta). Enviar, quem envia é sempre a pessoa, no app dela.
 */
export async function uiDeliver(
  s: Session,
  { action, client, phone, subject, body, text }: { action: DeliverAction; client?: MailClient; phone?: string; subject?: string; body?: string; text?: string },
) {
  const file = signedPath(s);
  if (!existsSync(file)) throw new LabsignError('SIGNED_FILE_MISSING', { file });
  const clip = (v: unknown, max: number) => String(v ?? '').slice(0, max);
  const opts = deliveryOptions();
  switch (action) {
    case 'open': {
      const done = await openFile(file);
      if (done) note(s, 'opened_file');
      return { done, file };
    }
    case 'reveal': {
      const done = await revealFile(file);
      if (done) note(s, 'revealed');
      return { done, file };
    }
    case 'copy': {
      if (!opts.copy) throw new LabsignError('DELIVERY_UNAVAILABLE');
      const done = await copyFileToClipboard(file);
      if (done) note(s, 'copied');
      return { done, file };
    }
    case 'mail': {
      if (!client || !opts.mail.includes(client)) throw new LabsignError('DELIVERY_UNAVAILABLE');
      if (client === 'gmail') {
        // o Gmail na web não recebe anexo por link: o PDF vai copiado e à vista, e o Gmail abre por último (fica na frente)
        const copied = await copyFileToClipboard(file);
        const revealed = await revealFile(file);
        const done = await openUrl(gmailComposeUrl(clip(subject, 300), clip(body, 2000)));
        if (done) note(s, 'mail', { client });
        return { done, copied, revealed, guided: true, file };
      }
      const done = await mailWithAttachment(client, file, clip(subject, 300), clip(body, 2000));
      if (done) note(s, 'mail', { client });
      return { done, attached: done, file };
    }
    case 'whatsapp': {
      // não há como anexar por link: o PDF vai copiado e à vista na pasta; o WhatsApp abre por último
      const digits = String(phone ?? '').replace(/\D/g, '').slice(0, 15);
      const copied = await copyFileToClipboard(file);
      const revealed = await revealFile(file);
      const done = await openUrl(whatsappUrl(digits, clip(text, 1000), opts.whatsappApp));
      if (done) note(s, 'whatsapp', { via: opts.whatsappApp ? 'app' : 'web' });
      return { done, copied, revealed, guided: true, via: opts.whatsappApp ? 'app' : 'web', file };
    }
  }
  throw new LabsignError('DELIVERY_UNAVAILABLE');
}

/**
 * "Salvar uma cópia em…": abre a janela de salvar do sistema e devolve na hora — a janela espera a
 * pessoa o tempo que ela quiser, e a tela acompanha por uiSaveJob (uma chamada presa até a pessoa
 * escolher estouraria o limite de tempo do app de chat).
 */
export function uiSaveCopy(s: Session, { prompt }: { prompt?: string } = {}): SaveJob {
  const signed = signedPath(s);
  if (!existsSync(signed)) throw new LabsignError('SIGNED_FILE_MISSING', { file: signed });
  if (s.job?.state === 'running') return { ...s.job };
  const job: SaveJob = { id: (s.job?.id ?? 0) + 1, state: 'running' };
  s.job = job;
  void (async () => {
    try {
      const dest = await saveAsDialog(String(prompt || 'Save a copy of the signed PDF').slice(0, 200), basename(signed), dirname(signed));
      if (!dest) job.state = 'cancelled';
      else {
        const { file: target, renamed } = copyTo(signed, dest);
        Object.assign(job, { state: 'done', file: target, name: basename(target), folder: folderLabel(dirname(target)), renamed });
        note(s, 'saved_copy', { name: basename(target), folder: folderLabel(dirname(target)) });
      }
    } catch (e) {
      job.state = 'error';
      job.error = errorPayload(e);
    } finally {
      bus.emit(`job:${s.id}`);
    }
  })();
  return { ...job };
}

/** Estado da última "cópia em…"; com wait_ms, espera (até 25 s) ela terminar. */
export async function uiSaveJob(s: Session, { wait_ms }: { wait_ms?: number } = {}) {
  const wait = Math.min(Math.max(Number(wait_ms) || 0, 0), 25000);
  if (s.job?.state === 'running' && wait > 0) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        bus.off(`job:${s.id}`, done);
        resolve();
      };
      const timer = setTimeout(done, wait);
      bus.once(`job:${s.id}`, done);
    });
  }
  return s.job ? { ...s.job } : { id: 0, state: 'none' as const };
}

/** "arquivo.pdf" livre: se já existe, "arquivo-2.pdf", "arquivo-3.pdf"… (nunca substitui nada). */
function freePath(wanted: string): string {
  const ext = extname(wanted);
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  let file = wanted;
  for (let n = 2; existsSync(file); n++) file = `${stem}-${n}${ext}`;
  return file;
}

const platformName = () => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[process.platform as string] ?? process.platform;

/**
 * Comprovante: um PDF à parte, ao lado da cópia assinada ("….comprovante.pdf"), com data e hora,
 * onde entrou a assinatura, o desenho usado e os SHA-256 do original e do assinado. Abre na hora.
 */
export async function uiReceipt(s: Session, { lang }: { lang?: string } = {}) {
  const signed = signedPath(s);
  if (!existsSync(signed)) throw new LabsignError('SIGNED_FILE_MISSING', { file: signed });
  // já existe para esta assinatura: abre o mesmo, em vez de espalhar comprovantes iguais pela pasta
  if (s.receipt && existsSync(s.receipt)) {
    const opened = await openFile(s.receipt);
    return { file: s.receipt, name: basename(s.receipt), folder: folderLabel(dirname(s.receipt)), opened, again: true };
  }
  const r = s.result!;
  let signature = null;
  try {
    if (s.signedWith) signature = strokesToSignature(loadSignature(s.signedWith.signatureId).strokes, penOptions(s.signedWith.pen));
  } catch {} // apagada do cofre depois de assinar: o comprovante sai sem o desenho
  const signedAt = [...s.history].reverse().find((h) => h.event === 'signed')?.at ?? new Date().toISOString();
  const bytes = await makeReceipt({
    lang: langFrom(lang),
    documentName: s.file ? basename(s.file) : basename(signed),
    pageCount: s.pageCount,
    signedName: basename(signed),
    folder: folderLabel(dirname(signed)),
    signedAt,
    sha256Original: r.sha256_original ?? '',
    sha256Signed: r.sha256_signed ?? '',
    places: r.places ?? (r.pages ?? []).map((page) => ({ page, label: null })),
    initialsPages: r.initials_pages ?? 0,
    texts: r.texts ?? 0,
    signature,
    signatureLabel: r.signature_label ?? '',
    registryNo: s.registryNo,
    auditId: r.audit_id ?? null,
    version: VERSION,
    platform: platformName(),
  });
  const ext = extname(signed);
  const file = freePath(`${ext ? signed.slice(0, -ext.length) : signed}.comprovante.pdf`);
  writeFileSync(file, bytes, { flag: 'wx' });
  s.receipt = file;
  try {
    audit({ event: 'receipt_created', output: file, sha256_signed: r.sha256_signed, sha256_receipt: sha256(bytes), client: s.client });
  } catch (e) {
    console.error('[labsign] comprovante gerado, mas o registro de auditoria falhou:', (e as Error)?.message ?? e);
  }
  note(s, 'receipt', { name: basename(file) });
  const opened = await openFile(file);
  return { file, name: basename(file), folder: folderLabel(dirname(file)), opened, again: false };
}

/**
 * Desfazer a assinatura: a cópia assinada vai para a Lixeira (dá para recuperar), o registro de
 * evidências ganha uma linha (nada é apagado dele) e o pedido volta a ficar aberto com o mesmo
 * documento. Cópias que a pessoa já salvou em outro lugar ou enviou continuam onde estão.
 */
export async function uiUndo(s: Session) {
  const file = signedPath(s);
  if (!s.original) throw new LabsignError('UNDO_EXPIRED'); // passou 1 h: o original já saiu da memória
  const result = s.result!;
  let trashed = false;
  if (existsSync(file)) {
    trashed = await moveToTrash(file);
    if (!trashed && existsSync(file)) throw new LabsignError('TRASH_FAILED', { file });
  }
  // o comprovante descreve uma cópia que não existe mais: vai junto (se não der, fica — não impede desfazer)
  if (s.receipt && existsSync(s.receipt)) await moveToTrash(s.receipt).catch(() => false);
  try {
    audit({ event: 'signature_undone', output: file, sha256_signed: result.sha256_signed, trashed, client: s.client });
  } catch (e) {
    console.error('[labsign] desfeito, mas o registro de auditoria falhou:', (e as Error)?.message ?? e);
  }
  reopen(s);
  note(s, 'undone', { name: basename(file), trashed: trashed ? 1 : 0 });
  return { ...publicState(s), undone_file: file, trashed };
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
 * Depois de assinar, a tela ainda serve para salvar, enviar ou desfazer: espera ela fechar (com a mesma
 * carência de recarregar) ou a pessoa desfazer a assinatura, que reabre o pedido — o que vier primeiro.
 */
export async function waitAfterSigned(id: string, ms: number, graceMs = CLOSE_GRACE_MS): Promise<'closed' | 'reopened' | 'timeout'> {
  const s = sessions.get(id);
  const deadline = Date.now() + ms;
  const nap = (t: number) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(t, deadline - Date.now()))));
  // o status muda por fora (a tela desfaz) enquanto este laço dorme: lê sempre de novo
  const status = (): SessionStatus | undefined => s?.status;
  while (s && Date.now() < deadline) {
    if (status() === 'pending') return 'reopened';
    if (s.closed) {
      await nap(graceMs);
      if (s.closed && status() !== 'pending') return 'closed';
      continue;
    }
    await nap(400);
  }
  return status() === 'pending' ? 'reopened' : 'timeout';
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
