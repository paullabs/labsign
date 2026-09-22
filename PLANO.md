# labsign — plano

> Assinar documentos de dentro do Claude, do Codex e afins: o agente prepara, **o humano assina** numa telinha (desenha ou escolhe uma assinatura salva) e o PDF assinado volta para a conversa. Local, leve, sem conta e sem nuvem.

**Status:** Fase 1 entregue em 21/09/2026 — o produto está na raiz do repositório (TypeScript), com instalador `.mcpb` para o Claude Desktop, plugin do Claude Code, instruções para o Codex, docs e CI; detalhes e o que falta na **seção 13**. Fase 0 (spike) em [spike/RESULTADOS.md](spike/RESULTADOS.md) — o código em `spike/` fica só como referência. Duas rodadas de UX com testes à mão do Paulo (seção 11.2). Análise de "assinar dentro do chat e enviar" na **seção 12** — decisão: validar o caminho local primeiro, sem serviço hospedado por enquanto. Falta o teste manual da tela embutida no Claude Desktop real.
Itens marcados com _(não verificado)_ precisam ser confirmados na Fase 0.

---

## 1. O que é (e o que não é)

**É** um pacote npm único que funciona como:

- **CLI** — `labsign sign contrato.pdf`
- **Servidor MCP** local (stdio) — `labsign mcp`
- **UI web de assinatura** (pad de desenho + posicionamento no PDF), usada de dois jeitos: embutida no chat (MCP Apps) ou numa página `127.0.0.1` no navegador
- **Cofre local de assinaturas** — o "pacotinho": assinatura, rubrica, carimbo… como no iPhone/Preview
- **Skill** (`SKILL.md`) para Claude Code e Codex, ensinando o agente a usar tudo isso

**Não é (v1):** plataforma para coletar assinatura de terceiros (isso é ZapSign/Clicksign/DocuSign), serviço hospedado, nem assinatura com certificado digital. Esses entram como integrações no roadmap.

---

## 2. O que a pesquisa mostrou

### 2.1 Já existe coisa parecida — o espaço não está vazio

| Projeto | O que faz | O que falta |
|---|---|---|
| **PDF-Tools** (Open-Document-Alliance, MIT, ~157★, ativo) | Servidor MCP local + `.mcpb`; viewer inline com aba Sign: desenha, salva e reaplica assinaturas locais (`create_signature`, `list_signatures`, `apply_signature`, `detect_signature_zones`) | Suíte grande de PDF (não é focado); hosts verificados: Claude Desktop e Cursor; Codex "não verificado"; sem fluxo BR |
| **pdf-viewer** (plugin oficial Anthropic, já instalado aqui) | Carimba uma imagem de assinatura **que você já tem** num PDF e salva cópia | Sem pad de desenho, sem cofre, sem confirmação humana dedicada |
| omapdf (AGPL, Linux) | Janela GTK para desenhar + MCP `place_signature` | Só Linux |
| MCPs de provedores (DocuSign, ZapSign, Autentique, Assinafy, D4Sign, SignWell, BoldSign…) | Enviam documento para assinatura por link/e-mail | Exigem conta; não capturam a **sua** assinatura no chat |

**Lacuna real:** uma ferramenta pequena e focada, que funcione em **qualquer host** (inclusive onde UI inline não renderiza: Claude Code CLI, Codex CLI), com instalação de um comando, confirmação humana obrigatória e fluxo brasileiro (rubrica em todas as páginas, CPF/data, registro de evidências).

### 2.2 UI dentro do chat existe, mas o suporte é desigual

MCP Apps (extensão oficial do MCP, estável desde 26/01/2026, SDK `@modelcontextprotocol/ext-apps` 2.x): a tool declara `_meta.ui.resourceUri: "ui://…"`, o host renderiza o HTML num iframe isolado, e a view chama tools do servidor via `callServerTool()`.

| Host | UI inline (MCP Apps) | Observação |
|---|---|---|
| Claude Desktop (chat) | Sim, inclusive servidor local stdio | Caminho inline mais confiável |
| claude.ai web / mobile | Só conectores **remotos** | Fora do escopo local-first |
| Claude Code CLI | Não | Suporta elicitação por URL (abre navegador) |
| App desktop do Claude, aba Code | _(não verificado)_ — há relatos de widget local não montar | Testar na Fase 0 com o pdf-viewer |
| Codex CLI | Não | `tool_timeout_sec` padrão = **60 s** |
| Codex app desktop | Atrás de flag experimental (`features.enable_mcp_apps`) _(não verificado)_ | Relato de CSP bloqueando `127.0.0.1` |
| ChatGPT | Sim, mas só servidor remoto HTTPS / túnel | Fora do escopo local-first |
| Cursor, VS Code Copilot, Goose | Sim | VS Code só modo inline |

Restrições do iframe que afetam o design: sem rede (`connect-src 'none'`), sem download, scripts inline OK (bundle em arquivo único), drag-and-drop e eventos de toque funcionam, `<input type=file>` _(não verificado)_, payload recomendado em blocos de ~500 KB. No mobile o desenho precisa ser em tela cheia.

Dois detalhes que pesam na segurança: hosts sem MCP Apps **ignoram** `visibility: ["app"]` (o modelo enxerga tools "só da view"), e o servidor **não consegue distinguir** chamada vinda da view de chamada vinda do modelo.

### 2.3 Conclusão da pesquisa

O único caminho que funciona em 100% dos hosts é **CLI + página local no navegador**. A UI inline é melhoria progressiva por cima, não a fundação.

---

## 3. Arquitetura recomendada

