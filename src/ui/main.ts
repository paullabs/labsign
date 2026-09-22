// Tela única do labsign — o talão de vias.
//   Sessão "sign": canhoto (documento, onde assinar, sua assinatura, histórico), picote e via (o
//                  documento inteiro, com a assinatura posicionável e a régua de páginas). O pé
//                  tem sempre a saída (Cancelar) e a próxima ação dizendo o que vai acontecer.
//                  O que aparece na página é exatamente o que será carimbado.
//                  Depois de assinar, a via se destaca pelo picote e vira o quadro de entrega:
//                  abrir, pasta, salvar em…, e-mail com anexo, WhatsApp, copiar, desfazer.
//   Sessão "pad":  cofre — desenhar, salvar e apagar assinaturas.
// Dois transportes: HTTP (página em 127.0.0.1) ou MCP Apps (embutida no chat).
import { icons } from './icons.ts';
import { createPad, type Pad, type PadState } from './pad.ts';
import { openPdf, type PdfDoc } from './pdf-preview.ts';
import { createViewer, renderThumb, ZOOMS, type Viewer } from './viewer.ts';
import { strokesToSignature, signatureToSvg, penOptions, inkHex, INKS, PENS, type Ink, type Pen, type Stroke } from '../core/signature.ts';
import { DEFAULT_BOX, MIN_WIDTH, frameFromPlacement, boxInFrame, clampFrame, resizeFrame, scaleFrame, type Frame, type Placement } from '../core/placement.ts';
import { t, langFrom, hasKey, type Lang, type MessageKey, type Params } from '../i18n/messages.ts';

declare const __MCP_APP__: boolean;
declare const __LABSIGN_FONT__: string;

// ---------------------------------------------------------------- idioma e utilidades
// LABSIGN_LANG no servidor vence o idioma do navegador
const bootLang = (window as any).__LABSIGN_HTTP__?.lang;
let lang: Lang = bootLang === 'pt' || bootLang === 'en' ? bootLang : langFrom(navigator.language);
const L = (key: MessageKey, params?: Params) => t(lang, key, params);

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $app = $('#app');
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const baseName = (p: string) => String(p).split(/[\\/]/).pop() ?? String(p);
const locale = () => (lang === 'pt' ? 'pt-BR' : 'en-US');
const hm = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

/** "hoje, 19:02" · "ontem, 18:40" · "em 12/09/2026" */
function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 864e5);
  return days === 0 ? L('today', { hm: hm(iso) }) : days === 1 ? L('yesterday', { hm: hm(iso) }) : L('onDate', { date: d.toLocaleDateString(locale()) });
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A letra estreita dos rótulos vem embutida e entra por FontFace (a CSP da página e a do chat não precisam liberar fonte externa). */
function loadFont(): void {
  try {
    if (typeof __LABSIGN_FONT__ !== 'string' || !__LABSIGN_FONT__) return;
    const face = new FontFace('Labsign Form', fromBase64(__LABSIGN_FONT__) as unknown as ArrayBuffer, { weight: '600' });
    (document.fonts as any).add(face);
    face.load().catch(() => {});
  } catch {}
}

/** Erro vindo do servidor, com código estável (a mensagem sai no idioma da tela). */
class UiError extends Error {
  code: string;
  params: Params;
  constructor(code: string, message: string, params: Params = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}
const toUiError = (payload: any, fallback: string) =>
  payload && typeof payload.error === 'string' ? new UiError(payload.error, payload.message ?? fallback, payload.params ?? {}) : new UiError('INTERNAL', fallback);
/** fetch que não chegou ao servidor (programa fechado, conexão caiu) — não um erro de código */
const isConnectionLost = (e: unknown) => e instanceof TypeError && /fetch|network|load failed/i.test(e.message);
function errText(e: unknown, fallback: MessageKey = 'err.generic'): string {
  if (e instanceof UiError && hasKey(`err.${e.code}`)) return L(`err.${e.code}` as MessageKey, e.params);
  if (isConnectionLost(e)) return L('err.CONNECTION');
  console.error(e);
  return L(fallback);
}

// ---------------------------------------------------------------- transporte
interface Display {
  readonly can: boolean;
  readonly mode: 'inline' | 'fullscreen';
  toggle(): Promise<void>;
}
interface Transport {
  embedded: boolean;
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  readDocument(): Promise<Uint8Array>;
  readSigned(): Promise<Uint8Array>;
  upload(file: File, onProgress?: (p: number) => void): Promise<unknown>;
  closeOnExit(): void;
  notifyModel(text: string): Promise<void>;
  /** Tela cheia no app de chat (quando ele deixa). */
  display: Display | null;
  onHostChange(cb: () => void): void;
  /** Altura máxima que o app de chat dá para a tela embutida. */
  maxHeight(): number | null;
}

async function makeTransport(): Promise<Transport> {
  const boot = (window as any).__LABSIGN_HTTP__ as { sessionId: string; viewToken: string; lang?: string } | undefined;
  if (boot) {
    const headers = { 'content-type': 'application/json', 'x-labsign-view': boot.viewToken };
    const post = (name: string, args?: unknown) => fetch(`/api/${boot.sessionId}/${name}`, { method: 'POST', headers, body: JSON.stringify(args ?? {}) });
    const bytesOf = async (name: string) => {
      const res = await post(name);
      if (!res.ok) throw toUiError(await res.json().catch(() => null), L('cannotRead'));
      return new Uint8Array(await res.arrayBuffer());
    };
    return {
      embedded: false,
      async call(name, args) {
        const res = await post(name, args);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw toUiError(json, `HTTP ${res.status}`);
        return json;
      },
      readDocument: () => bytesOf('document'),
      readSigned: () => bytesOf('signed_document'),
      /** Envia o PDF escolhido/arrastado (um POST cru; o servidor valida). */
      async upload(file, onProgress) {
        onProgress?.(0);
        const res = await fetch(`/api/${boot.sessionId}/upload_document`, {
          method: 'POST',
          headers: { 'x-labsign-view': boot.viewToken, 'content-type': 'application/pdf', 'x-labsign-filename': encodeURIComponent(file.name) },
          body: file,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw toUiError(json, `HTTP ${res.status}`);
        onProgress?.(1);
        return json;
      },
      /** Avisa que a aba fechou (o CLI espera isso para encerrar). Beacon não leva cabeçalho: o token vai no corpo. */
      closeOnExit() {
        addEventListener('pagehide', () =>
          navigator.sendBeacon(`/api/${boot.sessionId}/close`, new Blob([JSON.stringify({ view_token: boot.viewToken })], { type: 'application/json' })),
        );
      },
      notifyModel: async () => {},
      display: null,
      onHostChange() {},
      maxHeight: () => null,
    };
  }
  // __MCP_APP__ é constante de build: na variante do navegador, este ramo (e o SDK) some do pacote
  if (__MCP_APP__) return makeAppTransport();
  throw new UiError('NO_SESSION', 'no session');
}

/** MCP Apps: a sessão chega pelo resultado da tool que abriu esta tela. */
async function makeAppTransport(): Promise<Transport> {
  const { App, applyDocumentTheme } = await import('@modelcontextprotocol/ext-apps');
  const app = new App({ name: 'labsign', version: '1' });
  let gotResult!: (r: any) => void;
  const firstResult = new Promise<any>((r) => (gotResult = r));
  app.ontoolresult = (params: any) => gotResult(params);
  const ctx = () => (app.getHostContext() ?? {}) as any;
  const listeners: (() => void)[] = [];
  // tema do app de chat (claro/escuro), inclusive quando muda com a tela aberta
  const applyTheme = () => {
    const theme = ctx().theme;
    if (theme === 'light' || theme === 'dark') applyDocumentTheme(theme);
  };
  app.addEventListener('hostcontextchanged', () => {
    applyTheme();
    for (const cb of listeners) cb();
  });
  await app.connect();
  applyTheme();
  const hostLocale = ctx().locale;
  if (hostLocale) lang = langFrom(hostLocale);
  const result = await firstResult;
  // bug aberto do Claude Desktop com servidor local: structuredContent pode não chegar à tela
  // (anthropics/claude-ai-mcp#563) — o texto do resultado repete o request_id como plano B
  const text: string = result.content?.find((c: any) => c.type === 'text')?.text ?? '';
  const requestId: string | undefined = result.structuredContent?.request_id ?? /request_id="([a-f0-9]{12})"/.exec(text)?.[1];
  const viewToken: string | undefined = result._meta?.labsign?.viewToken;
  if (!requestId || !viewToken) throw new UiError('NO_HANDOFF', 'no handoff');
  const call = async (name: string, args?: Record<string, unknown>) => {
    const r: any = await app.callServerTool({ name: `labsign_view_${name}`, arguments: { request_id: requestId, view_token: viewToken, ...(args ?? {}) } });
    if (r.isError) {
      const raw = r.content?.[0]?.text ?? '';
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {}
      throw toUiError(payload, raw || 'error');
    }
    return r.structuredContent;
  };
  const readChunks = async (tool: string) => {
    const parts: Uint8Array[] = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const r = await call(tool, { offset });
      total = r.total;
      const chunk = fromBase64(r.data);
      if (!chunk.length) break;
      parts.push(chunk);
      offset += chunk.length;
    }
    const out = new Uint8Array(offset);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  return {
    embedded: true,
    call,
    readDocument: () => readChunks('document'),
    readSigned: () => readChunks('signed_document'),
    /** No chat, o PDF sobe em blocos pela tool da própria tela (sem rede direta a partir do iframe). */
    async upload(file, onProgress) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const CHUNK = 384 * 1024;
      let r = null;
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        r = await call('upload_document', { name: file.name, size: bytes.length, offset, data: toBase64(bytes.subarray(offset, offset + CHUNK)) });
        onProgress?.(Math.min(1, (offset + CHUNK) / bytes.length));
      }
      return r;
    },
    closeOnExit() {}, // no chat, o servidor MCP vive enquanto o app de chat quiser
    async notifyModel(text) {
      try {
        await app.updateModelContext({ content: [{ type: 'text', text }] });
      } catch {}
    },
    display: {
      get can() {
        return (ctx().availableDisplayModes ?? []).includes('fullscreen');
      },
      get mode() {
        return ctx().displayMode === 'fullscreen' ? 'fullscreen' : 'inline';
      },
      async toggle() {
        await app.requestDisplayMode({ mode: ctx().displayMode === 'fullscreen' ? 'inline' : 'fullscreen' });
      },
    },
    onHostChange: (cb) => listeners.push(cb),
    maxHeight: () => {
      const d = ctx().containerDimensions ?? {};
      return typeof d.maxHeight === 'number' ? d.maxHeight : typeof d.height === 'number' ? d.height : null;
    },
  };
}

// ---------------------------------------------------------------- estado
interface UiSignature {
  id: string;
  label: string;
  kind: string;
  createdAt: string;
  lastUsedAt: string | null;
  strokes: Stroke[];
}
interface Prefs {
  drawMode: 'drag' | 'click';
  ink: Ink;
  pen: Pen;
  /** Altura do painel no chat: pequeno, médio, grande. */
  panel: 'p' | 'm' | 'g';
  fill?: { city: string; name: string; doc: string };
  rubrica?: { dx: number; dy: number; w: number; withSigned: boolean };
}
interface Spot {
  label: string;
  name: string | null;
  page: number;
  placement: Placement;
}
interface DocInfo {
  awaiting?: boolean;
  maxBytes?: number;
  outputDir?: string;
  outputDirLabel?: string;
  name?: string;
  outputName?: string;
  uploaded?: boolean;
  hasDigitalSignature?: boolean;
  anchor?: { text: string | null; found: boolean; page: number } | null;
  placements?: Placement[];
  spots?: Spot[];
  pages?: number | null;
  hints?: { initials: boolean; placeDate: boolean };
}
interface HistoryEntry {
  at: string;
  event: string;
  detail?: Record<string, string | number>;
}
interface Delivery {
  platform: 'mac' | 'windows' | 'linux';
  saveAs: boolean;
  copy: boolean;
  trash: boolean;
  mail: string[];
  whatsappApp: boolean;
}

const S = {
  t: null as unknown as Transport,
  kind: 'sign' as 'sign' | 'pad',
  status: 'pending',
  doc: null as DocInfo | null,
  signatures: [] as UiSignature[],
  prefs: { drawMode: 'drag', ink: 'navy', pen: 'medium', panel: 'm' } as Prefs,
  selected: null as string | null, // assinatura escolhida (sempre uma salva no cofre)
  frame: null as Frame | null, // moldura da assinatura principal, em pontos visuais da página
  spot: null as number | null, // lugar da lista "Onde assinar"; null = outro lugar
  extras: [] as { key: string; frame: Frame }[], // "assinar em mais um lugar"
  rubrica: { on: false, sigId: null as string | null, dx: 40, dy: 56, w: 58, withSigned: false },
  texto: { on: false, city: '', date: '', name: '', doc: '', pageIndex: 0, x: 0, y: 0, placed: false },
  viewer: null as Viewer | null,
  pdf: null as PdfDoc | null,
  source: null as 'original' | 'signed' | null,
  history: [] as HistoryEntry[],
  registryNo: null as number | null,
  delivery: null as Delivery | null,
  receipt: null as string | null, // nome do comprovante já gerado para esta assinatura
  result: null as any,
  busy: false,
  locked: false,
  placing: false as false | 'move' | 'add',
  previewFailed: false,
  uploading: false,
  saving: false,
  layout: 'full' as 'full' | 'compact',
  elsewhere: false, // a tela está aberta no navegador (plano B do chat)
};
let pad: Pad | null = null;

// cada assinatura é redesenhada a partir dos traços, na cor e espessura atuais
const art = new Map<string, { key: string; svg: string; aspect: number }>();
function rendered(strokes: Stroke[], key: string) {
  const k = `${key}|${S.prefs.pen}|${S.prefs.ink}`;
  if (!art.has(k)) {
    const sig = strokesToSignature(strokes, penOptions(S.prefs.pen));
    art.set(k, { key: k, svg: signatureToSvg(sig, inkHex(S.prefs.ink) as any), aspect: sig.height / sig.width });
  }
  return art.get(k)!;
}

/** Um registro estragado no cofre (sem traços, traços inválidos) fica de fora em vez de apagar a tela inteira. */
function usable(list: unknown): UiSignature[] {
  return (Array.isArray(list) ? list : []).filter((s: any) => {
    try {
      if (typeof s?.id !== 'string' || typeof s.label !== 'string' || typeof s.createdAt !== 'string') return false;
      const { aspect } = rendered(s.strokes, s.id);
      return Number.isFinite(aspect) && aspect > 0;
    } catch {
      return false;
    }
  });
}

const byId = (id: string | null) => (id ? S.signatures.find((s) => s.id === id) : undefined);
/** O desenho da assinatura na cor do texto em volta (o canhoto pinta de azul de carbono). */
function carbonCopy(id: string): string | null {
  const s = byId(id);
  return s ? signatureToSvg(strokesToSignature(s.strokes, penOptions(S.prefs.pen)), 'currentColor' as any) : null;
}
function currentSig() {
  const s = byId(S.selected);
  return s ? { ...rendered(s.strokes, s.id), label: L('sigLabelSaved', { label: s.label }), name: s.label } : null;
}
const placeholderAspect = (f: Frame | null = S.frame) => (f && Number.isFinite(f.h) ? f.h / f.w : DEFAULT_BOX.maxHeight / DEFAULT_BOX.width);
const currentAspect = (f: Frame | null = S.frame) => currentSig()?.aspect ?? placeholderAspect(f);
const mostRecent = (list: UiSignature[]) => [...list].sort((a, b) => (b.lastUsedAt || b.createdAt).localeCompare(a.lastUsedAt || a.createdAt))[0] ?? null;
const rowMeta = (s: UiSignature) => (s.lastUsedAt ? L('usedWhen', { when: when(s.lastUsedAt) }) : L('savedWhen', { when: when(s.createdAt) }));
const pageSize = (i: number) => S.viewer?.sizes[i] ?? { width: 595, height: 842 };
const modKey = () => (S.delivery?.platform ?? (/Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other')) === 'mac' ? '⌘' : 'Ctrl+';
const pasteKey = () => `${modKey()}V`;
/** Pasta de saída como o servidor a descreve ("~/Downloads"); o caminho completo é o plano B. */
const folderFull = () => S.doc?.outputDirLabel || S.doc?.outputDir || '';
/** Caminho comprido vira as duas últimas pastas ("…/Contratos/2026"); o completo fica no title. */
const shortFolder = (label: string) => {
  const parts = label.split(/[\\/]/).filter(Boolean);
  return label.length <= 34 || parts.length <= 2 ? label : `…/${parts.slice(-2).join('/')}`;
};
const folderLabel = () => shortFolder(folderFull());

async function refreshState(): Promise<any> {
  const st = await S.t.call('state');
  S.status = st.status;
  S.doc = st.document;
  S.history = st.history ?? [];
  S.registryNo = st.registryNo ?? null;
  S.delivery = st.delivery ?? null;
  S.receipt = st.receipt ?? null;
  S.signatures = usable(st.signatures);
  if (S.selected && !byId(S.selected)) S.selected = mostRecent(S.signatures)?.id ?? null;
  return st;
}

// ---------------------------------------------------------------- aviso rápido
let recadoTimer: ReturnType<typeof setTimeout>;
let recadoGen = 0;
/** Recado sobre as folhas: não empurra nada. Some sozinho — mas só depois do próximo gesto, para não sumir enquanto a pessoa lê. */
function flash(text: string, { error = false, sticky = false } = {}): void {
  const el = $('#recado');
  if (!el) return;
  const gen = ++recadoGen;
  const pe = $('#pe');
  el.style.bottom = pe && !pe.hidden && pe.offsetParent ? `${pe.offsetHeight + 14}px` : '16px';
  el.className = `recado${error ? ' erro' : ''}`;
  el.innerHTML = `${error ? icons.alert(16) : icons.check(16)}<span>${esc(text)}</span>`;
  void el.offsetWidth;
  el.classList.add('mostra');
  clearTimeout(recadoTimer);
  if (sticky) return;
  recadoTimer = setTimeout(
    () => {
      const hide = () => {
        window.removeEventListener('pointerup', hide, true);
        window.removeEventListener('keyup', hide, true);
        setTimeout(() => gen === recadoGen && el.classList.remove('mostra'));
      };
      window.addEventListener('pointerup', hide, true);
      window.addEventListener('keyup', hide, true);
    },
    error ? 7000 : 4000,
  );
}
const hideFlash = () => $('#recado')?.classList.remove('mostra');

// ---------------------------------------------------------------- pedaços de HTML
const inkHtml = (suffix = '') => `
  <div class="tinta">
    <span class="rotulo">${L('inkColor')}</span>
    <div class="amostras" role="radiogroup" aria-label="${L('inkColorAria')}">
      ${(Object.keys(INKS) as Ink[])
        .map((k) => `<label class="amostra" title="${L(`ink_${k}`)}"><input type="radio" name="ink${suffix}" value="${k}" aria-label="${L(`ink_${k}`)}"><span style="--c:${INKS[k]}"></span></label>`)
        .join('')}
    </div>
    <span class="rotulo">${L('inkStroke')}</span>
    <div class="seg" role="radiogroup" aria-label="${L('inkStrokeAria')}">
      ${(Object.keys(PENS) as Pen[])
        .map((k) => `<label><input type="radio" name="pen${suffix}" value="${k}"><span><i class="traco-linha" style="height:${Math.max(1, PENS[k] / 2.4).toFixed(1)}px"></i>${L(`pen_${k}`)}</span></label>`)
        .join('')}
    </div>
  </div>`;

const quadroHtml = () => `
  <div class="seg" id="modo" role="radiogroup" aria-label="${L('howToWrite')}">
    <label><input type="radio" name="modo" value="drag"><span>${L('modeDrag')}</span></label>
    <label><input type="radio" name="modo" value="click"><span>${L('modeClick')}</span></label>
  </div>
  <div class="quadro" id="quadro">
    <canvas id="pad" tabindex="0" aria-label="${L('padAria')}"></canvas>
    <p class="quadro-dica" id="quadro-dica"></p>
    <span class="caneta" id="caneta" aria-hidden="true"><span class="ponto"></span>${L('penStatus')}</span>
  </div>
  <div class="quadro-ferramentas">
    <div class="acoes">
      <button class="btn pequeno discreto" id="pad-desfazer" type="button" disabled>${icons.undo(15)}${L('undo')}</button>
      <button class="btn pequeno discreto" id="pad-limpar" type="button" disabled>${icons.x(15)}${L('clear')}</button>
    </div>
    ${inkHtml('-pad')}
  </div>`;

// ---------------------------------------------------------------- tinta (cor e espessura)
function syncInk(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name^="ink"], input[name^="pen"]')) {
    const key = input.name.startsWith('ink') ? 'ink' : 'pen';
    input.checked = S.prefs[key] === input.value;
  }
}
function wireInk(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name^="ink"], input[name^="pen"]')) {
    if (input.dataset.wired) continue;
    input.dataset.wired = '1';
    input.addEventListener('change', () => setInk({ [input.name.startsWith('ink') ? 'ink' : 'pen']: input.value }));
  }
  syncInk();
}
function setInk(change: Partial<Prefs>): void {
  Object.assign(S.prefs, change);
  syncInk();
  S.t.call('set_prefs', change).catch(() => {});
  pad?.redraw();
  if (S.kind === 'sign') {
    clampAllFrames(); // a espessura muda a proporção
    renderSig();
    renderRubricaField();
    if ($('#sig-lista') && !$('#sig-lista').hidden) renderSigList();
    if ($('#rubrica-lista') && !$('#rubrica-lista').hidden) renderSigList('rubrica');
    placeBox();
  } else renderVaultList();
}

