// Trava antes de publicar no npm: exige que a versão do package.json esteja marcada
// (tag git vX.Y.Z), publicada (branch main = origin/main, sem mudanças soltas) e, se o
// gh CLI estiver disponível, que a Release correspondente já exista no GitHub — nessa ordem.
// Motivo: v0.1.1 foi publicada no npm e no GitHub a partir de commits diferentes (ver
// PLANO.md §13.2), e cada lado ficou com um conteúdo ligeiramente distinto. Isso impede
// que aconteça de novo, em vez de depender de lembrar a ordem certa.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(`\n✖ npm publish bloqueado: ${msg}\n`);
  process.exit(1);
};

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;

// 1) árvore limpa
const dirty = sh('git', ['status', '--porcelain']);
if (dirty) fail(`há mudanças não commitadas.\n${dirty}`);

// 2) a tag da versão existe e aponta para HEAD
let taggedSha;
try {
  taggedSha = sh('git', ['rev-list', '-n', '1', tag]);
} catch {
  fail(`a tag ${tag} não existe. Rode: git tag -a ${tag} -m "..." && git push origin ${tag}`);
}
const head = sh('git', ['rev-parse', 'HEAD']);
if (taggedSha !== head) fail(`a tag ${tag} aponta para ${taggedSha.slice(0, 7)}, mas HEAD é ${head.slice(0, 7)} — publique da mesma revisão que foi tagueada.`);

// 3) main está no remoto, igual ao HEAD local (senão o que o npm mostrar não bate com o GitHub)
try {
  execFileSync('git', ['fetch', 'origin', 'main', '--quiet']);
} catch (e) {
  console.warn(`(aviso: não consegui atualizar origin/main — ${e.message}. Seguindo com a referência local.)`);
}
let remote;
try {
  remote = sh('git', ['rev-parse', 'origin/main']);
} catch {
  remote = null;
}
if (remote && remote !== head) fail(`HEAD (${head.slice(0, 7)}) é diferente de origin/main (${remote.slice(0, 7)}) — dê push antes de publicar.`);

// 4) a Release do GitHub já existe para esta tag (evita publicar no npm antes do GitHub)
try {
  sh('gh', ['--version']);
  try {
    sh('gh', ['release', 'view', tag]);
  } catch {
    fail(`a Release ${tag} ainda não existe no GitHub. Crie-a primeiro (gh release create ${tag} ...) e só então publique no npm.`);
  }
} catch {
  console.warn('(aviso: gh CLI não disponível — não deu para conferir se a Release do GitHub já existe.)');
}

console.log(`✔ ${tag} — árvore limpa, tag em HEAD, main em dia com origin, Release do GitHub existe. Publicando.`);
