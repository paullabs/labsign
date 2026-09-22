// Tela única do labsign.
//   Sessão "sign": prévia do documento com a assinatura escolhida por cima, arrastável;
//                  o que aparece na página é exatamente o que será carimbado.
//                  Sem documento ainda: pede o PDF (arrastar ou escolher).
//                  Depois de assinar: baixar, compartilhar, e-mail, WhatsApp, pasta.
//   Sessão "pad":  cofre — desenhar, salvar e apagar assinaturas.
// Dois transportes: HTTP (página em 127.0.0.1) ou MCP Apps (embutida no chat).
import { icons } from './icons.ts';
import { createPad, type Pad, type PadState } from './pad.ts';
import { openPdf, createPageRenderer, type PageView } from './pdf-preview.ts';
import { strokesToSignature, signatureToSvg, penOptions, inkHex, INKS, PENS, type Ink, type Pen, type Stroke } from '../core/signature.ts';
import { DEFAULT_BOX, MIN_WIDTH, frameFromPlacement, boxInFrame, clampFrame, resizeFrame, scaleFrame, type Frame, type Placement } from '../core/placement.ts';
import { t, langFrom, hasKey, type Lang, type MessageKey, type Params } from '../i18n/messages.ts';

declare const __MCP_APP__: boolean;

// ---------------------------------------------------------------- idioma e utilidades
// LABSIGN_LANG no servidor vence o idioma do navegador
const bootLang = (window as any).__LABSIGN_HTTP__?.lang;
let lang: Lang = bootLang === 'pt' || bootLang === 'en' ? bootLang : langFrom(navigator.language);
const L = (key: MessageKey, params?: Params) => t(lang, key, params);

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $app = $('#app');
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** Rolagem suave só para quem não pediu menos movimento. */
const smooth = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/** "hoje, 19:02" · "ontem, 18:40" · "em 12/09/2026" — curto o bastante para caber na linha */
function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 864e5);
  const locale = lang === 'pt' ? 'pt-BR' : 'en-US';
  const hm = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return days === 0 ? L('today', { hm }) : days === 1 ? L('yesterday', { hm }) : L('onDate', { date: d.toLocaleDateString(locale) });
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
/** Texto no idioma da tela. Código desconhecido ou erro inesperado: `fallback` (a mensagem crua em inglês vai só para o console). */
function errText(e: unknown, fallback: MessageKey = 'err.generic'): string {
  if (e instanceof UiError && hasKey(`err.${e.code}`)) return L(`err.${e.code}` as MessageKey, e.params);
  if (isConnectionLost(e)) return L('err.CONNECTION');
  console.error(e);
  return L(fallback);
}

// ---------------------------------------------------------------- transporte
interface Transport {
  embedded: boolean;
  canDownload: boolean;
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  readDocument(): Promise<Uint8Array>;
  readSigned(): Promise<Uint8Array>;
  upload(file: File, onProgress?: (p: number) => void): Promise<unknown>;
  download(bytes: Uint8Array, name: string): Promise<void>;
  openLink(url: string): Promise<void> | void;
  closeOnExit(): void;
  notifyModel(text: string): Promise<void>;
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
      canDownload: true,
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
      async download(bytes, name) {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      },
      openLink(url) {
        if (url.startsWith('mailto:')) location.href = url; // entrega ao app de e-mail sem sair da página
        else window.open(url, '_blank', 'noopener');
      },
      /** Avisa que a aba fechou (o CLI espera isso para encerrar). Beacon não leva cabeçalho: o token vai no corpo. */
      closeOnExit() {
        addEventListener('pagehide', () =>
          navigator.sendBeacon(`/api/${boot.sessionId}/close`, new Blob([JSON.stringify({ view_token: boot.viewToken })], { type: 'application/json' })),
        );
      },
      notifyModel: async () => {},
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
  // tema do app de chat (claro/escuro), inclusive quando muda com a tela aberta
  const applyTheme = () => {
    const theme = app.getHostContext()?.theme;
    if (theme === 'light' || theme === 'dark') applyDocumentTheme(theme);
  };
  app.addEventListener('hostcontextchanged', applyTheme);
  await app.connect();
  applyTheme();
  const hostLocale = (app.getHostContext() as any)?.locale;
  if (hostLocale) lang = langFrom(hostLocale);
  const result = await firstResult;
  // bug aberto do Claude Desktop com servidor local: structuredContent pode não chegar à tela
  // (anthropics/claude-ai-mcp#563) — o texto do resultado repete o request_id como plano B
  const text: string = result.content?.find((c: any) => c.type === 'text')?.text ?? '';
  const requestId: string | undefined = result.structuredContent?.request_id ?? /request_id="([a-f0-9]{12})"/.exec(text)?.[1];
  const viewToken: string | undefined = result._meta?.labsign?.viewToken;
  if (!requestId || !viewToken) throw new UiError('NO_HANDOFF', 'no handoff');
  const caps: any = app.getHostCapabilities() ?? {};
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
    canDownload: Boolean(caps.downloadFile), // o iframe não baixa sozinho; só pelo app de chat
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
    async download(bytes, name) {
      const r: any = await app.downloadFile({ contents: [{ type: 'resource', resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType: 'application/pdf', blob: toBase64(bytes) } }] } as any);
      if (r?.isError) throw new UiError('DOWNLOAD', 'download cancelled');
    },
    async openLink(url) {
      if (!caps.openLinks) throw new UiError('NO_LINKS', 'host cannot open links');
      const r: any = await app.openLink({ url });
      if (r?.isError) throw new UiError('LINK', 'link not opened');
    },
    closeOnExit() {}, // no chat, o servidor MCP vive enquanto o app de chat quiser
    async notifyModel(text) {
      try {
        await app.updateModelContext({ content: [{ type: 'text', text }] });
      } catch {}
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
}
type Selection = { type: 'saved'; id: string } | { type: 'draft' } | null;

const S = {
  t: null as unknown as Transport,
  kind: 'sign' as 'sign' | 'pad',
  status: 'pending',
  doc: null as DocInfo | null,
  signatures: [] as UiSignature[],
  prefs: { drawMode: 'drag', ink: 'navy', pen: 'medium' } as Prefs,
  selected: null as Selection,
  lastSaved: null as string | null,
  draftStrokes: null as Stroke[] | null,
  draftVersion: 0,
  padCount: 0,
  frame: null as Frame | null, // moldura da assinatura, em pontos visuais da página
  page: 0,
  pageCount: 1,
  view: null as PageView | null,
  pdf: null as ReturnType<typeof createPageRenderer> | null,
  padOpen: false,
  busy: false,
  locked: false,
  previewFailed: false,
  awaiting: false,
  uploading: false,
  saving: false, // "Salvar" em andamento: Enter duas vezes não salva duas vezes
  pageWidth: 0, // largura CSS da última página desenhada
};
let pad: Pad;

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

