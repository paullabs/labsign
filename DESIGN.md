---
name: labsign
description: "Talão de vias para assinar PDF sem sair da IA: o original fica, a via assinada se destaca pelo picote, o canhoto guarda o registro."
colors:
  # tema claro: os mesmos nomes das variáveis CSS de src/ui/index.html
  tinta: "#15205c"
  tinta-2: "#414b7e"
  pauta: "#737a9e"
  pauta-leve: "#cfd2e2"
  carbono: "#3a3fb2"
  carbono-forte: "#2c3093"
  carbono-leve: "#e4e5f7"
  carbono-tinta: "#ffffff"
  numeradora: "#bd2a1f"
  numeradora-leve: "#f9e4e1"
  canhoto: "#f4e8a6"
  canhoto-2: "#eadb8a"
  via: "#ffffff"
  chao: "#e3e5ee"
  # fixos nos dois temas: o papel do documento e as tintas reais da assinatura
  papel: "#ffffff"
  ink-navy: "#0d1a59"
  ink-blue: "#1f3fa8"
  ink-black: "#161616"
  # tema escuro: mesma função, valor trocado
  tinta-escuro: "#e8eaf7"
  tinta-2-escuro: "#b3b8d6"
  pauta-escuro: "#6f76a8"
  pauta-leve-escuro: "#30345e"
  carbono-escuro: "#9ca1f5"
  carbono-forte-escuro: "#b7bbf8"
  carbono-leve-escuro: "#262a55"
  carbono-tinta-escuro: "#0b0d1e"
  numeradora-escuro: "#ff8a7e"
  numeradora-leve-escuro: "#3a1f2a"
  numeradora-texto-escuro: "#1a0b0b"
  rotulo-escuro: "#ead67a"
  canhoto-escuro: "#1d2040"
  canhoto-2-escuro: "#2a2e57"
  via-escuro: "#151831"
  chao-escuro: "#0b0d1e"
typography:
  headline:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "0.005em"
  title:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.15
  title-sm:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "0.005em"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm-strong:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.5
  body-xs:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  button:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "13.5px"
    fontWeight: 650
  button-principal:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "15px"
    fontWeight: 650
  label:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
  label-lugar:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.04em"
  numero:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.06em"
    fontFeature: "tnum"
  numero-folha:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.04em"
    fontFeature: "tnum"
  carimbo:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.1em"
  carimbo-grande:
    fontFamily: "Labsign Form, Arial Narrow, Helvetica Neue, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.14em"
rounded:
  r: "3px"
  r-fino: "2px"
  circulo: "50%"
spacing:
  gap-acoes: "8px"
  gutter-compacto: "14px"
  gutter-via: "16px"
  gutter-canhoto: "18px"
  pad-dialogo: "22px"
  pad-folha: "26px"
components:
  btn:
    backgroundColor: "transparent"
    textColor: "{colors.tinta}"
    typography: "{typography.button}"
    rounded: "{rounded.r}"
    padding: "0 16px"
    height: "40px"
  btn-hover:
    backgroundColor: "{colors.carbono-leve}"
    textColor: "{colors.carbono}"
  btn-principal:
    backgroundColor: "{colors.carbono}"
    textColor: "{colors.carbono-tinta}"
    typography: "{typography.button-principal}"
    rounded: "{rounded.r}"
    padding: "0 22px"
    height: "44px"
  btn-principal-hover:
    backgroundColor: "{colors.carbono-forte}"
    textColor: "{colors.carbono-tinta}"
  btn-discreto:
    backgroundColor: "transparent"
    textColor: "{colors.tinta-2}"
    typography: "{typography.button}"
    rounded: "{rounded.r}"
    padding: "0 16px"
    height: "40px"
  btn-discreto-hover:
    backgroundColor: "{colors.carbono-leve}"
    textColor: "{colors.tinta}"
  btn-perigo:
    backgroundColor: "{colors.numeradora}"
    textColor: "{colors.papel}"
    typography: "{typography.button}"
    rounded: "{rounded.r}"
    padding: "0 16px"
    height: "40px"
  btn-pequeno:
    padding: "0 12px"
    height: "32px"
  link-btn:
    backgroundColor: "transparent"
    textColor: "{colors.tinta}"
    typography: "{typography.body-sm-strong}"
    padding: "2px 0"
  link-btn-hover:
    textColor: "{colors.carbono}"
  icone-btn:
    backgroundColor: "transparent"
    textColor: "{colors.tinta}"
    typography: "{typography.body-sm-strong}"
    rounded: "{rounded.r}"
    padding: "0 8px"
    height: "32px"
    width: "32px"
  icone-btn-ativo:
    backgroundColor: "{colors.carbono-leve}"
    textColor: "{colors.carbono}"
  campo-texto:
    backgroundColor: "{colors.via}"
    textColor: "{colors.tinta}"
    typography: "{typography.body}"
    rounded: "{rounded.r}"
    padding: "0 10px"
    height: "38px"
  lugar:
    backgroundColor: "transparent"
    textColor: "{colors.tinta}"
    typography: "{typography.label-lugar}"
    rounded: "{rounded.r}"
    padding: "8px 8px 8px 6px"
  lugar-hover:
    backgroundColor: "{colors.canhoto-2}"
  lugar-escolhido:
    backgroundColor: "{colors.carbono-leve}"
    textColor: "{colors.carbono}"
  seg-escolhido:
    backgroundColor: "{colors.carbono}"
    textColor: "{colors.carbono-tinta}"
    rounded: "{rounded.r-fino}"
    padding: "3px 9px"
  amostra:
    rounded: "{rounded.circulo}"
    size: "24px"
  carimbo:
    backgroundColor: "transparent"
    textColor: "{colors.carbono}"
    typography: "{typography.carimbo}"
    rounded: "{rounded.r-fino}"
    padding: "1px 6px 0"
  carimbo-cancelado:
    textColor: "{colors.numeradora}"
  carimbo-grande:
    typography: "{typography.carimbo-grande}"
    padding: "3px 12px 2px"
  numero:
    textColor: "{colors.numeradora}"
    typography: "{typography.numero}"
  canhoto:
    backgroundColor: "{colors.canhoto}"
    textColor: "{colors.tinta}"
    width: "300px"
  campo:
    textColor: "{colors.tinta}"
    padding: "14px 18px 16px"
  assinatura-linha:
    backgroundColor: "{colors.papel}"
    rounded: "{rounded.r-fino}"
    padding: "0 8px 4px"
    height: "58px"
  assinatura-linha-copia:
    backgroundColor: "transparent"
    textColor: "{colors.carbono}"
  folha:
    backgroundColor: "{colors.papel}"
  recado:
    backgroundColor: "{colors.tinta}"
    textColor: "{colors.via}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.r}"
    padding: "10px 14px"
  recado-erro:
    backgroundColor: "{colors.numeradora}"
    textColor: "{colors.papel}"
  recado-erro-escuro:
    backgroundColor: "{colors.numeradora-escuro}"
    textColor: "{colors.numeradora-texto-escuro}"
  aviso:
    backgroundColor: "{colors.canhoto}"
    textColor: "{colors.tinta}"
    typography: "{typography.body-sm}"
    padding: "9px 16px"
  aviso-escuro:
    backgroundColor: "{colors.carbono-leve-escuro}"
    textColor: "{colors.tinta-escuro}"
  guia:
    backgroundColor: "{colors.carbono-leve}"
    textColor: "{colors.tinta}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.r}"
    padding: "12px 14px"
  dlg:
    backgroundColor: "{colors.via}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.r}"
    padding: "22px 22px 18px"
    width: "min(620px, calc(100vw - 24px))"