```
 Host com UI inline            Host sem UI               Qualquer agente com shell
 (Claude Desktop, Cursor,      (Claude Code CLI,         (Skill → Bash)
  VS Code, Codex app*)          Codex CLI)
        │ MCP + ui://                │ MCP                       │ labsign sign …
        ▼                            ▼                           ▼
 ┌──────────────────────── labsign (1 pacote npm) ─────────────────────────┐
 │  Servidor MCP (stdio) ── detecta o que o host suporta ──┐       CLI     │
 │        │                                                │        │      │
 │        ▼                                                ▼        ▼      │
 │  UI embutida no chat                    Página em 127.0.0.1 (navegador) │
 │        └───────── a MESMA UI web: pad + preview do PDF ─────────┘       │
 │                                 │                                       │
 │   Core: cofre · carimbo no PDF · âncoras · auditoria (hash + log)       │
 └─────────────────────────────────┬───────────────────────────────────────┘
                                   ▼
                 ~/.labsign/  (assinaturas, config, audit.jsonl)
```

**Uma UI, dois transportes.** A mesma interface web fala com o core por uma interface de transporte: (a) `callServerTool()` quando embutida no chat, (b) `fetch()` em `127.0.0.1` quando no navegador. Nenhuma lógica duplicada.

**Escolha automática do caminho** (do melhor para o mais universal), decidida na inicialização MCP pelas capacidades que o cliente declara:

1. Host declara MCP Apps → UI inline.
2. Host declara elicitação por URL (Claude Code, VS Code) → o host pede para abrir o navegador.
3. Caso contrário → o próprio servidor abre o navegador.

Em todos os casos o resultado da tool **sempre** traz a URL local como saída de emergência ("se o painel não abrir, clique aqui").

**Nunca bloquear esperando o humano.** Como o Codex corta tools em 60 s, `labsign_sign_document` espera no máximo ~45 s; se o usuário ainda não terminou, devolve `status: "pending"` + `request_id`, e o agente consulta `labsign_status` depois. Na UI inline, a própria view avisa o modelo quando termina (`updateModelContext`).

**O carimbo é feito no servidor, não na view.** A view só envia: id da assinatura + página + coordenadas + token de confirmação. Os bytes do PDF só trafegam servidor → view (em blocos) para o preview. A assinatura é gravada como **vetor** (nítida em qualquer zoom, arquivo pequeno).

---

## 4. Fluxos

**Criar assinatura (uma vez).** `labsign add` ou a tool de gerenciar → abre o pad → desenhar (mouse/trackpad/mesa), digitar (fonte cursiva) ou importar foto de assinatura no papel (remoção de fundo) → salvar como "Assinatura", "Rubrica", "Carimbo"…

**Assinar documento.**
1. Agente chama `labsign_sign_document({ file, signer_hint })`.
2. Servidor analisa o PDF e propõe onde assinar (linhas `_____`, "Assinatura", "CONTRATANTE/CONTRATADO", nome do signatário, campos de assinatura AcroForm, âncoras deixadas pelo agente).
3. Abre a UI: preview da página com a assinatura já no lugar sugerido; usuário ajusta (arrastar/redimensionar), escolhe qual assinatura, liga "rubricar todas as páginas", "data/nome/CPF".
4. Usuário clica **Assinar** → servidor grava `contrato.assinado.pdf` (**nunca sobrescreve o original**), calcula SHA-256 antes/depois, registra no log.
5. Agente recebe só `{ signed_file, sha256, pages, signature_label, audit_id }`.

**Verificar.** `labsign verify arquivo.pdf` → "este arquivo confere com o que você assinou em …" (hash + log).

**Casos de borda já previstos:** PDF com senha (senha digitada **na UI**, nunca via modelo); PDF que já tem assinatura digital (avisar + save incremental para não invalidar); páginas rotacionadas/escaneadas; DOCX/MD → fora da v1 (o agente converte para PDF antes).

---

## 5. Superfície

**Tools MCP visíveis ao modelo (poucas, de propósito)**

| Tool | Faz |
|---|---|
| `labsign_sign_document` | Abre a UI de assinatura para um PDF; espera limitada; devolve resultado ou `pending` |
| `labsign_status` | Estado de um pedido: `pending / signed / cancelled / expired` |
| `labsign_list_signatures` | Lista rótulos/ids/tipos — **sem imagem** |
| `labsign_manage_signatures` | Abre a UI do cofre (criar, renomear, apagar) |
| `labsign_verify` | Confere um PDF contra o log de auditoria |

Tools só-da-view (ler blocos do PDF, obter imagem da assinatura, salvar assinatura, confirmar) são **registradas apenas quando o host declara MCP Apps**, e a confirmação exige token entregue só à view.

**CLI**

```
labsign sign contrato.pdf [--signature "Paulo"] [--rubrica-all] [--out …]
labsign add | list | rm | rename
labsign verify contrato.assinado.pdf
labsign export | import        # levar o pacotinho para outra máquina
labsign mcp                    # servidor MCP (stdio)
labsign doctor                 # checa ambiente e imprime snippets de instalação por host
```

**Skill (Claude Code + Codex):** quando o usuário quer assinar → usar a tool MCP se existir, senão `npx -y labsign sign "<arquivo>"`; nunca tentar desenhar/forjar assinatura nem editar o PDF para inserir uma; nunca ler `~/.labsign`; ao **gerar** contratos, incluir bloco de assinatura com âncoras para posicionamento exato.

**Cofre**

```
~/.labsign/
  config.json          # perfil opcional (nome, CPF/CNPJ, e-mail) e preferências
  signatures/<id>.json # rótulo, tipo, traços crus, bbox, origem (draw/type/photo)
  signatures/<id>.svg  # vetor
  signatures/<id>.png  # raster transparente (thumbnails/fallback)
  audit.jsonl          # log encadeado por hash
```

---

## 6. Modelo de segurança

Ferramenta de assinatura dirigida por IA precisa partir disto:

1. **O modelo nunca vê nem manipula a imagem da assinatura.** Tools devolvem ids e rótulos. Nenhuma tool devolve nem aceita bytes de assinatura.
2. **Nenhuma assinatura é aplicada sem gesto humano na UI.** Não existe tool "aplicar assinatura" sem interface. A confirmação usa token de uso único entregue só à sessão da UI.
3. **Original intocado**, saída sempre em arquivo novo, hashes no log.
4. **100% local:** bind só em `127.0.0.1`, porta aleatória, token por sessão, desligamento por inatividade, zero telemetria, zero chamadas de rede.
5. **Log de auditoria** encadeado por hash: o que foi assinado, quando, com qual assinatura, por qual host (`clientInfo`).
6. **Dados sensíveis só pela UI** (senha de PDF, CPF) — nunca passando pelo modelo.

**Limite honesto da v1:** um agente com shell irrestrito na mesma máquina consegue, em tese, ler arquivos do cofre ou simular chamadas HTTP locais. A v1 é _tamper-evident_ (sessão de uso único + log), não _tamper-proof_. O fechamento real vem na Fase 5: cofre criptografado com chave no Keychain/DPAPI/libsecret e presença do usuário (Touch ID no macOS) para destravar cada sessão de assinatura.

---

## 7. Camada jurídica (Brasil) — contexto de produto, não aconselhamento jurídico

- Contratos **entre particulares** se apoiam na MP 2.200-2/2001 art. 10 §2º (vale o meio que as partes admitirem) + liberdade de forma do Código Civil. A classificação simples/avançada/qualificada da Lei 14.063/2020 é voltada a interações com o poder público; aplica-se por analogia.
- **O desenho sozinho pesa pouco.** O que sustenta autoria e integridade é evidência: hash do documento, carimbo de tempo, autenticação do signatário, trilha de auditoria. É isso que Clicksign/ZapSign/D4Sign anexam.
- CPC art. 784 §4º dispensa testemunhas quando a integridade é conferida por **provedor de assinatura** — uma ferramenta local própria provavelmente não se enquadra.
- A API de assinatura do gov.br é **fechada para desenvolvedores privados** (só órgãos públicos); o usuário pode assinar manualmente no portal.

**Níveis no produto**

| Nível | O que entrega | Quando |
|---|---|---|
| 0 | Assinatura desenhada (equivalente a assinar no Preview/iPhone) | v1 |
| 1 | + registro de evidências: hash SHA-256, data/hora, signatário declarado, versão — embutido no PDF e opcionalmente como página final | v1 |
| 2 | + assinatura criptográfica PAdES com certificado (A1 ICP-Brasil `.pfx` → qualificada) e carimbo de tempo RFC 3161, via `@libpdf/core` | roadmap |
| 3 | Repasse para provedor via MCP deles (ZapSign, Autentique, Clicksign, DocuSign) quando a contraparte precisa assinar ou quando se quer trilha de provedor | roadmap |

Comunicação do produto: nunca prometer "validade jurídica garantida"; dizer exatamente qual nível está sendo aplicado.

---

## 8. Stack

- **TypeScript, Node ≥ 20, zero dependência nativa** (para `npx -y labsign` funcionar na hora).
- `@modelcontextprotocol/sdk` + `@modelcontextprotocol/ext-apps` — servidor MCP e UI inline.
- `@cantoo/pdf-lib` (MIT, fork ativo do pdf-lib) — carimbo vetorial (`drawSvgPath`), PDF com senha, **save incremental**.
- `pdfjs-dist` — preview na UI e posições de texto (âncoras) no Node.
- `perfect-freehand` (~2 KB) — traço com cara de caneta; um path preenchido por traço mapeia direto para vetor no PDF. Alternativa: `signature_pad` (~5 KB gzip, pronto para uso, mas gera muitos paths).
- UI: TS puro ou Preact + Vite com `vite-plugin-singlefile` (HTML único, exigência prática do MCP Apps). Duas views: `pad` (minúscula) e `sign` (com PDF.js).
- Futuro: `@libpdf/core` (Documenso, MIT, beta) para PAdES.
- Testes: PDFs de fixture (normal, rotacionado, escaneado, com senha, já assinado digitalmente), testes de transformação de coordenadas, Playwright na UI, MCP Inspector/`basic-host` do ext-apps para a view inline.

**Distribuição:** npm (`npx -y labsign mcp`) · plugin do Claude Code (marketplace: `.claude-plugin/plugin.json` + `.mcp.json` + `skills/`) · `.mcpb` para instalar no Claude Desktop com dois cliques · `codex mcp add labsign -- npx -y labsign mcp` + skill em `~/.agents/skills/` · snippets `mcp.json` para Cursor/VS Code.

### 8.1 Por ser open source para o público

- **Licença MIT.** Todas as dependências escolhidas são MIT/Apache-2.0; evitar AGPL (ex.: mupdf).
- **A instalação é o produto.** Dois caminhos oficiais e só: `.mcpb` (dois cliques, para quem usa o Claude Desktop e não é dev) e um comando (`npx`) para Claude Code/Codex/Cursor. `labsign doctor` detecta os hosts instalados e imprime — ou aplica, com confirmação — a configuração de cada um.
- **Confiança na cadeia de entrega**, porque é uma ferramenta que toca na sua assinatura: poucas dependências, sem scripts de `postinstall`, lockfile, publicação com `npm publish --provenance`, CI no GitHub Actions em macOS/Windows/Linux.
- **`SECURITY.md` com o modelo de ameaça da seção 6**, incluindo o limite honesto da v1.
- **PT-BR e EN desde o início** (UI e README) — tabela de strings simples; barato agora, caro depois.
- README com GIF do fluxo completo em 15 segundos; `CONTRIBUTING.md`; fixtures de PDF sem dados reais.

---

## 9. Fases

Cada fase termina em algo utilizável. Ordem definida por risco e dependência.