const byId = (id: string) => S.signatures.find((s) => s.id === id);
function currentSig() {
  if (S.selected?.type === 'saved') {
    const s = byId(S.selected.id);
    return s ? { ...rendered(s.strokes, s.id), label: L('sigLabelSaved', { label: s.label }) } : null;
  }
  if (S.selected?.type === 'draft' && S.draftStrokes) return { ...rendered(S.draftStrokes, `draft-${S.draftVersion}`), label: L('sigLabelDraft') };
  return null;
}
const placeholderAspect = () => (S.frame && Number.isFinite(S.frame.h) ? S.frame.h / S.frame.w : DEFAULT_BOX.maxHeight / DEFAULT_BOX.width);
const currentAspect = () => currentSig()?.aspect ?? placeholderAspect();
const mostRecent = (list: UiSignature[]) => [...list].sort((a, b) => (b.lastUsedAt || b.createdAt).localeCompare(a.lastUsedAt || a.createdAt))[0] ?? null;
const isWide = () => matchMedia('(min-width: 960px)').matches && !document.body.classList.contains('embedded');
const rowMeta = (s: UiSignature) => (s.lastUsedAt ? L('usedWhen', { when: when(s.lastUsedAt) }) : L('savedWhen', { when: when(s.createdAt) }));

// ---------------------------------------------------------------- pedaços de HTML
const topbar = (title: string, status?: string) => `
  <header class="topbar">
    <span class="brand">${icons.nib(18)}labsign</span>
    <span class="docname">${title}</span>
    ${status ? `<span class="status" id="status">${status}</span>` : ''}
    <span class="spacer"></span>
    <span class="trust">${icons.lock(14)}${L('trust')}</span>
  </header>`;

const drawerHtml = () => `
  <div class="drawer" id="drawer">
    <div class="seg" id="mode-seg" role="radiogroup" aria-label="${L('howToWrite')}">
      <label><input type="radio" name="draw-mode" value="drag"><span>${L('modeDrag')}</span></label>
      <label><input type="radio" name="draw-mode" value="click"><span>${L('modeClick')}</span></label>
    </div>
    <div class="pad" id="pad-wrap">
      <canvas id="pad" tabindex="0" aria-label="${L('padAria')}"></canvas>
      <p class="pad-hint" id="pad-hint"></p>
      <span class="pen-status" id="pen-status" aria-hidden="true"><span class="dot"></span>${L('penStatus')}</span>
      <span class="on-doc" id="draft-badge" hidden>${icons.check(14)}${L('onDocument')}</span>
    </div>
    <div class="pad-actions">
      <button class="btn ghost small" id="undo" type="button" disabled>${icons.undo(15)}${L('undo')}</button>
      <button class="btn ghost small" id="clear" type="button" disabled>${icons.x(15)}${L('clear')}</button>
    </div>
    <div class="save-row">
      <label class="field"><span>${L('nameLabel')}</span><input id="label" type="text" maxlength="56" placeholder="${L('namePlaceholder')}" autocomplete="off" spellcheck="false"></label>
      <button class="btn" id="save" type="button" disabled>${L('save')}</button>
    </div>
  </div>`;

const inkHtml = () => `
  <section class="group" aria-labelledby="ink-label">
    <div class="group-head"><p class="group-label" id="ink-label">${L('groupInk')}</p></div>
    <div class="ink-grid">
      <span class="field-label">${L('inkColor')}</span>
      <div class="swatches" role="radiogroup" aria-label="${L('inkColorAria')}">
        ${(Object.keys(INKS) as Ink[])
          .map((k) => `<label class="swatch" title="${L(`ink_${k}`)}"><input type="radio" name="ink" value="${k}" aria-label="${L(`ink_${k}`)}"><span style="--c:${INKS[k]}"></span></label>`)
          .join('')}
        <span class="ink-name" id="ink-name"></span>
      </div>
      <span class="field-label">${L('inkStroke')}</span>
      <div class="seg" role="radiogroup" aria-label="${L('inkStrokeAria')}">
        ${(Object.keys(PENS) as Pen[])
          .map((k) => `<label><input type="radio" name="pen" value="${k}"><span><i class="pen-line" style="height:${Math.max(1, PENS[k] / 2.4).toFixed(1)}px"></i>${L(`pen_${k}`)}</span></label>`)
          .join('')}
      </div>
    </div>
  </section>`;

// ---------------------------------------------------------------- tinta (cor e espessura)
function mountInk(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="ink"], input[name="pen"]')) {
    input.checked = (S.prefs as any)[input.name] === input.value;
    input.addEventListener('change', () => setInk({ [input.name]: input.value }));
  }
  $('#ink-name').textContent = L(`ink_${S.prefs.ink}`);
}

function setInk(change: Partial<Prefs>): void {
  Object.assign(S.prefs, change);
  $('#ink-name').textContent = L(`ink_${S.prefs.ink}`);
  S.t.call('set_prefs', change).catch(() => {});
  pad.redraw();
  if (S.kind === 'sign') {
    buildList();
    if (S.view && S.frame) S.frame = clampFrame(S.frame, currentAspect(), S.view); // a espessura muda a proporção
    renderBox();
  } else buildVaultList();
}

// ---------------------------------------------------------------- quadro de desenho
function mountPad(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="draw-mode"]')) {
    input.checked = input.value === S.prefs.drawMode;
    input.addEventListener('change', () => setDrawMode(input.value as Prefs['drawMode']));
  }
  pad = createPad($<HTMLCanvasElement>('#pad'), {
    getMode: () => S.prefs.drawMode,
    getInk: () => inkHex(S.prefs.ink),
    getSize: () => PENS[S.prefs.pen],
    onChange: onPadChange,
  });
  $('#undo').addEventListener('click', () => pad.undo());
  $('#clear').addEventListener('click', () => pad.clear());
  $('#save').addEventListener('click', savePad);
  $('#label').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && savePad());
  // tablet com trackpad, notebook com tela de toque: o ponteiro principal pode mudar no meio da sessão
  matchMedia('(hover: none)').addEventListener('change', renderHint);
  renderHint();
}

function setDrawMode(mode: Prefs['drawMode']): void {
  pad.finishStroke();
  S.prefs.drawMode = mode;
  renderHint();
  S.t.call('set_prefs', { drawMode: mode }).catch(() => {});
  $('#pad').focus({ preventScroll: true });
}

function renderHint(): void {
  const touchOnly = matchMedia('(hover: none)').matches;
  $('#mode-seg').hidden = touchOnly;
  $('#pad-hint').textContent = touchOnly ? L('hintTouch') : S.prefs.drawMode === 'click' ? L('hintClick') : L('hintDrag');
}

