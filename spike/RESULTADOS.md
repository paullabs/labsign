# Fase 0 — resultados do spike (21/09/2026)

Código descartável: serve para derrubar incógnitas, não é a base do produto.
Ambiente: macOS, Node 24.19, npm 11.17, Claude Code 2.1.278, poppler (`pdftoppm`, `pdfsig`).

## Veredito

A arquitetura do `PLANO.md` se sustenta. Os três riscos técnicos que dependiam só de código foram derrubados; o que resta depende de abrir hosts com interface gráfica (Claude Desktop, Codex no ChatGPT.app), que precisam das suas mãos.

| Incógnita | Resultado | Como foi verificado |
|---|---|---|
| Carimbo vetorial em PDF difícil | **Resolvido** | `test/stamp-test.mjs` — 20/20 casos |
| Assinatura digital de terceiros sobrevive | **Resolvido** (só com save incremental) | `pdfsig` antes/depois |
| Caminho navegador + espera limitada | **Resolvido** | `test/mcp-client-test.mjs` — 29/29 casos + Claude Code real |
| UI num navegador de verdade | **Resolvido** | desenho, salvar, assinar, cancelar e recarregar, pelo painel de navegador |
| Detecção do que o host suporta | **Resolvido** | cliente roteirizado com e sem a capacidade de MCP Apps |
| UI embutida no chat (MCP Apps) | **Protocolo ok, renderização não testada** | falta abrir num host real — ver "Falta testar" |
| Codex | **Não testado** | CLI do Codex não está instalado nesta máquina |
| Nome no npm | `labsign`, `@labsign/cli` e `labsign-mcp` **livres** | `npm view` → 404 |

## O que foi provado

**1. Carimbo (`src/core/stamp.mjs`).** A assinatura entra como vetor (curvas de Bézier preenchidas), posicionada em coordenadas visuais e convertida por uma matriz afim por rotação. O teste usa oráculo independente: renderiza com poppler e confere nos *pixels* se a tinta caiu no retângulo pedido, em pé e sem espelhar. Passou com erro de 0 px em: A4 normal, `/Rotate` 90/180/270, `MediaBox` com origem deslocada + `CropBox` menor, e a combinação deslocado + rotacionado.

**2. Save incremental é obrigatório, não opcional.** Num PDF já assinado digitalmente pela contraparte: com save incremental o `pdfsig` continua dizendo "Signature is Valid"; com save normal (reescrita) a assinatura digital **é destruída**. Bônus: no modo incremental o arquivo assinado começa com os bytes *exatos* do original — dá para provar que o conteúdo original está intacto comparando o hash do prefixo. Isso vira item do registro de evidências.

**3. Âncora por texto (`src/core/anchors.mjs`).** `pdfjs-dist` no Node, sem canvas nem dependência nativa, devolve a posição de "CONTRATANTE"/"CONTRATADO" já em coordenadas visuais; a assinatura caiu sentada na linha certa. Em PDF escaneado (sem camada de texto) não acha nada, como esperado → o posicionamento manual sobre o preview (Fase 1) é necessário, não enfeite.

**4. Caminho navegador (`src/http`, `src/mcp`).** Com host sem UI, `labsign_sign_document` voltou `pending` em 2,5 s com a espera configurada para 2,5 s, trazendo a URL local e sem vazar o token da view. Dentro do **Claude Code 2.1.278 real** (`claude -p`): a tool ficou aguardando, a assinatura foi feita no navegador, a tool voltou `signed` e o Claude Code relatou o arquivo — 3 turnos, 34 s. O Claude Code CLI declarou: sem MCP Apps e, em modo headless, sem elicitação por URL → caiu no "servidor abre o navegador", como previsto.

**5. Modelo de segurança (testes A5–A19, B6–B7).** Recusados: confirmar sem token (401), token certo sem cookie (401), origem estranha (403), `Host` forjado/DNS rebinding (403), segunda abertura da sessão por outro cliente (409, e fica registrada na auditoria), confirmar duas vezes (400), tool da view com token inventado (erro). A listagem para o modelo não contém desenho. No caminho inline o token da view vai em `_meta`, fora de `content`/`structuredContent`. Cofre criado com 0700/0600. Log de auditoria encadeado por hash confere.

