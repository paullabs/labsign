# Segurança · Security

## Como reportar · Reporting

Encontrou uma falha? Abra um aviso privado no GitHub (**Security → Report a vulnerability**) em vez de uma issue pública. Respondemos o quanto antes.

Found a vulnerability? Please open a private advisory on GitHub (**Security → Report a vulnerability**) instead of a public issue.

## O que o labsign protege

O labsign é uma ferramenta local. Ele guarda desenhos de assinatura, que são dados pessoais sensíveis (provavelmente biométricos, pela LGPD), e escreve PDFs em seu nome. A regra é que só você, na tela do labsign, assina, e ninguém mais lê as suas assinaturas.

| Ameaça | Defesa |
| --- | --- |
| **Outro site aberto no navegador** tenta falar com o servidor local (CSRF, DNS rebinding) | Escuta só em `127.0.0.1`, em porta aleatória. Recusa `Host` diferente de `127.0.0.1:<porta>`, `Origin` de fora e `Sec-Fetch-Site` que não seja da própria página. Depois da abertura, vale um cookie `HttpOnly; SameSite=Strict` da sessão mais um token de visualização. CSP com nonce por resposta (sem `'unsafe-inline'` para scripts), `frame-ancestors 'none'`, `no-referrer`, `nosniff`, `no-store` |
| **A IA ou um prompt injection** tenta assinar sozinho ou ler a assinatura | O link que abre a tela (com o token de uso único) vai direto para o seu navegador ou para o app de chat, por elicitação. O modelo recebe só um endereço sem token, que não abre nada fora do navegador que já abriu a tela. O link com token só vai para o modelo repassar quando não há navegador para abrir. No terminal, o `labsign sign` só imprime o link com token quando o navegador não abriu. As ferramentas internas da tela exigem um token que só a tela recebe. Confirmar exige o clique da pessoa. Nenhuma ferramenta devolve o desenho |
| **Link vazado** (histórico, print, outra pessoa na máquina) | Cada pedido abre uma vez só: outro navegador recebe 409 e fica no log de auditoria. Sem o token, o endereço só reabre no navegador que abriu primeiro (cookie). O pedido expira em 30 minutos |
| **Sobrescrever ou estragar o documento** | O original nunca é alterado. A cópia assinada é criada com `wx`, que falha em vez de sobrescrever. O salvamento é incremental: o original é prefixo exato do assinado, e assinaturas digitais anteriores continuam válidas. PDFs criptografados são recusados logo na abertura |
| **Duplo clique, duas abas, cancelar no meio** | Uma confirmação por vez. O status é conferido de novo antes de gravar: pedido cancelado ou expirado durante o carimbo não gera arquivo. Encerrado, o pedido não muda mais nem mexe no cofre |
| **Outros usuários do mesmo computador** | `~/.labsign` com `0700` e os arquivos com `0600` |
| **PDF malicioso** | O PDF.js 6 não usa `eval` nem `new Function`, e nada do PDF é executado. PDFs enviados pela tela têm limite de 30 MB e precisam começar com `%PDF-`; danificados ou com senha (mesmo só de permissões) são recusados ao abrir, com erro próprio. O nome do arquivo recebido é limpo (sem separadores, sem `..`) antes de virar o nome da cópia assinada. Traços recebidos da tela são validados (números finitos, quantidade limitada). Erros inesperados vão só para o stderr, nunca com detalhes para a tela ou para o modelo |
| **Esgotar memória ou encher a tela de abas** | No máximo 20 pedidos abertos ao mesmo tempo. O PDF sai da memória 1 h depois de encerrado o pedido. Corpo das requisições limitado (30 MB o PDF, 5 MB o resto) |
| **Adulteração do histórico** | `audit.jsonl` encadeado por SHA-256: cada evento carrega o hash do anterior, e `labsign doctor` confere a cadeia. Gravações de processos diferentes (o app de chat e o terminal ao mesmo tempo) passam por uma trava de arquivo |

## Limites (o que ele NÃO garante)

- **O log é evidente, não inviolável.** Quem tem acesso à sua conta no computador pode reescrever a cadeia inteira. O log mostra que o histórico foi mexido; não impede.
- **O PDF assinado carrega a imagem da sua assinatura.** Quem recebe o arquivo pode copiá-la, como acontece com qualquer papel assinado e escaneado. Mande só para quem deve receber.
- **Não é certificado digital.** Não substitui uma assinatura ICP-Brasil (ou qualificada/avançada em outros países) quando a lei exige.
- **Um agente com terminal roda como você.** Claude Code, Codex e o Claude Desktop com extensões de terminal executam comandos com as suas permissões. Um agente mal-intencionado, ou enganado por um documento (prompt injection), pode ler `~/.labsign` e os PDFs que você já assinou, como qualquer programa seu. O labsign não entrega à IA o link da tela nem o desenho, mas isso não é barreira contra um agente decidido a burlar. Revise os comandos que o agente pede para rodar e desconfie de qualquer um que mexa em `~/.labsign` ou chame `127.0.0.1`.
- **Programas rodando como você** (malware, extensões) podem ler `~/.labsign`, como leriam qualquer arquivo seu.
- **Sem criptografia em repouso** na v1. O cofre depende das permissões do sistema e da criptografia de disco (FileVault, BitLocker…).

## Cadeia de entrega

- Cada artefato é um arquivo só (`dist/labsign.js`, `dist/ui.html`, `dist/ui-app.html`), montado do código-fonte pelo `npm run build`, sem nada baixado em tempo de execução. As bibliotecas embutidas e as licenças estão em `dist/THIRD_PARTY_LICENSES.txt`.
- `npm audit` sem vulnerabilidades no lançamento; o Dependabot acompanha as dependências e as actions da CI, que são fixadas por hash do commit.
- O código do protótipo (Fase 0) não está no repositório: ele entregava ao modelo o link que abre a tela.
- Ao instalar um `.mcpb` ou um pacote do npm, confira que veio da página de Releases ou do pacote `labsign` oficial. O SHA-256 do `.mcpb` é publicado em cada Release.

## Rede

O labsign não faz nenhuma chamada de rede. O servidor local só atende `127.0.0.1`. Os botões "Abrir no Gmail" e "Abrir o WhatsApp" só abrem o seu navegador ou app, e quem envia é você.
