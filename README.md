# labsign

Assine PDFs com a sua própria assinatura sem sair do Claude, do Codex ou do terminal. Local, sem conta, sem nuvem.

[English](README.en.md)

Você diz "assina esse contrato". Abre uma tela, você desenha a assinatura (ou escolhe uma já salva), arrasta até o lugar certo e confirma. Sai uma cópia assinada ao lado do original. Ninguém edita o documento e você não precisa pedir para a IA refazer nada. As assinaturas ficam guardadas no seu computador, como no iPhone.

## O que ele faz

- **Desenhar:** com mouse, trackpad ou dedo. Dá para segurar e arrastar (padrão) ou usar o clique para escrever (um clique abaixa a caneta, outro levanta). Há três espessuras de caneta e três tintas: azul-marinho, azul e preta.
- **Pacote de assinaturas:** salve quantas quiser, use a última com um clique e apague as que não servem mais.
- **Prévia de verdade:** a página do PDF aparece com a assinatura por cima. Dá para arrastar, redimensionar (também pelo teclado), trocar de página ou tirar a assinatura dali. O que você vê é o que sai no PDF.
- **Acha o lugar sozinho:** procura o texto do bloco de assinatura (ex.: `CONTRATANTE`) e propõe a posição logo acima. Se não achar, propõe a última página e você arrasta.
- **Não estraga o original:** gera `contrato.assinado.pdf` (ou `.assinado-2.pdf`…) e nunca sobrescreve nada. Salva de forma incremental, então assinaturas digitais que já existiam no PDF continuam válidas.
- **Registro de evidências:** para cada assinatura, grava a data e a hora e o SHA-256 do original e do assinado num log encadeado por hash.
- **Enviar ou guardar:** depois de assinar, você pode baixar o arquivo, mostrá-lo na pasta, compartilhar (Mail, Mensagens, AirDrop…, quando o sistema permite), enviar por e-mail (Gmail ou o seu app) ou mandar pelo WhatsApp. No e-mail e no WhatsApp, a mensagem abre pronta e você anexa o PDF.
- **PT e EN:** a tela segue a língua do seu sistema.

## Instalar

### Claude Desktop

