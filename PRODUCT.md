# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pessoas comuns, não desenvolvedoras (confirmado por Paulo em 22/09/2026), assinando contratos e documentos de 10 a 60 páginas que uma IA preparou ou recebeu, na maioria das vezes dentro do chat do Claude. Num documento longo elas não sabem onde fica o lugar da assinatura, e se perdem quando a tela não mostra por onde entrar e por onde sair de cada etapa.

Público secundário: devs no Claude Code, no Codex e no terminal, que usam a mesma tela aberta no navegador.

## Product Purpose

Assinar um PDF com a própria assinatura desenhada, sem sair da IA e sem editar o documento: abrir o documento certo, achar o lugar, assinar, e mandar ou guardar o PDF assinado.

Sucesso: a pessoa assina o documento certo, no lugar certo, e entrega o arquivo (e-mail, WhatsApp, pasta) sem ficar perdida e sem precisar de ajuda.

## Positioning

Local e sem conta: a assinatura, o documento e o cofre nunca saem do computador. Só a pessoa assina; a IA só abre a tela, e não recebe nem o desenho nem o link que abre a tela. O que aparece na prévia é exatamente o que sai no PDF, e o original nunca é sobrescrito (salvamento incremental; assinaturas digitais anteriores continuam válidas).

## Operating Context

- **Duas superfícies, a mesma tela:** (1) embutida no chat via MCP Apps, num iframe com poderes limitados — não baixa nem compartilha arquivo sozinho, e links e download dependem do app de chat; (2) no navegador, servida em `127.0.0.1`.
- **O servidor local roda no computador da pessoa** e pode fazer o que o iframe não faz: salvar numa pasta escolhida, mostrar na pasta, abrir o app de e-mail já com o anexo, pôr o arquivo na área de transferência.
- **Documentos reais:** contratos brasileiros (prestação de serviços, locação…) de 10 a 60 páginas, com o bloco de assinatura perto do fim (no teste real de Paulo, página 13) e rótulos como CONTRATANTE, CONTRATADA, TESTEMUNHAS. Alguns são escaneados, sem texto pesquisável.
- **Entrega:** Paulo usa Gmail no navegador, Apple Mail e Outlook; o WhatsApp dele é a versão web (sem app de computador instalado).
- **Fluxo típico:** a IA prepara ou recebe o contrato → a pessoa pede para assinar → a tela abre → a pessoa assina → manda para a outra parte.

## Capabilities and Constraints

- Hoje: desenho da assinatura (segurar e arrastar, ou clique para escrever), cofre local de assinaturas, tinta (3 cores) e traço (3 espessuras), âncora por texto, prévia com arrastar e redimensionar, salvamento incremental, registro de evidências com hash encadeado, PT/EN, claro/escuro e o tema do app de chat.
- Limites de plataforma: links de e-mail e de WhatsApp não carregam anexo; envio automático pelo WhatsApp pessoal não existe (não há API para pessoa física) — quem envia é sempre a pessoa.
- Uma página HTML só, sem dependências externas em tempo de execução. O pdf.js roda na thread principal (sem worker), então renderizar muitas páginas tem de ser preguiçoso.
- Decidido: rubrica em todas as páginas fica para depois (Paulo, 22/09/2026). Serviço hospedado fica fora até validar o uso local.
- Em aberto: fluxo e visual novos — a tela atual foi considerada "esquisita" no fluxo e no visual (Paulo, 22/09/2026).

## Brand Commitments

- Nome labsign, autor Paulo Labs, open source (MIT).
- Tom sério e simples, "mas não pode faltar nada para que não atrapalhe o fluxo de assinatura de documentos" (Paulo, 21/09/2026).
- Todo texto em PT-BR e EN.
- Ícone atual: pena branca sobre quadrado azul-marinho (`mcpb/icon.png`).

## Evidence on Hand

- Teste real de Paulo em 22/09/2026: contrato de prestação de serviços, assinatura na página 13, assinado pelo painel dentro do chat.
- Nenhum depoimento, cliente, número de uso ou comparativo existe; não inventar.

## Product Principles

1. Só a pessoa assina; a IA nunca desenha nem confirma por ela.
2. O que aparece na tela é o que sai no PDF.
3. Toda etapa tem entrada e saída visíveis: dá para trocar o documento, voltar, desfazer e fechar sem se perder.
4. O computador faz o trabalho pesado da entrega (anexar, salvar, copiar), o mais perto possível de um clique — sem fingir uma automação que a plataforma não permite.
5. Nada sai do computador sem a pessoa mandar.

## Accessibility & Inclusion

- Teclado e leitor de tela em todos os controles, com o foco levado ao resultado depois de assinar.
- Contraste WCAG: pelo menos 4,5:1 em texto e 3:1 em bordas de controle; respeito a `prefers-reduced-motion` e a `forced-colors`.
- Público leigo: textos claros, sem jargão técnico.