**Fase 0 — Spike de viabilidade** (derrubar as incógnitas antes de construir)
- **Prioridade 1 — caminho universal:** tool que sobe servidor local, abre navegador e faz espera limitada; testar em Claude Code CLI e Codex CLI (timeouts, UX).
- **Prioridade 2 — caminho mais acessível para não-devs:** view mínima com canvas via MCP Apps no Claude Desktop (chat): renderiza? desenho fluido? tela cheia? ida e volta com `callServerTool`?
- Bônus, sem bloquear: mesma view na aba Code, no Codex app (flag) e no Cursor.
- Script que carimba assinatura vetorial em 3 PDFs reais: normal, rotacionado/escaneado, e um já assinado digitalmente (save incremental).
- Instalar o PDF-Tools e assinar um documento: anotar o que é bom e o que incomoda.
- Checar disponibilidade do nome `labsign` no npm.
- **Saída:** arquitetura confirmada ou ajustada.

**Fase 1 — MVP: CLI + navegador**
Core (cofre, pad, carimbo, nunca sobrescrever, log) · `labsign add / sign / list` · UI local com preview PDF.js e arrastar-para-posicionar · importar foto de assinatura · strings em PT-BR e EN.
**Saída:** já dá para assinar de qualquer agente via Bash.

**Fase 2 — Servidor MCP + Skill**
Tools da seção 5 · espera limitada + `status` · detecção de capacidades · elicitação por URL onde houver · `SKILL.md` para Claude Code e Codex · plugin.
**Saída:** "assina esse contrato" funciona no Claude Code e no Codex.

**Fase 3 — UI inline (MCP Apps)**
Mesma UI sobre transporte MCP · leitura em blocos · tela cheia para desenhar · tools só-da-view condicionadas à capacidade · `.mcpb`.
**Saída:** assinar sem sair do chat no Claude Desktop (e onde mais renderizar).

**Fase 4 — Fluxo brasileiro + evidências**
Detecção de âncoras (CONTRATANTE/CONTRATADO/testemunhas, `____`) · âncoras que o agente insere ao gerar o contrato · rubrica em todas as páginas · data/nome/CPF · registro de evidências · `verify`.

**Fase 5 — Blindagem e extras**
Cofre criptografado + Touch ID · assinar pelo celular via QR (dedo na tela é muito melhor que trackpad) · PAdES com A1 · repasse para provedores · `export/import` do pacotinho.

---

## 10. Riscos

| Risco | Mitigação |
|---|---|
| UI inline inconsistente entre hosts (aba Code instável, Codex atrás de flag) | Navegador primeiro; URL sempre no resultado |
| Timeout de tool (Codex 60 s) | Espera limitada + `labsign_status` |
| Coordenadas erradas em PDF rotacionado/escaneado | Fixtures + testes de transformação desde a Fase 0 |
| Agente com shell contornar a confirmação | Sessão de uso único + log (v1); criptografia + presença do usuário (Fase 5); documentar o limite |
| Expectativa jurídica exagerada | Rotular o nível aplicado; roadmap para PAdES/provedor |
| Concorrência anda rápido (PDF-Tools; o pdf-viewer pode ganhar pad) | Diferenciar em: qualquer host, um comando, fluxo BR, escopo mínimo |
| PDFs malformados / senha + incremental _(não verificado)_ no `@cantoo/pdf-lib` | Fallback para `@libpdf/core` (parser tolerante) |

---

## 11. Decisões tomadas (Paulo, 21/09/2026)

1. **Objetivo: ferramenta open source para o público.** Mantém a arquitetura local-first; implica a seção 8.1 (instalação trivial, confiança na cadeia de entrega, PT-BR + EN, docs).
2. **Hosts: "o que for mais acessível e fácil para todos".** Tradução em prioridade: (1) caminho universal CLI + navegador, que funciona em qualquer host; (2) UI inline no Claude Desktop (chat) com instalação por `.mcpb`, que é o caminho mais fácil para quem não é dev. Aba Code, Codex app e Cursor são bônus — nunca bloqueiam uma fase.
3. **Nível jurídico da v1: visual + registro de evidências** (níveis 0 + 1 da seção 7). Certificado A1 e provedores ficam no roadmap.
4. **Construir o labsign focado.** PDF-Tools entra só como benchmark na Fase 0.

**Resolvido na Fase 0:** nome `labsign` livre no npm (21/09/2026 — vale reservar logo) · `perfect-freehand` funcionou e mapeia direto para vetor no PDF (falta só o veredito do traço feito à mão).

**Resolvido na Fase 1:** TS puro na UI, sem framework (a tela inteira é um HTML único).

**Ainda em aberto:** renderização da UI embutida no Claude Desktop, na aba Code e no Codex (teste manual, roteiro em `spike/RESULTADOS.md`).

## 11.1 Ajustes que o spike impôs ao plano

1. **SDK v2:** usar `@modelcontextprotocol/server` e `/client` 2.x (exigidos pelo `ext-apps` 2.0), não o antigo `@modelcontextprotocol/sdk`.
2. **Save incremental sempre.** A reescrita destrói assinatura digital de terceiros (confirmado com `pdfsig`); o incremental a preserva e ainda deixa os bytes exatos do original como prefixo do arquivo assinado — entra no registro de evidências.
3. **`labsign_status` aceita `wait_seconds`** (espera limitada), e cada chamada de tool tem um orçamento de tempo único que inclui a elicitação por URL.
4. **Rubrica em todas as páginas via Form XObject** (assinatura desenhada uma vez e referenciada), para o arquivo não inchar.
5. **Dois bundles de UI:** a página do navegador sem o SDK de MCP Apps (que responde por quase todos os 605 KB do HTML único).
6. **PDF escaneado não tem âncora de texto** → o posicionamento manual sobre o preview, na Fase 1, é requisito.
7. **`SECURITY.md`:** deixar claro que o cofre é protegido, mas um PDF assinado contém a imagem da assinatura e qualquer leitor do documento — inclusive o modelo — pode vê-la.

## 11.2 Requisitos de UX vindos dos testes do Paulo (21/09/2026)

Validados no spike; valem para a Fase 1 em diante.