---

# Design System: labsign

## Overview

**Creative North Star: "O Talão de Vias"**

A tela inteira é um talão de recibo com carbono. À esquerda fica o canhoto, em papel canário de 2ª via, com campos pautados que guardam o registro: o documento, onde assinar, a assinatura escolhida, o histórico e o Nº do registro em vermelho de numeradora. No meio, o picote serrilhado. À direita, a via branca com o documento inteiro, a assinatura já sentada na linha e uma régua de páginas para achar o bloco de assinatura no meio de 60 páginas. Assinar destaca a via pelo picote: ela vira a folha de entrega, carimbada ASSINADO, e o canhoto fica com a cópia em azul de carbono. Desfazer carimba CANCELADO.

O formulário é impresso numa cor só, o azul-marinho do ícone, com rótulos em letra estreita e caixa alta, como num impresso de gráfica. O que a pessoa já fez ou escolheu aparece em azul de carbono, como um decalque; o vermelho da numeradora fica para o Nº, o CANCELADO e os erros. A densidade é de formulário: campos curtos, linhas pautadas, texto que explica em uma frase e um botão que diz o que vai acontecer. É liso, sem textura: formulário, não fantasia de papel.

O documento manda na tela. As páginas do PDF são papel branco nos dois temas, a assinatura aparece nelas na tinta real, e o que se vê é o que sai no PDF. O único movimento com peso é a via se soltando do canhoto; o resto fica quieto. A tese recusa três coisas, e elas continuam recusadas: stepper numerado, zona de soltar como tela principal e grade de cartões brancos.

**Key Characteristics:**
- Canhoto, picote e via sempre juntos na tela; no chat, o canhoto sobe e o picote deita.
- Uma cor de impressão (`tinta`), uma cor de feito ou escolhido (`carbono`) e um vermelho de numeradora de uso contado.
- Letra estreita Labsign Form (Archivo Narrow 600) para o que é impresso; fonte do sistema para o que se lê.
- Estado dito com cinco sinais: linha pautada vazia, azul de carbono, carimbo ASSINADO, carimbo CANCELADO e esmaecido.
- Papel branco para o documento e para a tinta real da assinatura, nos dois temas.
- Um momento marcante: a via se destaca pelo picote e o carimbo bate.

## Colors

Um formulário impresso numa cor só, sobre dois papéis (canário e branco), com um azul de decalque para o que foi feito e um vermelho de numeradora de uso contado.

