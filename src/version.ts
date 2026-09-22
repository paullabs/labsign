// Versão: embutida pelo build (esbuild define) ou lida do package.json quando roda do código-fonte.
import { readFileSync } from 'node:fs';

declare const __LABSIGN_VERSION__: string | undefined;

export const VERSION: string =
  typeof __LABSIGN_VERSION__ !== 'undefined'
    ? __LABSIGN_VERSION__
    : (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