// ---------------------------------------------------------------- quadro de desenho
function mountPad(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="modo"]')) {
    input.checked = input.value === S.prefs.drawMode;
    input.addEventListener('change', () => setDrawMode(input.value as Prefs['drawMode']));
  }
  pad = createPad($<HTMLCanvasElement>('#pad'), {
    getMode: () => S.prefs.drawMode,
    getInk: () => inkHex(S.prefs.ink),
    getSize: () => PENS[S.prefs.pen],
    onChange: onPadChange,
  });
  $('#pad-desfazer').addEventListener('click', () => pad!.undo());
  $('#pad-limpar').addEventListener('click', () => pad!.clear());
  // tablet com trackpad, notebook com tela de toque: o ponteiro principal pode mudar no meio da sessão
  matchMedia('(hover: none)').addEventListener('change', renderHint);
  renderHint();
}

function setDrawMode(mode: Prefs['drawMode']): void {
  pad?.finishStroke();
  S.prefs.drawMode = mode;
  renderHint();
  S.t.call('set_prefs', { drawMode: mode }).catch(() => {});
  $('#pad').focus({ preventScroll: true });
}

function renderHint(): void {
  const touchOnly = matchMedia('(hover: none)').matches;
  $('#modo').hidden = touchOnly;
  $('#quadro-dica').textContent = touchOnly ? L('hintTouch') : S.prefs.drawMode === 'click' ? L('hintClick') : L('hintDrag');
}

function onPadChange({ count, writing, sticky }: PadState): void {
  $('#quadro-dica').hidden = count > 0 || writing;
  $('#caneta').classList.toggle('on', sticky);
  $('#quadro').classList.toggle('escrevendo', writing);
  $<HTMLButtonElement>('#pad-desfazer').disabled = $<HTMLButtonElement>('#pad-limpar').disabled = count === 0 && !writing;
  const save = document.querySelector<HTMLButtonElement>('#pad-usar, #salvar');
  if (save) save.disabled = count === 0 || S.saving;
}

/** Salva o desenho do quadro no cofre. Devolve a assinatura salva, ou null. */
async function savePadDrawing(kind: 'signature' | 'rubrica' = 'signature'): Promise<UiSignature | null> {
  pad?.finishStroke();
  if (!pad || !pad.count() || S.saving) return null;
  S.saving = true;
  const button = document.querySelector<HTMLButtonElement>('#pad-usar, #salvar');
  if (button) button.disabled = true;
  try {
    const name = $<HTMLInputElement>('#pad-nome').value.trim() || L('defaultLabel');
    const meta = await S.t.call('save_signature', { label: name, kind, strokes: pad.strokes() });
    await refreshSignatures();
    return byId(meta.id) ?? null;
  } catch (e) {
    flash(errText(e), { error: true });
    return null;
  } finally {
    S.saving = false;
    if (button) button.disabled = !pad || pad.count() === 0;
  }
}

async function refreshSignatures(): Promise<void> {
  const st = await S.t.call('state');
  S.signatures = usable(st.signatures);
}

// ---------------------------------------------------------------- apagar do cofre
/** Troca a linha por uma confirmação; só apaga com o segundo clique. */
function askDelete(row: HTMLElement, s: UiSignature): void {
  row.classList.add('confirmando');
  row.innerHTML = `
    <span class="confirma-texto">${esc(L('deleteAsk', { label: s.label }))}</span>
    <button class="btn pequeno perigo" type="button" data-act="sim">${L('deleteYes')}</button>
    <button class="btn pequeno discreto" type="button" data-act="nao">${L('cancel')}</button>`;
  const rebuild = () => (S.kind === 'sign' ? renderSigList() : renderVaultList());
  $('[data-act="nao"]', row).addEventListener('click', () => {
    rebuild();
    $('#sig-lista .apagar')?.focus();
  });
  $('[data-act="sim"]', row).addEventListener('click', async () => {
    try {
      await S.t.call('delete_signature', { id: s.id });
      S.signatures = S.signatures.filter((x) => x.id !== s.id);
      if (S.selected === s.id) {
        S.selected = mostRecent(S.signatures)?.id ?? null;
        renderSig();
        placeBox();
        renderFoot();
      }
      rebuild();
      flash(L('deleted', { label: s.label }));
      document.querySelector<HTMLElement>('#sig-lista input, #sig-lista .apagar, #sig-nova, #pad')?.focus();
    } catch (e) {
      flash(errText(e), { error: true });
      rebuild();
    }
  });
  $('[data-act="nao"]', row).focus();
}

// ---------------------------------------------------------------- sessão "sign": a casca
function signShell(): string {
  return `
  <div class="talao" id="talao" data-layout="full" data-state="pending">
    <aside class="canhoto" id="canhoto" aria-label="${L('stubAria')}">
      <header class="c-topo">
        <span class="marca">${icons.nib(18)}labsign</span>
        <span class="numero" id="numero" title="${L('registryTitle')}"></span>
      </header>
      <section class="campo" id="campo-doc" aria-labelledby="l-doc">
        <h2 class="rotulo" id="l-doc">${L('fDoc')}</h2>
        <div id="doc-corpo"></div>
        <div class="campo-acoes" id="doc-acoes">
          <button class="link-btn" id="doc-trocar" type="button">${icons.swap(14)}${L('docSwap')}</button>
          <button class="link-btn" id="doc-remover" type="button">${icons.x(14)}${L('docRemove')}</button>
        </div>
      </section>
      <section class="campo" id="campo-onde" aria-labelledby="l-onde">
        <h2 class="rotulo" id="l-onde">${L('fWhere')}</h2>
        <div id="onde"></div>
        <div id="extras"></div>
      </section>
      <section class="campo" id="campo-sig" aria-labelledby="l-sig">
        <h2 class="rotulo" id="l-sig">${L('fSig')}</h2>
        <div id="sig-atual"></div>
        <div class="campo-acoes" id="sig-acoes">
          <button class="link-btn" id="sig-trocar" type="button" aria-expanded="false" aria-controls="sig-lista">${L('sigChange')}</button>
          <button class="link-btn" id="sig-nova" type="button">${icons.pen(14)}${L('sigNew')}</button>
        </div>
        <div class="sig-lista" id="sig-lista" role="radiogroup" aria-label="${L('sigListAria')}" hidden></div>
        ${inkHtml()}
      </section>
      <section class="campo campo-opcional" id="campo-rubrica" aria-labelledby="l-rubrica">
        <h2 class="rotulo" id="l-rubrica">${L('fRubrica')}</h2>
        <label class="chave"><input type="checkbox" id="rubrica-on"><span class="caixinha" aria-hidden="true">${icons.check(12)}</span><span>${L('rubricaOn')}</span></label>
        <div id="rubrica-corpo" hidden>
          <div id="rubrica-atual"></div>
          <div class="campo-acoes" id="rubrica-acoes">
            <button class="link-btn" id="rubrica-trocar" type="button" aria-expanded="false" aria-controls="rubrica-lista">${L('sigChange')}</button>
            <button class="link-btn" id="rubrica-nova" type="button">${icons.pen(14)}${L('rubricaDraw')}</button>
          </div>
          <div class="sig-lista" id="rubrica-lista" role="radiogroup" aria-label="${L('sigListAria')}" hidden></div>
          <p class="nota-campo" id="rubrica-nota"></p>
          <label class="chave pequena" id="rubrica-com-linha"><input type="checkbox" id="rubrica-com"><span class="caixinha" aria-hidden="true">${icons.check(12)}</span><span>${L('rubricaWithSigned')}</span></label>
        </div>
      </section>
      <section class="campo campo-opcional" id="campo-texto" aria-labelledby="l-texto">
        <h2 class="rotulo" id="l-texto">${L('fTexto')}</h2>
        <label class="chave"><input type="checkbox" id="texto-on"><span class="caixinha" aria-hidden="true">${icons.check(12)}</span><span>${L('textoOn')}</span></label>
        <div id="texto-corpo" hidden>
          <div class="grade-campos">
            <label class="campo-form"><span>${L('textoCity')}</span><input id="texto-cidade" type="text" maxlength="80" placeholder="${L('textoCityPh')}" autocomplete="address-level2"></label>
            <label class="campo-form"><span>${L('textoDate')}</span><input id="texto-data" type="text" maxlength="80"></label>
            <label class="campo-form"><span>${L('textoName')}</span><input id="texto-nome" type="text" maxlength="80" autocomplete="name"></label>
            <label class="campo-form"><span>${L('textoDoc')}</span><input id="texto-doc" type="text" maxlength="80" inputmode="numeric"></label>
          </div>
          <p class="nota-campo">${L('textoNote')}</p>
        </div>
      </section>
      <section class="campo" id="campo-hist" aria-labelledby="l-hist">
        <h2 class="rotulo" id="l-hist">${L('fHist')}</h2>
        <div class="hist-linha">
          <button class="link-btn hist-toggle" id="hist-toggle" type="button" aria-expanded="false" aria-controls="historico">${icons.chevronDown(14)}${L('fHist')}</button>
          <div class="painel-tamanho" id="painel-tamanho" role="group" aria-label="${L('panelSize')}" hidden>
            <span class="rotulo" aria-hidden="true">${L('panelSizeShort')}</span>
            <button class="icone-btn" id="painel-menor" type="button" aria-label="${L('panelSmaller')}" title="${L('panelSmaller')}">${icons.shrink(16)}</button>
            <button class="icone-btn" id="painel-maior" type="button" aria-label="${L('panelBigger')}" title="${L('panelBigger')}">${icons.grow(16)}</button>
          </div>
        </div>
        <ol class="historico" id="historico"></ol>
      </section>
      <p class="confianca">${icons.lock(14)}${L('trust')}</p>
    </aside>
    <div class="picote" aria-hidden="true"></div>
    <main class="via" id="via" aria-label="${L('viaAria')}">
      <div class="abas" id="abas" role="tablist" aria-label="${L('doneTitle')}" hidden>
        <button class="aba" id="aba-entrega" type="button" role="tab" aria-selected="true" aria-controls="entrega">${icons.share(15)}${L('tabDeliver')}</button>
        <button class="aba" id="aba-ver" type="button" role="tab" aria-selected="false" aria-controls="folhas-area">${icons.page(15)}${L('tabView')}</button>
      </div>
      <div class="barra" id="barra">
        <label class="endereco"><span>${L('pageField')}</span><input id="pagina" type="text" inputmode="numeric" autocomplete="off" spellcheck="false"><span id="pagina-total" class="num"></span></label>
        <button class="icone-btn ir-lugar" id="ir-lugar" type="button" hidden>${icons.target(16)}<span id="ir-lugar-t"></span></button>
        <span class="espaco"></span>
        <div class="ferramentas" role="group" aria-label="${L('zoomGroup')}">
          <button class="icone-btn" id="zoom-menos" type="button" aria-label="${L('zoomOut')}" title="${L('zoomOut')}">${icons.minus(16)}</button>
          <button class="icone-btn zoom-valor" id="zoom-ajustar" type="button" title="${L('zoomFit')}"></button>
          <button class="icone-btn" id="zoom-mais" type="button" aria-label="${L('zoomIn')}" title="${L('zoomIn')}">${icons.plus(16)}</button>
          <button class="icone-btn" id="zoom-pagina" type="button" aria-label="${L('zoomPage')}" title="${L('zoomPage')}">${icons.page(16)}</button>
        </div>
        <button class="icone-btn" id="procurar" type="button" aria-expanded="false" aria-controls="busca" aria-label="${esc(L('search'))}" title="${esc(L('search'))}">${icons.search(16)}<span class="rotulo-longo">${L('search')}</span></button>
        <button class="icone-btn" id="tela-cheia" type="button" hidden>${icons.expand(16)}<span class="rotulo-longo" id="tela-cheia-t">${L('fullscreen')}</span></button>
        <button class="icone-btn" id="no-navegador" type="button" aria-label="${esc(L('openBrowser'))}" title="${esc(L('openBrowser'))}" hidden>${icons.external(16)}<span class="rotulo-longo">${L('openBrowser')}</span></button>
      </div>
      <div class="busca" id="busca" hidden>
        <input id="busca-campo" type="search" placeholder="${L('searchPlaceholder')}" aria-label="${L('searchPlaceholder')}" autocomplete="off" spellcheck="false">
        <span class="busca-conta" id="busca-conta" aria-live="polite"></span>
        <button class="icone-btn" id="busca-ant" type="button" aria-label="${L('searchPrev')}">${icons.chevronUp(16)}</button>
        <button class="icone-btn" id="busca-prox" type="button" aria-label="${L('searchNext')}">${icons.chevronDown(16)}</button>
        <button class="icone-btn" id="busca-fechar" type="button" aria-label="${L('searchClose')}">${icons.x(16)}</button>
      </div>
      <div class="avisos" id="avisos"></div>
      <div class="folhas-area" id="folhas-area">
        <div class="folhas" id="folhas" tabindex="0" role="region" aria-label="${L('docRegion')}"></div>
        <div class="regua" id="regua" role="slider" tabindex="0" aria-orientation="vertical" aria-label="${L('rulerAria')}"><div class="regua-trilho" id="regua-trilho"></div></div>
      </div>
      <div class="receber" id="receber" hidden>
        <div class="receber-folha">
          <h2>${L('dzTitle')}</h2>
          <p>${L('dzText')}</p>
          <label class="btn principal arquivo-btn"><input type="file" id="arquivo" accept="application/pdf,.pdf">${icons.file(18)}${L('dzChoose')}</label>
          <p id="receber-nota"></p>
          <p class="receber-estado" id="receber-estado" role="status"></p>
        </div>
      </div>
      <section class="entrega" id="entrega" hidden aria-labelledby="entrega-t"></section>
      <div class="encerrado" id="encerrado" hidden></div>
      <p class="recado" id="recado" role="status" aria-live="polite"></p>
      <footer class="pe" id="pe">
        <p class="pe-nota" id="pe-nota"></p>
        <div class="pe-acoes">
          <button class="btn discreto" id="cancelar" type="button">${L('cancel')}</button>
          <button class="btn principal" id="principal" type="button"></button>
        </div>
      </footer>
    </main>
  </div>
  <dialog class="dlg" id="dlg-quadro" aria-labelledby="dlg-quadro-t">
    <div class="dlg-corpo">
      <h2 id="dlg-quadro-t">${L('padTitle')}</h2>
      ${quadroHtml()}
      <label class="campo-form"><span class="rotulo">${L('nameLabel')}</span><input id="pad-nome" type="text" maxlength="56" placeholder="${L('namePlaceholder')}" autocomplete="off" spellcheck="false"></label>
      <p>${L('padNote')}</p>
      <div class="dlg-pe">
        <button class="btn discreto" id="pad-cancelar" type="button">${L('cancel')}</button>
        <button class="btn principal" id="pad-usar" type="button" disabled>${L('padUse')}</button>
      </div>
    </div>
  </dialog>
  <dialog class="dlg" id="dlg-desfazer" aria-labelledby="dlg-desfazer-t">
    <div class="dlg-corpo">
      <h2 id="dlg-desfazer-t">${L('undoTitle')}</h2>
      <p id="dlg-desfazer-texto"></p>
      <div class="dlg-pe">
        <button class="btn discreto" id="desfazer-nao" type="button">${L('undoNo')}</button>
        <button class="btn perigo" id="desfazer-sim" type="button">${L('undoYes')}</button>
      </div>
    </div>
  </dialog>`;
}