function onPadChange({ count, writing, sticky }: PadState): void {
  $('#pad-hint').hidden = count > 0 || writing;
  $('#pen-status').classList.toggle('on', sticky);
  $('#pad-wrap').classList.toggle('writing', writing);
  $<HTMLButtonElement>('#undo').disabled = $<HTMLButtonElement>('#clear').disabled = count === 0 && !writing;
  $<HTMLButtonElement>('#save').disabled = count === 0 || S.busy;
  if (S.kind !== 'sign' || count === S.padCount) return;
  S.padCount = count;
  if (count > 0) {
    // o desenho vai para o documento ao vivo: a prévia mostra sempre o que será assinado
    S.draftStrokes = pad.strokes();
    S.draftVersion++;
    if (S.selected?.type !== 'draft') select({ type: 'draft' }, { land: true });
    else {
      if (S.view && S.frame) S.frame = clampFrame(S.frame, currentAspect(), S.view);
      renderBox();
    }
  } else {
    S.draftStrokes = null;
    if (S.selected?.type === 'draft') select(S.lastSaved && byId(S.lastSaved) ? { type: 'saved', id: S.lastSaved } : null);
  }
}

async function savePad(): Promise<void> {
  pad.finishStroke();
  if (!pad.count() || S.busy || S.saving) return;
  S.saving = true;
  $<HTMLButtonElement>('#save').disabled = true;
  try {
    const meta = await S.t.call('save_signature', { label: $<HTMLInputElement>('#label').value.trim() || L('defaultLabel'), strokes: pad.strokes() });
    S.signatures = usable((await S.t.call('state')).signatures);
    if (S.kind === 'sign') {
      adoptSaved(meta.id);
      focusSig(meta.id);
      flash(L('savedToDoc', { label: meta.label }));
    } else {
      pad.clear();
      $<HTMLInputElement>('#label').value = '';
      buildVaultList();
      flash(L('savedToVault', { label: meta.label }));
    }
  } catch (e) {
    flash(errText(e), true);
  } finally {
    S.saving = false;
    $<HTMLButtonElement>('#save').disabled = pad.count() === 0;
  }
}

/** A assinatura recém-salva passa a ser a escolhida; o quadro fica livre para outra. */
function adoptSaved(id: string): void {
  S.selected = { type: 'saved', id }; // antes de limpar o quadro: nada de voltar para a anterior
  pad.clear();
  $<HTMLInputElement>('#label').value = '';
  buildList();
  select({ type: 'saved', id });
  togglePad(false);
}

const focusSig = (id: string) => document.querySelector<HTMLInputElement>(`#sig-list input[value="${CSS.escape(id)}"]`)?.focus();

let flashTimer: ReturnType<typeof setTimeout>;
let flashGen = 0;
function flash(text: string, isError = false): void {
  const el = $('#flash');
  if (!el) return;
  const gen = ++flashGen;
  el.className = `flash${isError ? ' error' : ''}`;
  el.innerHTML = `<span><span class="flash-row">${isError ? icons.alert(16) : icons.check(16)}<span>${esc(text)}</span></span></span>`;
  void el.offsetWidth; // reflow: a transição roda mesmo sem quadro de animação (aba em segundo plano)
  el.classList.add('show');
  clearTimeout(flashTimer);
  // Recolher sozinho empurraria o painel para cima no meio de um movimento, e o clique cairia no lugar errado.
  // Passado o tempo, o aviso recolhe logo depois do próximo gesto da pessoa (clique ou tecla).
  flashTimer = setTimeout(
    () => {
      const collapse = (e: Event) => {
        // no quadro de desenho, não: recolher moveria o quadro sob a caneta (no "clique para escrever", ela segue abaixada)
        if (e.type === 'pointerup' && (e.target as Element | null)?.closest?.('#pad-wrap')) return;
        window.removeEventListener('pointerup', collapse, true);
        window.removeEventListener('keyup', collapse, true);
        setTimeout(() => gen === flashGen && el.classList.remove('show')); // depois de o clique chegar ao alvo
      };
      window.addEventListener('pointerup', collapse, true);
      window.addEventListener('keyup', collapse, true);
    },
    isError ? 8000 : 5000,
  );
}

// ---------------------------------------------------------------- apagar do cofre
/** Troca a linha por uma confirmação; só apaga com o segundo clique. */
function askDelete(row: HTMLElement, s: UiSignature): void {
  row.classList.add('confirming');
  row.innerHTML = `
    <span class="confirm-text">${esc(L('deleteAsk', { label: s.label }))}</span>
    <button class="btn small danger" type="button" data-act="yes">${L('deleteYes')}</button>
    <button class="btn small ghost" type="button" data-act="no">${L('cancel')}</button>`;
  const rebuild = () => (S.kind === 'sign' ? buildList() : buildVaultList());
  const index = [...row.parentElement!.children].indexOf(row);
  // a linha é recriada: o foco vai para a linha na mesma posição (ou a de cima), senão para desenhar uma nova
  const refocus = (what: 'pick' | 'del') => {
    const rows = document.querySelectorAll<HTMLElement>('#sig-list .sig-row');
    const target = rows[Math.min(index, rows.length - 1)];
    const el = target ? $(what === 'pick' && S.kind === 'sign' ? 'input' : '.row-del', target) : $(S.kind === 'sign' ? '#new-sig' : '#pad');
    el?.focus();
  };
  $('[data-act="no"]', row).addEventListener('click', () => {
    rebuild();
    refocus('del');
  });
  $('[data-act="yes"]', row).addEventListener('click', async () => {
    try {
      await S.t.call('delete_signature', { id: s.id });
      S.signatures = S.signatures.filter((x) => x.id !== s.id);
      if (S.lastSaved === s.id) S.lastSaved = mostRecent(S.signatures)?.id ?? null;
      rebuild();
      if (S.kind === 'sign' && S.selected?.type === 'saved' && S.selected.id === s.id) select(S.lastSaved ? { type: 'saved', id: S.lastSaved } : null);
      refocus('pick');
      flash(L('deleted', { label: s.label }));
    } catch (e) {
      flash(errText(e), true);
      rebuild();
      refocus('del');
    }
  });
  $('[data-act="no"]', row).focus();
}

// ---------------------------------------------------------------- sessão "sign"
const docTitle = () => (S.doc?.name ? L('titleSign', { name: `<b>${esc(S.doc.name)}</b>` }) : L('titleSignNoDoc'));
/** Pasta de saída como o servidor a descreve ("~/Downloads"); o caminho completo é o plano B. */
const folderLabel = () => S.doc?.outputDirLabel || S.doc?.outputDir || '';