1. **A prévia do documento é o centro da tela, e é WYSIWYG:** a assinatura escolhida aparece sobre a página real, exatamente onde será carimbada. Escolher, desenhar, arrastar ou redimensionar muda a prévia na hora. Selecionar sem efeito visível foi o defeito que motivou isto.
2. **"Segurar e arrastar" é o padrão** (é o gesto que as pessoas conhecem — revisão do Paulo na 2ª rodada); **"Clique para escrever"** fica a um clique e é sugerido para trackpad: clique abaixa a caneta, mover desenha, clique levanta. Dedo e stylus desenham ao encostar.
3. **A assinatura usada por último vem pré-selecionada e posicionada** — o caminho de quem volta é conferir e assinar.
4. **Sem âncora no PDF, abrir mesmo assim** com a assinatura proposta e posicionamento manual, em vez de erro.
5. **A posição final vem da tela** (o humano decide), é validada no servidor e registrada na auditoria.
6. **Preferências da tela ficam no cofre**, não no navegador (a porta local muda a cada sessão).
7. **Visual sóbrio e quadrado** (2ª rodada): cinzas neutros, cantos de 2–3 px, um só acento (azul-marinho da tinta), rótulos de grupo, status do documento no topo, sem animação decorativa.
8. **Apagar em todos os níveis:** traço (Desfazer), desenho (Limpar), assinatura no documento (×, sem apagar nada), assinatura do cofre (lixeira + confirmação). Apagar do cofre é só pela tela.
9. **Tinta:** cor (azul-marinho, azul, preto) e traço (fino, médio, grosso) escolhidos na tela valem no PDF — o cofre guarda traços crus e o carimbo é recalculado.
10. **Depois de assinar, "Enviar ou guardar":** baixar, compartilhar (folha nativa, quando houver), e-mail (mensagem pronta), WhatsApp (conversa pronta), mostrar na pasta. A sessão fica viva até a aba fechar.

---

## 12. Assinar dentro do chat e enviar — análise (21/09/2026)

**O fluxo pedido pelo Paulo:** a pessoa manda o documento no chat (Claude, ChatGPT) → a IA percebe que é para assinar → a pessoa confirma → o painel abre ali dentro → assina → envia por e-mail, baixa, ou manda pelo WhatsApp.

### 12.1 O que dá para fazer em cada lugar (verificado em fontes primárias)

| Onde | Painel dentro do chat | Recebe o PDF anexado no chat | Devolve o PDF assinado | Precisa de servidor na internet |
|---|---|---|---|---|
| **Claude Desktop** (servidor local) | Sim — com bugs abertos: às vezes não conecta; no Windows não renderiza | **Não** — o Claude não repassa anexos para tools. **O painel pede o PDF** (arrastar/escolher) — já feito | Salva em Downloads + "Mostrar na pasta"; download pelo próprio app funciona | **Não** |
| **claude.ai** (web e celular) | Sim (celular desde mar/2026, só servidor remoto; bug no iOS) | **Não** — idem, painel pede o PDF | Download funciona na web; no iOS não | Sim |
| **ChatGPT** (web e celular) | Sim | **Sim**, via `openai/fileParams` — mas falha em ~10% das chamadas e no iOS chega só texto | Só por link HTTPS do nosso domínio (o iframe não baixa) | **Sim** (servidor público; túnel só para uso pessoal em modo desenvolvedor) |
| **Claude Code / Codex** (terminal) | Não — abre a página local | Lê do disco | Ao lado do original | Não |

### 12.2 E-mail e WhatsApp: o limite real

- **Link nenhum carrega anexo** — nem `mailto:` (RFC 6068), nem `wa.me`, nem o compose do Gmail/Outlook web.
- **PDF anexado em um passo** só pela **folha de compartilhamento do sistema**: Chrome no Mac (128+) e no Windows, Safari, iPhone, Android. **Não funciona dentro do painel do chat** (o iframe não tem permissão `web-share`). O WhatsApp aparece nela no iPhone, Android e Windows — **no Mac, provavelmente não** (só arrastar).
- **Nos outros casos, dois passos:** a mensagem abre pronta (destinatário, assunto, texto) e o PDF já está baixado para anexar — é o que a tela faz hoje.
- **Envio automático** (o labsign manda o e-mail sozinho) exige **serviço hospedado**: e-mail de um domínio do labsign com o usuário em Reply-To (não dá para enviar "como" o Gmail dele), controles antiabuso, e o WhatsApp só com **link** para o arquivo (a API oficial do WhatsApp não serve para pessoa física mandar contrato a qualquer um).
- **A IA mandar pelo Gmail do usuário:** o conector do Gmail aceita anexo, mas o modelo teria que escrever os bytes do PDF na chamada — inviável na prática; o do Outlook não anexa.

### 12.3 Três caminhos

**A. Local (o que existe hoje no spike).** Claude Desktop com painel no chat + página local para Claude Code, Codex e terminal. Sem servidor, sem conta, nada sai do computador. O PDF vem do disco ou é arrastado para o painel; a cópia assinada fica no disco; envio por compartilhar / mensagem pronta / pasta. Para nós, é o caminho sem obrigações de LGPD (o tratamento acontece na máquina do próprio usuário). Limites: não alcança ChatGPT nem celular; no Windows o painel do Claude Desktop não renderiza (cai no navegador).

**B. ChatGPT pessoal via túnel.** O ChatGPT (modo desenvolvedor, planos pagos, web) fala com o servidor **local** por um túnel seguro da OpenAI; o upload do chat chega via `fileParams`. Serve para o Paulo usar e demonstrar; **não é distribuível** ao público.