1. Baixe o `labsign-<versão>.mcpb` na [página de Releases](https://github.com/paullabs/labsign/releases), ou gere o arquivo você mesmo (veja [Desenvolvimento](#desenvolvimento)).
2. Dê dois cliques no arquivo (ou arraste-o em **Configurações → Extensões**) e clique em **Instalar**.
3. Numa conversa, peça: _"assina o contrato que está em ~/Downloads/contrato.pdf"_. Se você só anexou o PDF na conversa, diga _"quero assinar esse PDF"_: a tela vai pedir para você soltar o arquivo nela, porque o Claude não repassa anexos para extensões.

A tela abre dentro da conversa nas versões do Claude Desktop que suportam MCP Apps. Nas outras, abre no navegador. Se o Claude Desktop pedir Node.js, instale a versão LTS em [nodejs.org](https://nodejs.org).

### Claude Code

```bash
claude plugin marketplace add paullabs/labsign
claude plugin install labsign@labsign
```

O plugin busca o servidor MCP do [npm](https://www.npmjs.com/package/labsign) (via `npx`, na hora de usar) e já traz a skill que ensina o Claude Code a usar o labsign. Como o Claude Code roda no terminal, a tela abre no navegador.

### Codex

```bash
codex mcp add labsign -- npx -y labsign@latest mcp
mkdir -p ~/.agents/skills/labsign
curl -fsSL https://raw.githubusercontent.com/paullabs/labsign/main/plugin/skills/labsign/SKILL.md -o ~/.agents/skills/labsign/SKILL.md
```

O Codex corta as ferramentas em 60 segundos. Por isso o labsign responde em até 45 segundos e depois acompanha a assinatura pelo `labsign_status`. A skill não vai dentro do pacote do npm (é específica do Codex/Claude Code), por isso o `curl` busca ela direto do repositório.

### Terminal (e qualquer outro app)

```bash
npm install -g labsign
labsign sign contrato.pdf --anchor CONTRATANTE
```

| Comando | O que faz |
| --- | --- |
| `labsign sign <arquivo.pdf> [--anchor TEXTO]` | Abre a tela para assinar e espera você terminar |
| `labsign sign` | Abre a tela pedindo o PDF (você solta o arquivo nela) |
| `labsign add` | Abre a tela para desenhar e salvar assinaturas |
| `labsign list` | Lista as assinaturas salvas (só os nomes) |
| `labsign doctor` | Confere o ambiente e mostra o comando exato para conectar cada app. Não altera nada |
| `labsign mcp` | Servidor MCP (stdio), para apps que falam MCP (Cursor etc.) |

Requer Node.js 22.13 ou mais novo.

### Configuração (opcional)

| Variável | Para quê |
| --- | --- |
| `LABSIGN_HOME` | Pasta do cofre (padrão: `~/.labsign`) |
| `LABSIGN_OUTPUT_DIR` | Onde fica a cópia assinada de um PDF solto na tela (padrão: `~/Downloads`) |
| `LABSIGN_LANG` | `pt` ou `en`, no terminal e na tela |
| `LABSIGN_BROWSER` | Programa que abre a tela, no lugar do navegador padrão |
| `LABSIGN_NO_OPEN=1` | Não abre navegador nem pasta: o terminal mostra o link para você abrir |
| `LABSIGN_UI` | `auto` (padrão), `inline` ou `browser`: força onde a tela aparece nos apps de chat |

## Privacidade e segurança

- **Tudo acontece no seu computador.** A tela é servida em `127.0.0.1`, numa porta aleatória, por um link de uso único. Nada vai para a internet e não há telemetria.
- **O labsign não mostra a sua assinatura à IA.** Ela só abre a tela e recebe o resultado (o nome do arquivo assinado). O link que abre a tela vai direto para o seu navegador; as ferramentas internas da tela exigem um token que só a tela recebe.
- **Nada é assinado sem o seu clique.** Um agente com acesso ao terminal (Claude Code, Codex) roda como você: veja os limites em [SECURITY.md](SECURITY.md).
- **Cofre em `~/.labsign`**, com permissões só para o seu usuário: as assinaturas (os traços), as preferências e o `audit.log`.

Detalhes e limites em [SECURITY.md](SECURITY.md).

## Validade jurídica (Brasil)

O labsign faz uma assinatura eletrônica simples: a imagem da sua assinatura no PDF, mais o registro de evidências (data e hora, SHA-256 do original e do assinado). Entre particulares, ela vale quando as partes aceitam esse meio (MP 2.200-2/2001, art. 10, § 2º). Não é assinatura com certificado digital ICP-Brasil. Se o ato exige certificado (alguns atos com órgãos públicos, registros e cartórios), use um. Isto não é aconselhamento jurídico.

## Desenvolvimento

```bash
npm ci
npm run build       # dist/labsign.js (CLI + MCP) e dist/ui.html, dist/ui-app.html (a tela)
npm test            # build + testes (precisa do Node 24; o poppler é opcional e ativa as checagens de pixel)
npm run typecheck
npm run mcpb        # dist/labsign-<versão>.mcpb (instalador do Claude Desktop)
```

| Pasta | Conteúdo |
| --- | --- |
| `src/core` | assinatura (traços → contornos), posicionamento, carimbo no PDF, âncoras, cofre, sessões |
| `src/http` | servidor local da tela (só `127.0.0.1`) |
| `src/mcp` | servidor MCP: tela embutida (MCP Apps) ou página no navegador |
| `src/ui` | a tela: um HTML único, sem dependências externas em tempo de execução |
| `src/cli` | comandos `sign`, `add`, `list`, `doctor`, `mcp` |
| `src/i18n` | textos em PT e EN |
| `plugin/` | plugin do Claude Code e skill (também serve para o Codex) |
| `mcpb/` | manifest e ícone da extensão do Claude Desktop |

Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

MIT. As bibliotecas embutidas e as licenças delas estão em `dist/THIRD_PARTY_LICENSES.txt`.
