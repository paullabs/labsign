// Erros com código estável: a tela e o terminal traduzem pelo código (pt/en);
// a mensagem em inglês fica para logs e para o modelo.

export type ErrorCode =
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_ABSOLUTE'
  | 'NOT_PDF'
  | 'ENCRYPTED'
  | 'TOO_MANY_OPEN'
  | 'NOT_A_SIGN_SESSION'
  | 'SESSION_CLOSED'
  | 'NO_DOCUMENT'
  | 'NOT_AWAITING'
  | 'OUT_OF_PAGE'
  | 'PAGE_MISSING'
  | 'INVALID_PLACEMENT'
  | 'INVALID_INK'
  | 'INVALID_PEN'
  | 'EMPTY_DRAWING'
  | 'INVALID_ID'
  | 'SIGNATURE_NOT_FOUND'
  | 'NOT_SIGNED_YET'
  | 'SIGNED_FILE_MISSING'
  | 'TRASH_FAILED'
  | 'UNDO_EXPIRED'
  | 'DELIVERY_UNAVAILABLE'
  | 'UPLOAD_EMPTY'
  | 'UPLOAD_TOO_BIG'
  | 'UPLOAD_OUT_OF_ORDER'
  | 'UPLOAD_OVERFLOW'
  | 'UNAUTHORIZED'
  | 'BAD_ORIGIN'
  | 'BAD_HOST'
  | 'BODY_TOO_BIG'
  | 'NOT_FOUND'
  | 'INTERNAL';

export type ErrorParams = Record<string, string | number>;

const EN: Record<ErrorCode, (p: ErrorParams) => string> = {
  FILE_NOT_FOUND: (p) => `file not found: ${p.file}`,
  FILE_NOT_ABSOLUTE: () => 'file must be an absolute path',
  NOT_PDF: () => 'the file is not a PDF',
  ENCRYPTED: () => 'the PDF is password-protected or encrypted; the user must save an unprotected copy first',
  TOO_MANY_OPEN: (p) => `too many open signing requests (${p.max}); finish or cancel the open ones first`,
  NOT_A_SIGN_SESSION: () => 'this request is not a signing request',
  SESSION_CLOSED: (p) => `this request is already ${p.status}`,
  NO_DOCUMENT: () => 'there is no document to sign yet',
  NOT_AWAITING: () => 'this request is not waiting for a document',
  OUT_OF_PAGE: (p) => `the signature falls outside page ${p.page}`,
  PAGE_MISSING: (p) => `page ${p.page} does not exist`,
  INVALID_PLACEMENT: () => 'invalid position',
  INVALID_INK: () => 'invalid ink color',
  INVALID_PEN: () => 'invalid stroke width',
  EMPTY_DRAWING: () => 'the drawing is empty',
  INVALID_ID: () => 'invalid signature id',
  SIGNATURE_NOT_FOUND: () => 'signature not found',
  NOT_SIGNED_YET: () => 'the document has not been signed yet',
  SIGNED_FILE_MISSING: (p) => `the signed file is no longer at ${p.file}`,
  TRASH_FAILED: (p) => `could not move ${p.file} to the trash`,
  UNDO_EXPIRED: () => 'too late to undo from this screen; delete the signed copy from its folder',
  DELIVERY_UNAVAILABLE: () => 'that option is not available on this computer',
  UPLOAD_EMPTY: () => 'the file is empty',
  UPLOAD_TOO_BIG: (p) => `the PDF is larger than ${p.mb} MB`,
  UPLOAD_OUT_OF_ORDER: () => 'chunk out of order; send the file again',
  UPLOAD_OVERFLOW: () => 'the file is larger than announced',
  UNAUTHORIZED: () => 'not authorized: only the person at the labsign screen can do this',
  BAD_ORIGIN: () => 'invalid origin',
  BAD_HOST: () => 'invalid host',
  BODY_TOO_BIG: () => 'request body too large',
  NOT_FOUND: () => 'not found',
  INTERNAL: (p) => `internal error${p.detail ? `: ${p.detail}` : ''}`,
};

export class LabsignError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams;
  constructor(code: ErrorCode, params: ErrorParams = {}) {
    super(EN[code](params));
    this.name = 'LabsignError';
    this.code = code;
    this.params = params;
  }
}

export interface ErrorPayload {
  error: ErrorCode;
  message: string;
  params: ErrorParams;
}

/**
 * O que sai para a tela e para o modelo. Erro inesperado (biblioteca, sistema de arquivos) vai
 * inteiro para o stderr e sai daqui só como INTERNAL: a mensagem crua pode carregar caminhos e detalhes internos.
 */
export function errorPayload(e: unknown): ErrorPayload {
  if (e instanceof LabsignError) return { error: e.code, message: e.message, params: e.params };
  console.error('[labsign] erro inesperado:', e instanceof Error ? (e.stack ?? e.message) : e);
  return { error: 'INTERNAL', message: EN.INTERNAL({}), params: {} };
}