function signShell(): string {
  const mb = Math.round((S.doc?.maxBytes ?? 30 * 1024 * 1024) / 1024 / 1024);
  return `
  ${topbar(docTitle(), L('statusPending'))}
  <div class="workspace">
    <section class="desk" id="desk" aria-label="${L('titleSignNoDoc')}">
      <div class="notices" id="notices" hidden></div>
      <div class="dropzone" id="dropzone" hidden>
        <span class="dz-icon">${icons.file(26)}</span>
        <h2>${L('dzTitle')}</h2>
        <p>${L('dzText')}</p>
        <label class="btn primary file-btn"><input type="file" id="file-input" accept="application/pdf,.pdf">${L('dzChoose')}</label>
        <p class="dz-note">${esc(L('dzNote', { mb, folder: folderLabel() }))}</p>
        <p class="dz-status" id="dz-status" role="status"></p>
      </div>
      <div class="stage" id="stage">
        <div class="page" id="page">
          <div class="skeleton" aria-hidden="true">${'<i></i>'.repeat(16)}</div>
          <canvas id="page-canvas" role="img" aria-label="${L('loadingPage')}"></canvas>
          <div class="sig-box" id="sig-box" tabindex="0" role="group" aria-roledescription="${L('boxRole')}" hidden>
            <div class="art"></div>
            <span class="handle" aria-hidden="true"></span>
            <button class="box-remove" id="box-remove" type="button" aria-label="${L('boxRemove')}" title="${L('boxRemoveShort')}">${icons.x(13)}</button>
          </div>
        </div>
        <div class="pager" id="pager">
          <button class="icon-btn" id="prev" type="button" aria-label="${L('prevPage')}">${icons.chevronLeft(18)}</button>
          <span id="page-label" aria-live="polite"></span>
          <button class="icon-btn" id="next" type="button" aria-label="${L('nextPage')}">${icons.chevronRight(18)}</button>
          <button class="btn small" id="bring" type="button" hidden>${L('bringHere')}</button>
          <span class="drag-hint" id="drag-hint" hidden>${icons.move(15)}${L('dragHint')}</span>
        </div>
      </div>
    </section>
    <aside class="panel" aria-label="${L('groupSignature')}">
      <div class="panel-body" id="panel-body">
        <section class="group" aria-labelledby="sig-label">
          <div class="group-head"><p class="group-label" id="sig-label">${L('groupSignature')}</p></div>
          <p class="flash" id="flash" role="status"></p>
          <div class="sig-list" id="sig-list" role="radiogroup" aria-labelledby="sig-label"></div>
          <button class="btn new-sig" id="new-sig" type="button" aria-controls="drawer">${icons.plus(16)}${L('newSignature')}</button>
          ${drawerHtml()}
        </section>
        ${inkHtml()}
      </div>
      <footer class="panel-foot" id="panel-foot">
        <p class="error" id="error" role="alert" hidden></p>
        <p class="foot-note" id="foot-note"></p>
        <div class="foot-actions">
          <button class="btn ghost" id="cancel" type="button">${L('cancel')}</button>
          <button class="btn primary" id="confirm" type="button">${L('signDocument')}</button>
        </div>
      </footer>
    </aside>
  </div>`;
}

async function mountSign(st: any): Promise<void> {
  document.title = S.doc?.name ? L('tabSign', { name: S.doc.name }) : L('tabSignNoDoc');
  $app.innerHTML = signShell();
  S.awaiting = Boolean(S.doc?.awaiting);
  S.frame = S.awaiting || !S.doc?.placements ? null : frameFromPlacement(S.doc.placements[0]);
  S.page = S.frame?.pageIndex ?? 0;
  const pick = mostRecent(S.signatures);
  S.selected = pick ? { type: 'saved', id: pick.id } : null;
  S.lastSaved = pick?.id ?? null;
  mountPad();
  mountInk();
  buildList();
  togglePad(!pick, { focus: false });
  $('#new-sig').addEventListener('click', () => togglePad(!S.padOpen));
  renderNotices();
  renderFoot();
  wireSign();
  if (st.status !== 'pending') {
    S.frame = null; // a posição final não é conhecida aqui: melhor não sugerir nenhuma
    showClosedFromState(st);
    if (S.awaiting) return void ($('#stage').hidden = true); // encerrado sem nunca ter recebido o PDF: não há prévia a tentar
  }
  if (S.awaiting) return mountDropzone();
  await loadPreview();
}

// ---------------------------------------------------------------- PDF enviado pela própria tela
function mountDropzone(): void {
  const dz = $('#dropzone');
  dz.hidden = false;
  $('#stage').hidden = true;
  const input = $<HTMLInputElement>('#file-input');
  const status = (text: string, isError = false) => {
    const el = $('#dz-status');
    el.textContent = text;
    el.classList.toggle('error', isError);
  };
  const take = async (file: File | undefined | null) => {
    if (!file || S.uploading || !canDrop()) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) return status(L('dzNotPdf'), true);
    if (!file.size) return status(L('err.UPLOAD_EMPTY'), true);
    const max = S.doc?.maxBytes ?? 30 * 1024 * 1024;
    if (file.size > max) return status(L('dzTooBig', { mb: Math.round(max / 1024 / 1024) }), true);
    S.uploading = true;
    dz.classList.add('busy');
    status(L('dzUploading', { name: file.name }));
    try {
      await S.t.upload(file, (p) => status(L('dzUploadingPct', { name: file.name, pct: Math.round(p * 100) })));
      const st = await S.t.call('state');
      S.doc = st.document;
      S.awaiting = false;
      S.frame = frameFromPlacement(S.doc!.placements![0]);
      S.page = S.frame.pageIndex;
      document.title = L('tabSign', { name: S.doc!.name! });
      $('.docname').innerHTML = docTitle();
      dz.hidden = true;
      $('#stage').hidden = false;
      renderNotices();
      renderFoot();
      await loadPreview();
    } catch (e) {
      if (e instanceof UiError && e.code === 'SESSION_CLOSED') {
        // o pedido acabou enquanto a tela esperava o PDF
        S.status = 'closed';
        setStatus(L('statusClosed'));
        showClosed(L('closedTitle'), L('closedText'), { focus: true });
      } else status(errText(e), true);
    } finally {
      S.uploading = false;
      dz.classList.remove('busy');
      input.value = '';
    }
  };
  input.addEventListener('change', () => take(input.files?.[0]));
  // soltar funciona em qualquer ponto da tela (o preventDefault geral está em main)
  addEventListener('dragover', (e) => canDrop() && hasFiles(e) && dz.classList.add('over'));
  addEventListener('dragleave', (e) => !e.relatedTarget && dz.classList.remove('over')); // saiu da janela
  addEventListener('drop', (e) => {
    dz.classList.remove('over');
    if (hasFiles(e)) take(e.dataTransfer!.files[0]);
  });
}

/** Só aceita PDF enquanto o pedido espera por um. */
const canDrop = () => S.awaiting && !S.locked && S.status === 'pending';
const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));