**C. Hospedado ("labsign na nuvem").** Única forma de "qualquer pessoa, no ChatGPT e no claude.ai, inclusive no celular". Exige:
- servidor HTTPS público + contas com OAuth (para guardar o pacotinho de assinaturas entre conversas);
- **LGPD pesada:** traços de assinatura provavelmente são dado **sensível** (biometria comportamental, segundo a ANPD) → base legal específica/consentimento destacado, encarregado (DPO), segurança, aviso de incidente em 3 dias úteis, retenção mínima, regras de transferência internacional;
- não guardar documentos (processar em memória, apagar em minutos), links de download que expiram;
- e-mail transacional com domínio próprio e antiabuso; WhatsApp por link;
- revisão de loja: a OpenAI proíbe apps de "documentos forjados" e trata CPF como dado restrito (risco de revisão); o diretório do Claude exige organização Team/Enterprise.
- Custo e operação contínuos — é outro produto, não só uma ferramenta open source.

### 12.4 Recomendação

1. **A é a base e já cobre o "dentro da IA" no Claude Desktop** — o que faltava (receber o PDF no painel) foi construído nesta rodada. Próximo passo: validar no Claude Desktop real (roteiro em `spike/RESULTADOS.md`).
2. **B** como receita documentada para testar o fluxo no ChatGPT sem hospedar nada.
3. **C é uma decisão de negócio**, não técnica: só vale se o objetivo for público amplo no ChatGPT/celular. Se sim, construir como uma camada fina hospedada **sobre o mesmo núcleo** (sessões, carimbo, cofre, tela), com as salvaguardas acima — e de preferência depois de validar A com usuários reais.

**Decisão (Paulo, 21/09/2026): validar A primeiro.** A Fase 1 segue local — painel dentro do chat no Claude Desktop, página local para Claude Code, Codex e terminal. O serviço hospedado (C) volta à mesa depois de testar com usuários reais. B fica como receita opcional para demonstrar no ChatGPT.

---

## 13. Fase 1 — o que foi entregue (21/09/2026)

A Fase 1 juntou o escopo das antigas fases 1 a 3: o spike mostrou que CLI, MCP e tela embutida compartilham quase tudo.

- **Produto em TypeScript** na raiz: núcleo (`src/core`), servidor local da tela (`src/http`), servidor MCP (`src/mcp`), tela (`src/ui`), CLI (`src/cli`), textos PT/EN (`src/i18n`). O código do `spike/` fica fora do repositório público (só `spike/RESULTADOS.md` é versionado): o protótipo entregava ao modelo o link que abre a tela, a falha crítica que a revisão de segurança encontrou e o produto corrigiu.
- **Um arquivo por artefato:** `dist/labsign.js` (CLI + MCP, com tudo embutido) e as telas `dist/ui.html` e `dist/ui-app.html`.
- **Instalação:** `dist/labsign-0.1.0.mcpb` (Claude Desktop, dois cliques, 2,2 MB) · plugin do Claude Code (`plugin/` + `.claude-plugin/marketplace.json`, com a skill) · Codex (`codex mcp add` + skill em `~/.agents/skills`) · `labsign doctor` mostra o comando exato de cada app. O `.mcp.json` da raiz usa o próprio build (`labsign-dev`) para testar no Claude Code.
- **Docs:** README (PT e EN), `SECURITY.md` (ameaças e limites), `CONTRIBUTING.md`, `LICENSE` (MIT), CI no GitHub Actions (testes em Linux e macOS; pacote em Node 22 e 24, inclusive Windows).
- **Verificação:** 69 testes (carimbo, posicionamento, tinta, âncoras, cofre, sessões, CLI, MCP de ponta a ponta nos dois caminhos). O `.mcpb` aberto fora do repositório passa nos testes de ponta a ponta. O plugin, instalado numa configuração isolada do Claude Code, conecta (`✔ Connected`). O fluxo completo no navegador (desenhar, salvar, tinta azul e grossa, arrastar, assinar, entregar) foi conferido em números no PDF: tinta no lugar da prévia (±1 pt), cor exata e original intacto como prefixo.

**Achados e correções desta rodada**
1. O PDF.js 6 exige **Node ≥ 22.13** (o plano dizia 20). O requisito foi atualizado em todo lugar, e o pacote avisa com mensagem clara se o Node for antigo.
2. Fora do repositório, o PDF.js reclamava de um pacote nativo opcional (`@napi-rs/canvas`): 4 avisos assustadores em todo comando. Silenciados só esses avisos; no Node o labsign só lê o texto do PDF.
3. Arquivo inexistente ou que não é PDF dava erro cru do Node. Agora a mensagem é clara e traduzida no CLI, e o erro chega limpo ao modelo.
4. Tela: o marcador "Sua assinatura vai aqui" vazava da caixa em prévias pequenas (painel estreito, chat); agora escala com a caixa. O aviso "foi salva" recolhia sozinho e empurrava o painel no meio de um clique; agora só recolhe depois do próximo gesto. No celular, a dica de arrastar empurrava o quadro de desenho no primeiro traço; agora o espaço fica reservado.
5. Fechar a aba sem assinar deixava o CLI (e o modelo) esperando até 30 minutos. Agora encerra em ~3 s como cancelado; recarregar a página não conta.

**Revisão antes do primeiro commit (21/09/2026)**

Três revisões independentes: segurança, robustez do núcleo, tela e acessibilidade. Tudo que apareceu foi corrigido e ganhou teste (68 no total).
- **Crítico:** o link que abre a tela (com o token de uso único) ia para o modelo. Um agente com terminal podia abri-lo com `curl` e assinar sem a pessoa. Agora o link vai direto ao navegador ou ao app (elicitação). O modelo recebe uma URL sem token, que só reabre no navegador que já abriu (cookie). A tool nova `labsign_open_in_browser` é o plano B quando o painel não aparece. O SECURITY.md agora diz com clareza o limite de sempre: um agente com terminal roda como você.
- **Altos:**
  - Duas confirmações simultâneas, ou cancelar no meio do carimbo, geravam dois PDFs, ou um "cancelado" que tinha sido gravado. Agora há uma confirmação por vez, e o status é conferido de novo antes de gravar.
  - `xdg-open` ausente derrubava o servidor no Linux/WSL.
  - Só dava para escolher o PDF com mouse; o teclado não chegava lá.
  - Soltar o arquivo fora da área abria o PDF no lugar da tela e cancelava o pedido.
