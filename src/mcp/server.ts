// Servidor MCP (stdio). Escolhe o caminho da tela pelas capacidades que o app de chat declara:
//   1) MCP Apps            -> tela embutida na conversa
//   2) elicitação por URL  -> o app pede para abrir o navegador
//   3) senão               -> o próprio servidor abre o navegador
// Em todos os casos a URL local volta no resultado, e a espera é LIMITADA (o Codex corta em 60 s).
// Textos para o modelo em inglês; a tela fala a língua da pessoa.
import { readFileSync, appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppTool, registerAppResource, getUiCapability, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { ensureHttp, sessionUrl, publicUrl, openInBrowser, uiFile } from '../http/server.ts';
import {
  createSession,
  readPdf,
  prepareSignSession,
  createAwaitingSignSession,
  getSession,
  waitForSession,
  publicState,
  sameToken,
  uiState,
  uiSaveSignature,
  uiDeleteSignature,
  uiSetPrefs,
  uiDocumentChunk,
  uiUploadChunk,
  uiSignedChunk,
  uiReveal,
  uiConfirm,
  uiCancel,
  uiFinish,
  type Session,
} from '../core/sessions.ts';
import { listSignatures } from '../core/vault.ts';
import { locateSignatureSpot, assertPdfReadable } from '../core/anchors.ts';
import { errorPayload, LabsignError } from '../core/errors.ts';
import { VERSION } from '../version.ts';

const WAIT_MS = Number(process.env.LABSIGN_WAIT_MS || 45000); // abaixo dos 60 s do Codex
const FORCE_UI = process.env.LABSIGN_UI || 'auto'; // auto | browser | inline
const UI_URI = 'ui://labsign/sign.html';

const log = (...a: unknown[]) => {
  console.error('[labsign]', ...a); // stdout é do protocolo
  if (process.env.LABSIGN_LOG) appendFileSync(process.env.LABSIGN_LOG, `${new Date().toISOString()} ${a.join(' ')}\n`);
};

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };
const reply = (state: Record<string, unknown>, text: string): ToolResult => ({ content: [{ type: 'text', text }], structuredContent: state });

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'labsign', version: VERSION });
  const clientName = () => {
    const v = server.server.getClientVersion();
    return v ? `${v.name}@${v.version}` : 'unknown';
  };

  const placementSchema = z.object({
    page: z.number().int().min(1).describe('Page number (1 = first)'),
    x: z.number().describe('PDF points from the left edge of the displayed page'),
    y: z.number().describe('PDF points from the TOP of the displayed page'),
    width: z.number().min(20).max(600).default(170),
  });
  const signInput = z.object({
    file: z
      .string()
      .optional()
      .describe('ABSOLUTE path of the PDF on disk. If the user only attached the PDF in the conversation (you have no path), omit it: the labsign screen asks the user to drop or pick the file.'),
    anchor_text: z.string().max(200).optional().describe('Text of the user’s signature block, e.g. "CONTRATANTE" or "Signature". The signature goes on the line right above it.'),
    placement: placementSchema.optional().describe('Explicit starting position (the user can still move it); if omitted, anchor_text is used'),
  });

  /** Posição proposta. Sem âncora no PDF, propõe a última página: a pessoa ajusta arrastando. */
  async function openSignSession(args: z.infer<typeof signInput>): Promise<Session> {
    if (!args.file) return createAwaitingSignSession({ anchorText: args.anchor_text, client: clientName() });
    if (!isAbsolute(args.file)) throw new LabsignError('FILE_NOT_ABSOLUTE');
    if (args.placement) {
      const p = args.placement;
      const bytes = readPdf(args.file);
      await assertPdfReadable(bytes); // com senha ou danificado: erro claro agora, não na hora de confirmar
      return prepareSignSession({ file: args.file, bytes, placements: [{ pageIndex: p.page - 1, x: p.x, y: p.y, width: p.width }], anchor: null, client: clientName() });
    }
    const bytes = readPdf(args.file); // erros claros (arquivo sumiu, não é PDF) antes de procurar a âncora
    const { placement, anchor } = await locateSignatureSpot(bytes, args.anchor_text || 'CONTRATANTE');
    return prepareSignSession({ file: args.file, bytes, placements: [placement], anchor, client: clientName() });
  }

  const note = (s: Session) =>
    s.awaiting
      ? ' The screen is asking for the PDF: the user drops or picks the file there (it stays on this computer; the signed copy goes to Downloads).'
      : s.anchor && !s.anchor.found
        ? ` The text "${s.anchor.text}" was not found in the PDF: the signature was proposed on the last page and the user will drag it into place.`
        : '';

  const HANDS_OFF = 'Only the user signs: never open, fetch or call the local labsign page or its API yourself.';
  /** Não deu para abrir a tela por outro caminho: o link com token vai ao modelo, para a pessoa abrir. */
  const relayLink = (url: string) => `The browser could not be opened automatically. Give the user this link to open in their browser (it works in one browser only): ${url}. ${HANDS_OFF}`;

  /**
   * Caminho navegador: abre a tela fora do chat e espera um tempo limitado.
   * O link que abre a tela (com o token de uso único) vai pela elicitação ou direto ao navegador — o modelo
   * só recebe a URL sem token, que não abre nada fora do navegador da pessoa. Um agente com terminal não pode
   * usar o link para assinar sozinho.
   */
  async function browserFlow(session: Session, ctx: any, what: string): Promise<ToolResult> {
    await ensureHttp();
    const url = sessionUrl(session);
    const deadline = Date.now() + WAIT_MS; // a tool inteira cabe neste orçamento
    let opened = 'none';
    if (server.server.getClientCapabilities()?.elicitation?.url) {
      try {
        const r = await ctx.mcpReq.elicitInput({ mode: 'url', message: `labsign: open the local page to ${what}.`, url, elicitationId: session.id }, { timeout: Math.round(WAIT_MS * 0.4) });
        log(`URL elicitation answered: ${r?.action}`);
        if (r?.action === 'accept') opened = 'elicitation';
        else if (r?.action === 'decline' || r?.action === 'cancel') {
          uiCancel(session);
          return reply({ ...publicState(session), ui: 'elicitation' }, 'The user declined to open the labsign page. Nothing was changed.');
        }
      } catch (e) {
        log('URL elicitation failed, falling back to opening the browser:', (e as Error).message);
      }
    }
    if (opened === 'none' && (await openInBrowser(url))) opened = 'browser';
    log(`session ${session.id} opened via ${opened}`);
    const modelUrl = opened === 'none' ? url : publicUrl(session);
    const s = (await waitForSession(session.id, Math.max(0, deadline - Date.now())))!;
    const state = { ...publicState(s), ui: opened, url: modelUrl };
    if (s.status === 'signed')
      return reply(state, s.kind === 'sign' ? `The user signed the document. Signed file: ${s.result?.signed_file}` : `Signature "${s.result?.signature_label}" saved in the local vault.`);
    if (s.status === 'cancelled') return reply(state, 'The user cancelled or closed the page. Nothing was changed.');
    if (s.status === 'expired') return reply(state, 'The request expired without action from the user.');
    const where = opened === 'none' ? relayLink(url) : `The labsign page is open in the user's browser. ${HANDS_OFF}`;
    return reply(state, `Waiting for the user. ${where} Ask them to finish there, then call labsign_status with request_id="${s.id}" and wait_seconds=45.${note(s)}`);
  }

  /** Caminho embutido: devolve na hora; quem conclui é a tela. O token vai em _meta, fora do alcance do modelo. */
  async function inlineFlow(session: Session, what: string): Promise<ToolResult> {
    await ensureHttp();
    return {
      // o request_id também vai no texto: plano B para app de chat que perde o structuredContent
      content: [
        {
          type: 'text',
          text: `The labsign screen opened in the conversation to ${what}. The user finishes there; follow up with labsign_status (request_id="${session.id}"). If the user says the panel did not show up, call labsign_open_in_browser with this request_id. ${HANDS_OFF}${note(session)}`,
        },
      ],
      structuredContent: { ...publicState(session), ui: 'inline' },
      _meta: { labsign: { viewToken: session.viewToken } },
    };
  }

  // ---- tools que existem em qualquer app ------------------------------------------------
  server.registerTool(
    'labsign_status',
    {
      title: 'Signing request status',
      description: 'Checks a request opened by labsign_sign_document or labsign_manage_signatures. Use wait_seconds to wait for the user to finish instead of polling repeatedly.',
      inputSchema: z.object({ request_id: z.string(), wait_seconds: z.number().min(0).max(45).default(0).describe('Wait up to this long for a status change (max 45)') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ request_id, wait_seconds }) => {
      if (wait_seconds > 0) await waitForSession(request_id, Math.min(wait_seconds * 1000, WAIT_MS));
      const s = getSession(request_id);
      return reply(publicState(s), s ? `Request ${request_id}: ${s.status}${s.result?.signed_file ? ` → ${s.result.signed_file}` : ''}` : 'Unknown request (the server may have restarted).');
    },
  );

  server.registerTool(
    'labsign_open_in_browser',
    {
      title: 'Open the signing screen in the browser',
      description:
        'Opens the labsign screen of an open request in the user’s default browser — for when the panel inside the conversation did not show up, or the user closed the page. The user signs there.',
      inputSchema: z.object({ request_id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ request_id }) => {
      const s = getSession(request_id);
      if (!s) return reply(publicState(s), 'Unknown request (the server may have restarted). Start a new one.');
      if (s.status !== 'pending') return reply(publicState(s), `Request ${request_id} is already ${s.status}.`);
      await ensureHttp();
      // já aberta numa aba: não abre outra (um modelo em loop encheria o navegador de abas)
      if (s.openPages > 0) return reply({ ...publicState(s), ui: 'browser', url: publicUrl(s) }, `The labsign page is already open in the user's browser. ${HANDS_OFF} Ask the user to finish there, then call labsign_status.`);
      const url = sessionUrl(s);
      if (await openInBrowser(url))
        return reply({ ...publicState(s), ui: 'browser', url: publicUrl(s) }, `Opened the labsign page in the user's browser. ${HANDS_OFF} Then call labsign_status with request_id="${s.id}" and wait_seconds=45.`);
      return reply({ ...publicState(s), ui: 'none', url }, `${relayLink(url)} Then call labsign_status with request_id="${s.id}" and wait_seconds=45.`);
    },
  );

  server.registerTool(
    'labsign_list_signatures',
    {
      title: 'List saved signatures',
      description: 'Names of the signatures saved in the local vault. Never returns the drawing.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const list = listSignatures();
      return reply({ signatures: list }, list.length ? list.map((s) => `• ${s.label}`).join('\n') : 'No saved signatures yet.');
    },
  );

  // O recurso da tela é registrado sempre (inofensivo em apps sem MCP Apps).
  registerAppResource(server, 'labsign screen', UI_URI, { description: 'labsign signing screen' }, async () => ({
    contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: readFileSync(uiFile('ui-app.html'), 'utf8') }],
  }));

  // ---- tools que dependem do que o app suporta -------------------------------------------
  server.server.oninitialized = () => {
    const caps = server.server.getClientCapabilities();
    const ui = getUiCapability(caps);
    const inline = FORCE_UI === 'inline' || (FORCE_UI === 'auto' && Boolean(ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE)));
    log(`host=${clientName()} · ui=${inline ? 'inline (MCP Apps)' : 'browser'} · url-elicitation=${Boolean(caps?.elicitation?.url)}`);

    const signCfg = {
      title: 'Sign a PDF',
      description:
        'Opens the labsign screen so the USER can sign a PDF (contract, agreement, power of attorney…) with their own handwritten signature, drawn or saved. Use it when the user asks to sign a document — including a PDF only attached to the conversation, with no path on disk. Only the user completes it, on the screen; the original is never overwritten.',
      inputSchema: signInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    };
    const manageCfg = {
      title: 'Manage signatures',
      description: 'Opens the labsign screen so the user can draw, save and delete signatures in the local vault.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    };

    if (inline) {
      const meta = { ui: { resourceUri: UI_URI } };
      registerAppTool(server, 'labsign_sign_document', { ...signCfg, _meta: meta }, async (args) => inlineFlow(await openSignSession(args), 'sign the document'));
      registerAppTool(server, 'labsign_manage_signatures', { ...manageCfg, _meta: meta }, async () => inlineFlow(createSession({ kind: 'pad', client: clientName() }), 'manage signatures'));

      // Tools só-da-tela: só existem quando o app declarou MCP Apps, e exigem o token que só a tela recebeu.
      const viewTool = (name: string, extra: Record<string, z.ZodType>, fn: (s: Session, args: any) => unknown) =>
        registerAppTool(
          server,
          `labsign_view_${name}`,
          { description: 'Internal to the labsign screen.', inputSchema: z.object({ request_id: z.string(), view_token: z.string(), ...extra }), _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } } },
          async ({ request_id, view_token, ...rest }: any) => {
            const s = getSession(request_id);
            if (!s || !sameToken(view_token, s.viewToken)) return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorPayload(new LabsignError('UNAUTHORIZED'))) }] };
            try {
              const out = await fn(s, rest);
              return { content: [{ type: 'text', text: 'ok' }], structuredContent: out as Record<string, unknown> };
            } catch (e) {
              const p = errorPayload(e);
              return { isError: true, content: [{ type: 'text', text: JSON.stringify(p) }] };
            }
          },
        );
      const placement = z.object({ pageIndex: z.number().int().min(0), x: z.number(), y: z.number(), width: z.number() });
      viewTool('state', {}, (s) => uiState(s));
      viewTool('document', { offset: z.number().int().min(0).optional(), length: z.number().int().min(1).optional() }, (s, b) => uiDocumentChunk(s, b));
      viewTool('upload_document', { name: z.string(), size: z.number().int().min(1), offset: z.number().int().min(0), data: z.string() }, (s, b) => uiUploadChunk(s, b));
      viewTool('save_signature', { label: z.string().optional(), kind: z.string().optional(), strokes: z.array(z.array(z.array(z.number()))) }, (s, b) => uiSaveSignature(s, b));
      viewTool('delete_signature', { id: z.string() }, (s, b) => uiDeleteSignature(s, b));
      viewTool('set_prefs', { drawMode: z.enum(['click', 'drag']).optional(), ink: z.string().optional(), pen: z.string().optional() }, (s, b) => uiSetPrefs(s, b));
      viewTool('confirm', { signatureId: z.string(), placements: z.array(placement).optional(), ink: z.string().optional(), pen: z.string().optional() }, (s, b) => uiConfirm(s, b));
      viewTool('signed_document', { offset: z.number().int().min(0).optional(), length: z.number().int().min(1).optional() }, (s, b) => uiSignedChunk(s, b));
      viewTool('reveal', {}, (s) => uiReveal(s));
      viewTool('cancel', {}, (s) => uiCancel(s));
      viewTool('finish', {}, (s) => uiFinish(s));
    } else {
      server.registerTool('labsign_sign_document', signCfg, async (args, ctx) => browserFlow(await openSignSession(args), ctx, 'sign the document'));
      server.registerTool('labsign_manage_signatures', manageCfg, async (_args, ctx) => browserFlow(createSession({ kind: 'pad', client: clientName() }), ctx, 'manage signatures'));
    }
  };

  await server.connect(new StdioServerTransport());
  log(`labsign ${VERSION} ready (stdio)`);
}