// ---------------------------------------------------------------- tamanho e disposição
/** Alturas do painel no chat (a pessoa escolhe; o app de chat pode limitar). */
const PANEL = { p: 440, m: 620, g: 820 } as const;
const PANEL_ORDER = ['p', 'm', 'g'] as const;
const inlinePanel = () => S.t.embedded && S.t.display?.mode !== 'fullscreen';

/** Altura da tela: a janela inteira no navegador e em tela cheia; no chat, o tamanho escolhido (sem virar um rolo de 60 páginas). */
function sizeApp(): void {
  const t = S.t;
  let h = '100dvh';
  if (inlinePanel()) h = `${Math.round(Math.max(360, Math.min(PANEL[S.prefs.panel] ?? PANEL.m, t.maxHeight() ?? 9999)))}px`;
  document.documentElement.style.setProperty('--app-h', h);
  const tamanho = $('#painel-tamanho');
  if (tamanho) {
    tamanho.hidden = !inlinePanel();
    const i = PANEL_ORDER.indexOf(S.prefs.panel);
    const max = t.maxHeight();
    $<HTMLButtonElement>('#painel-menor').disabled = i <= 0;
    $<HTMLButtonElement>('#painel-maior').disabled = i >= PANEL_ORDER.length - 1 || (max != null && PANEL[S.prefs.panel] >= max);
  }
  const btn = $('#tela-cheia');
  if (btn) {
    btn.hidden = !t.display?.can || S.status !== 'pending';
    const full = t.display?.mode === 'fullscreen';
    btn.setAttribute('aria-pressed', String(full));
    btn.setAttribute('aria-label', L(full ? 'exitFullscreen' : 'fullscreen'));
    btn.title = L(full ? 'exitFullscreen' : 'fullscreen');
    btn.innerHTML = `${full ? icons.compress(16) : icons.expand(16)}<span class="rotulo-longo">${L(full ? 'exitFullscreen' : 'fullscreen')}</span>`;
  }
  const nav = $('#no-navegador');
  if (nav) nav.hidden = !t.embedded || S.status !== 'pending' || S.elsewhere;
}

/** Canhoto ao lado (tela larga) ou em cima (chat, janela estreita). Decidido antes de desenhar o documento. */
function applyLayout(): boolean {
  const talao = $('#talao');
  if (!talao) return false;
  const layout = $app.clientWidth < 880 ? 'compact' : 'full';
  if (layout === S.layout && talao.dataset.layout === layout) return false;
  S.layout = layout;
  talao.dataset.layout = layout;
  return true;
}

function watchLayout(): void {
  let last = $app.clientWidth;
  new ResizeObserver(() => {
    if (!$('#talao')) return;
    const w = $app.clientWidth;
    if (applyLayout()) renderDoc();
    if (Math.abs(w - last) > 1) {
      last = w;
      S.viewer?.relayout();
      placeBox();
      renderSearchHighlight();
    }
  }).observe($app);
}

// ---------------------------------------------------------------- canhoto
/** No compacto o canhoto rola por dentro: o campo que acabou de abrir entra na vista (sem mexer na página do chat). */
function showField(sel: string): void {
  const box = document.querySelector<HTMLElement>('.canhoto');
  const el = document.querySelector<HTMLElement>(sel);
  if (S.layout !== 'compact' || !box || !el) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.bottom > b.bottom) box.scrollBy({ top: Math.min(r.bottom - b.bottom + 8, r.top - b.top), behavior: reduced() ? 'auto' : 'smooth' });
}

function renderNumero(): void {
  for (const el of document.querySelectorAll<HTMLElement>('#numero, #numero-mini')) {
    el.innerHTML = S.registryNo ? `Nº <span class="num">${String(S.registryNo).padStart(4, '0')}</span>` : '';
    el.title = S.status === 'signed' ? L('registryTitleDone', { n: S.registryNo ?? '' }) : L('registryTitle');
  }
}

function renderDoc(): void {
  const el = $('#doc-corpo');
  if (!el) return;
  const d = S.doc;
  const acoes = $('#doc-acoes');
  if (!d || d.awaiting) {
    el.innerHTML = `<p class="vazio">${L('docNone')}</p>`;
    acoes.hidden = true;
    return;
  }
  const pages = S.viewer?.count ?? d.pages ?? null;
  const where = d.uploaded ? L('docChosenHere') : folderLabel();
  el.innerHTML = `
    <div class="doc">
      <span class="doc-thumb" aria-hidden="true"><canvas id="doc-thumb"></canvas></span>
      <div>
        <p class="doc-nome" title="${esc(d.name)}">${esc(d.name)}</p>
        <p class="doc-meta"><span title="${esc(d.uploaded ? '' : folderFull())}">${pages ? `${esc(L(pages === 1 ? 'docPage1' : 'docPages', { n: pages }))} · ` : ''}${esc(where)}</span><span class="numero numero-mini" id="numero-mini"></span></p>
      </div>
    </div>`;
  renderNumero();
  acoes.hidden = S.status !== 'pending' || S.locked;
  if (S.pdf) renderThumb(S.pdf, 0, $<HTMLCanvasElement>('#doc-thumb'), S.layout === 'compact' ? 30 : 44).catch(() => {});
}

function renderSpots(): void {
  const el = $('#onde');
  if (!el) return;
  if (!S.doc || S.doc.awaiting) {
    el.innerHTML = `<p class="vazio">${L('whereNoDoc')}</p>`;
    return;
  }
  const spots = S.doc.spots ?? [];
  const lines = spots.map(
    (s, i) => `
      <label class="lugar" title="${esc([s.label, s.name, L('spotPage', { page: s.page })].filter(Boolean).join(' · '))}"><input type="radio" name="lugar" value="${i}" aria-label="${esc(L('spotAria', { label: s.label, name: s.name ? `, ${s.name}` : '', page: s.page }))}"><span class="marcador" aria-hidden="true"></span><span class="lugar-rotulo">${esc(s.label)}</span><span class="lugar-pag">${L('spotPage', { page: s.page })}</span>${s.name ? `<span class="lugar-nome">${esc(s.name)}</span>` : ''}</label>`,
  );
  el.innerHTML = `${spots.length ? '' : `<p class="lugares-nota">${L('spotsNone')}</p>`}
    <div class="lugares" role="radiogroup" aria-labelledby="l-onde">
      ${lines.join('')}
      <label class="lugar"><input type="radio" name="lugar" value="outro"><span class="marcador" aria-hidden="true"></span><span class="lugar-rotulo">${L('spotOther')}</span><span class="lugar-pag"></span><span class="lugar-nome">${L('spotOtherHint')}</span></label>
    </div>`;
  for (const input of el.querySelectorAll<HTMLInputElement>('input[name="lugar"]'))
    input.addEventListener('change', () => (input.value === 'outro' ? startPlacing('move') : chooseSpot(Number(input.value))));
  syncSpots();
  renderExtras();
}

/** Lugares a mais (além do principal): uma linha cada, com a página e "Tirar". */
function renderExtras(): void {
  const el = $('#extras');
  if (!el) return;
  const pending = S.status === 'pending' && !S.locked && Boolean(S.doc && !S.doc.awaiting);
  el.innerHTML = `
    ${S.extras.length ? `<ul class="extras">${S.extras.map((e) => `<li><button class="link-btn ir" type="button" data-ir="${esc(e.key)}">${esc(L('extraSpot', { page: e.frame.pageIndex + 1 }))}</button>${pending ? `<button class="link-btn tirar-lugar" type="button" data-tirar="${esc(e.key)}" aria-label="${esc(L('extraRemoveAria', { page: e.frame.pageIndex + 1 }))}">${L('extraRemove')}</button>` : ''}</li>`).join('')}</ul>` : ''}
    ${pending && S.frame ? `<button class="link-btn mais-lugar" type="button" id="mais-lugar" aria-pressed="${S.placing === 'add'}">${icons.plus(14)}${L('moreSpot')}</button>` : ''}`;
  $('#mais-lugar')?.addEventListener('click', () => (S.placing === 'add' ? stopPlacing() : startPlacing('add')));
  for (const b of el.querySelectorAll<HTMLButtonElement>('[data-ir]')) b.addEventListener('click', () => scrollToFrame(true, frameOf(b.dataset.ir!)));
  for (const b of el.querySelectorAll<HTMLButtonElement>('[data-tirar]')) b.addEventListener('click', () => removePlace(b.dataset.tirar!));
}

// ---- campos da rubrica e de local e data
function renderRubricaField(): void {
  const el = $('#campo-rubrica');
  if (!el) return;
  const pending = S.status === 'pending' && !S.locked;
  const r = rubricaSig();
  const on = S.rubrica.on;
  $<HTMLInputElement>('#rubrica-on').checked = on;
  $<HTMLInputElement>('#rubrica-on').disabled = !pending;
  el.classList.toggle('aberto', on);
  $('#rubrica-corpo').hidden = !on;
  if (!on) return;
  const n = S.viewer ? rubricaPages().length : null;
  $('#rubrica-atual').innerHTML = r
    ? `<div class="assinatura-linha pequena">${S.status !== 'pending' ? carbonCopy(r.id) : rendered(r.strokes, r.id).svg}</div>`
    : `<p class="vazio">${L('rubricaNone')}</p>`;
  $('#rubrica-atual').classList.toggle('carbono', S.status !== 'pending' && Boolean(r));
  $('#rubrica-nota').textContent = n == null ? L('rubricaNote') : `${L('rubricaCount', { n })} ${L('rubricaNote')}`;
  $<HTMLInputElement>('#rubrica-com').checked = S.rubrica.withSigned;
  $('#rubrica-acoes').hidden = !pending;
  $('#rubrica-com-linha').hidden = !pending;
  $('#rubrica-trocar').hidden = !r || S.signatures.length < 2;
}

function renderTextoField(): void {
  const el = $('#campo-texto');
  if (!el) return;
  const pending = S.status === 'pending' && !S.locked;
  $<HTMLInputElement>('#texto-on').checked = S.texto.on;
  $<HTMLInputElement>('#texto-on').disabled = !pending;
  el.classList.toggle('aberto', S.texto.on);
  $('#texto-corpo').hidden = !S.texto.on;
  for (const [id, key] of [['texto-cidade', 'city'], ['texto-data', 'date'], ['texto-nome', 'name'], ['texto-doc', 'doc']] as const) {
    const input = $<HTMLInputElement>(`#${id}`);
    if (document.activeElement !== input) input.value = S.texto[key];
    input.disabled = !pending;
  }
}

/** Data de hoje por extenso ("22 de setembro de 2026"). */
const todayText = () => new Date().toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });

let fillSave: ReturnType<typeof setTimeout>;
function saveFillPrefs(): void {
  clearTimeout(fillSave);
  fillSave = setTimeout(() => S.t.call('set_prefs', { fill: { city: S.texto.city, name: S.texto.name, doc: S.texto.doc } }).catch(() => {}), 500);
}

function syncSpots(): void {
  const value = S.placing === 'move' ? 'outro' : S.spot === null ? (S.frame ? 'outro' : '') : String(S.spot);
  for (const input of document.querySelectorAll<HTMLInputElement>('#onde input[name="lugar"]')) {
    input.checked = input.value === value;
    input.disabled = S.locked || S.status !== 'pending';
  }
}