- **Médios:**
  - Âncora: agora escolhe o bloco de assinatura no fim do documento, não a menção no corpo do texto. Também encontra rótulos quebrados em pedaços e com ou sem acento.
  - Sessões: liberam memória, com limite de 20 pedidos abertos. Uma aba fechada não cancela o pedido aberto em outra.
  - Cofre: gravação atômica e trava no log de auditoria (evita bifurcar a cadeia com dois processos). Um arquivo corrompido não derruba a lista.
  - Recusas: PDF criptografado é recusado logo na abertura, e o nome `..` num PDF solto na tela não sai mais da pasta de saída.
  - CSP: com nonce, sem `'unsafe-inline'`.
  - Contraste: fica em pelo menos 3:1 nas bordas e 4,5:1 nos textos.
  - Tela: segue o tema do Claude Desktop, move o foco para os títulos de resultado e não duplica assinaturas ao tentar de novo.
  - CLI: lê argumentos com `parseArgs` estrito, e agentes esperam 90 s (não 15 min) depois de assinar.

**Segunda passada de segurança, antes de subir no GitHub (21/09/2026)**
- `npm audit`: 9 vulnerabilidades (4 críticas) em dependências só de desenvolvimento, nunca embutidas (`crypto-js` via `pdfkit`, que o teste de assinatura digital declara mas nunca carrega; `tmp` via o empacotador `.mcpb`). Resolvidas por `overrides` no `package.json`; agora zero.
- PDF criptografado passou a ser detectado pelo próprio pdf.js (`getPermissions()`), no mesmo carregamento das âncoras, em vez de uma busca textual por `/Encrypt` que podia errar; PDF danificado vira `NOT_PDF`. Teste com PDFs cifrados de verdade (senha de abertura e só de permissões).
- Erro inesperado (biblioteca, sistema de arquivos) não vai mais com o texto cru para a tela nem para o modelo; fica no stderr.
- `Sec-Fetch-Site` conferido no servidor local; traços recebidos da tela validados (números finitos, no máximo 400 traços e 60 mil pontos).
- `labsign_open_in_browser` não abre outra aba enquanto uma está aberta.
- O código do `spike/` saiu do repositório (fica só no disco do Paulo, e `spike/RESULTADOS.md` continua versionado): o protótipo tem a falha crítica corrigida no produto.
- CI com actions fixadas por hash de commit e `.github/dependabot.yml` (npm e actions, semanal).