**6. Detecção de host.** Com a capacidade `io.modelcontextprotocol/ui` declarada, o servidor registra a tool apontando para `ui://labsign/sign.html` (MIME `text/html;profile=mcp-app`, HTML autossuficiente) e só então cria as 4 tools só-da-view; a tool volta em 39 ms sem bloquear. Sem a capacidade, essas tools nem existem.

## Ajustes no plano que saíram daqui

1. **SDK v2.** `@modelcontextprotocol/ext-apps` 2.0 depende de `@modelcontextprotocol/server` e `/client` 2.x — o pacote antigo `@modelcontextprotocol/sdk` não serve.
2. **Sempre salvar em modo incremental** (com reescrita só como plano B).
3. **`labsign_status` com `wait_seconds`** (espera limitada), para o agente aguardar sem ficar consultando em loop. Já implementado no spike.
4. **Orçamento de tempo único por chamada:** a elicitação por URL ganhou timeout próprio para nunca estourar a espera total.
5. **Rubrica em todas as páginas:** cada carimbo custou ~3,6 KB comprimidos com uma assinatura simples; uma real pode custar 15–40 KB. Desenhar a assinatura uma vez como Form XObject e referenciar em cada página.
6. **Dois bundles de UI:** o HTML único ficou com 605 KB, quase tudo do SDK de MCP Apps. A página do navegador não precisa dele.
7. **Traço:** `perfect-freehand` funcionou e mapeia direto para vetor no PDF. Corrigido um detalhe real: o último ponto pode chegar só no `pointerup`. Falta o veredito da mão humana (abaixo).
8. **npm 11 bloqueia `postinstall` por padrão** — o `esbuild` funcionou mesmo assim. Confirma a regra do plano: nosso pacote não pode depender de script de instalação.
9. **Aviso para o `SECURITY.md`** (lição do PDF-Tools): o cofre é protegido, mas um PDF assinado contém a imagem da assinatura — se o modelo renderizar a página, ele a vê. Isso é inerente a compartilhar o documento.

## Achado do primeiro teste manual (Paulo, 21/09/2026)

`node bin/labsign.mjs add` abriu sozinho o navegador padrão e salvou a assinatura no cofre — era o único passo do caminho navegador ainda não exercitado. Defeito encontrado e corrigido: o `add` encerrava o processo já no primeiro "Salvar", deixando a aba sem servidor para quem quisesse desenhar também a rubrica. Agora a sessão de cofre do CLI só encerra no botão "Concluir" (o MCP continua avisando o agente no primeiro salvar). Coberto por `test/pad-session-test.mjs` (6/6). Lição para a Fase 1: **quem encerra uma sessão é o usuário, não o primeiro evento**.

**Segundo teste manual — assinatura real num contrato.** `sign fixtures/normal.pdf --anchor CONTRATANTE` com a assinatura desenhada à mão. Conferido **numericamente, sem exibir o desenho** (é a regra do projeto: o modelo não vê a assinatura): SHA-256 igual ao impresso pelo CLI; original é prefixo exato do assinado; tinta na caixa x=78..247, base em y=605 — sentada 5 pt acima da linha, largura exata de 170 pt. Dois achados:

- **Custo real de uma assinatura à mão: ~18 KB** por carimbo (3 KB → 21 KB). Confirma que a rubrica em todas as páginas precisa de Form XObject (item 5 acima): num contrato de 30 páginas seriam ~540 KB a mais sem isso.
- **Largura fixa não basta.** A assinatura real saiu com 81 pt de altura (quase 3 cm) porque só a largura era limitada. Na Fase 1: encaixar numa caixa com largura **e** altura máximas (ex.: 170 × 55 pt), preservando a proporção — e o usuário ainda ajusta no preview.
- PDFs assinados nos testes contêm assinatura real: `*.assinado*.pdf` entrou no `.gitignore`. Mesma regra vale para o repositório do produto.