function renderSig(): void {
  const el = $('#sig-atual');
  if (!el) return;
  const cur = currentSig();
  // assinado: o canhoto guarda a cópia que passou pelo carbono (azul de carbono), não a tinta do documento
  const copy = S.status !== 'pending' && cur ? carbonCopy(S.selected!) : null;
  el.innerHTML = cur
    ? `<div class="assinatura-atual${copy ? ' carbono' : ''}"><div class="assinatura-linha">${copy ?? cur.svg}</div><span class="assinatura-nome">${esc(cur.name)}</span></div>`
    : `<p class="vazio">${L(S.signatures.length ? 'sigNoneChosen' : 'sigNone')}</p>`;
  $('#sig-trocar').hidden = S.signatures.length < (cur ? 2 : 1);
  $('#sig-acoes').hidden = S.locked || S.status !== 'pending';
}

function renderSigList(target: 'sig' | 'rubrica' = 'sig'): void {
  const el = $(target === 'sig' ? '#sig-lista' : '#rubrica-lista');
  const chosen = target === 'sig' ? S.selected : S.rubrica.sigId;
  el.innerHTML = S.signatures
    .map(
      (s) => `
      <div class="sig-item" data-id="${esc(s.id)}">
        <label class="pick">
          <input type="radio" name="${target}" value="${esc(s.id)}">
          <span class="marcador" aria-hidden="true"></span>
          <span class="sig-thumb">${rendered(s.strokes, s.id).svg}</span>
          <span class="sig-texto"><span class="nome">${esc(s.label)}</span><span class="meta">${esc(rowMeta(s))}</span></span>
        </label>
        <button class="apagar" type="button" aria-label="${esc(L('deleteAria', { label: s.label }))}" title="${L('deleteTitle')}">${icons.trash(16)}</button>
      </div>`,
    )
    .join('');
  for (const row of el.querySelectorAll<HTMLElement>('.sig-item')) {
    const s = byId(row.dataset.id!)!;
    const input = $<HTMLInputElement>('input', row);
    input.checked = s.id === chosen;
    input.addEventListener('change', () => (target === 'sig' ? chooseSignature(s.id) : chooseRubrica(s.id)));
    $('.apagar', row).addEventListener('click', () => askDelete(row, s));
  }
}

function toggleRubricaList(open: boolean): void {
  const list = $('#rubrica-lista');
  list.hidden = !open;
  $('#rubrica-trocar').setAttribute('aria-expanded', String(open));
  if (open) {
    renderSigList('rubrica');
    ($('input:checked', list) ?? $('input', list))?.focus();
  }
}

function chooseRubrica(id: string): void {
  S.rubrica.sigId = id;
  renderRubricaField();
  renderRubricas();
  renderFoot();
}

/** A rubrica mais recente do cofre (as salvas como "rubrica"); sem nenhuma, nenhuma. */
const defaultRubrica = () => mostRecent(S.signatures.filter((x) => x.kind === 'rubrica'))?.id ?? null;

function toggleSigList(open: boolean): void {
  const list = $('#sig-lista');
  list.hidden = !open;
  $('#sig-trocar').setAttribute('aria-expanded', String(open));
  $('#campo-sig').classList.toggle('aberto', open);
  if (open) {
    renderSigList();
    ($('input:checked', list) ?? $('input', list))?.focus();
  }
}

function chooseSignature(id: string): void {
  S.selected = id;
  renderSig();
  clampAllFrames();
  placeBox({ land: true });
  renderFoot();
}

/** A proporção da assinatura mudou (outra assinatura, outra espessura): todas as molduras continuam dentro da página. */
function clampAllFrames(): void {
  if (!S.viewer) return;
  if (S.frame) S.frame = clampFrame(S.frame, currentAspect(S.frame), pageSize(S.frame.pageIndex));
  for (const e of S.extras) e.frame = clampFrame(e.frame, currentAspect(e.frame), pageSize(e.frame.pageIndex));
}

const historyText = (h: HistoryEntry): string => {
  const d = h.detail ?? {};
  switch (h.event) {
    case 'created':
      return L('h_created');
    case 'document':
      return d.pages ? L('h_document_pages', { name: d.name, n: d.pages }) : L('h_document', { name: d.name ?? '' });
    case 'removed':
      return L('h_removed', { name: d.name ?? '' });
    case 'signed':
      return (d.places ? L('h_signed_many', { n: d.places }) : L('h_signed', { page: d.page ?? '' })) + (d.initials ? L('h_initials', { n: d.initials }) : '');
    case 'undone':
      return L('h_undone');
    case 'saved_copy':
      return L('h_saved_copy', { folder: d.folder ?? '' });
    case 'opened_file':
      return L('h_opened_file');
    case 'revealed':
      return L('h_revealed');
    case 'copied':
      return L('h_copied');
    case 'mail':
      return L('h_mail', { client: mailName(String(d.client ?? '')) });
    case 'whatsapp':
      return L('h_whatsapp');
    case 'receipt':
      return L('h_receipt');
  }
  return h.event;
};
const mailName = (c: string) => (hasKey(`mail_${c}`) ? L(`mail_${c}` as MessageKey) : c);

function renderHistory(): void {
  const el = $('#historico');
  if (!el) return;
  el.innerHTML = S.history
    .map((h) => {
      const stamp =
        h.event === 'signed' ? ` <span class="carimbo">${L('stampSigned')}</span>` : h.event === 'undone' || h.event === 'removed' ? ` <span class="carimbo cancelado">${L('stampCancelled')}</span>` : '';
      return `<li><time datetime="${esc(h.at)}">${hm(h.at)}</time><span>${esc(historyText(h))}${stamp}</span></li>`;
    })
    .join('');
}

function renderCanhoto(): void {
  renderNumero();
  renderDoc();
  renderSpots();
  renderSig();
  renderRubricaField();
  renderTextoField();
  renderHistory();
}

// ---------------------------------------------------------------- avisos sobre o documento
function renderNotices(errorText?: string): void {
  const items: [string, string, string][] = [];
  if (errorText) items.push(['erro', icons.alert(17), esc(errorText)]);
  const a = S.doc?.anchor;
  if (S.status === 'pending' && S.doc && !S.doc.awaiting && a && !a.found && !(S.doc.spots ?? []).length) items.push(['', icons.alert(17), esc(L('anchorFallback'))]);
  if (S.status === 'pending' && S.doc?.hasDigitalSignature) items.push(['', icons.shield(17), esc(L('hasDigitalSignature'))]);
  const el = $('#avisos');
  el.innerHTML = items.map(([cls, icon, text]) => `<div class="aviso-doc ${cls}">${icon}<span>${text}</span></div>`).join('');
}

// ---------------------------------------------------------------- o documento (via)
async function loadDocument(source: 'original' | 'signed'): Promise<void> {
  const folhas = $('#folhas');
  S.previewFailed = false;
  showView('folhas');
  folhas.innerHTML = '<div class="folhas-inner"><div class="folha" style="width:min(620px,86%);aspect-ratio:1/1.414"></div></div>';
  renderFoot();
  try {
    const bytes = source === 'signed' ? await S.t.readSigned() : await S.t.readDocument();
    const pdf = await openPdf(bytes);
    S.viewer?.destroy();
    S.pdf = pdf;
    S.source = source;
    S.viewer = await createViewer(pdf, folhas, {
      onPage,
      pageLabel: (i, n) => L('pageAria', { page: i + 1, total: n, name: S.doc?.name ?? '' }),
    });
    renderDoc();
    renderZoom();
    renderPageField();
    if (source === 'original' && S.frame) {
      S.frame = clampFrame({ ...S.frame, pageIndex: clamp(S.frame.pageIndex, 0, S.viewer.count - 1) }, currentAspect(), pageSize(S.frame.pageIndex));
      placeBox({ land: Boolean(currentSig()) });
      scrollToFrame(false);
    } else {
      placeBox();
      // arquivo assinado: abre na assinatura (a posição usada), não no topo da página
      const page = S.frame?.pageIndex ?? (S.result?.pages?.[0] ?? 1) - 1;
      S.viewer.scrollToPage(page, S.frame ? { y: boxInFrame(S.frame, currentAspect()).y } : {});
    }
    renderRegua();
  } catch (e) {
    console.error(e);
    S.previewFailed = true;
    folhas.innerHTML = '';
    renderNotices(L('previewFailed', { detail: (e as Error)?.message ?? String(e) }));
  }
  renderFoot();
}

/** Qual área a via mostra: as folhas, o pedido de PDF, a entrega ou uma tela de encerrado. */
function showView(which: 'folhas' | 'receber' | 'entrega' | 'encerrado'): void {
  $('#folhas-area').hidden = which !== 'folhas';
  $('#barra').hidden = which !== 'folhas';
  $('#busca').hidden = which !== 'folhas' || $('#procurar').getAttribute('aria-expanded') !== 'true';
  $('#avisos').hidden = which !== 'folhas';
  $('#receber').hidden = which !== 'receber';
  $('#entrega').hidden = which !== 'entrega';
  $('#encerrado').hidden = which !== 'encerrado';
  $('#pe').hidden = which === 'entrega' || which === 'encerrado' || S.status !== 'pending';
  $('#abas').hidden = S.status !== 'signed' || which === 'encerrado';
  $('#aba-entrega').setAttribute('aria-selected', String(which === 'entrega'));
  $('#aba-ver').setAttribute('aria-selected', String(which === 'folhas'));
}

/** Depois de assinar: ver o arquivo assinado ali mesmo (o que foi gravado de fato), ou voltar para enviar. */
async function showTab(tab: 'entrega' | 'ver'): Promise<void> {
  if (S.status !== 'signed') return;
  if (tab === 'entrega') return showView('entrega');
  if (S.source !== 'signed') await loadDocument('signed');
  else showView('folhas');
}

function onPage(): void {
  renderPageField();
  renderRegua();
  renderGoSpot();
}

function renderPageField(): void {
  const v = S.viewer;
  const input = $<HTMLInputElement>('#pagina');
  if (!v || !input) return;
  if (document.activeElement !== input) input.value = String(v.current() + 1);
  input.setAttribute('aria-label', L('pageInputAria', { total: v.count }));
  $('#pagina-total').textContent = L('pageOfTotal', { total: v.count });
}

function goToPageInput(): void {
  const v = S.viewer;
  const input = $<HTMLInputElement>('#pagina');
  if (!v) return;
  const n = parseInt(input.value.replace(/\D/g, ''), 10);
  if (Number.isFinite(n)) v.scrollToPage(clamp(n, 1, v.count) - 1);
  input.value = String(v.current() + 1);
}

/** O lugar com assinatura mais perto, fora da página que está na vista (para o botão "Ir para a página N"). */
function nextFrameAway(): Frame | null {
  const v = S.viewer;
  if (!v) return null;
  const away = allFrames().filter((f) => f.pageIndex !== v.current());
  return away.sort((a, b) => Math.abs(a.pageIndex - v.current()) - Math.abs(b.pageIndex - v.current()))[0] ?? null;
}

function renderGoSpot(): void {
  const btn = $('#ir-lugar');
  if (!btn) return;
  const onPage = S.viewer ? allFrames().some((f) => f.pageIndex === S.viewer!.current()) : true;
  const target = S.source === 'original' && !S.locked && !onPage ? nextFrameAway() : null;
  btn.hidden = !target;
  if (target) {
    $('#ir-lugar-t').textContent = L('goSpot', { page: target.pageIndex + 1 });
    btn.setAttribute('aria-label', L('goSpotAria', { page: target.pageIndex + 1 }));
  }
}

function renderZoom(): void {
  const v = S.viewer;
  if (!v) return;
  const z = v.zoom();
  $('#zoom-ajustar').textContent = `${Math.round(z * 100)}%`;
  $('#zoom-ajustar').setAttribute('aria-label', L('zoomFitAria', { pct: Math.round(z * 100) }));
  $<HTMLButtonElement>('#zoom-menos').disabled = z <= ZOOMS[0];
  $<HTMLButtonElement>('#zoom-mais').disabled = z >= ZOOMS.at(-1)!;
}

function stepZoom(dir: 1 | -1): void {
  const v = S.viewer;
  if (!v) return;
  const z = v.zoom();
  const next = dir > 0 ? ZOOMS.find((q) => q > z + 0.001) : [...ZOOMS].reverse().find((q) => q < z - 0.001);
  if (next === undefined) return;
  v.setZoom(next);
  afterZoom();
}
function afterZoom(): void {
  renderZoom();
  placeBox();
  renderSearchHighlight();
}

// ---- régua de páginas
function renderRegua(): void {
  const regua = $('#regua');
  const v = S.viewer;
  if (!regua) return;
  if (!v) {
    regua.hidden = true;
    return;
  }
  regua.hidden = false;
  const n = v.count;
  const cur = v.current();
  const trilho = $('#regua-trilho');
  // um traço por página enquanto cabem (depois disso seriam só uma mancha)
  const each = n <= 150 ? `calc(100% / ${n})` : '';
  trilho.style.backgroundImage = each ? 'linear-gradient(var(--pauta) 0 1px, transparent 1px)' : 'none';
  trilho.style.backgroundSize = each ? `7px ${each}` : '';
  const pct = (page: number, frac = 0) => `${((page + frac) / n) * 100}%`;
  const marks: string[] = [`<span class="regua-atual" style="top:${pct(cur)};height:max(3px, ${100 / n}%)"></span>`];
  if (S.source === 'original') {
    // lugares da mesma página viram uma marca só (com quantos são); a escolhida vem cheia
    const pages = new Map<number, { chosen: boolean; labels: string[] }>();
    for (const [i, s] of (S.doc?.spots ?? []).entries()) {
      const e = pages.get(s.placement.pageIndex) ?? { chosen: false, labels: [] };
      e.labels.push(s.label);
      e.chosen ||= i === S.spot;
      pages.set(s.placement.pageIndex, e);
    }
    const other = [...(S.frame && S.spot === null ? [S.frame] : []), ...S.extras.map((x) => x.frame)];
    for (const f of other) {
      const e = pages.get(f.pageIndex) ?? { chosen: false, labels: [] };
      e.chosen = true;
      e.labels.push(L('spotOther'));
      pages.set(f.pageIndex, e);
    }
    for (const [page, e] of pages)
      marks.push(`<span class="regua-marca${e.chosen ? '' : ' outro'}" style="top:${pct(page, 0.5)}" title="${esc(`${e.labels.join(', ')} · ${L('spotPage', { page: page + 1 })}`)}">${e.labels.length > 1 ? e.labels.length : ''}</span>`);
  }
  for (const h of search.hits.slice(0, 400)) marks.push(`<span class="regua-busca" style="top:${pct(h.page, 0.5)}"></span>`);
  trilho.innerHTML = marks.join('');
  regua.setAttribute('aria-valuemin', '1');
  regua.setAttribute('aria-valuemax', String(n));
  regua.setAttribute('aria-valuenow', String(cur + 1));
  regua.setAttribute('aria-valuetext', L('pageOf', { page: cur + 1, total: n }));
}

function wireRegua(): void {
  const regua = $('#regua');
  const pageFromY = (y: number) => {
    const r = regua.getBoundingClientRect();
    return clamp(Math.floor(((y - r.top) / r.height) * (S.viewer?.count ?? 1)), 0, (S.viewer?.count ?? 1) - 1);
  };
  let dragging = false;
  regua.addEventListener('pointerdown', (e) => {
    if (!S.viewer || e.button !== 0) return;
    dragging = true;
    regua.setPointerCapture(e.pointerId);
    S.viewer.scrollToPage(pageFromY(e.clientY));
  });
  regua.addEventListener('pointermove', (e) => {
    if (dragging && S.viewer) S.viewer.scrollToPage(pageFromY(e.clientY));
  });
  const stop = () => (dragging = false);
  regua.addEventListener('pointerup', stop);
  regua.addEventListener('pointercancel', stop);
  regua.addEventListener('keydown', (e) => {
    const v = S.viewer;
    if (!v) return;
    const steps: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, PageDown: 10, PageUp: -10 };
    let to: number | null = null;
    if (e.key in steps) to = v.current() + steps[e.key];
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = v.count - 1;
    if (to === null) return;
    e.preventDefault();
    v.scrollToPage(clamp(to, 0, v.count - 1));
  });
}

