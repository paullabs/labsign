# Contribuindo

Obrigado! Issues e PRs são bem-vindos, em português ou inglês.

## Rodando

```bash
npm ci
npm test            # build + todos os testes (Node 24)
npm run typecheck
node src/cli/index.ts sign caminho/contrato.pdf   # roda direto do código-fonte
```

O `.mcp.json` da raiz registra `labsign-dev`, que aponta para o seu build (`dist/labsign.js`), para testar no Claude Code aberto nesta pasta. Rode `npm run build` antes, e de novo a cada mudança.

O [poppler](https://poppler.freedesktop.org/) (`pdftoppm`, `pdfsig`) é opcional. Com ele, os testes conferem os pixels do PDF assinado e a validade de assinaturas digitais anteriores; sem ele, essas checagens são puladas.

## Princípios

1. **Local primeiro.** Nenhuma chamada de rede, nenhuma telemetria, nenhuma conta.
2. **Só a pessoa assina.** Nada no labsign desenha, gera ou aplica uma assinatura sem o clique de quem assina, e nenhuma ferramenta devolve o desenho para o modelo.
3. **O original é sagrado.** Nunca sobrescrever, sempre salvamento incremental.
4. **Um arquivo por artefato.** `dist/labsign.js` e as telas `dist/ui*.html` levam tudo embutido. Dependências novas precisam de licença compatível com MIT (elas entram em `THIRD_PARTY_LICENSES.txt`).
5. **Toda frase da tela em PT e EN** (`src/i18n/messages.ts`). Textos para o modelo, em inglês.
6. **Testes nunca tocam o cofre real.** Use `LABSIGN_HOME` num diretório temporário (veja `test/helpers.ts`).

## Checklist do PR

- [ ] `npm test` e `npm run typecheck` passam
- [ ] Mudanças na tela testadas no navegador, no claro e no escuro
- [ ] Textos novos nas duas línguas
- [ ] Nada de rede, `eval` ou dependência carregada de CDN