**Terceiro teste manual — assinar o mesmo arquivo de novo.** Saiu `normal.assinado-2.pdf`; o primeiro assinado ficou byte a byte igual (mesmo SHA-256) e o original também: a regra de nunca sobrescrever vale também entre assinados. Cadeia de hash da auditoria íntegra após 4 eventos. Achado: o cofre ficou com **duas assinaturas chamadas "Assinatura"**, indistinguíveis na listagem do modelo e no log. Corrigido: rótulo repetido ou vazio ganha número ("Assinatura 2"), coberto pelo caso C7. Para a Fase 1: mostrar data de criação no cartão e oferecer renomear/apagar na tela do cofre (já previsto no plano).

## Rodada de UX — feedback do Paulo testando à mão (21/09/2026)

Dois problemas relatados, os dois resolvidos no spike e verificados num navegador de verdade.

**1. "Clico na assinatura salva e não adiciona na parada."** Selecionar não tinha efeito visível — por isso a segunda "Assinatura" do cofre: sem ver a salva aplicada, ele desenhou outra. Agora:
- A tela mostra a **página real do PDF** (PDF.js rodando na thread principal, sem Worker, sem eval — funciona com a CSP da página local e no iframe de MCP Apps) com a assinatura por cima, **exatamente onde vai ser carimbada**.
- Clicar num cartão troca a assinatura no documento na hora (com uma animação curta de "pousar"); o cartão ganha check e "No documento".
- Desenho novo aparece **ao vivo** no documento enquanto é feito; "Assinar documento" com um desenho novo salva no cofre e assina (como no iPhone).
- A assinatura usada por último vem **pré-selecionada e já posicionada**: quem volta só confere e assina.
- Arrastar move; o canto redimensiona; setas/Shift+setas e +/− pelo teclado. A posição final vem da tela, é validada no servidor (fora da página = recusa) e fica **registrada na auditoria**.
- Aviso "“X” foi salva no seu cofre e está no documento." ao salvar.

**2. "Segurar o clique perde a coordenação."** Novo modo padrão **"Clique para escrever"**: um clique abaixa a caneta, mover o mouse ou o dedo no trackpad desenha, outro clique levanta. Segurar e arrastar continua funcionando no mesmo modo (o gesto decide). Esc ou sair do quadro levanta a caneta; um selo "Escrevendo · clique para levantar a caneta" mostra o estado. Dedo e stylus sempre desenham ao encostar. O modo clássico "Segurar e arrastar" fica a um clique; a escolha é salva no cofre (`config.json` — a porta muda a cada sessão, então `localStorage` não serviria).

**De brinde:** âncora não encontrada deixou de ser erro — o pedido abre com a assinatura proposta no fim da última página e um aviso para arrastar (resolve o PDF escaneado); os bytes da prévia são os mesmos que serão assinados (lidos uma vez, na abertura); saída gravada com `flag: 'wx'` (nunca sobrescreve, nem numa corrida); bundles separados (navegador 1,75 MB sem o SDK de MCP Apps; chat 2,35 MB); escala tipográfica de 5 degraus e aviso que abre espaço sem animar layout (achados do detector de design).

**Verificação.** Navegador real (Chromium), cofre de teste isolado — nunca o cofre real:
- Modo clique: clique + só movimento desenhou; arrastar no mesmo modo também; selo de estado correto.
- WYSIWYG: assinatura arrastada 200 px e redimensionada na prévia → x=328,64 y=575,61 largura 195,64 pt na tela; no PDF gerado, renderizado pelo poppler, a tinta ficou em x=329..523, y=578..611 — dentro da caixa mostrada. Auditoria registrou a mesma posição.
- Layouts: desktop 1280 px (duas colunas), celular 375 px (sem rolagem lateral, botão fixo no rodapé), modo escuro (página e quadro continuam brancos, como papel), tela do cofre.
- Cancelar não grava nada; recarregar a página mantém a sessão.
- Testes automáticos: carimbo 20/20, posicionamento 8/8, cofre 8/8, MCP 40/40 (novos: leitura da prévia por HTTP e em blocos, posição vinda da tela, posição fora da página, âncora ausente, preferência).