// ---- a assinatura sobre a página: o lugar principal (S.frame) e os lugares a mais (S.extras)
const boxes = new Map<string, HTMLDivElement>();
const MAIN = 'main';
const frameOf = (key: string): Frame | null => (key === MAIN ? S.frame : (S.extras.find((e) => e.key === key)?.frame ?? null));
function setFrameOf(key: string, f: Frame): void {
  if (key === MAIN) S.frame = f;
  else {
    const e = S.extras.find((x) => x.key === key);
    if (e) e.frame = f;
  }
}
/** Todos os lugares com assinatura, o principal primeiro. */
const allFrames = (): Frame[] => [...(S.frame ? [S.frame] : []), ...S.extras.map((e) => e.frame)];

function boxFor(key: string): HTMLDivElement {
  let box = boxes.get(key);
  if (box) return box;
  box = document.createElement('div');
  box.className = 'sig-box';
  box.dataset.key = key;
  if (key === MAIN) box.id = 'sig-box';
  box.tabIndex = 0;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-roledescription', L('boxRole'));
  box.innerHTML = `<div class="arte"></div><span class="alca" aria-hidden="true"></span><button class="tirar" type="button" aria-label="${L('boxRemove')}" title="${L('boxRemoveShort')}">${icons.x(13)}</button>`;
  wireBox(box, key);
  boxes.set(key, box);
  return box;
}

/** Desenha todas as marcas sobre as páginas: assinaturas (principal e a mais), rubricas e local e data. */
function placeBox({ land = false } = {}): void {
  const v = S.viewer;
  const show = Boolean(v) && S.source === 'original' && !S.previewFailed;
  const keys = new Set<string>(show ? [...(S.frame ? [MAIN] : []), ...S.extras.map((e) => e.key)] : []);
  for (const [key, box] of boxes) if (!keys.has(key)) box.remove();
  for (const key of keys) positionBox(key, land);
  renderRubricas();
  renderTexto();
  renderGoSpot();
}

function positionBox(key: string, land: boolean): void {
  const v = S.viewer!;
  const frame = frameOf(key)!;
  const box = boxFor(key);
  const slot = v.slot(frame.pageIndex);
  if (box.parentElement !== slot) slot.append(box);
  const cur = currentSig();
  const b = boxInFrame(frame, cur?.aspect ?? placeholderAspect(frame));
  const k = v.scale();
  box.hidden = false;
  box.style.left = `${b.x * k}px`;
  box.style.top = `${b.y * k}px`;
  box.style.width = `${b.width * k}px`;
  box.style.height = `${b.height * k}px`;
  // posição em pontos PDF, exposta para os testes de ponta a ponta
  Object.assign(box.dataset, { page: String(b.pageIndex), x: b.x.toFixed(2), y: b.y.toFixed(2), w: b.width.toFixed(2), h: b.height.toFixed(2) });
  box.classList.toggle('vaga', !cur);
  box.classList.toggle('travada', S.locked);
  box.tabIndex = S.locked ? -1 : 0;
  const artEl = $('.arte', box);
  const artKey = cur ? cur.key : 'vaga';
  if (artEl.dataset.key !== artKey || land) {
    artEl.dataset.key = artKey;
    artEl.innerHTML = cur ? cur.svg : `<span>${L('boxPlaceholder')}</span>`;
    if (land && cur && !reduced()) {
      artEl.classList.remove('decalque');
      void artEl.offsetWidth; // reinicia a animação
      artEl.classList.add('decalque');
    }
  }
  box.setAttribute('aria-label', cur ? L('boxAria', { label: cur.label, page: b.pageIndex + 1 }) : L('boxAriaEmpty', { page: b.pageIndex + 1 }));
}

function scrollToFrame(smooth = true, frame: Frame | null = S.frame): void {
  const v = S.viewer;
  if (!v || !frame) return;
  const b = boxInFrame(frame, currentAspect(frame));
  v.scrollToPage(frame.pageIndex, { y: b.y, smooth: smooth && !reduced() });
}

/** O lugar escolhido ainda é o da lista? Arrastar um pouco para ajustar continua sendo o mesmo lugar. */
function matchSpot(): void {
  const spots = S.doc?.spots ?? [];
  if (!S.frame) return void (S.spot = null);
  const f = S.frame;
  const bottom = f.align === 'bottom' ? f.y + f.h : f.y;
  const i = spots.findIndex((s) => s.placement.pageIndex === f.pageIndex && Math.abs(s.placement.x - f.x) < 60 && Math.abs((s.placement.bottom ?? s.placement.y ?? 0) - bottom) < 40);
  S.spot = i >= 0 ? i : null;
}

/** Efeito de qualquer mudança nos lugares: marcas, lista, régua e o pé. */
function afterPlaces({ land = false } = {}): void {
  placeBox({ land });
  syncSpots();
  renderExtras();
  renderRegua();
  renderFoot();
}

function chooseSpot(i: number): void {
  const sp = S.doc?.spots?.[i];
  if (!sp || S.locked) return;
  stopPlacing();
  S.frame = clampFrame(frameFromPlacement(sp.placement), currentAspect(), pageSize(sp.placement.pageIndex));
  S.spot = i;
  afterPlaces({ land: true });
  scrollToFrame(true);
}

/** "Outro lugar" (move o principal) ou "+ Assinar em mais um lugar" (acrescenta): o próximo clique na página decide. */
function startPlacing(mode: 'move' | 'add' = 'move'): void {
  if (S.locked || !S.viewer) return;
  S.placing = mode;
  $('#talao').classList.add('colocando');
  flash(L(mode === 'add' ? 'placeHintAdd' : 'placeHint'), { sticky: true });
  syncSpots();
}
function stopPlacing(): void {
  if (!S.placing) return;
  S.placing = false;
  $('#talao').classList.remove('colocando');
  hideFlash();
  syncSpots();
}

let extraSeq = 0;
/** Clicou na página: a assinatura senta na linha onde clicou (move o principal, ou acrescenta um lugar). */
function placeAt(p: { i: number; x: number; y: number }, mode: 'move' | 'add' = S.placing || 'move'): void {
  const ref = S.frame ?? S.extras[0]?.frame ?? null;
  const w = ref?.w ?? DEFAULT_BOX.width;
  const h = ref && Number.isFinite(ref.h) ? ref.h : DEFAULT_BOX.maxHeight;
  const frame = clampFrame({ pageIndex: p.i, x: p.x - w * 0.25, y: p.y + 3 - h, w, h, align: 'bottom' }, currentAspect(ref), pageSize(p.i));
  if (mode === 'add' && S.frame) S.extras.push({ key: `extra-${++extraSeq}`, frame });
  else S.frame = frame;
  stopPlacing();
  matchSpot();
  afterPlaces({ land: true });
}

/** Tira a assinatura de um lugar. Sem o principal, o primeiro lugar a mais vira o principal. Não apaga nada do cofre. */
function removePlace(key: string): void {
  if (S.locked) return;
  if (key === MAIN) {
    const next = S.extras.shift();
    S.frame = next ? next.frame : null;
    if (next) boxes.get(next.key)?.remove(), boxes.delete(next.key);
    matchSpot();
  } else S.extras = S.extras.filter((e) => e.key !== key);
  afterPlaces();
  (boxes.get(MAIN) ?? $('#principal')).focus({ preventScroll: true });
}

function wireBox(box: HTMLElement, key: string): void {
  let drag: { id: number; gx: number; gy: number; frame: Frame; box: ReturnType<typeof boxInFrame>; aspect: number; resize: boolean } | null = null;
  box.addEventListener('pointerdown', (e) => {
    const frame = frameOf(key);
    if (S.locked || e.button !== 0 || !S.viewer || !frame || (e.target as Element).closest('.tirar')) return;
    e.preventDefault();
    e.stopPropagation();
    box.focus({ preventScroll: true });
    box.setPointerCapture(e.pointerId);
    const aspect = currentAspect(frame);
    const k = S.viewer.scale();
    const r = box.getBoundingClientRect();
    drag = { id: e.pointerId, gx: (e.clientX - r.left) / k, gy: (e.clientY - r.top) / k, frame: { ...frame }, box: boxInFrame(frame, aspect), aspect, resize: Boolean((e.target as Element).closest('.alca')) };
    box.classList.add('arrastando');
  });
  box.addEventListener('pointermove', (e) => {
    const frame = frameOf(key);
    if (!drag || e.pointerId !== drag.id || !S.viewer || !frame) return;
    if (e.buttons === 0) return stop(e); // o botão foi solto sem o pointerup chegar aqui
    const v = S.viewer;
    const k = v.scale();
    if (drag.resize) {
      const slot = v.slot(frame.pageIndex).getBoundingClientRect();
      const a = drag.aspect;
      const size = pageSize(frame.pageIndex);
      const maxW = Math.min(size.width - drag.box.x, (size.height - drag.box.y) / a);
      const px = (e.clientX - slot.left) / k - drag.box.x;
      const py = (e.clientY - slot.top) / k - drag.box.y;
      // projeta o movimento na diagonal da caixa: crescer e encolher respondem igual
      const w = clamp((px + py * a) / (1 + a * a), MIN_WIDTH, Math.max(MIN_WIDTH, maxW));
      setFrameOf(key, resizeFrame(drag.frame, a, w));
    } else {
      // arrastar de uma página para outra: vale a página que está sob o ponteiro
      const p = v.pageAt(e.clientX, e.clientY) ?? (() => {
        const slot = v.slot(frame.pageIndex).getBoundingClientRect();
        return { i: frame.pageIndex, x: (e.clientX - slot.left) / k, y: (e.clientY - slot.top) / k };
      })();
      const nx = p.x - drag.gx;
      const ny = p.y - drag.gy;
      setFrameOf(key, clampFrame({ ...drag.frame, pageIndex: p.i, x: drag.frame.x + (nx - drag.box.x), y: drag.frame.y + (ny - drag.box.y) }, drag.aspect, pageSize(p.i)));
    }
    placeBox();
  });
  const stop = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    box.classList.remove('arrastando');
    matchSpot();
    afterPlaces();
  };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);
  box.addEventListener('lostpointercapture', stop);
  box.addEventListener('keydown', (e) => {
    const frame = frameOf(key);
    if (S.locked || !S.viewer || !frame || e.target !== box) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      return removePlace(key);
    }
    const a = currentAspect(frame);
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    let f: Frame | null = null;
    if (moves[e.key]) f = { ...frame, x: frame.x + moves[e.key][0], y: frame.y + moves[e.key][1] };
    else if (e.key === '+' || e.key === '=') f = scaleFrame(frame, 1.05);
    else if (e.key === '-' || e.key === '_') f = scaleFrame(frame, 1 / 1.05);
    if (!f) return;
    e.preventDefault();
    const size = pageSize(frame.pageIndex);
    const b = boxInFrame(f, a);
    if (b.width < MIN_WIDTH || b.width > size.width || b.height > size.height) return;
    setFrameOf(key, clampFrame(f, a, size));
    placeBox();
    matchSpot();
    syncSpots();
  });
  $('.tirar', box).addEventListener('click', () => removePlace(key));
}

// ---- rubrica em todas as páginas: mesma distância do canto de baixo à direita em cada página
const rubricaEls = new Map<number, HTMLDivElement>();
const rubricaSig = () => byId(S.rubrica.sigId);
const rubricaArt = () => {
  const r = rubricaSig();
  return r ? rendered(r.strokes, r.id) : null;
};
/** Páginas que levam rubrica: todas, menos as que já têm assinatura (a não ser que a pessoa peça). */
function rubricaPages(): number[] {
  const n = S.viewer?.count ?? 0;
  const signed = new Set(allFrames().map((f) => f.pageIndex));
  return Array.from({ length: n }, (_, i) => i).filter((i) => S.rubrica.withSigned || !signed.has(i));
}
function rubricaBox(i: number): { pageIndex: number; x: number; y: number; width: number; height: number } {
  const art = rubricaArt();
  const size = pageSize(i);
  const w = Math.min(S.rubrica.w, size.width);
  const h = Math.min(w * (art?.aspect ?? 0.5), size.height);
  return { pageIndex: i, x: clamp(size.width - S.rubrica.dx - w, 0, size.width - w), y: clamp(size.height - S.rubrica.dy - h, 0, size.height - h), width: w, height: h };
}

function renderRubricas(): void {
  const v = S.viewer;
  const art = rubricaArt();
  const show = Boolean(v && art && S.rubrica.on && S.source === 'original' && !S.previewFailed);
  const pages = new Set(show ? rubricaPages() : []);
  for (const [i, el] of rubricaEls)
    if (!pages.has(i)) {
      el.remove();
      rubricaEls.delete(i);
    }
  if (!show) return;
  const k = v!.scale();
  for (const i of pages) {
    let el = rubricaEls.get(i);
    if (!el) {
      el = document.createElement('div');
      el.className = 'rubrica-box';
      el.tabIndex = -1;
      el.setAttribute('role', 'img');
      el.innerHTML = `<div class="arte"></div><span class="alca" aria-hidden="true"></span>`;
      wireRubrica(el, i);
      rubricaEls.set(i, el);
    }
    if (el.parentElement !== v!.slot(i)) v!.slot(i).append(el);
    const b = rubricaBox(i);
    Object.assign(el.style, { left: `${b.x * k}px`, top: `${b.y * k}px`, width: `${b.width * k}px`, height: `${b.height * k}px` });
    el.classList.toggle('travada', S.locked);
    const artEl = $('.arte', el);
    if (artEl.dataset.key !== art!.key) {
      artEl.dataset.key = art!.key;
      artEl.innerHTML = art!.svg;
    }
    el.setAttribute('aria-label', L('rubricaAria', { page: i + 1 }));
  }
}

let rubricaSave: ReturnType<typeof setTimeout>;
function saveRubricaPrefs(): void {
  clearTimeout(rubricaSave);
  rubricaSave = setTimeout(() => S.t.call('set_prefs', { rubrica: { dx: S.rubrica.dx, dy: S.rubrica.dy, w: S.rubrica.w, withSigned: S.rubrica.withSigned } }).catch(() => {}), 400);
}

/** Arrastar a rubrica numa página muda a posição em todas (a mesma distância do canto). */
function wireRubrica(el: HTMLElement, i: number): void {
  let drag: { id: number; x: number; y: number; dx: number; dy: number; w: number; resize: boolean } | null = null;
  el.addEventListener('pointerdown', (e) => {
    if (S.locked || e.button !== 0 || !S.viewer) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: S.rubrica.dx, dy: S.rubrica.dy, w: S.rubrica.w, resize: Boolean((e.target as Element).closest('.alca')) };
    el.classList.add('arrastando');
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !S.viewer) return;
    const k = S.viewer.scale();
    const size = pageSize(i);
    const mx = (e.clientX - drag.x) / k;
    const my = (e.clientY - drag.y) / k;
    if (drag.resize) {
      // a alça fica embaixo à direita: crescer puxa o canto, e a rubrica continua encostada no mesmo lugar à esquerda/em cima
      const w = clamp(drag.w + mx, 20, 200);
      S.rubrica.w = w;
      S.rubrica.dx = clamp(drag.dx - (w - drag.w), 0, size.width - w);
    } else {
      S.rubrica.dx = clamp(drag.dx - mx, 0, size.width - S.rubrica.w);
      S.rubrica.dy = clamp(drag.dy - my, 0, size.height - 10);
    }
    renderRubricas();
  });
  const stop = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    el.classList.remove('arrastando');
    saveRubricaPrefs();
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('lostpointercapture', stop);
}