function buildList(): void {
  const el = $('#sig-list');
  if (!S.signatures.length) {
    el.innerHTML = `<p class="empty">${L('listEmpty')}</p>`;
    return;
  }
  el.innerHTML = S.signatures
    .map(
      (s) => `
      <div class="sig-row" data-id="${esc(s.id)}">
        <label class="pick">
          <input type="radio" name="sig" value="${esc(s.id)}">
          <span class="radio" aria-hidden="true"></span>
          <span class="thumb">${rendered(s.strokes, s.id).svg}</span>
          <span class="sig-text"><span class="name">${esc(s.label)}</span><span class="meta"></span></span>
        </label>
        <button class="row-del" type="button" aria-label="${esc(L('deleteAria', { label: s.label }))}" title="${L('deleteTitle')}">${icons.trash(16)}</button>
      </div>`,
    )
    .join('');
  for (const row of el.querySelectorAll<HTMLElement>('.sig-row')) {
    const s = byId(row.dataset.id!)!;
    $('input', row).addEventListener('change', () => select({ type: 'saved', id: s.id }, { land: true }));
    $('.row-del', row).addEventListener('click', () => askDelete(row, s));
  }
  syncList();
}

/** Atualiza a seleção sem recriar as linhas (o foco do teclado fica onde está). */
function syncList(): void {
  const sel = S.selected?.type === 'saved' ? S.selected.id : null;
  for (const input of document.querySelectorAll<HTMLInputElement>('#sig-list input[name="sig"]')) {
    input.checked = input.value === sel;
    $('.meta', input.closest('.sig-row')!).textContent = input.value === sel ? L('onDocument') : rowMeta(byId(input.value)!);
  }
}

function togglePad(open: boolean, { focus = true } = {}): void {
  S.padOpen = open;
  $('#drawer').hidden = !open;
  $('#new-sig').setAttribute('aria-expanded', String(open));
  if (!open) return pad?.finishStroke();
  if (focus)
    requestAnimationFrame(() => {
      $('#drawer').scrollIntoView({ block: 'nearest', behavior: smooth() });
      $('#pad').focus({ preventScroll: true });
    });
}

function select(sel: Selection, { land = false } = {}): void {
  S.selected = sel;
  if (sel?.type === 'saved') S.lastSaved = sel.id;
  syncList();
  $('#draft-badge').hidden = sel?.type !== 'draft';
  if (S.view && S.frame) S.frame = clampFrame(S.frame, currentAspect(), S.view);
  renderBox({ land });
  renderFoot();
  hideError();
}

function renderNotices(errorText?: string): void {
  const items: [string, string, string][] = [];
  if (errorText) items.push(['error', icons.alert(17), esc(errorText)]);
  const a = S.doc?.anchor;
  if (a && !a.found) items.push(['warn', icons.alert(17), `${a.text ? esc(L('anchorMissing', { text: a.text })) : ''}${esc(L('anchorFallback'))}`]);
  if (S.doc?.hasDigitalSignature) items.push(['info', icons.shield(17), esc(L('hasDigitalSignature'))]);
  const el = $('#notices');
  el.innerHTML = items.map(([cls, icon, text]) => `<div class="notice ${cls}">${icon}<span>${text}</span></div>`).join('');
  el.hidden = !items.length;
}

const pageCssWidth = () => Math.floor(Math.min($('#stage').clientWidth, 760));