**Limite desta verificação:** o painel do navegador de teste estava oculto, então as animações (pousar, aviso) foram conferidas pelo estado final, não a olho. E a sensação do traço no modo clique precisa da sua mão.

## Segunda rodada de UX — "mais sério, mais quadrado, simples e completo" (21/09/2026)

Pedidos do Paulo e o que virou:

| Pedido | Feito |
|---|---|
| Design "estranho" → mais sério, mais quadrado | Cinzas neutros no lugar do bege; cantos de 2–3 px; bordas finas; um só acento (o azul-marinho da tinta); rótulos de grupo ("ASSINATURA", "TINTA", "ENVIAR OU GUARDAR"); status do documento no topo (Pendente/Assinado/Cancelado); animações decorativas removidas (ficou só um fade de 140 ms ao trocar a assinatura). Assinaturas viraram uma lista de linhas com rádio — sem "cartão dentro de cartão". |
| Mais opções de apagar | Lixeira em cada assinatura salva, com confirmação na própria linha (foco em "Cancelar"); × na assinatura sobre o documento (tira do documento sem apagar nada); Desfazer e Limpar no quadro; Delete/Backspace no teclado. Apagar do cofre só pela tela — o modelo não tem tool para isso. |
| Padrão "segurar e arrastar" | Virou o padrão; "Clique para escrever" continua a um clique, sugerido para quem usa trackpad. |
| Afinar a grossura | Traço Fino / Médio / Grosso. Vale para o quadro, para as miniaturas e **para o PDF**: o cofre guarda os traços crus e o servidor recalcula o contorno na espessura escolhida. |
| Trocar a cor | Azul-marinho, Azul e Preto (paleta fechada; o servidor recusa cor fora dela). Vale na prévia e no PDF. Cor e traço ficam salvos como preferência. |
| Enviar por e-mail / baixar / WhatsApp | Depois de assinar, "Enviar ou guardar": Baixar PDF · Compartilhar… (folha nativa do sistema, com o PDF anexado — só aparece onde o navegador suporta) · Enviar por e-mail (Gmail ou app de e-mail, com destinatário, assunto e mensagem prontos) · Enviar pelo WhatsApp (abre a conversa com a mensagem; número com DDD vira +55) · Mostrar na pasta. Dentro do chat (MCP Apps) baixar usa o download do próprio app de chat e os links abrem pelo app de chat. |

**Defeito real encontrado no teste:** depois de assinar, o `labsign sign` encerrava na hora e a tela ficava sem servidor — "Baixar"/"Mostrar na pasta" falhariam. Agora o processo espera a aba fechar (aviso via `sendBeacon`, com limite de 15 min) e a tela, se o servidor já tiver saído, diz onde está o arquivo em vez de "Failed to fetch". Confirmado com o CLI real: "Mostrar na pasta" funcionou depois de assinar e o processo encerrou sozinho (código 0) ao sair da página.

**Limite honesto do envio "direto":** link não carrega anexo — nem `mailto:`, nem `wa.me`, nem Gmail. Com o PDF anexado em um passo, só a folha de compartilhamento do sistema (quando o navegador suporta). Nos outros caminhos a tela baixa o PDF e abre a mensagem pronta; a pessoa anexa. Envio 100% automático exige um serviço hospedado — ver a análise no `PLANO.md`.