// ---- local e data (e nome/CPF), escritos na página perto da assinatura
const TEXT_SIZE = 10;
const LEADING = 1.3; // o mesmo espaçamento que o carimbo usa no PDF
function textLines(): string[] {
  const t = S.texto;
  return [[t.city.trim(), t.date.trim()].filter(Boolean).join(', '), t.name.trim(), t.doc.trim() ? `${L('textoDocPrefix')} ${t.doc.trim()}` : ''].filter(Boolean);
}
let measureCtx: CanvasRenderingContext2D | null = null;
/** Largura do texto em pontos (Helvetica, a mesma fonte do PDF; margem de 4% para a diferença de métrica). */
function textBox(): { width: number; height: number } {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const lines = textLines();
  if (!measureCtx) return { width: 200, height: lines.length * TEXT_SIZE * LEADING };
  measureCtx.font = `${TEXT_SIZE}px Helvetica, Arial, sans-serif`;
  return { width: Math.max(10, ...lines.map((l) => measureCtx!.measureText(l).width)) * 1.04, height: Math.max(1, lines.length) * TEXT_SIZE * LEADING };
}
function clampTexto(): void {
  const t = S.texto;
  const size = pageSize(t.pageIndex);
  const b = textBox();
  t.x = clamp(t.x, 0, Math.max(0, size.width - b.width));
  t.y = clamp(t.y, 0, Math.max(0, size.height - b.height));
}
/** Primeira posição: logo acima da assinatura principal (ou, sem ela, no pé da última página). */
function placeTextoDefault(): void {
  const t = S.texto;
  const b = textBox();
  const f = S.frame ?? S.extras[0]?.frame ?? null;
  if (f) {
    const box = boxInFrame(f, currentAspect(f));
    t.pageIndex = f.pageIndex;
    t.x = box.x;
    t.y = box.y - b.height - 10;
    if (t.y < 12) t.y = box.y + box.height + 30;
  } else {
    t.pageIndex = Math.max(0, (S.viewer?.count ?? 1) - 1);
    const size = pageSize(t.pageIndex);
    t.x = 72;
    t.y = size.height - 140;
  }
  t.placed = true;
  clampTexto();
}

let textoEl: HTMLDivElement | null = null;
function renderTexto(): void {
  const v = S.viewer;
  const lines = textLines();
  const show = Boolean(v && S.texto.on && lines.length && S.source === 'original' && !S.previewFailed);
  if (!show) {
    textoEl?.remove();
    return;
  }
  if (!S.texto.placed) placeTextoDefault();
  if (!textoEl) {
    textoEl = document.createElement('div');
    textoEl.className = 'texto-box';
    textoEl.tabIndex = 0;
    textoEl.setAttribute('role', 'group');
    textoEl.setAttribute('aria-roledescription', L('textoRole'));
    wireTexto(textoEl);
  }
  clampTexto();
  const k = v!.scale();
  const slot = v!.slot(S.texto.pageIndex);
  if (textoEl.parentElement !== slot) slot.append(textoEl);
  const b = textBox();
  Object.assign(textoEl.style, {
    left: `${S.texto.x * k}px`,
    top: `${S.texto.y * k}px`,
    width: `${b.width * k}px`,
    height: `${b.height * k}px`,
    fontSize: `${TEXT_SIZE * k}px`,
    lineHeight: `${TEXT_SIZE * LEADING * k}px`,
    color: inkHex(S.prefs.ink),
  });
  textoEl.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
  textoEl.classList.toggle('travada', S.locked);
  textoEl.tabIndex = S.locked ? -1 : 0;
  textoEl.setAttribute('aria-label', L('textoAria', { page: S.texto.pageIndex + 1 }));
}

function wireTexto(el: HTMLElement): void {
  let drag: { id: number; gx: number; gy: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    if (S.locked || e.button !== 0 || !S.viewer) return;
    e.preventDefault();
    e.stopPropagation();
    el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    const k = S.viewer.scale();
    const r = el.getBoundingClientRect();
    drag = { id: e.pointerId, gx: (e.clientX - r.left) / k, gy: (e.clientY - r.top) / k };
    el.classList.add('arrastando');
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !S.viewer) return;
    const v = S.viewer;
    const k = v.scale();
    const p = v.pageAt(e.clientX, e.clientY) ?? (() => {
      const slot = v.slot(S.texto.pageIndex).getBoundingClientRect();
      return { i: S.texto.pageIndex, x: (e.clientX - slot.left) / k, y: (e.clientY - slot.top) / k };
    })();
    Object.assign(S.texto, { pageIndex: p.i, x: p.x - drag.gx, y: p.y - drag.gy });
    renderTexto();
  });
  const stop = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    el.classList.remove('arrastando');
    renderFoot();
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('lostpointercapture', stop);
  el.addEventListener('keydown', (e) => {
    if (S.locked) return;
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (!moves[e.key]) return;
    e.preventDefault();
    S.texto.x += moves[e.key][0];
    S.texto.y += moves[e.key][1];
    renderTexto();
  });
}

// ---- procurar no documento
const search = { token: 0, hits: [] as { page: number; rect: number[] }[], i: -1, noText: false, done: true };
const textCache = new Map<number, { f: string; rect: number[] }[]>();

async function pageText(i: number) {
  if (textCache.has(i)) return textCache.get(i)!;
  const page = await S.pdf!.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  const out = (items as any[])
    .filter((it) => typeof it.str === 'string' && it.str.trim() && it.transform)
    .map((it) => {
      const [, , c, d, e, f] = it.transform as number[];
      const h = it.height || Math.hypot(c, d) || 10;
      const [x1, y1] = vp.convertToViewportPoint(e, f - h * 0.22);
      const [x2, y2] = vp.convertToViewportPoint(e + (it.width || h), f + h * 0.88);
      return { f: fold(it.str), rect: [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)] };
    });
  textCache.set(i, out);
  return out;
}

async function runSearch(q: string): Promise<void> {
  const token = ++search.token;
  search.hits = [];
  search.i = -1;
  search.noText = false;
  const needle = fold(q).replace(/\s+/g, ' ').trim();
  renderSearchHighlight();
  if (needle.length < 2 || !S.viewer) {
    search.done = true;
    renderSearch();
    renderRegua();
    return;
  }
  search.done = false;
  let anyText = false;
  for (let i = 0; i < S.viewer.count; i++) {
    const items = await pageText(i);
    if (token !== search.token) return;
    if (items.length) anyText = true;
    for (const it of items) if (it.f.includes(needle)) search.hits.push({ page: i, rect: it.rect });
    if (search.i < 0 && search.hits.length) goHit(0);
    if (i % 6 === 5) renderSearch();
  }
  search.noText = !anyText;
  search.done = true;
  renderSearch();
  renderRegua();
}

function goHit(i: number): void {
  if (!search.hits.length || !S.viewer) return;
  search.i = (i + search.hits.length) % search.hits.length;
  const h = search.hits[search.i];
  S.viewer.scrollToPage(h.page, { y: h.rect[1] });
  renderSearchHighlight();
  renderSearch();
}

function renderSearchHighlight(): void {
  document.querySelectorAll('.achado').forEach((el) => el.remove());
  const h = search.hits[search.i];
  if (!h || !S.viewer) return;
  const k = S.viewer.scale();
  const mark = document.createElement('span');
  mark.className = 'achado';
  Object.assign(mark.style, { left: `${h.rect[0] * k - 2}px`, top: `${h.rect[1] * k - 2}px`, width: `${h.rect[2] * k + 4}px`, height: `${h.rect[3] * k + 4}px` });
  S.viewer.slot(h.page).append(mark);
}

function renderSearch(): void {
  const el = $('#busca-conta');
  if (!el) return;
  const q = $<HTMLInputElement>('#busca-campo').value.trim();
  el.textContent = !q
    ? ''
    : search.noText
      ? L('searchNoText')
      : search.hits.length
        ? L('searchCount', { i: search.i + 1, n: search.hits.length }) + (search.done ? '' : '…')
        : search.done
          ? L('searchNone')
          : '…';
  $<HTMLButtonElement>('#busca-ant').disabled = $<HTMLButtonElement>('#busca-prox').disabled = search.hits.length < 2;
}

function openSearch(open = true): void {
  const bar = $('#busca');
  bar.hidden = !open;
  $('#procurar').setAttribute('aria-expanded', String(open));
  if (open) {
    const input = $<HTMLInputElement>('#busca-campo');
    input.focus();
    input.select();
  } else {
    search.token++;
    search.hits = [];
    search.i = -1;
    renderSearchHighlight();
    renderRegua();
    $('#procurar').focus();
  }
}

function wireSearch(): void {
  const input = $<HTMLInputElement>('#busca-campo');
  let timer: ReturnType<typeof setTimeout>;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value), 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goHit(search.i + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      openSearch(false);
    }
  });
  $('#procurar').addEventListener('click', () => openSearch($('#busca').hidden !== false));
  $('#busca-ant').addEventListener('click', () => goHit(search.i - 1));
  $('#busca-prox').addEventListener('click', () => goHit(search.i + 1));
  $('#busca-fechar').addEventListener('click', () => openSearch(false));
}

// ---------------------------------------------------------------- pé: a próxima ação
type Next = { kind: 'choose' | 'wait' | 'draw' | 'pick' | 'place' | 'rubrica' | 'sign' | 'none'; label: string; disabled?: boolean; spin?: boolean };
function nextStep(): Next {
  if (S.status !== 'pending') return { kind: 'none', label: '' };
  if (S.uploading) return { kind: 'wait', label: L('primaryOpening'), disabled: true, spin: true };
  if (!S.doc || S.doc.awaiting) return { kind: 'choose', label: L('primaryChoose') };
  if (S.busy) return { kind: 'wait', label: L('signing'), disabled: true, spin: true };
  if (S.previewFailed) return { kind: 'sign', label: L('signDocument'), disabled: true };
  if (!S.viewer) return { kind: 'wait', label: L('primaryOpening'), disabled: true, spin: true };
  if (!currentSig()) return S.signatures.length ? { kind: 'pick', label: L('primaryPick') } : { kind: 'draw', label: L('primaryDraw') };
  if (!S.frame) return { kind: 'place', label: L('primaryPlace') };
  if (S.rubrica.on && !rubricaSig()) return { kind: 'rubrica', label: L('primaryRubrica') };
  const n = allFrames().length;
  return { kind: 'sign', label: n > 1 ? L('primarySignMany', { n }) : L('primarySign', { page: S.frame.pageIndex + 1 }) };
}

/** "13", "13 e 20", "13, 20 e 21". */
function joinPages(pages: number[]): string {
  if (pages.length < 2) return String(pages[0] ?? '');
  return `${pages.slice(0, -1).join(', ')}${L('andJoin')}${pages.at(-1)}`;
}

/** O que vai entrar no PDF, numa linha — só quando há mais que uma assinatura num lugar. */
function summaryLine(): string {
  const frames = allFrames();
  const pages = [...new Set(frames.map((f) => f.pageIndex + 1))].sort((a, b) => a - b);
  const rubrica = S.rubrica.on && rubricaSig() && S.viewer ? rubricaPages().length : 0;
  const texto = S.texto.on && textLines().length > 0;
  if (frames.length < 2 && !rubrica && !texto) return '';
  const where = { pages: joinPages(pages), n: frames.length };
  const parts = [L(pages.length > 1 ? 'footPlaces' : frames.length > 1 ? 'footPlacesSame' : 'footPlace', where)];
  if (rubrica) parts.push(L('footRubrica', { n: rubrica }));
  if (texto) parts.push(L('footTexto', { page: S.texto.pageIndex + 1 }));
  return `${parts.join(' · ')}. `;
}

function renderFoot(): void {
  const btn = $<HTMLButtonElement>('#principal');
  if (!btn) return;
  const next = nextStep();
  btn.innerHTML = `${next.spin ? '<span class="gira" aria-hidden="true"></span>' : ''}${esc(next.label)}`;
  btn.disabled = Boolean(next.disabled);
  btn.dataset.next = next.kind;
  $<HTMLButtonElement>('#cancelar').disabled = S.busy;
  const nota = $('#pe-nota');
  const out = S.doc?.outputName ? `<b>${esc(S.doc.outputName)}</b>` : '';
  nota.innerHTML =
    next.kind === 'choose'
      ? esc(L('footAwaiting'))
      : S.previewFailed
        ? esc(L('notePreviewFailed'))
        : next.kind === 'draw'
          ? esc(L('footDraw'))
          : next.kind === 'pick'
            ? esc(L('notePick'))
            : next.kind === 'rubrica'
              ? esc(L('footRubricaDraw'))
              : esc(summaryLine()) +
                (S.doc?.uploaded ? L('footUploaded', { name: out, folder: esc(folderLabel()) }) : L('footNextTo', { name: out, folder: esc(folderLabel()) }));
}

function primary(): void {
  switch ($('#principal').dataset.next) {
    case 'choose':
      return $<HTMLInputElement>('#arquivo').click();
    case 'draw':
      return openPad();
    case 'pick':
      return toggleSigList(true);
    case 'place':
      return startPlacing('move');
    case 'rubrica':
      return S.signatures.some((x) => x.kind === 'rubrica') ? toggleRubricaList(true) : openPad('rubrica');
    case 'sign':
      return void confirmSign();
  }
}

function setBusy(on: boolean): void {
  S.busy = on;
  document.body.classList.toggle('ocupado', on);
  // durante a assinatura, trocar assinatura, tinta ou posição faria a prévia diferir do PDF
  $('#canhoto').inert = on;
  for (const el of [...boxes.values(), ...rubricaEls.values(), ...(textoEl ? [textoEl] : [])]) el.inert = on;
  renderFoot();
}

// ---------------------------------------------------------------- desenhar (diálogo)
/** O quadro serve para a assinatura e para a rubrica (a rubrica fica salva no cofre como "rubrica"). */
let padFor: 'sig' | 'rubrica' = 'sig';
function openPad(mode: 'sig' | 'rubrica' = 'sig'): void {
  const dlg = $<HTMLDialogElement>('#dlg-quadro');
  if (dlg.open) return;
  padFor = mode;
  pad?.clear();
  $('#dlg-quadro-t').textContent = L(mode === 'rubrica' ? 'padTitleRubrica' : 'padTitle');
  $('#pad-usar').textContent = L(mode === 'rubrica' ? 'padUseRubrica' : 'padUse');
  $<HTMLInputElement>('#pad-nome').value = mode === 'rubrica' ? L('defaultRubrica') : S.signatures.length ? '' : L('defaultLabel');
  syncInk();
  dlg.showModal();
  requestAnimationFrame(() => $('#pad').focus({ preventScroll: true }));
}

function wirePadDialog(): void {
  const dlg = $<HTMLDialogElement>('#dlg-quadro');
  $('#pad-cancelar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => pad?.finishStroke());
  $('#pad-usar').addEventListener('click', async () => {
    const saved = await savePadDrawing(padFor === 'rubrica' ? 'rubrica' : 'signature');
    if (!saved) return;
    dlg.close();
    if (padFor === 'rubrica') {
      chooseRubrica(saved.id);
      if (!$('#rubrica-lista').hidden) renderSigList('rubrica');
      flash(L('savedRubrica', { label: saved.label }));
    } else {
      S.selected = saved.id;
      if (!$('#sig-lista').hidden) renderSigList();
      chooseSignature(saved.id);
      renderSig();
      flash(L('savedToDoc', { label: saved.label }));
    }
    $('#principal').focus();
  });
  $('#pad-nome').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      $('#pad-usar').click();
    }
  });
}

// ---------------------------------------------------------------- assinar
async function confirmSign(): Promise<void> {
  const cur = currentSig();
  if (!cur || S.busy || !S.frame || !S.selected) return;
  stopPlacing();
  hideFlash();
  setBusy(true);
  try {
    const placements = allFrames().map((f) => {
      const b = boxInFrame(f, currentAspect(f));
      return { pageIndex: b.pageIndex, x: b.x, y: b.y, width: b.width };
    });
    const rubrica = S.rubrica.on && rubricaSig() ? { signatureId: S.rubrica.sigId, placements: rubricaPages().map((i) => ({ pageIndex: i, x: rubricaBox(i).x, y: rubricaBox(i).y, width: rubricaBox(i).width })) } : undefined;
    const lines = S.texto.on ? textLines() : [];
    if (lines.length) clampTexto();
    const r = await S.t.call('confirm', {
      signatureId: S.selected,
      placements,
      ink: S.prefs.ink,
      pen: S.prefs.pen,
      ...(rubrica && rubrica.placements.length ? { initials: rubrica } : {}),
      ...(lines.length ? { texts: [{ pageIndex: S.texto.pageIndex, x: S.texto.x, y: S.texto.y, size: TEXT_SIZE, lines }] } : {}),
    });
    const extra = [r.initials_pages ? ` Initials on ${r.initials_pages} pages.` : '', r.texts ? ' Place and date written next to the signature.' : ''].join('');
    S.t.notifyModel(`The user signed the document in labsign${placements.length > 1 ? ` in ${placements.length} places` : ''}. Signed file: ${r.signed_file}.${extra}`).catch(() => {});
    setBusy(false);
    await refreshState().catch(() => {});
    showSigned(r, { animate: true, focus: true });
  } catch (e) {
    setBusy(false);
    flash(errText(e, 'signFailed'), { error: true });
    $('#principal').focus();
  }
}