**Publicado em 22/09/2026:** repositório [paullabs/labsign](https://github.com/paullabs/labsign) no ar (commit `eca0f4d`), tag e Release `v0.1.0` com o `.mcpb` anexado (SHA-256 conferido baixando de volta da Release). Dependabot já abriu PRs de atualização das actions no mesmo dia.

**Teste manual no Claude Desktop: feito e confirmado (22/09/2026).** O Paulo instalou o `.mcpb` (v0.1.1) no Claude Desktop real (2.2553.1), pediu para assinar um PDF numa conversa nova, e **o painel abriu dentro do chat** — a tela embutida via MCP Apps funciona de ponta a ponta no host real, não só nos testes automatizados. Confirmado por dois caminhos independentes: (1) o relato do Paulo; (2) evidência no próprio sistema de arquivos — `~/.labsign` foi criado com a migração das 2 assinaturas do protótipo cerca de 1 minuto depois da instalação, o que só acontece quando a tela chama de verdade a ferramenta interna `labsign_view_state`.

Isso também revelou um bug de diagnóstico (não de segurança): o Claude Desktop moderno instala `.mcpb` como extensão própria, numa pasta `Claude Extensions/` com metadados em `extensions-installations.json` — **não** editando `mcpServers` no `claude_desktop_config.json` como o `doctor` assumia. `doctor` dizia "not found" com tudo funcionando. Corrigido: `doctor` agora lê os dois formatos e mostra a versão instalada (ou avisa se a extensão está desativada). `LABSIGN_CLAUDE_DIR` isola essa checagem nos testes, como `LABSIGN_HOME` já fazia com o cofre.

**npm: publicado em 22/09/2026.** Conta `paullabs` criada na hora (2FA ativado antes do primeiro publish — o npm exige para qualquer publicação, mesmo de pacote novo). [`labsign@0.1.1`](https://www.npmjs.com/package/labsign) no ar; conferido de fora (metadados da API, hash do tarball, conteúdo baixado de volta, `npx labsign@0.1.1 --version` funcionando). `plugin/.mcp.json` passou a rodar `npx -y labsign@latest mcp` em vez de um servidor montado localmente — testei a instalação do plugin do zero, numa config isolada: `claude mcp list` mostra `✔ Connected`. Isso destrava instalar o plugin direto do GitHub, sem clonar/montar nada. A skill não vai no pacote do npm (é só para Claude Code/Codex); as instruções do Codex agora buscam ela do repositório com `curl`. `scripts/build-mcpb.mjs` não monta mais `plugin/server/` (ficou sem uso).

**Adiado:** importar foto da assinatura (estava no escopo original da Fase 1); rubrica em todas as páginas, CPF e data, `verify` (Fase 4).

**Nada mais pendente da Fase 1** — Claude Desktop, Claude Code, Codex e terminal testados; GitHub, npm e Releases publicados.

## 13.1 v0.1.1 — corrigido depois da primeira CI (22/09/2026)

A primeira execução da CI (gatilhada pelo push do `v0.1.0`) pegou um bug real: no job `dist (node 24, windows-latest)`, o teste de ponta a ponta do MCP falhava com `ECONNRESET` — só nessa combinação, os outros 5 jobs (Linux, macOS, Windows com Node 22) passaram.

**Causa:** o servidor local deixava a conexão HTTP em keep-alive (padrão do Node). Vários caminhos de erro (token errado, origem errada, `Sec-Fetch-Site` de fora) respondem sem drenar o corpo da requisição até o fim. Numa bateria de chamadas em sequência pela mesma conexão (como o teste faz, e como a tela real faz ao trocar de estado), isso deixa o socket num estado ambíguo para reaproveitar — no Windows, a chamada seguinte às vezes pega essa conexão já sendo fechada pelo servidor e cai com `ECONNRESET`. Em Linux/macOS o timing normalmente não expõe isso, mas o risco existe lá também.

Isso não é só um problema de teste: a tela de verdade também faz várias chamadas em sequência pela mesma origem, então um usuário Windows podia esbarrar nisso de vez em quando.

**Correção:** `Connection: close` em toda resposta do servidor local — sem keep-alive, sem essa classe de corrida. É um servidor de uso esporádico, o custo de um handshake a mais em `127.0.0.1` é irrelevante. Teste novo (`test/mcp.test.ts`) confere o cabeçalho.

Como já havia uma Release pública (`v0.1.0`) com o `.mcpb` anexado, a correção virou `v0.1.1` em vez de reescrever a tag já publicada.

## 13.2 v0.1.2 — GitHub e npm publicados em momentos diferentes, saíram dessincronizados (22/09/2026)

Publiquei `labsign@0.1.1` no npm depois do commit do doctor (`9a63e1e`), mas antes do commit seguinte (`fbbac26`, que corrigia os READMEs — inclusive um `git clone <repositório>` com placeholder nunca preenchido, que sobrou de antes do repositório existir). Resultado: o npm ficou com o README antigo e quebrado; a Release `v0.1.1` do `.mcpb` no GitHub, montada antes do commit do doctor, ficou sem essa correção. Nenhum dos dois lados tinha exatamente o que estava em `main`.

Sem mudança de código nesta versão — só sincroniza: `v0.1.2` é montada e publicada (GitHub Release + npm) do mesmo commit, de uma vez, depois de tudo já estar em `main`. Daqui em diante, publicar nos dois lugares no mesmo passo evita esse descompasso.

**Trava técnica, não só lembrete:** `scripts/check-release.mjs`, ligado a `prepublishOnly`, bloqueia `npm publish` (com mensagem clara) a menos que: a árvore esteja limpa, exista uma tag `v<versão do package.json>` apontando exatamente para `HEAD`, `HEAD` seja igual a `origin/main`, e — se o `gh` CLI estiver disponível — a Release correspondente já exista no GitHub. Testado nos dois sentidos: bloqueia em 4 cenários quebrados (sem tag, tag em outro commit, HEAD à frente do remoto, sem Release) e passa limpo no estado bom. Não depende de eu lembrar a ordem certa da próxima vez.

---

## 14. Fontes (consultadas em 21/09/2026)

- MCP Apps — spec e SDK: https://github.com/modelcontextprotocol/ext-apps · https://modelcontextprotocol.io/extensions/apps/overview · matriz de clientes: https://modelcontextprotocol.io/extensions/client-matrix
- MCP Apps no Claude: https://claude.com/docs/connectors/building/mcp-apps/getting-started
- Exemplo pdf-server / plugin pdf-viewer: https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/pdf-server · https://github.com/anthropics/knowledge-work-plugins/tree/main/pdf-viewer
- Elicitação (URL mode): https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation · changelog do Claude Code: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Codex — MCP e config: https://learn.chatgpt.com/docs/extend/mcp · https://learn.chatgpt.com/docs/config-file/config-reference · skills: https://learn.chatgpt.com/docs/build-skills
- ChatGPT Apps SDK: https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
- PDF-Tools: https://github.com/Open-Document-Alliance/PDF-Tools
- Bibliotecas: https://github.com/cantoo-scribe/pdf-lib · https://github.com/LibPDF-js/core · https://github.com/steveruizok/perfect-freehand · https://github.com/szimek/signature_pad
- Legislação: MP 2.200-2 https://www.planalto.gov.br/ccivil_03/mpv/antigas_2001/2200-2.htm · Lei 14.063 https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2020/lei/l14063.htm · CPC https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2015/lei/l13105.htm
- gov.br assinatura (só órgãos públicos): https://www.gov.br/governodigital/pt-br/identidade/assinatura-eletronica/assinatura-eletronica-para-orgaos
- **Seção 12 — chat e envio:**
  - ChatGPT Apps: https://developers.openai.com/plugins/reference · https://developers.openai.com/plugins/build/chatgpt-ui · https://developers.openai.com/plugins/app-guidelines · https://developers.openai.com/plugins/deploy/submission · túnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels · relatos de falha do `fileParams`: https://github.com/openai/openai-apps-sdk-examples/issues/237 e /185
  - Claude: https://claude.com/docs/connectors/building/index · https://claude.com/docs/connectors/building/mcp-apps/external-links · https://claude.com/docs/connectors/building/review-criteria · uploads de arquivo no MCP (em rascunho): https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631 · `downloadFile` no iOS: https://github.com/modelcontextprotocol/ext-apps/issues/574 · bugs do Desktop local: https://github.com/anthropics/claude-ai-mcp/issues/165 · /563 · /729
  - Compartilhar arquivos (Web Share): https://chromestatus.com/feature/5668769141620736 · https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share · https://developer.chrome.com/blog/web-share-api-in-third-party-iframes
  - WhatsApp: https://faq.whatsapp.com/5913398998672934 · https://developers.facebook.com/docs/whatsapp/messaging-limits · `mailto:` sem anexo: https://www.rfc-editor.org/rfc/rfc6068
  - E-mail hospedado: https://resend.com/docs/dashboard/emails/attachments · https://aws.amazon.com/ses/pricing · https://support.google.com/a/answer/81126
  - LGPD: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm · ANPD, Radar Tecnológico nº 2 (biometria): https://www.gov.br/anpd/pt-br/centrais-de-conteudo/documentos-tecnicos-orientativos/radar-tecnologico-biometria-anpd.pdf