async function loadPreview(): Promise<void> {
  const pageEl = $('#page');
  const w = pageCssWidth();
  pageEl.style.width = `${w}px`;
  pageEl.style.height = `${(w * 841.89) / 595.28}px`; // A4 provisório enquanto carrega
  try {
    // já assinado (a tela foi recarregada): a prévia é o arquivo assinado, não o original
    const doc = await openPdf(await (S.status === 'signed' ? S.t.readSigned() : S.t.readDocument()));
    S.pdf = createPageRenderer(doc, $<HTMLCanvasElement>('#page-canvas'));
    S.pageCount = doc.numPages;
    S.page = clamp(S.page, 0, S.pageCount - 1);
    if (!(await renderPage())) return;
    if (S.frame && S.view) S.frame = clampFrame(S.frame, currentAspect(), S.view);
    renderBox({ land: Boolean(currentSig()) });
    if (isWide() && S.frame) $('#sig-box').scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch (e) {
    console.error(e);
    S.previewFailed = true;
    pageEl.classList.add('failed');
    renderNotices(L('previewFailed', { detail: (e as Error)?.message ?? String(e) }));
    renderFoot();
  }
}

async function renderPage(): Promise<boolean> {
  const size = await S.pdf!.size(S.page);
  const w = pageCssWidth();
  const pageEl = $('#page');
  pageEl.style.width = `${w}px`;
  pageEl.style.height = `${(w * size.height) / size.width}px`;
  const view = await S.pdf!.render(S.page, w);
  if (!view) return false;
  S.view = view;
  S.pageWidth = w;
  pageEl.classList.add('ready');
  $('#page-canvas').setAttribute('aria-label', L('pageAria', { page: S.page + 1, total: S.pageCount, name: S.doc?.name ?? '' }));
  renderPager();
  return true;
}

function renderBox({ land = false } = {}): void {
  const box = $('#sig-box');
  if (!box) return;
  if (!S.view || !S.frame || S.frame.pageIndex !== S.page) {
    box.hidden = true;
    return renderPager();
  }
  const cur = currentSig();
  const b = boxInFrame(S.frame, cur?.aspect ?? placeholderAspect());
  const k = S.view.scale;
  box.hidden = false;
  box.style.left = `${b.x * k}px`;
  box.style.top = `${b.y * k}px`;
  box.style.width = `${b.width * k}px`;
  box.style.height = `${b.height * k}px`;
  // posição em pontos PDF, exposta para os testes de ponta a ponta
  Object.assign(box.dataset, { page: String(b.pageIndex), x: b.x.toFixed(2), y: b.y.toFixed(2), w: b.width.toFixed(2), h: b.height.toFixed(2) });
  box.classList.toggle('placeholder', !cur);
  box.classList.toggle('locked', S.locked);
  box.tabIndex = S.locked ? -1 : 0;
  const artEl = $('.art', box);
  const key = cur ? cur.key : 'placeholder';
  if (artEl.dataset.key !== key || land) {
    artEl.dataset.key = key;
    artEl.innerHTML = cur ? cur.svg : `<span>${L('boxPlaceholder')}</span>`;
    if (land && cur) {
      artEl.classList.remove('landing');
      void artEl.offsetWidth; // reinicia a animação
      artEl.classList.add('landing');
    }
  }
  box.setAttribute('aria-label', cur ? L('boxAria', { label: cur.label, page: b.pageIndex + 1 }) : L('boxAriaEmpty', { page: b.pageIndex + 1 }));
  renderPager();
}

function renderPager(): void {
  if (!$('#pager')) return;
  const n = S.pageCount;
  const elsewhere = Boolean(S.frame) && S.frame!.pageIndex !== S.page;
  $('#prev').hidden = $('#next').hidden = $('#page-label').hidden = n <= 1;
  $<HTMLButtonElement>('#prev').disabled = S.page <= 0;
  $<HTMLButtonElement>('#next').disabled = S.page >= n - 1;
  // região viva: só reescreve quando o texto muda (arrastar chama isto a cada movimento)
  const label = L('pageOf', { page: S.page + 1, total: n }) + (elsewhere ? L('sigElsewhere', { page: S.frame!.pageIndex + 1 }) : '');
  if ($('#page-label').textContent !== label) $('#page-label').textContent = label;
  $('#bring').hidden = !elsewhere || S.locked || S.busy || !S.view;
  $('#drag-hint').hidden = elsewhere || S.locked || !S.view || !S.frame || !currentSig();
}

async function goPage(i: number): Promise<void> {
  if (!S.pdf || i < 0 || i >= S.pageCount) return;
  S.page = i;
  if (await renderPage()) renderBox();
}

function bringHere(): void {
  if (!S.frame || !S.view) return;
  S.frame = clampFrame({ ...S.frame, pageIndex: S.page }, currentAspect(), S.view);
  renderBox({ land: true });
}

function wireBox(box: HTMLElement): void {
  let drag: { id: number; x: number; y: number; frame: Frame; box: ReturnType<typeof boxInFrame>; aspect: number; resize: boolean } | null = null;
  box.addEventListener('pointerdown', (e) => {
    if (S.locked || e.button !== 0 || !S.view || !S.frame || (e.target as Element).closest('.box-remove')) return;
    e.preventDefault();
    box.focus({ preventScroll: true });
    box.setPointerCapture(e.pointerId);
    const aspect = currentAspect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, frame: { ...S.frame }, box: boxInFrame(S.frame, aspect), aspect, resize: Boolean((e.target as Element).closest('.handle')) };
    box.classList.add(drag.resize ? 'resizing' : 'dragging');
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !S.view) return;
    if (e.buttons === 0) return stop(e); // o botão foi solto sem o pointerup chegar aqui
    const k = S.view.scale;
    const dx = (e.clientX - drag.x) / k;
    const dy = (e.clientY - drag.y) / k;
    if (drag.resize) {
      const a = drag.aspect;
      const maxW = Math.min(S.view.width - drag.box.x, (S.view.height - drag.box.y) / a);
      // projeta o movimento na diagonal da caixa: crescer e encolher respondem igual
      const w = clamp(drag.box.width + (dx + dy * a) / (1 + a * a), MIN_WIDTH, Math.max(MIN_WIDTH, maxW));
      S.frame = resizeFrame(drag.frame, a, w);
    } else {
      S.frame = clampFrame({ ...drag.frame, x: drag.frame.x + dx, y: drag.frame.y + dy }, drag.aspect, S.view);
    }
    renderBox();
  });
  const stop = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    box.classList.remove('dragging', 'resizing');
  };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);
  box.addEventListener('lostpointercapture', stop);
  box.addEventListener('keydown', (e) => {
    if (S.locked || !S.view || !S.frame || e.target !== box) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && currentSig()) {
      e.preventDefault();
      return removeFromDocument();
    }
    const a = currentAspect();
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    let f: Frame | null = null;
    if (moves[e.key]) f = { ...S.frame, x: S.frame.x + moves[e.key][0], y: S.frame.y + moves[e.key][1] };
    else if (e.key === '+' || e.key === '=') f = scaleFrame(S.frame, 1.05);
    else if (e.key === '-' || e.key === '_') f = scaleFrame(S.frame, 1 / 1.05);
    if (!f) return;
    e.preventDefault();
    const b = boxInFrame(f, a);
    if (b.width < MIN_WIDTH || b.width > S.view.width || b.height > S.view.height) return;
    S.frame = clampFrame(f, a, S.view);
    renderBox();
  });
  $('#box-remove').addEventListener('click', removeFromDocument);
}

/** Tira a assinatura do documento. Não apaga nada: nem do cofre, nem o desenho no quadro. */
function removeFromDocument(): void {
  select(null);
  $('#sig-box').focus({ preventScroll: true });
}

function wireSign(): void {
  $('#confirm').addEventListener('click', confirmSign);
  $('#cancel').addEventListener('click', cancelSign);
  $('#prev').addEventListener('click', () => goPage(S.page - 1));
  $('#next').addEventListener('click', () => goPage(S.page + 1));
  $('#bring').addEventListener('click', bringHere);
  wireBox($('#sig-box'));
  let timer: ReturnType<typeof setTimeout>;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      // só a altura mudou (iframe do chat se ajustando, barra de endereço do celular): a página continua igual
      if (!S.pdf || pageCssWidth() === S.pageWidth || !(await renderPage())) return;
      renderBox();
      const box = $('#sig-box');
      if (isWide() && !box.hidden) box.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // não deixa a assinatura sumir ao mudar o layout
    }, 120);
  });
}

function renderFoot(): void {
  const btn = $<HTMLButtonElement>('#confirm');
  if (!btn) return;
  const cur = currentSig();
  btn.disabled = !cur || S.busy || S.previewFailed || !S.frame || S.awaiting;
  $('#foot-note').innerHTML = S.awaiting
    ? esc(L('noteAwaiting'))
    : S.previewFailed
      ? esc(L('notePreviewFailed'))
      : cur
        ? L(S.doc?.uploaded ? 'noteUploaded' : 'noteNextTo', { name: esc(S.doc?.outputName ?? ''), folder: esc(folderLabel()) })
        : esc(L('notePick'));
}

function setBusy(on: boolean): void {
  S.busy = on;
  $('#confirm').innerHTML = on ? `<span class="spin" aria-hidden="true"></span>${L('signing')}` : L('signDocument');
  $<HTMLButtonElement>('#cancel').disabled = on;
  document.body.classList.toggle('busy', on);
  // durante a assinatura, trocar assinatura, tinta ou posição faria a prévia diferir do PDF
  $('.panel').inert = on;
  $('#sig-box').inert = on;
  renderFoot();
  renderPager();
}

function showError(text: string): void {
  const el = $('#error');
  el.innerHTML = `${icons.alert(16)}<span>${esc(text)}</span>`;
  el.hidden = false;
}
function hideError(): void {
  const el = $('#error');
  if (el) el.hidden = true;
}