async function cancelSign(): Promise<void> {
  if (S.busy) return;
  await S.t.call('cancel').catch(() => {});
  S.t.notifyModel('The user cancelled the signing in labsign.').catch(() => {});
  S.status = 'cancelled';
  showClosed(L('cancelledTitle'), `${L('cancelledText')} ${S.t.embedded ? L('backToChat') : L('canCloseTab')}`, { stamp: true, focus: true });
}

function lock(): void {
  S.locked = true;
  stopPlacing();
  placeBox();
  syncSpots();
  renderDoc();
  renderSig();
  toggleSigList(false);
  sizeApp();
}

function showClosed(title: string, text: string, { stamp = false, focus = false } = {}): void {
  lock();
  $('#talao').dataset.state = 'encerrado';
  $('#encerrado').innerHTML = `
    <div class="encerrado-folha">
      ${stamp ? `<span class="carimbo grande cancelado">${L('stampCancelled')}</span>` : ''}
      <h2 id="encerrado-t" tabindex="-1">${esc(title)}</h2>
      <p>${esc(text)}</p>
    </div>`;
  showView('encerrado');
  if (focus) $('#encerrado-t').focus();
}

function showClosedFromState(st: any): void {
  if (st.status === 'signed' && st.result?.signed_file) return showSigned(st.result);
  showClosed(st.status === 'expired' ? L('expiredTitle') : L('closedTitle'), L('closedText'));
}

/** Data e hora do carimbo: quando foi assinado de fato (o histórico guarda), não quando a tela foi aberta. */
const stampDate = () => {
  const at = [...S.history].reverse().find((h) => h.event === 'signed')?.at ?? new Date().toISOString();
  return `${new Date(at).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' })} · ${hm(at)}`;
};
const folderOf = (file: string) => {
  const dir = String(file).replace(/[\\/][^\\/]*$/, '');
  return S.doc?.outputDir && dir === S.doc.outputDir ? folderLabel() : shortFolder(dir);
};

// ---------------------------------------------------------------- a via destacada: entrega
function showSigned(r: any, { animate = false, focus = false } = {}): void {
  S.status = 'signed';
  S.result = r;
  lock();
  const talao = $('#talao');
  talao.dataset.state = 'signed';
  buildEntrega(r);
  showView('entrega');
  const via = $('#via');
  via.classList.remove('destacada', 'quieta');
  void via.offsetWidth;
  via.classList.add('destacada');
  if (!animate || reduced()) via.classList.add('quieta');
  renderCanhoto();
  if (focus) $('#entrega-t').focus({ preventScroll: true });
}

async function buildEntrega(r: any): Promise<void> {
  const file = String(r.signed_file);
  const name = baseName(file);
  const d = S.delivery;
  const mails = d?.mail?.length ? d.mail : ['gmail'];
  const attach = mails.some((c) => c !== 'gmail');
  const docName = S.doc?.name ?? name;
  $('#entrega').innerHTML = `
    <div class="entrega-cab">
      <div>
        <span class="carimbo grande">${L('stampSigned')}<small>${esc(stampDate())}</small></span>
        <h2 id="entrega-t" tabindex="-1">${L('doneTitle')}</h2>
        <p>${L(S.doc?.uploaded ? 'doneUploaded' : 'doneNextTo', { name: `<b>${esc(name)}</b>`, folder: esc(folderOf(file)) })}</p>
      </div>
      <button class="miniatura" id="miniatura" type="button" aria-label="${esc(L('tabView'))}" title="${esc(L('tabView'))}"><canvas id="miniatura-c"></canvas></button>
    </div>
    <div class="grupo">
      <h3 class="rotulo">${L('groupKeep')}</h3>
      <div class="acoes">
        <button class="btn" type="button" data-act="open">${icons.file(16)}${L('actOpen')}</button>
        <button class="btn" type="button" data-act="reveal">${icons.folder(16)}${L('actFolder')}</button>
        ${d?.saveAs ? `<button class="btn" type="button" data-act="save">${icons.download(16)}${L('actSaveAs')}</button>` : ''}
        ${d?.copy ? `<button class="btn" type="button" data-act="copy">${icons.copy(16)}${L('actCopy')}</button>` : ''}
        <button class="btn" type="button" data-act="receipt" title="${esc(L('actReceiptTitle'))}">${icons.shield(16)}${L(S.receipt ? 'actReceiptOpen' : 'actReceipt')}</button>
        <button class="btn" type="button" data-act="share" hidden>${icons.share(16)}${L('actShare')}</button>
      </div>
    </div>
    <div class="grupo">
      <h3 class="rotulo">${L('groupMail')}</h3>
      <div class="acoes">${mails.map((c) => `<button class="btn" type="button" data-mail="${esc(c)}">${icons.mail(16)}${esc(mailName(c))}</button>`).join('')}</div>
      <p class="nota">${attach ? `${esc(L('mailAttachNote', { apps: mails.filter((c) => c !== 'gmail').map(mailName).join(L('orJoin')) }))} ` : ''}${esc(L('mailGmailNote', { paste: pasteKey() }))}</p>
      <div class="guia" id="guia-mail" role="status" hidden></div>
    </div>
    <div class="grupo">
      <h3 class="rotulo">${L('groupWa')}</h3>
      <div class="whats">
        <label class="campo-form"><span>${L('waNumber')}</span><input type="tel" id="wa-numero" placeholder="${L('waNumberPlaceholder')}" autocomplete="tel"></label>
        <button class="btn" type="button" id="wa-abrir">${icons.chat(16)}${L('waOpen')}</button>
      </div>
      <p class="nota">${esc(L('waNote', { paste: pasteKey() }))}</p>
      <div class="guia" id="guia-wa" role="status" hidden></div>
    </div>
    <div class="entrega-pe">
      ${d?.trash !== false ? `<button class="btn discreto" type="button" id="desfazer">${icons.undo(16)}${L('undoBtn')}</button>` : ''}
      <p>${esc(L(S.t.embedded ? 'anotherChat' : 'anotherBrowser'))}</p>
    </div>`;

  const busyWhile = async (btn: HTMLButtonElement | null, fn: () => Promise<void>) => {
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await fn();
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  const deliver = async (args: Record<string, unknown>) => {
    try {
      const out = await S.t.call('deliver', args);
      refreshHistory();
      return out;
    } catch (e) {
      flash(isConnectionLost(e) ? L('flashServerGone', { path: file }) : errText(e), { error: true });
      return null;
    }
  };
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#entrega [data-act]')) {
    btn.addEventListener('click', () =>
      busyWhile(btn, async () => {
        const act = btn.dataset.act!;
        if (act === 'save') return saveCopy();
        if (act === 'receipt') return makeReceipt(btn);
        if (act === 'share') return share(file, name, docName);
        const out = await deliver({ action: act });
        if (!out) return;
        if (act === 'open') flash(out.done ? L('flashOpened') : L('flashFileAt', { path: file }), { error: !out.done });
        else if (act === 'reveal') flash(out.done ? L('flashFolderOpened') : L('flashFileAt', { path: file }), { error: !out.done });
        else if (act === 'copy') flash(out.done ? L('flashCopied', { paste: pasteKey() }) : L('flashCopyFailed'), { error: !out.done });
      }),
    );
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#entrega [data-mail]')) {
    btn.addEventListener('click', () =>
      busyWhile(btn, async () => {
        const client = btn.dataset.mail!;
        const out = await deliver({ action: 'mail', client, subject: L('mailSubjectDefault', { name: docName }), body: L('mailBodyDefault', { name: docName }) });
        if (!out) return;
        if (client === 'gmail') guide('#guia-mail', out.done ? (out.copied ? L('guideGmail', { paste: pasteKey() }) : L('guideGmailDrag')) : L('guideGmailManual'));
        else flash(out.done ? L('flashMailOpened', { client: mailName(client) }) : L('flashMailFailed', { client: mailName(client) }), { error: !out.done });
      }),
    );
  }
  const waBtn = $<HTMLButtonElement>('#wa-abrir');
  waBtn.addEventListener('click', () =>
    busyWhile(waBtn, async () => {
      let digits = $<HTMLInputElement>('#wa-numero').value.replace(/\D/g, '');
      if (lang === 'pt' && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`; // número brasileiro sem o código do país
      const out = await deliver({ action: 'whatsapp', phone: digits, text: L('waTextDefault', { name: docName }) });
      if (!out) return;
      guide('#guia-wa', out.done ? (out.copied ? L('guideWa', { paste: pasteKey() }) : L('guideWaDrag')) : L('guideWaManual'));
    }),
  );
  $('#wa-numero').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && waBtn.click());
  $('#miniatura').addEventListener('click', () => showTab('ver'));
  $('#desfazer')?.addEventListener('click', askUndo);

  // miniatura da página assinada, feita do próprio arquivo assinado (o que foi gravado de fato)
  try {
    const signed = await S.t.readSigned();
    const doc = await openPdf(signed);
    if (!S.pdf) {
      // tela recarregada depois de assinar: a miniatura do canhoto sai do próprio arquivo assinado
      S.pdf = doc;
      renderDoc();
    }
    const page = clamp((r.pages?.[0] ?? 1) - 1, 0, doc.numPages - 1);
    await renderThumb(doc, page, $<HTMLCanvasElement>('#miniatura-c'), S.layout === 'compact' ? 96 : 132);
    // compartilhar (só no navegador que sabe mandar arquivos: celular, Safari, Chrome no Windows)
    const f = new File([signed as BlobPart], name, { type: 'application/pdf' });
    if (!S.t.embedded && navigator.canShare?.({ files: [f] })) {
      shareFile = f;
      const shareBtn = document.querySelector<HTMLButtonElement>('#entrega [data-act="share"]');
      if (shareBtn) shareBtn.hidden = false;
    }
  } catch (e) {
    console.error(e);
    $('#miniatura').hidden = true;
  }
}

let shareFile: File | null = null;
async function share(file: string, name: string, docName: string): Promise<void> {
  if (!shareFile) return;
  try {
    await navigator.share({ files: [shareFile], title: name, text: L('shareText', { name: docName }) });
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') flash(L('flashShareUnavailable'), { error: true });
  }
  void file;
}

function guide(sel: string, text: string): void {
  const el = $(sel);
  for (const g of document.querySelectorAll<HTMLElement>('.guia')) if (g !== el) g.hidden = true;
  // "⌘V" vira tecla desenhada
  el.innerHTML = `${icons.info(17)}<span>${esc(text).replace(/(⌘V|Ctrl\+V)/g, '<kbd>$1</kbd>')}</span>`;
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
}

async function refreshHistory(): Promise<void> {
  try {
    const st = await S.t.call('state');
    S.history = st.history ?? [];
    renderHistory();
  } catch {}
}

/** "Salvar uma cópia em…": a janela do sistema abre; a tela acompanha até a pessoa escolher (ou desistir). */
async function saveCopy(): Promise<void> {
  try {
    let job = await S.t.call('save_copy', { prompt: L('saveAsPrompt') });
    flash(L('flashSaving'), { sticky: true });
    for (let i = 0; job.state === 'running' && i < 60; i++) job = await S.t.call('save_job', { wait_ms: 20000 });
    hideFlash();
    if (job.state === 'done') {
      flash(job.renamed ? L('flashSavedRenamed', { folder: job.folder ?? '', name: job.name ?? '' }) : L('flashSaved', { folder: job.folder ?? '', name: job.name ?? '' }));
      refreshHistory();
    } else if (job.state === 'error') flash(job.error?.error && hasKey(`err.${job.error.error}`) ? L(`err.${job.error.error}` as MessageKey, job.error.params) : L('err.generic'), { error: true });
  } catch (e) {
    hideFlash();
    flash(errText(e), { error: true });
  }
}

/**
 * Comprovante: um PDF à parte, ao lado da cópia assinada, com data, hora, lugares e os SHA-256. Abre na hora.
 * O segundo clique abre o mesmo arquivo (o servidor não gera outro), e o botão passa a dizer isso.
 */
async function makeReceipt(btn: HTMLButtonElement): Promise<void> {
  try {
    const r = await S.t.call('receipt', { lang });
    const args = { name: r.name, folder: folderOf(r.file) };
    if (r.again) flash(L(r.opened ? 'flashReceiptAgainOpened' : 'flashReceiptAgain', args));
    else flash(L(r.opened ? 'flashReceiptOpened' : 'flashReceipt', args));
    S.receipt = r.name;
    btn.innerHTML = `${icons.shield(16)}${L('actReceiptOpen')}`;
    refreshHistory();
  } catch (e) {
    flash(errText(e), { error: true });
  }
}

// ---------------------------------------------------------------- desfazer
function askUndo(): void {
  const dlg = $<HTMLDialogElement>('#dlg-desfazer');
  $('#dlg-desfazer-texto').textContent = `${L('undoText', { name: baseName(S.result?.signed_file ?? '') })}${S.receipt ? ` ${L('undoReceipt')}` : ''}`;
  dlg.showModal();
  $('#desfazer-nao').focus();
}

function wireUndo(): void {
  const dlg = $<HTMLDialogElement>('#dlg-desfazer');
  $('#desfazer-nao').addEventListener('click', () => dlg.close());
  $('#desfazer-sim').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#desfazer-sim');
    btn.disabled = true;
    try {
      await S.t.call('undo');
      dlg.close();
      S.t.notifyModel('The user undid the signature in labsign: the signed copy was moved to the Trash and the request is open again (same document).').catch(() => {});
      await reopenAfterUndo();
      flash(L('undoDone'));
    } catch (e) {
      dlg.close();
      flash(errText(e), { error: true });
    } finally {
      btn.disabled = false;
    }
  });
}

async function reopenAfterUndo(): Promise<void> {
  await refreshState();
  S.result = null;
  S.locked = false;
  const via = $('#via');
  via.classList.remove('destacada', 'quieta');
  $('#talao').dataset.state = 'pending';
  S.status = 'pending';
  showView('folhas');
  renderCanhoto();
  sizeApp();
  if (S.source !== 'original') await loadDocument('original');
  else {
    placeBox();
    renderRegua();
  }
  renderNotices();
  renderFoot();
  $('#principal').focus();
}

// ---------------------------------------------------------------- trocar, remover e receber o documento
function showReceber(): void {
  showView('receber');
  const mb = Math.round((S.doc?.maxBytes ?? 30 * 1024 * 1024) / 1024 / 1024);
  $('#receber-nota').textContent = L('dzNote', { mb, folder: folderLabel() || '~/Downloads' });
  $('#receber-estado').textContent = '';
  renderFoot();
}

async function removeDocument(): Promise<boolean> {
  try {
    await S.t.call('remove_document');
  } catch (e) {
    flash(errText(e), { error: true });
    return false;
  }
  S.viewer?.destroy();
  S.viewer = null;
  S.pdf = null;
  S.source = null;
  S.frame = null;
  S.spot = null;
  S.extras = [];
  S.texto.placed = false;
  for (const box of boxes.values()) box.remove();
  boxes.clear();
  for (const el of rubricaEls.values()) el.remove();
  rubricaEls.clear();
  textoEl?.remove();
  textCache.clear();
  search.hits = [];
  $('#folhas').innerHTML = '';
  await refreshState().catch(() => {});
  renderCanhoto();
  renderNotices();
  showReceber();
  return true;
}

async function takeFile(file: File | undefined | null): Promise<void> {
  const estado = (text: string, error = false) => {
    const el = $('#receber-estado');
    el.textContent = text;
    el.classList.toggle('erro', error);
    if (error && $('#receber').hidden) flash(text, { error: true });
  };
  if (!file || S.uploading || S.status !== 'pending' || S.locked) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) return estado(L('dzNotPdf'), true);
  if (!file.size) return estado(L('err.UPLOAD_EMPTY'), true);
  const max = S.doc?.maxBytes ?? 30 * 1024 * 1024;
  if (file.size > max) return estado(L('dzTooBig', { mb: Math.round(max / 1024 / 1024) }), true);
  // trocar: o documento atual sai da tela primeiro (o arquivo dele continua no computador)
  if (S.doc && !S.doc.awaiting && !(await removeDocument())) return;
  S.uploading = true;
  $('#receber').classList.add('ocupado');
  renderFoot();
  estado(L('dzUploading', { name: file.name }));
  try {
    await S.t.upload(file, (p) => estado(L('dzUploadingPct', { name: file.name, pct: Math.round(p * 100) })));
    await refreshState();
    S.frame = S.doc?.placements?.[0] ? frameFromPlacement(S.doc.placements[0]) : null;
    matchSpot();
    document.title = L('tabSign', { name: S.doc?.name ?? '' });
    renderCanhoto();
    renderNotices();
    S.uploading = false;
    await loadDocument('original');
  } catch (e) {
    if (e instanceof UiError && e.code === 'SESSION_CLOSED') {
      S.status = 'closed';
      showClosed(L('closedTitle'), L('closedText'), { focus: true });
    } else estado(errText(e), true);
  } finally {
    S.uploading = false;
    $('#receber').classList.remove('ocupado');
    $<HTMLInputElement>('#arquivo').value = '';
    renderFoot();
  }
}

const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
const canDrop = () => Boolean(S.doc?.awaiting) && !S.locked && S.status === 'pending';

// ---------------------------------------------------------------- tela aberta no navegador (plano B do chat)
async function openInBrowser(): Promise<void> {
  try {
    const r = await S.t.call('open_in_browser');
    if (!r?.opened) return flash(L('flashBrowserFailed'), { error: true });
  } catch (e) {
    return flash(errText(e), { error: true });
  }
  S.elsewhere = true;
  sizeApp();
  $('#encerrado').innerHTML = `
    <div class="encerrado-folha aberto-fora">
      <h2 id="encerrado-t" tabindex="-1">${L('inBrowserTitle')}</h2>
      <p>${L('inBrowserText')}</p>
      <p><button class="btn" type="button" id="continuar-aqui">${L('continueHere')}</button></p>
    </div>`;
  showView('encerrado');
  $('#encerrado-t').focus();
  const back = async () => {
    S.elsewhere = false;
    clearInterval(poll);
    const st = await refreshState();
    if (st.status !== 'pending') return showClosedFromState(st);
    await remountDocument();
  };
  $('#continuar-aqui').addEventListener('click', back);
  // assinou ou cancelou por lá: esta tela mostra o resultado
  const poll = setInterval(async () => {
    try {
      const st = await S.t.call('state');
      if (st.status !== 'pending') {
        clearInterval(poll);
        S.elsewhere = false;
        await refreshState();
        showClosedFromState(st);
      }
    } catch {}
  }, 4000);
}

async function remountDocument(): Promise<void> {
  renderCanhoto();
  renderNotices();
  if (S.doc?.awaiting) return showReceber();
  S.frame = S.doc?.placements?.[0] ? frameFromPlacement(S.doc.placements[0]) : S.frame;
  matchSpot();
  await loadDocument('original');
}

// ---------------------------------------------------------------- montar a tela de assinar
async function mountSign(st: any): Promise<void> {
  document.title = S.doc?.name ? L('tabSign', { name: S.doc.name }) : L('tabSignNoDoc');
  $app.innerHTML = signShell();
  S.layout = 'full';
  applyLayout();
  // a assinatura mais usada (que não seja rubrica) já vem escolhida
  const pick = mostRecent(S.signatures.filter((x) => x.kind !== 'rubrica')) ?? mostRecent(S.signatures);
  S.selected = pick?.id ?? null;
  S.frame = !S.doc || S.doc.awaiting || !S.doc.placements ? null : frameFromPlacement(S.doc.placements[0]);
  matchSpot();
  // rubrica e local e data: o que ficou guardado da última vez; ligados se a pessoa pediu à IA
  const hints = S.doc?.hints;
  Object.assign(S.rubrica, S.prefs.rubrica ?? {}, { on: Boolean(hints?.initials), sigId: defaultRubrica() });
  Object.assign(S.texto, S.prefs.fill ?? {}, { on: Boolean(hints?.placeDate), date: todayText(), placed: false });
  mountPad();
  wireInk();
  wirePadDialog();
  wireUndo();
  wireSign();
  watchLayout();
  sizeApp();
  S.t.onHostChange(() => {
    sizeApp();
    requestAnimationFrame(() => {
      S.viewer?.relayout();
      placeBox();
    });
  });
  renderCanhoto();
  renderNotices();
  renderFoot();
  if (st.status !== 'pending') {
    if (st.status === 'signed' && st.result?.signed_file) {
      S.result = st.result;
      showSigned(st.result);
      // recarregou depois de assinar: a prévia é o arquivo assinado, não o original
      return;
    }
    return showClosedFromState(st);
  }
  if (S.doc?.awaiting) return showReceber();
  await loadDocument('original');
}

function wireSign(): void {
  $('#principal').addEventListener('click', primary);
  $('#cancelar').addEventListener('click', cancelSign);
  $('#doc-trocar').addEventListener('click', () => $<HTMLInputElement>('#arquivo').click());
  $('#doc-remover').addEventListener('click', async () => {
    if (!(await removeDocument())) return;
    flash(L('docRemoved'));
    $<HTMLInputElement>('#arquivo').closest('label')?.focus();
  });
  $<HTMLInputElement>('#arquivo').addEventListener('change', (e) => takeFile((e.target as HTMLInputElement).files?.[0]));
  $('#sig-trocar').addEventListener('click', () => toggleSigList($('#sig-lista').hidden !== false));
  $('#sig-nova').addEventListener('click', () => openPad('sig'));
  // rubrica em todas as páginas
  $<HTMLInputElement>('#rubrica-on').addEventListener('change', (e) => {
    S.rubrica.on = (e.target as HTMLInputElement).checked;
    if (S.rubrica.on && !rubricaSig()) S.rubrica.sigId = defaultRubrica();
    renderRubricaField();
    renderRubricas();
    renderFoot();
    // sem rubrica no cofre ainda: já abre o quadro para desenhar
    if (S.rubrica.on && !rubricaSig()) openPad('rubrica');
    else if (S.rubrica.on) showField('#campo-rubrica');
  });
  $('#rubrica-nova').addEventListener('click', () => openPad('rubrica'));
  $('#rubrica-trocar').addEventListener('click', () => toggleRubricaList($('#rubrica-lista').hidden !== false));
  $<HTMLInputElement>('#rubrica-com').addEventListener('change', (e) => {
    S.rubrica.withSigned = (e.target as HTMLInputElement).checked;
    saveRubricaPrefs();
    renderRubricaField();
    renderRubricas();
    renderFoot();
  });
  // local e data (e nome/CPF)
  $<HTMLInputElement>('#texto-on').addEventListener('change', (e) => {
    S.texto.on = (e.target as HTMLInputElement).checked;
    renderTextoField();
    renderTexto();
    renderFoot();
    if (S.texto.on) {
      if (S.viewer) S.viewer.scrollToPage(S.texto.pageIndex, { y: S.texto.y, smooth: !reduced() });
      showField('#campo-texto');
      if (!S.texto.city) $('#texto-cidade').focus({ preventScroll: true });
    }
  });
  for (const [id, key] of [['texto-cidade', 'city'], ['texto-data', 'date'], ['texto-nome', 'name'], ['texto-doc', 'doc']] as const)
    $<HTMLInputElement>(`#${id}`).addEventListener('input', (e) => {
      S.texto[key] = (e.target as HTMLInputElement).value;
      if (key !== 'date') saveFillPrefs();
      renderTexto();
      renderFoot();
    });
  $('#hist-toggle').addEventListener('click', () => {
    const open = !$('#campo-hist').classList.contains('aberto');
    $('#campo-hist').classList.toggle('aberto', open);
    $('#hist-toggle').setAttribute('aria-expanded', String(open));
  });
  // página: digitar o número e Enter
  const pagina = $<HTMLInputElement>('#pagina');
  pagina.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goToPageInput();
      $('#folhas').focus({ preventScroll: true });
    } else if (e.key === 'Escape') {
      pagina.value = String((S.viewer?.current() ?? 0) + 1);
      $('#folhas').focus({ preventScroll: true });
    }
  });
  pagina.addEventListener('change', goToPageInput);
  pagina.addEventListener('focus', () => pagina.select());
  $('#ir-lugar').addEventListener('click', () => scrollToFrame(true, nextFrameAway()));
  $('#zoom-menos').addEventListener('click', () => stepZoom(-1));
  $('#zoom-mais').addEventListener('click', () => stepZoom(1));
  $('#zoom-ajustar').addEventListener('click', () => {
    S.viewer?.setZoom(1);
    afterZoom();
  });
  $('#zoom-pagina').addEventListener('click', () => {
    if (!S.viewer) return;
    S.viewer.setZoom(S.viewer.fitPageZoom());
    S.viewer.scrollToPage(S.viewer.current());
    afterZoom();
  });
  // tamanho do painel no chat: a escolha fica guardada para a próxima vez
  const panel = (dir: 1 | -1) => {
    const i = PANEL_ORDER.indexOf(S.prefs.panel) + dir;
    if (i < 0 || i >= PANEL_ORDER.length) return;
    S.prefs.panel = PANEL_ORDER[i];
    S.t.call('set_prefs', { panel: S.prefs.panel }).catch(() => {});
    sizeApp();
    requestAnimationFrame(() => {
      S.viewer?.relayout();
      placeBox();
      if (S.frame && S.source === 'original' && !S.locked) scrollToFrame(false);
    });
  };
  $('#painel-menor').addEventListener('click', () => panel(-1));
  $('#painel-maior').addEventListener('click', () => panel(1));
  $('#aba-entrega').addEventListener('click', () => showTab('entrega'));
  $('#aba-ver').addEventListener('click', () => showTab('ver'));
  $('#tela-cheia').addEventListener('click', () => S.t.display?.toggle().catch(() => flash(L('flashFullscreenFailed'), { error: true })));
  $('#no-navegador').addEventListener('click', openInBrowser);
  wireRegua();
  wireSearch();
  // no documento: digitar um número leva ao campo da página (como teclar a página no teletexto)
  const folhas = $('#folhas');
  folhas.addEventListener('keydown', (e) => {
    if (/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      pagina.focus();
      pagina.value = e.key;
    } else if (e.key === 'Escape' && S.placing) stopPlacing();
  });
  const onMark = (e: Event) => (e.target as Element).closest('.sig-box, .rubrica-box, .texto-box');
  folhas.addEventListener('click', (e) => {
    if (!S.placing || S.locked || !S.viewer || onMark(e)) return;
    const p = S.viewer.pageAt(e.clientX, e.clientY);
    if (p) placeAt(p);
  });
  folhas.addEventListener('dblclick', (e) => {
    if (S.locked || !S.viewer || S.source !== 'original' || onMark(e)) return;
    const p = S.viewer.pageAt(e.clientX, e.clientY);
    if (p) placeAt(p, 'move');
  });
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && S.viewer && !$('#folhas-area').hidden) {
      e.preventDefault();
      openSearch(true);
    } else if (e.key === 'Escape' && S.placing) stopPlacing();
  });
  // soltar um PDF funciona em qualquer ponto da tela enquanto o pedido espera um (o preventDefault geral está em main)
  addEventListener('dragover', (e) => canDrop() && hasFiles(e) && $('#receber').classList.add('sobre'));
  addEventListener('dragleave', (e) => !e.relatedTarget && $('#receber').classList.remove('sobre'));
  addEventListener('drop', (e) => {
    $('#receber').classList.remove('sobre');
    if (hasFiles(e) && canDrop()) takeFile(e.dataTransfer!.files[0]);
  });
}