### Primary
- **Azul de Carbono** (#3a3fb2, `carbono`): o decalque. Marca o que está escolhido ou feito e a próxima ação: o marcador e o rótulo do lugar escolhido, a assinatura escolhida, a página atual e os lugares na régua, o botão principal, o carimbo ASSINADO, a cópia da assinatura no canhoto depois de assinar, o anel de foco e o retorno de hover. Ícones de ação também levam carbono.
- **Carbono Forte** (#2c3093, `carbono-forte`): o hover do botão principal.
- **Carbono Leve** (#e4e5f7, `carbono-leve`): o fundo do que foi escolhido (linha do lugar, item da lista de assinaturas), o hover de botões e a caixa de guia da entrega. Carbono sobre carbono leve dá 6,65:1.
- **Branco sobre Carbono** (#ffffff, `carbono-tinta`): texto e ícone sobre o preenchimento de carbono (8,29:1).

### Secondary
- **Vermelho de Numeradora** (#bd2a1f, `numeradora`): o Nº do registro (4,82:1 no canário), o carimbo CANCELADO, os erros (ícone do aviso de erro, recado de erro, erro ao receber o PDF) e a confirmação destrutiva (Apagar, Desfazer, hover da lixeira).
- **Numeradora Leve** (#f9e4e1, `numeradora-leve`): o fundo da linha que pergunta "Apagar …?" e do hover da lixeira.

### Tertiary
- **Canário de 2ª Via** (#f4e8a6, `canhoto`): o papel do canhoto e do cofre; no claro, também a faixa de aviso sobre o documento.
- **Canário Fundo** (#eadb8a, `canhoto-2`): o hover das linhas do canhoto (lugares e assinaturas).

### Neutral
- **Tinta de Impressão** (#15205c, `tinta`): todo texto impresso, a borda e o texto do botão comum, o fundo do recado. 12,16:1 no canário, 15,08:1 no branco.
- **Tinta Leve** (#414b7e, `tinta-2`): o texto de apoio — metadados, notas do pé e da entrega, o nome sob a assinatura, as horas do histórico, o botão discreto (6,69:1 no canário).
- **Pauta** (#737a9e, `pauta`): as linhas do formulário e as bordas de controle — divisão entre campos do canhoto, borda de campo de texto, do segmentado e dos lugares no modo compacto, anel do marcador vazio, trilho e traços da régua, sublinhado dos links. 3,38:1 no canário e 4,19:1 no branco: passa os 3:1 de borda de controle.
- **Pauta Leve** (#cfd2e2, `pauta-leve`): divisões que não são controle — sob a barra da via e a busca, entre os grupos da entrega, o fio em volta das miniaturas de assinatura.
- **Via** (#ffffff, `via`): a superfície da via, do pé, dos diálogos e dos campos de texto. Segue o tema.
- **Chão** (#e3e5ee, `chao`): a mesa sob as folhas do PDF. Aparece pelos furos do picote e pelo rasgo quando a via se destaca.
- **Papel** (#ffffff, `papel`): o papel do documento, fixo nos dois temas — páginas do PDF, miniaturas, a linha da assinatura enquanto pendente, o quadro de desenho.
- **Tintas da assinatura** (`ink-navy` #0d1a59, `ink-blue` #1f3fa8, `ink-black` #161616): as três únicas cores que a assinatura pode ter no PDF. Aparecem nas amostras de cor e na prévia pendente, sempre sobre `papel`. O azul-marinho é o mesmo do quadrado do ícone do app.

### Tema escuro
No escuro, o chão e as folhas viram papel-carbono: `chao-escuro` (#0b0d1e) é a mesa, `via-escuro` (#151831) é a via e `canhoto-escuro` (#1d2040) é o canhoto, um azul-marinho um pouco mais claro que a via. O canário sai do papel e sobrevive só como a cor dos rótulos (`rotulo-escuro`, #ead67a, 10,8:1 no canhoto); no claro, o rótulo é `tinta`. O carbono clareia para lavanda (`carbono-escuro`, #9ca1f5) com `carbono-tinta-escuro` por cima, e a numeradora vira salmão (`numeradora-escuro`, #ff8a7e), que pede texto escuro (`numeradora-texto-escuro`, #1a0b0b, 8,38:1). A faixa de aviso troca o canário por `carbono-leve-escuro`. O tema segue `prefers-color-scheme`, a menos que o app de chat mande `data-theme`; os dois blocos de CSS têm os mesmos valores.

### Named Rules
**A Regra da Impressão de Uma Cor.** Todo texto, linha e borda impressos saem de `tinta`, `tinta-2`, `pauta` ou `pauta-leve`. Não existe cinza neutro nem segunda cor de texto: os "cinzas" do sistema são azul-marinho diluído.

**A Regra do Decalque.** `carbono` quer dizer "feito, escolhido ou a próxima ação", e nada mais. O que é só impresso nunca é carbono.

**A Regra da Numeradora.** Vermelho só no Nº, no carimbo CANCELADO, em erros e na confirmação de uma ação destrutiva. Se não é número, cancelamento ou erro, não é vermelho.

**A Regra do Papel Branco.** O documento e a tinta real ficam em `papel` nos dois temas. O que se desenha sobre esse papel (moldura e alça da assinatura, botão de tirar, destaque da busca, foco do quadro) usa o carbono claro (#3a3fb2), nunca `carbono-escuro`.

## Typography

**Display Font:** Labsign Form — Archivo Narrow 600 (licença OFL), embutida no pacote e registrada por FontFace, sem fonte externa; na falta dela, Arial Narrow, Helvetica Neue e a fonte do sistema.
**Body Font:** a pilha do sistema (system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif).
**Label/Mono Font:** Labsign Form, sempre no peso 600. Não há fonte mono.

**Character:** A letra estreita é a impressão do formulário: rótulos em caixa alta e espaçados, números, carimbos e os títulos das folhas. A fonte do sistema é a voz que explica, em frases curtas.

### Hierarchy
- **Headline** (600, 26px, 1.1, Labsign Form): o título da folha de entrega ("Cópia assinada pronta") e da tela de erro fatal. A página do cofre sobe um degrau (28px) no seu único título.
- **Title** (600, 24px, 1.15, Labsign Form): folhas sobre a mesa — "Escolha o PDF para assinar", "Assinatura cancelada".
- **Title-sm** (600, 22px, 1.15, Labsign Form): títulos de diálogo — "Desenhe sua assinatura", "Desfazer a assinatura?".
- **Body** (400, 15px, 1.5): o texto base, o nome do documento no canhoto, os campos de texto.
- **Body-sm** (400, 13.5px, 1.5): a nota do pé, as notas da entrega (até 62ch), metadados, histórico, recados e avisos. Nomes e links usam o mesmo tamanho em 600 (`body-sm-strong`).
- **Body-xs** (400, 12px, 1.5): metadados de lista ("Usada hoje, 19:02"), a linha "Tudo fica neste computador" e os metadados no modo compacto.
- **Button** (650, 13.5px; principal 15px): rótulos de botão, na fonte do sistema e em caixa normal.
- **Label** (600, 11.5px, 1.2, 0.08em, caixa alta, Labsign Form): nomes de campo e de grupo — DOCUMENTO, ONDE ASSINAR, SUA ASSINATURA, HISTÓRICO, GUARDAR, COR, TRAÇO.
- **Label-lugar** (600, 13.5px, 1.25, 0.04em, caixa alta): o nome do bloco como está no contrato — CONTRATANTE, TESTEMUNHA 1, OUTRO LUGAR.
- **Número** (600, 14px, 1, 0.06em, algarismos tabulares): o Nº 0007, em `numeradora`. O número de cada página, ao lado da folha, usa 11px e 0.04em (`numero-folha`) em `tinta-2`.
- **Carimbo** (600, 11px, 0.1em, caixa alta; grande: 17px, 0.14em): ASSINADO e CANCELADO.

### Named Rules
**A Regra do Rótulo Impresso.** Letra estreita é o que o formulário traria impresso: nomes de campo e de lugar, Nº, carimbos, números de página e títulos de folha (esses em caixa normal). O que a pessoa lê para decidir — notas, nomes de arquivo, botões, histórico, campos — é sempre a fonte do sistema. Um rótulo nomeia um campo; nunca fica em cima de um título, como chapéu.

**A Regra dos Algarismos Tabulares.** Nº, página, horas do histórico, zoom e contagem da busca usam algarismos tabulares, para os números não dançarem quando mudam.

## Layout

Com 880px ou mais de largura, o talão tem três colunas físicas: canhoto (300px), picote (16px) e via (o resto). A altura é a da janela (`100dvh`); embutida no chat, é a altura que o app deixa, entre 360 e 780px, para a tela não virar um rolo de 60 páginas.

- **Canhoto:** coluna de campos empilhados, cada um com rótulo e conteúdo, separados por uma linha `pauta` (respiro de 14px 18px 16px; 9px entre rótulo e conteúdo). No topo, a marca (pena + "labsign") e o Nº; embaixo, a linha "Tudo fica neste computador". Rola sozinho.
- **Via:** de cima para baixo, a barra (Página [n] de N; "Ir para a página N" quando a pessoa se afasta do lugar; zoom; Procurar; no chat, Tela cheia e Abrir no navegador), a busca quando aberta, a faixa de avisos, a área das folhas e o pé. Barras e pé usam 16px de margem lateral.
- **Folhas:** as páginas do PDF numa coluna centrada sobre o `chao`, com 18px entre elas; à direita, a régua de páginas (36px). A tela abre na página do lugar de assinar, com a assinatura já sentada na linha.
- **Pé:** a nota do que vai acontecer ocupa a esquerda; à direita, Cancelar (discreto) e o botão principal, com 8px entre eles. Fica sempre à vista enquanto se assina.
- **Entrega (a via destacada):** conteúdo até 820px, com respiro de 22px 26px 26px. Cabeçalho em duas colunas (carimbo, título e frase | miniatura de 132px); depois, grupos separados por `pauta-leve`, com 18px de respiro, cada um com rótulo, fileira de botões e nota.
- **Folhas sobre a mesa** (receber o PDF, encerrado): uma folha branca centrada no `chao`, até 460px, com 26px de respiro.
- **Diálogos:** até 620px de largura (a tela menos 24px, se for estreita), respiro de 22px.
- **Cofre:** uma coluna canário de até 680px, centrada sobre o `chao`.

**Compacto (menos de 880px de largura, dentro do chat ou em janela estreita).** Decidido pela largura da própria tela, não por media query. O canhoto sobe, o picote deita (12px) e a via fica embaixo. O canhoto vira uma grade de duas colunas: o documento à esquerda e a assinatura à direita (entre 190px e 36%); os lugares viram botões com borda `pauta`, que quebram linha numa faixa inteira; a lista de assinaturas abre numa faixa inteira; o histórico recolhe atrás de um link. Somem o topo (o Nº vai para o lado dos metadados do documento), a linha de confiança e os rótulos longos da barra (Procurar, Tela cheia e Abrir no navegador ficam só com o ícone). O canhoto usa 14px de margem lateral; a barra, 10px. O canhoto ocupa no máximo 55% da altura (42% quando a tela tem até 520px de altura) e rola por dentro: a via, com o documento, nunca some. Rubrica e Local e data ficam lado a lado enquanto desligados; ligados, cada um ganha a faixa inteira (os quatro campos de Local e data numa linha só, a partir de 640px), e o campo que acabou de abrir rola para a vista.

**Celular (até 520px).** Cidade e data ocupam a linha inteira (a data vai por extenso); nome e CPF ficam lado a lado. Os lugares viram duas colunas de botões, com o nome de quem assina numa segunda linha; os botões do pé ocupam a largura e o principal cresce; a miniatura da entrega some. Em qualquer tela de toque (ponteiro grosso), os campos de texto usam 16px, para o celular não dar zoom.

### Named Rules
**A Regra do Talão Inteiro.** Canhoto, picote e via estão sempre na tela ao mesmo tempo, lado a lado ou empilhados. O canhoto guarda o registro e a via mostra o documento; nenhum dos dois vira passo, aba ou menu.

**A Regra da Saída Antes da Ação.** Todo pé e todo diálogo alinha as ações à direita, com a saída primeiro (Cancelar, Voltar, em discreto) e a próxima ação por último (principal ou perigo). No pé, a nota que diz o que vai acontecer fica à esquerda.

## Elevation & Depth

Plano, com uma pilha de papel. As superfícies do talão (canhoto, via, barras, pé) não têm sombra: se separam por linhas pautadas e pelo picote. Profundidade só existe onde há papel sobre a mesa (as páginas do PDF, as folhas de receber e de encerrado, a miniatura da entrega), na via que se solta e nas duas camadas que flutuam (recado e diálogo). No escuro, a sombra da folha fica preta e mais funda.

### Shadow Vocabulary
- **Folha na mesa** (`box-shadow: 0 1px 2px rgba(21, 32, 92, 0.14), 0 12px 28px -14px rgba(21, 32, 92, 0.4)`; no escuro, `0 1px 2px rgba(0, 0, 0, 0.5), 0 14px 32px -12px rgba(0, 0, 0, 0.8)`): páginas do PDF, folhas sobre a mesa, miniatura da entrega. É a variável `--folha-sombra`.
- **Via destacada** (`box-shadow: -10px 0 24px -18px rgba(21, 32, 92, 0.6)`; no compacto, `0 -10px 24px -18px rgba(21, 32, 92, 0.6)`): a via que se soltou fica um pouco acima do canhoto, na borda do rasgo.
- **Recado** (`box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.45)`): o aviso rápido que flutua sobre as folhas.
- **Diálogo** (`box-shadow: 0 24px 60px -18px rgba(11, 13, 30, 0.6)`, sobre um fundo `rgba(11, 13, 30, 0.45)`): desenhar a assinatura e desfazer.
- **Fio** (`box-shadow: 0 0 0 1px`, em `pauta` ou `pauta-leve`): o contorno das miniaturas e da linha da assinatura. É borda, não elevação.

### Named Rules
**A Regra de Só o Papel Faz Sombra.** Botões, linhas, campos e chips nunca têm sombra de elevação. Sombra é de papel sobre a mesa, da via que se solta e das duas camadas que flutuam.

## Shapes

Cantos quase retos, furos e serrilhas de papel.

- **Cantos:** 3px (`r`) em todo controle — botões, campos, linhas de lugar e de assinatura, segmentado, recado, guia, diálogo, quadro de desenho. 2px (`r-fino`) nas peças miúdas — o preenchimento do segmentado, os carimbos, as miniaturas de assinatura, o topo da linha da assinatura, a régua, o destaque da busca. Folha não tem canto: páginas do PDF, folhas sobre a mesa, miniaturas do documento, canhoto e via são retos.
- **Círculos** (`circulo`): o marcador de escolha (14px, anel de 1,5px em `pauta`; escolhido, anel de 4,5px em `carbono`), as amostras de tinta (24px; a escolhida ganha anel duplo, `via` e depois `carbono`) e o botão × que tira a assinatura da página (26px). A amostra de espessura do traço é a única pílula.
- **Picote:** uma coluna de furos (raio de 2,4px, a cada 11px) na cor do `chao`, sobre a emenda meio canário, meio via. Destacada a via, a borda dela é cortada em ziguezague (máscara em `conic-gradient`, dente de 11px, 8px de fundo) e a mesa aparece pelo rasgo. No compacto, o mesmo desenho na horizontal.
- **Carimbo:** retângulo com borda na cor do texto (1,5px; o grande, 2,5px), inclinado −3° (o grande, −5°).
- **Marca na régua:** bandeirinha de 16×13px apontando para o trilho, cheia de carbono no lugar escolhido; os outros lugares são um quadrado vazado com anel de carbono. Quando há mais de um lugar na mesma página, a marca leva o número.
- **Ícones:** desenhados para o labsign, numa grade de 24, traço de 1,75, pontas e junções arredondadas, na cor do texto; 14px nos links do canhoto, 16px em botões e barras, 17–18px em avisos e na marca. A pena (um losango com a fenda) é a marca, a mesma do ícone do app.

### Named Rules
**A Regra do Canto Quase Reto.** 3px é o máximo num controle, e folha é reta. Círculo só para marcador, amostra de tinta e o × sobre a página.

**A Regra do Picote.** Entre canhoto e via só existe o picote: nunca uma sombra, nunca uma borda comum. É por ele que a via rasga quando se destaca.

## Components

### Buttons
Botões de formulário: contorno firme, sem sombra, texto que diz o que acontece.
- **Shape:** canto de 3px (`r`), borda de 1,5px.
- **Primary** (`btn-principal`): preenchido de `carbono`, texto `carbono-tinta`, 44px de altura, 0 22px, 15px/650. Um só por tela, no pé ou no diálogo, e o texto é a frase do próximo passo: "Escolher o PDF", "Desenhar sua assinatura", "Escolher sua assinatura", "Assinar na página 13", "Usar esta assinatura". Ocupado, mostra um anel de 14px girando antes do texto ("Assinando…", "Abrindo…") e fica desabilitado.
- **Hover / Focus:** o principal escurece para `carbono-forte`; o comum ganha fundo `carbono-leve` e borda, texto e ícone em `carbono`; pressionado, desce 1px. Foco: anel de 2px em `carbono`, afastado 2px. Indisponível: esmaecido (opacidade 0,45) e cursor de proibido.
- **Comum** (`btn`): transparente, borda e texto `tinta`, 40px, 0 16px, 13,5px/650. Na entrega, leva um ícone de 16px em `carbono` à esquerda (Abrir, Mostrar na pasta, Salvar uma cópia em…, Copiar o PDF, Apple Mail, Gmail, Abrir o WhatsApp).
- **Discreto** (`btn-discreto`): sem borda visível, texto `tinta-2`; no hover, fundo `carbono-leve` e texto `tinta`. É a saída (Cancelar, Voltar, Desfazer a assinatura) e as ações miúdas do quadro de desenho (Desfazer, Limpar).
- **Perigo** (`btn-perigo`): preenchido de `numeradora`, texto branco no claro. Só na confirmação destrutiva — "Apagar" na linha que confirma, "Desfazer" no diálogo. No escuro, o texto sobre `numeradora-escuro` segue o recado de erro (`numeradora-texto-escuro`).
- **Pequeno** (`btn-pequeno`): 32px, 0 12px — ações dentro de linhas e do quadro de desenho.
- **Link do canhoto** (`link-btn`): `tinta` 13,5px/600, sublinhado em `pauta` 3px abaixo, ícone de 14px antes quando há; no hover, texto `carbono` e sublinhado na cor do texto. Trocar, Remover, Desenhar nova.
- **Botão de ícone** (`icone-btn`): na barra da via, 32px de altura e no mínimo 32px de largura, sem borda, `tinta`; no hover e quando ligado, fundo `carbono-leve` e ícone `carbono`. "Ir para a página N" é o único que já nasce em `carbono`. No compacto, só o ícone.

### Chips
- **Style:** os lugares de assinatura. No canhoto largo, uma linha de formulário por bloco achado no PDF: marcador de 14px, RÓTULO em `label-lugar`, "p. 60" à direita em `tinta-2`, o nome de quem assina embaixo; por último, OUTRO LUGAR · clique na página. No compacto, cada lugar vira um botão com borda `pauta` (5px 10px) que quebra linha; no celular, duas colunas.
- **State:** hover em `canhoto-2`; escolhido com fundo `carbono-leve`, marcador com anel de 4,5px em `carbono` e rótulo e página em `carbono`. Depois de assinar, só o lugar usado continua, sem marcador. Em cores forçadas, o escolhido ganha contorno `Highlight`.
- **Segmentado** (traço; modo de escrever): caixa com borda `pauta`, 2px de respiro, opções em 13,5px/550 `tinta-2`; a escolhida fica preenchida de `carbono` com texto `carbono-tinta` (`seg-escolhido`). A opção de traço mostra a espessura.
- **Amostras de tinta** (`amostra`): três círculos de 24px nas tintas reais, com fio `pauta`; a escolhida ganha o anel duplo.

### Cards / Containers
Não há cartões. O recipiente é o campo pautado do canhoto (`campo`).
- **Corner Style:** reto.
- **Background:** nenhum próprio; o campo está no papel `canhoto`.
- **Shadow Strategy:** nenhuma (ver Elevation & Depth).
- **Border:** só a linha `pauta` embaixo; o último campo não tem.
- **Internal Padding:** 14px 18px 16px, com 9px entre o rótulo e o conteúdo; no compacto, 9px 14px 10px.
- **Vazio:** a frase em `tinta-2` sobre uma linha pautada ("Nenhum documento ainda.", "Nenhuma escolhida."). A linha vazia é o "a fazer".

### Inputs / Fields
- **Style:** 38px de altura, 0 10px, borda de 1px em `pauta`, fundo `via`, texto `tinta` na fonte do sistema, canto de 3px; placeholder em `tinta-2`. O campo de página da barra é curto (3,6em × 30px), centrado, em 600 e algarismos tabulares. O rótulo vai em cima, a 5px: `label` no diálogo e no cofre, 12px/600 `tinta-2` em caixa normal no número do WhatsApp.
- **Focus:** anel de 2px em `carbono` afastado 1px, e a borda vira `carbono`; o cursor de texto também é `carbono`.
- **Error:** o campo não muda de cor; o erro sai em frase, no recado de erro ou no estado de erro da folha de receber, em `numeradora`.
- **Travado (depois de assinar):** o que foi escrito vira cópia a carbono: sem caixa e sem fundo, só a pauta tracejada embaixo, o texto em `carbono`.

### Navigation
- **Barra da via:** Página [n] de N à esquerda; zoom (− 100% +, em algarismos tabulares) e Procurar à direita; respiro de 9px 16px e linha `pauta-leve` embaixo. Com o foco no documento, digitar um número leva ao campo da página; ⌘F ou Ctrl+F abre a busca.
- **Busca:** faixa logo abaixo da barra, com o campo que cresce, a contagem ("3 de 12") e anterior, próximo e fechar. O achado ganha, na página, um retângulo de carbono translúcido com contorno.
- **Régua de páginas:** trilho vertical de 36px à direita das folhas, com um traço `pauta` por página (até 150 páginas), a página atual numa barra `carbono` de 9px e os lugares de assinatura em bandeirinhas presas na página certa. Clicar ou arrastar pula de página; setas, PageUp, PageDown, Home e End também, porque a régua é um controle deslizante acessível.
- **Mobile:** a régua continua; a barra fica só com ícones.

### Assinatura sobre a página
O que se vê é o que será carimbado.
- A assinatura senta na linha do bloco, na tinta real e sem fundo. Em repouso, contorno tracejado de 1,5px em carbono claro a 60%, afastado 3px; no hover, no foco ou arrastando, contorno contínuo em carbono claro com um véu de 5%. Alça quadrada de 12px no canto de baixo à direita, que redimensiona pela diagonal; botão × redondo de 26px no canto de cima à direita, que aparece no hover e no foco (sempre, em tela de toque).
- Sem assinatura escolhida, a moldura mostra "SUA ASSINATURA VAI AQUI" em letra estreita, carbono sobre véu de 7%; o texto some quando a moldura fica pequena demais.
- Teclado: as setas movem 1pt (com Shift, 10pt), + e − redimensionam, Delete tira a assinatura.
- Ao escolher o lugar ou a assinatura, ela pousa como um decalque: 0,34s em `cubic-bezier(0.16, 1, 0.3, 1)`, saindo de opacidade 0, 3px acima, 3,5% maior e levemente borrada.
- Travada (assinando ou assinada): sem contorno, sem alça, sem ×.
- Enquanto uma página não foi desenhada, ela mostra linhas pautadas cinza no lugar do texto.

### Campos opcionais (rubrica, local e data)
- Uma chave de ligar: caixinha de 17px com borda de 1,5px em `pauta` e canto de 3px; ligada, fundo `carbono` e check em `carbono-tinta`. O corpo do campo só aparece com a chave ligada, e a chave travada (depois de assinar) fica esmaecida.
- **Rubrica:** a rubrica escolhida numa linha pequena (44px de altura, até 160px), com Trocar e Desenhar rubrica; a nota diz em quantas páginas ela vai. Na página, cada rubrica tem a mesma moldura tracejada da assinatura, e arrastar uma move todas, porque a posição é contada do canto de baixo à direita. Sem rubrica no cofre, ligar a chave já abre o quadro de desenho.
- **Local e data:** Cidade e Data (por extenso, já preenchida com hoje), Nome e CPF opcionais, em grade de duas colunas. O texto aparece na página logo acima da assinatura, na mesma tinta dela, em Helvetica de 10pt (a fonte padrão do PDF), e arrasta como ela.
- **Mais de um lugar:** "Assinar em mais um lugar" põe a tela em modo de clique (Esc desiste); cada lugar a mais vira uma linha "Também na página N" com Tirar, e o botão principal passa a dizer "Assinar em N lugares".

### Linha da assinatura (no canhoto)
- A assinatura escolhida senta numa linha, como no papel: faixa `papel` de 58px (40px no compacto, 34px no celular), fio `pauta-leve` em volta, linha de base `pauta` embaixo e a assinatura na tinta real. O nome dela vem embaixo, em `tinta-2`.
- Depois de assinar, a faixa perde o papel e a assinatura vira a cópia em `carbono` (`assinatura-linha-copia`): é o que passou pelo carbono.
- A lista (Trocar) mostra linhas com marcador, miniatura em `papel` de 88×36px, nome em 600 e "Usada hoje, 19:02" em 12px. A lixeira aparece no hover e confirma na própria linha, em `numeradora-leve`, com Apagar (perigo) e Cancelar.

### Carimbos
- **ASSINADO** em `carbono` e **CANCELADO** em `numeradora`: 11px com 0.1em, borda de 1,5px na cor do texto, canto de 2px, inclinados −3°, no fim da linha do histórico.
- **Grande** (`carimbo-grande`): 17px com 0.14em, borda de 2,5px, inclinado −5°, com a data e a hora menores dentro ("ASSINADO 22/09 · 17:58"). Bate no topo da folha de entrega e da tela de cancelado: 0,42s depois de 0,3s, de 1,5× a 0,96× até o tamanho certo, na mesma curva.

### Nº do registro
- "Nº 0007" em `numeradora`, letra estreita de 14px com algarismos tabulares e quatro dígitos. Fica no topo do canhoto, ou ao lado dos metadados do documento no compacto. É o número que a assinatura terá no registro deste computador.

### Recado
- Aparece sobre as folhas, centrado, logo acima do pé, sem empurrar nada: fundo `tinta`, texto `via`, 13,5px, canto de 3px, ícone de check (de alerta, no erro). O erro vem em `numeradora`, com texto branco no claro e `numeradora-texto-escuro` no escuro.
- Entra em 0,18s de opacidade e sobe 8px em 0,3s. Sai depois de 4s (7s no erro), mas só depois do próximo gesto da pessoa, para não sumir enquanto ela lê.

### Avisos e guia
- **Aviso sobre o documento** (`aviso`): faixa inteira acima das folhas, fundo `canhoto` (no escuro, `carbono-leve-escuro`), ícone de 17px em `carbono` (em `numeradora`, se for erro), texto de 13,5px. Serve para "não achei o lugar", "este PDF já tem assinatura digital" e falha da prévia.
- **Guia da entrega** (`guia`): caixa `carbono-leve` com ícone de informação, que explica o passo que falta depois de uma ação (colar com ⌘V, arrastar o arquivo). As teclas aparecem desenhadas, com borda de 2px embaixo.

### A via destacada (entrega)
- Ao assinar, a via se solta do canhoto: 0,62s na mesma curva, desliza 10px para a direita e gira 0,45° até 38% do tempo, e volta; no compacto, desce 9px e gira 0,3°. A borda do rasgo aparece serrilhada e a mesa aparece pelo picote.
- A folha de entrega traz o carimbo grande ASSINADO, o título "Cópia assinada pronta" e a frase com o nome do arquivo em negrito e a pasta; à direita, a miniatura da página assinada (132px, `papel` com sombra de folha), que abre o arquivo. Depois, os grupos GUARDAR (que inclui o Comprovante: um PDF à parte ao lado da cópia; depois do primeiro clique o botão vira "Abrir comprovante"), ENVIAR POR E-MAIL e ENVIAR PELO WHATSAPP, cada um com botões comuns com ícone e uma nota que diz o que o computador faz e o que falta a pessoa fazer. No fim, "Desfazer a assinatura" (discreto) e uma frase de saída.
- O canhoto vira registro: só o lugar usado, sem os controles de tinta, a assinatura em cópia de carbono e o histórico com o carimbo.

### Diálogos
- Superfície `via`, canto de 3px, sombra de diálogo, título em `title-sm`, texto em `tinta-2` e ações à direita com a saída primeiro.
- O quadro de desenho é `papel` com borda `pauta` e 210px de altura (220px no cofre). Escrevendo, a borda vira carbono claro com um halo de 2px; quando o traço está preso ao clique, aparece no canto um selo "Escrevendo · clique para levantar a caneta", em carbono leve.

### Cofre
- A mesma matéria do canhoto numa página só: coluna canário de até 680px sobre a mesa, a marca no topo, o título "Suas assinaturas", a lista das salvas, o quadro para desenhar uma nova com nome e "Salvar", e o pé com "Concluir".

### Named Rules
**A Regra do Vocabulário Fechado.** Estado se diz com cinco sinais, e só com eles: linha pautada vazia (a fazer), azul de carbono (feito ou escolhido), carimbo ASSINADO, carimbo CANCELADO em vermelho e esmaecido (indisponível). Nada de check verde, selo, barra de progresso ou passo numerado.

**A Regra dos Dois Carimbos.** Só existem ASSINADO e CANCELADO. Carimbo registra um fato que aconteceu; nunca é enfeite, selo de novidade ou título.

**A Regra da Frase no Botão.** O botão principal diz o verbo e o objeto do próximo passo e muda com o estado ("Escolher o PDF", "Desenhar sua assinatura", "Assinar na página 13"); a nota ao lado diz que arquivo sai e onde. Nunca um genérico "OK" ou "Próximo".

## Do's and Don'ts

### Do:
- **Do** usar `tinta` para todo texto impresso, `tinta-2` para o texto de apoio e `pauta` para linhas e bordas de controle; todo par novo precisa passar 4,5:1 em texto e 3:1 em borda de controle, nos dois temas.
- **Do** marcar o que foi escolhido do mesmo jeito em qualquer lista: fundo `carbono-leve`, marcador com anel de 4,5px em `carbono` e rótulo em `carbono`.
- **Do** manter as páginas do PDF, as miniaturas, a linha da assinatura pendente e o quadro de desenho em `papel` (#ffffff) nos dois temas, e desenhar o que fica sobre eles com o carbono claro (#3a3fb2).
- **Do** escrever o botão principal como verbo + objeto ("Assinar na página 13") e pôr ao lado a nota do que vai sair e onde.
- **Do** pôr a saída antes da próxima ação em todo pé e diálogo: discreto primeiro, principal (ou perigo) por último, alinhados à direita.
- **Do** usar Labsign Form 600 em caixa alta, com 0.04em a 0.14em de espaço, para rótulos, lugares, Nº e carimbos, e a mesma letra em caixa normal para os títulos das folhas.
- **Do** usar algarismos tabulares em Nº, páginas, horas, zoom e contagens.
- **Do** usar texto branco sobre `numeradora` no claro e `numeradora-texto-escuro` sobre `numeradora-escuro` no escuro.
- **Do** trocar cada token pelo seu par `-escuro` no tema escuro, menos `papel`, as tintas da assinatura e o que fica sobre o papel.
- **Do** respeitar `prefers-reduced-motion` (animações a 1ms, a via não se mexe, rolagem sem suavização) e `forced-colors` (o escolhido ganha contorno `Highlight`).

### Don't:
- **Don't** escrever "canhoto" ou "picote" em texto da tela: são nomes internos. Na tela, os campos se chamam Documento, Onde assinar, Sua assinatura e Histórico.
- **Don't** transformar o fluxo em stepper numerado, zona de soltar tracejada como tela principal ou grade de cartões brancos arredondados; o talão é a estrutura.
- **Don't** usar vermelho fora do Nº, do CANCELADO, dos erros e da confirmação destrutiva.
- **Don't** criar um terceiro carimbo nem usar carimbo como enfeite ou selo.
- **Don't** tingir a prévia pendente da assinatura com a cor do tema: ela fica na tinta real sobre `papel`, e só depois de assinar o canhoto mostra a cópia em `carbono`.
- **Don't** pôr sombra de elevação em controle nem arredondar folha; nada acima de 3px num controle e nenhuma pílula além da amostra de traço.
- **Don't** usar `carbono-escuro` ou qualquer valor `-escuro` sobre `papel`.
- **Don't** usar textura, grão ou fantasia de papel: o talão é liso.
- **Don't** usar a letra estreita em notas, botões, nomes de arquivo ou campos, nem pôr um rótulo em caixa alta em cima de um título, como chapéu; sobre um título, só o carimbo grande, que registra um fato.
- **Don't** usar emoji ou glifo como ícone; ícone novo segue a grade de 24 com traço de 1,75 e pontas arredondadas.