async function confirmSign(): Promise<void> {
  const cur = currentSig();
  if (!cur || S.busy || S.saving || !S.frame) return;
  pad.finishStroke();
  hideError();
  setBusy(true);
  try {
    let id = S.selected?.type === 'saved' ? S.selected.id : null;
    if (!id) {
      // desenho novo, ainda não salvo: entra no cofre agora (como no iPhone)
      const strokes = pad.strokes();
      const meta = await S.t.call('save_signature', { label: $<HTMLInputElement>('#label').value.trim() || L('defaultLabel'), strokes });
      id = meta.id as string;
      // já está no cofre: se a confirmação falhar, tentar de novo usa esta, sem salvar outra cópia
      S.signatures = [...S.signatures, { ...meta, lastUsedAt: null, strokes }];
      adoptSaved(id);
    }
    const b = boxInFrame(S.frame, currentAspect());
    const r = await S.t.call('confirm', { signatureId: id, placements: [{ pageIndex: b.pageIndex, x: b.x, y: b.y, width: b.width }], ink: S.prefs.ink, pen: S.prefs.pen });
    S.t.notifyModel(`The user signed the document in labsign. Signed file: ${r.signed_file}`).catch(() => {});
    setBusy(false); // tira o inert: o painel vira "enviar ou guardar"
    showSigned(r, { focus: true });
  } catch (e) {
    setBusy(false);
    showError(errText(e, 'signFailed'));
    $('#confirm').focus();
  }
}

async function cancelSign(): Promise<void> {
  if (S.busy) return;
  await S.t.call('cancel').catch(() => {});
  S.t.notifyModel('The user cancelled the signing in labsign.').catch(() => {});
  S.status = 'cancelled';
  setStatus(L('statusCancelled'));
  showClosed(L('cancelledTitle'), `${L('cancelledText')} ${S.t.embedded ? L('backToChat') : L('canCloseTab')}`, { focus: true });
}

function setStatus(text: string, done = false): void {
  const el = $('#status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('done', done);
}

function lockPreview(): void {
  S.locked = true;
  $('#dropzone').hidden = true; // pedido encerrado: não aceita mais PDF
  renderBox();
  renderPager();
  $('#panel-foot').hidden = true;
}

/** Leva o foco ao título da tela nova (só depois de um gesto da pessoa, não ao abrir a página). */
const focusHeading = (focus: boolean) => focus && $('#done-title')?.focus();

function showClosed(title: string, text: string, { focus = false } = {}): void {
  lockPreview();
  $('#panel-body').innerHTML = `
    <div class="done-head"><span class="done-mark neutral">${icons.x(20)}</span><div><h2 id="done-title" tabindex="-1">${esc(title)}</h2><p>${esc(text)}</p></div></div>`;
  focusHeading(focus);
}

function showClosedFromState(st: any): void {
  if (st.status === 'signed' && st.result?.signed_file) return showSigned(st.result);
  setStatus(st.status === 'expired' ? L('statusExpired') : L('statusClosed'));
  showClosed(st.status === 'expired' ? L('expiredTitle') : L('closedTitle'), L('closedText'));
}

// ---------------------------------------------------------------- depois de assinar: enviar ou guardar
function showSigned(r: any, { focus = false } = {}): void {
  S.status = 'signed';
  setStatus(L('statusSigned'), true);
  lockPreview();
  const name = String(r.signed_file).split(/[\\/]/).pop()!;
  $('#panel-body').innerHTML = `
    <div class="done-head">
      <span class="done-mark">${icons.check(20)}</span>
      <div><h2 id="done-title" tabindex="-1">${L('doneTitle')}</h2><p>${L(S.doc?.uploaded ? 'doneUploaded' : 'doneNextTo', { name: esc(name), folder: esc(folderLabel()) })}</p></div>
    </div>
    <p class="path">${esc(r.signed_file)}</p>
    <section class="group" aria-labelledby="send-label">
      <div class="group-head"><p class="group-label" id="send-label">${L('groupSend')}</p></div>
      <p class="flash" id="flash" role="status"></p>
      <div class="actions" id="actions"></div>
    </section>`;
  buildDelivery(name, r.signed_file);
  focusHeading(focus);
}

const actionBtn = (id: string, icon: string, title: string, sub: string, expandable = false) => `
  <button class="action" id="${id}" type="button"${expandable ? ` aria-expanded="false" aria-controls="${id}-form"` : ''}>
    ${icon}<span><span class="a-title">${title}</span><span class="a-sub">${sub}</span></span>${expandable ? icons.chevronDown(16).replace('class="icon"', 'class="icon chev"') : '<span></span>'}
  </button>`;

/** Servidor já encerrado (terminal fechado, por exemplo): diga onde está o arquivo, não "Failed to fetch". */
const deliveryError = (e: unknown, path: string) => (isConnectionLost(e) ? L('flashServerGone', { path }) : errText(e));

async function buildDelivery(name: string, path: string): Promise<void> {
  const docName = S.doc?.name ?? name;
  const canDownload = S.t.canDownload;
  // PDF solto na tela: a cópia assinada já está na pasta de saída; e-mail e WhatsApp não baixam outra
  const downloadWithSend = canDownload && !S.doc?.uploaded;
  $('#actions').innerHTML = `
    ${canDownload ? actionBtn('act-download', icons.download(18), L('actDownload'), L('actDownloadSub')) : ''}
    ${actionBtn('act-share', icons.share(18), L('actShare'), L('actShareSub'))}
    ${actionBtn('act-mail', icons.mail(18), L('actMail'), L('actMailSub'), true)}
    <form class="send-form" id="act-mail-form" hidden novalidate>
      <label class="field"><span>${L('mailTo')}</span><input type="email" id="mail-to" placeholder="${L('mailToPlaceholder')}" autocomplete="email"></label>
      <label class="field"><span>${L('mailSubject')}</span><input type="text" id="mail-subject" value="${esc(L('mailSubjectDefault', { name: docName }))}"></label>
      <label class="field"><span>${L('mailBody')}</span><textarea id="mail-body" rows="4">${esc(L('mailBodyDefault', { name: docName }))}</textarea></label>
      <div class="form-buttons">
        <button class="btn primary small" type="button" id="mail-gmail">${L('mailGmail')}</button>
        <button class="btn small" type="button" id="mail-app">${L('mailOther')}</button>
      </div>
      <p class="form-note">${downloadWithSend ? L('noteAttachDownloaded') : L('noteAttachFromFolder')}</p>
    </form>
    ${actionBtn('act-wa', icons.chat(18), L('actWhatsapp'), L('actWhatsappSub'), true)}
    <form class="send-form" id="act-wa-form" hidden novalidate>
      <label class="field"><span>${L('waNumber')}</span><input type="tel" id="wa-number" placeholder="${L('waNumberPlaceholder')}" autocomplete="tel"></label>
      <label class="field"><span>${L('waText')}</span><textarea id="wa-text" rows="3">${esc(L('waTextDefault', { name: docName }))}</textarea></label>
      <div class="form-buttons"><button class="btn primary small" type="button" id="wa-open">${L('waOpen')}</button></div>
      <p class="form-note">${downloadWithSend ? L('noteWaDownloaded') : L('noteWaFromFolder')}</p>
    </form>
    ${actionBtn('act-folder', icons.folder(18), L('actFolder'), L('actFolderSub'))}`;

  $('#act-share').hidden = true; // só aparece se o navegador souber compartilhar arquivos
  // Enter num campo não pode "enviar" o formulário (recarregaria a página e perderia a tela)
  for (const form of document.querySelectorAll('.send-form')) form.addEventListener('submit', (e) => e.preventDefault());
  const expander = (id: string) =>
    $(`#${id}`).addEventListener('click', () => {
      const btn = $(`#${id}`);
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      $(`#${id}-form`).hidden = !open;
      if (open) $<HTMLInputElement>(`#${id}-form input`)?.focus();
    });
  expander('act-mail');
  expander('act-wa');

  // o arquivo assinado fica pronto em memória: baixar e compartilhar respondem no mesmo clique
  let file: File | null = null;
  try {
    const bytes = await S.t.readSigned();
    file = new File([bytes as BlobPart], name, { type: 'application/pdf' });
  } catch (e) {
    console.error(e);
  }
  const shareOk = Boolean(file && navigator.canShare?.({ files: [file] }));
  $('#act-share').hidden = !shareOk;

  let downloaded = false; // uma cópia por tela: cliques seguidos não enchem a pasta de downloads
  const download = async (): Promise<boolean> => {
    if (downloaded) return true;
    if (!file) {
      if (canDownload) flash(L('flashDownloadFailed', { path }), true);
      return false;
    }
    if (!canDownload) return false;
    try {
      await S.t.download(new Uint8Array(await file.arrayBuffer()), name);
      return (downloaded = true);
    } catch (e) {
      flash(errText(e), true);
      return false;
    }
  };
  $('#act-download')?.addEventListener('click', async () => {
    if (await download()) flash(L('flashDownloaded', { name }));
  });
  $('#act-share').addEventListener('click', async () => {
    try {
      await navigator.share({ files: [file!], title: name, text: L('shareText', { name: docName }) });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') flash(L('flashShareUnavailable'), true);
    }
  });
  const open = async (url: string) => {
    try {
      await S.t.openLink(url);
    } catch (e) {
      flash(errText(e), true);
    }
  };
  const mail = () => ({
    to: $<HTMLInputElement>('#mail-to').value.trim().replace(/\s+/g, ''),
    su: $<HTMLInputElement>('#mail-subject').value,
    body: $<HTMLTextAreaElement>('#mail-body').value,
  });
  $('#mail-gmail').addEventListener('click', async () => {
    const m = mail();
    if (downloadWithSend) await download();
    open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(m.to)}&su=${encodeURIComponent(m.su)}&body=${encodeURIComponent(m.body)}`);
  });
  $('#mail-app').addEventListener('click', async () => {
    const m = mail();
    if (downloadWithSend) await download();
    const to = m.to.replace(/[^\w.@+,-]/g, encodeURIComponent);
    open(`mailto:${to}?subject=${encodeURIComponent(m.su)}&body=${encodeURIComponent(m.body)}`);
  });
  $('#wa-open').addEventListener('click', async () => {
    let digits = $<HTMLInputElement>('#wa-number').value.replace(/\D/g, '');
    if (lang === 'pt' && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`; // número brasileiro sem o código do país
    if (downloadWithSend) await download();
    open(`https://wa.me/${digits}?text=${encodeURIComponent($<HTMLTextAreaElement>('#wa-text').value)}`);
  });
  $('#act-folder').addEventListener('click', async () => {
    try {
      const res = await S.t.call('reveal');
      flash(res.revealed ? L('flashFolderOpened') : L('flashFileAt', { path: res.file }));
    } catch (e) {
      flash(deliveryError(e, path), true);
    }
  });
}