**Verificação:** navegador real com cofre de teste; downloads e aberturas de link interceptados na página (nada foi baixado nem aberto de verdade): os 3 downloads saíram com o PDF assinado, Gmail com `to/su/body` corretos, WhatsApp com `wa.me/5511912345678`. Medido no PDF gerado: traço grosso deixa 3× mais tinta que o fino; as três cores saem com erro ≤ 7 em RGB. Desktop, celular (375 px, sem rolagem lateral) e escuro conferidos. Detector de design sem apontamentos. Testes ao fim da rodada (incluindo o envio do PDF pela tela, abaixo): carimbo 20/20, posicionamento 8/8, tinta 5/5, cofre 12/12, MCP 58/58.

**PDF enviado pela própria tela (para o fluxo "mandei o documento no chat").** A pesquisa mostrou que o Claude **não repassa** anexos da conversa para tools, e no ChatGPT o repasse falha às vezes. Então: `labsign_sign_document` sem `file` (e `labsign sign` sem arquivo) abre a tela com "Envie o PDF para assinar" — arrastar ou escolher. No navegador o PDF sobe num POST; dentro do chat, em blocos pela tool da própria tela. Até 30 MB, validado como PDF, nome sem caminho (`../../etc/x.pdf` vira `x.pdf`), hash registrado na auditoria; o original não é gravado em lugar nenhum e a cópia assinada vai para Downloads. Verificado no navegador com o CLI real: arrastar → prévia com a assinatura na linha → assinar → só `Contrato de Locação.assinado.pdf` na pasta de saída, com o PDF enviado como prefixo exato. Testes novos A24–A31 e B9b.

**Plano B para um bug do Claude Desktop** (servidor local às vezes não entrega `structuredContent` à tela): a tela lê o `request_id` do texto do resultado. Não testado no Claude Desktop real.

## Falta testar (precisa de você)

> **Superado pela Fase 1.** Para testar agora, use o produto: o `.mcpb` no Claude Desktop, o plugin no Claude Code e o `labsign doctor` para os outros apps (README e PLANO §13). O roteiro abaixo fica como registro do spike. **O código do spike não está no repositório público**: ele entregava ao modelo o link que abre a tela (com o token), a falha crítica que a revisão de segurança da Fase 1 encontrou e corrigiu no produto. Os caminhos são relativos à raiz do repositório; `<repo>` é a pasta onde ele está.

**a) Sentir o traço com a sua mão** — abre no seu navegador padrão; grava em `~/.labsign-spike` (sem criptografia, é spike):

```bash
cd spike && node bin/labsign.mjs add
```

```bash
cd spike && node bin/labsign.mjs sign fixtures/normal.pdf --anchor CONTRATANTE
```

**b) UI embutida no Claude Desktop (chat)** — a Prioridade 2 do plano. Em `~/Library/Application Support/Claude/claude_desktop_config.json`, dentro de `mcpServers`, adicionar e reiniciar o Claude Desktop:

```json
"labsign-spike": { "command": "node", "args": ["<repo>/spike/src/mcp/server.mjs"] }
```

Depois pedir no chat: *"use labsign_manage_signatures"*. Observar: o painel aparece? o desenho é fluido? salva?

**c) Aba Code deste app** — o `.mcp.json` da raiz registrava `labsign-spike`; desde a Fase 1 ele registra `labsign-dev` (o produto, `dist/labsign.js`). Abrir uma sessão nova nesta pasta, aprovar o servidor e pedir: *"assine spike/fixtures/normal.pdf no bloco CONTRATANTE"*.

**d) Codex (dentro do ChatGPT.app)** — em `~/.codex/config.toml`:

```toml
[mcp_servers.labsign-spike]
command = "node"
args = ["<repo>/spike/src/mcp/server.mjs"]
```

Observar se a tool volta antes dos 60 s e se o agente usa `labsign_status` para aguardar.

**e) git** — resolvido em 21/09/2026: licença do Xcode aceita, `git version 2.54.0` funcionando. Repositório iniciado na Fase 1, ainda sem commits.

## Como rodar de novo

```bash
cd spike && npm run build:ui && npm run fixtures && npm run test:stamp && npm run test:placement && npm run test:ink && npm run test:pad && npm run test:mcp
```
