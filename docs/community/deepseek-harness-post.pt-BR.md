# Posts para a comunidade — DeepSeek Harness no Habblaud

Rascunhos prontos para colar. Ajuste o link do guia e as imagens. Tom: empolgado, mas honesto sobre o que é
experimental.

## Imagens sugeridas

1. `docs/community/habblaud-dsh.png` (visão geral, agente DSH na sala).
2. `docs/community/habblaud-dsh-usage.png` (cartão com tokens).
3. `docs/community/habblaud-dsh-terminal.png` (terminal + caixa de mensagem ativa).

## X / Twitter — thread

**1/6**
Você usa Claude Code e Codex no Habblaud… mas e o DeepSeek Harness?

Agora o DSH também entra no escritório: personagem com selo DSH, terminal com a conversa e mensagens direto do Habblaud. 🧵

**2/6**
O DSH grava a sessão em zstd e não tem um “hook” como o Codex. Então fiz uma ponte:

sessão .zstd → eventos → `POST /api/dsh/events` → Habblaud.

Ela descobre sessões abertas pelo `session.lock` e reenvia tudo quando o Habblaud reinicia.

**3/6**
O cartão da conta mostra **tokens** (sessão, 5 h e semana), porque o DeepSeek cobra por token — não faz sentido fingir
as janelas percentuais do Claude Code.

**4/6**
O terminal abre a conversa (prompts, comandos, resultados) e a caixa de mensagem funciona de verdade: um plugin Cordis
dentro do DSH busca `/api/mod/inbox` e entrega via `sessionController.prompt`.

**5/6**
Tudo local:
• ponte e plugin só falam com 127.0.0.1
• nenhuma credencial sai da máquina
• o Habblaud World ainda não aceita DSH (protocolo só conhece Claude/Codex)

**6/6**
É uma integração local, não upstream. Guia completo + patch:

👉 [LINK DO GUIA]

Se você testar, me conta o que quebrou. É assim que a comunidade melhora. 🐧

## LinkedIn

**DeepSeek Harness agora também mora no Habblaud.**

Quem acompanha o Habblaud sabe que ele já transforma sessões do Claude Code e do Codex em um escritório pixel art,
com personagens, atividades e aprovações.

Agora o DeepSeek Harness (DSH) entra como agente de primeira classe:
• personagem com selo próprio e sala do projeto;
• atividade ao vivo (prompt, ferramenta, resultado, fim de turno);
• cartão de tokens (sessão, 5 h e semana);
• terminal com a conversa;
• mensagens enviadas direto do Habblaud para a sessão do DSH.

O detalhe técnico interessante foi a ponte: o DSH grava a sessão em JSONL comprimido com zstd e não tem um hook como o
Codex. Uma ponte lê as sessões abertas, traduz os eventos e alimenta a API do Habblaud. Para as mensagens, um plugin
Cordis dentro do DSH busca a caixa de entrada e injeta o prompt na sessão.

Tudo local, sem credenciais saindo da máquina.

É uma integração experimental, não upstream — e o guia completo está aqui: [LINK DO GUIA]

#DeepSeek #AI #DeveloperTools #OpenSource #Habblaud #Agents

## Reddit / Discord (r/selfhosted, r/LocalLLaMA, Discord do Habblaud)

**Título:** DeepSeek Harness no Habblaud: personagem, terminal e mensagens pelo escritório

Eu uso o Habblaud para acompanhar Claude Code e Codex, mas o DeepSeek Harness ficava de fora. Fiz uma integração local
e estou compartilhando o guia.

O que funciona:
- cada sessão aberta do DSH vira um personagem com selo DSH;
- atividade ao vivo e cartão de tokens (sessão, 5 h, semana);
- terminal com a conversa (prompts, ferramentas, resultados);
- caixa de mensagem do Habblaud entregando prompt na sessão via plugin Cordis.

Como:
- ponte em TypeScript lê `~/.dsh/sessions/**/session.v4.jsonl.zstd`, descobre sessões abertas pelo `session.lock` e
  manda para `POST /api/dsh/events`;
- plugin no perfil do DSH (`~/.dsh/profiles/desktop/cordis.patch.yml`) faz `POST /api/mod/inbox` e chama
  `sessionController.prompt`.

Limitações: só texto, aprovações continuam no terminal do DSH, e o Habblaud World ainda não aceita o provider DSH.

Guia: [LINK]
Patch: [LINK DO PATCH]

Feedback é bem-vindo — principalmente se você roda em Linux ou usa múltiplas contas.

## Instagram / TikTok (legenda curta)

Seu escritório de agentes agora tem DeepSeek Harness. 🤖

Sessão aberta → personagem com selo DSH.
Terminal com a conversa.
Mensagem do Habblaud direto pra sessão.

Tudo local. Guia no link da bio.

#DeepSeek #Habblaud #DevLife #AI

## Checklist antes de publicar

- [ ] Subir o patch e o guia num repositório/Gist público.
- [ ] Trocar `[LINK DO GUIA]` e `[LINK DO PATCH]`.
- [ ] Usar as imagens `habblaud-dsh.png`, `habblaud-dsh-usage.png` e `habblaud-dsh-terminal.png`.
- [ ] Se possível, gravar um GIF de 10–15 s: personagem trabalhando + mensagem chegando no terminal.
- [ ] Dizer claramente que é experimental e não upstream.