// ---------------------------------------------------------------- sessão "pad" (cofre)
function mountVault(): void {
  document.title = L('tabVault');
  $app.innerHTML = `
    ${topbar(L('titleVault'))}
    <main class="vault-main">
      <h1>${L('vaultTitle')}</h1>
      <p class="sub">${L('vaultSub')}</p>
      <section class="group" aria-labelledby="list-label">
        <div class="group-head"><p class="group-label" id="list-label">${L('groupSaved')}</p></div>
        <p class="flash" id="flash" role="status"></p>
        <div class="sig-list static" id="sig-list"></div>
      </section>
      <section class="group" aria-labelledby="new-label">
        <div class="group-head"><p class="group-label" id="new-label">${L('groupNew')}</p></div>
        ${drawerHtml()}
      </section>
      ${inkHtml()}
      <footer class="vault-foot" id="panel-foot"><button class="btn" id="finish" type="button">${L('vaultDone')}</button></footer>
    </main>`;
  mountPad();
  mountInk();
  buildVaultList();
  $('#save').classList.add('primary'); // no cofre a ação principal é salvar; "Concluir" só encerra
  $('#finish').addEventListener('click', finishVault);
}

function buildVaultList(): void {
  const el = $('#sig-list');
  if (!S.signatures.length) {
    el.innerHTML = `<p class="empty">${L('vaultEmpty')}</p>`;
    return;
  }
  el.innerHTML = S.signatures
    .map(
      (s) => `
      <div class="sig-row" data-id="${esc(s.id)}">
        <span class="thumb">${rendered(s.strokes, s.id).svg}</span>
        <span class="sig-text"><span class="name">${esc(s.label)}</span><span class="meta">${esc(rowMeta(s))}</span></span>
        <button class="row-del" type="button" aria-label="${esc(L('deleteAria', { label: s.label }))}" title="${L('deleteTitle')}">${icons.trash(16)}</button>
      </div>`,
    )
    .join('');
  for (const row of el.querySelectorAll<HTMLElement>('.sig-row')) $('.row-del', row).addEventListener('click', () => askDelete(row, byId(row.dataset.id!)!));
}

async function finishVault(): Promise<void> {
  pad.finishStroke();
  await S.t.call('finish').catch(() => {});
  $('.vault-main').innerHTML = `
    <div class="done-head">
      <span class="done-mark">${icons.check(20)}</span>
      <div><h2 id="done-title" tabindex="-1">${L('vaultDoneTitle')}</h2><p>${S.signatures.length ? L('vaultDoneText') : L('vaultDoneNone')} ${S.t.embedded ? L('backToChat') : L('canCloseTab')}</p></div>
    </div>`;
  focusHeading(true);
}

// ---------------------------------------------------------------- início
async function main(): Promise<void> {
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  const transport = await makeTransport();
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en'; // o app de chat pode ter informado o idioma
  const st = await transport.call('state');
  Object.assign(S, { t: transport, kind: st.kind, status: st.status, doc: st.document, prefs: { ...S.prefs, ...(st.prefs ?? {}) } });
  S.signatures = usable(st.signatures); // depois das preferências: o filtro desenha com a tinta atual
  document.body.classList.toggle('embedded', transport.embedded);
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