// ---------------------------------------------------------------- sessão "pad" (cofre)
function mountVault(): void {
  document.title = L('tabVault');
  $app.innerHTML = `
    <div class="cofre">
      <header class="c-topo"><span class="marca">${icons.nib(18)}labsign</span></header>
      <div class="cofre-corpo">
        <h1>${L('vaultTitle')}</h1>
        <p>${L('vaultSub')}</p>
        <section class="campo" aria-labelledby="l-salvas">
          <h2 class="rotulo" id="l-salvas">${L('groupSaved')}</h2>
          <div class="sig-lista" id="sig-lista"></div>
        </section>
        <section class="campo" aria-labelledby="l-nova">
          <h2 class="rotulo" id="l-nova">${L('groupNew')}</h2>
          <div style="display:grid;gap:12px">
            ${quadroHtml()}
            <div class="whats">
              <label class="campo-form"><span>${L('nameLabel')}</span><input id="pad-nome" type="text" maxlength="56" placeholder="${L('namePlaceholder')}" autocomplete="off" spellcheck="false"></label>
              <button class="btn principal" id="salvar" type="button" disabled>${L('save')}</button>
            </div>
          </div>
        </section>
      </div>
      <footer class="cofre-pe"><button class="btn" id="concluir" type="button">${L('vaultDone')}</button></footer>
      <p class="recado" id="recado" role="status" aria-live="polite"></p>
    </div>`;
  mountPad();
  wireInk();
  renderVaultList();
  $('#salvar').addEventListener('click', async () => {
    const saved = await savePadDrawing();
    if (!saved) return;
    pad?.clear();
    $<HTMLInputElement>('#pad-nome').value = '';
    renderVaultList();
    flash(L('savedToVault', { label: saved.label }));
  });
  $('#pad-nome').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && $('#salvar').click());
  $('#concluir').addEventListener('click', finishVault);
}

function renderVaultList(): void {
  const el = $('#sig-lista');
  if (!el) return;
  if (!S.signatures.length) {
    el.innerHTML = `<p class="vazio">${L('vaultEmpty')}</p>`;
    return;
  }
  el.innerHTML = S.signatures
    .map(
      (s) => `
      <div class="sig-item" data-id="${esc(s.id)}" style="grid-template-columns: 88px minmax(0, 1fr) 30px; cursor: default">
        <span class="sig-thumb">${rendered(s.strokes, s.id).svg}</span>
        <span class="sig-texto"><span class="nome">${esc(s.label)}</span><span class="meta">${esc(rowMeta(s))}</span></span>
        <button class="apagar" type="button" aria-label="${esc(L('deleteAria', { label: s.label }))}" title="${L('deleteTitle')}">${icons.trash(16)}</button>
      </div>`,
    )
    .join('');
  for (const row of el.querySelectorAll<HTMLElement>('.sig-item')) $('.apagar', row).addEventListener('click', () => askDelete(row, byId(row.dataset.id!)!));
}

async function finishVault(): Promise<void> {
  pad?.finishStroke();
  await S.t.call('finish').catch(() => {});
  $('.cofre-corpo').innerHTML = `
    <h1 id="fim-t" tabindex="-1">${L('vaultDoneTitle')}</h1>
    <p>${S.signatures.length ? L('vaultDoneText') : L('vaultDoneNone')} ${S.t.embedded ? L('backToChat') : L('canCloseTab')}</p>`;
  $('.cofre-pe').hidden = true;
  $('#fim-t').focus();
}

// ---------------------------------------------------------------- início
async function main(): Promise<void> {
  loadFont();
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  const transport = await makeTransport();
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en'; // o app de chat pode ter informado o idioma
  S.t = transport;
  const st = await transport.call('state');
  Object.assign(S, { kind: st.kind, status: st.status, doc: st.document, prefs: { ...S.prefs, ...(st.prefs ?? {}) } });
  S.history = st.history ?? [];
  S.registryNo = st.registryNo ?? null;
  S.delivery = st.delivery ?? null;
  S.receipt = st.receipt ?? null;
  S.signatures = usable(st.signatures); // depois das preferências: o filtro desenha com a tinta atual
  document.body.classList.toggle('embutida', transport.embedded);
  // arquivo solto fora da área certa: sem isto o navegador abriria o PDF no lugar da tela (e o pedido seria encerrado)
  for (const type of ['dragover', 'drop'] as const)
    addEventListener(type, (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!canDrop()) e.dataTransfer!.dropEffect = 'none';
    });
  transport.closeOnExit(); // aba fechada, com ou sem assinatura: quem espera (CLI, modelo) fica sabendo
  if (S.kind === 'sign') await mountSign(st);
  else mountVault();
}

main().catch((e) => {
  $app.innerHTML = `<div class="fatal"><h1>${L('fatalTitle')}</h1><p>${esc(errText(e))}</p></div>`;
});
