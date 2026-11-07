# habblaud-dsh-inbox

Plugin do **DeepSeek Harness** que liga a caixa de mensagens do Habblaud à sessão aberta do DSH. É o equivalente
do `habblaud-mensagens` do Claude Code: a cada ~2 s pergunta ao Habblaud se há mensagem para a sessão, entrega
como prompt (`sessionController.prompt`) e confirma a entrega.

## Instalação

O plugin é carregado pelo perfil do DSH, não pelo Habblaud:

```bash
cp mod/habblaud-dsh-inbox/plugin.mjs ~/.dsh/profiles/desktop/habblaud-inbox.mjs
```

Acrescente ao fim de `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
# Habblaud: caixa de mensagens do escritório -> sessão do DSH (plugin local).
- insert:
    - id: habblaud-dsh-inbox
      name: "./habblaud-inbox.mjs"
```

O DSH recarrega o perfil sozinho (HMR) quando o arquivo muda; se não recarregar, reabra o DSH. O log fica em
`~/.habblaud/dsh-inbox.log`.

## O que ele faz

- Descobre as sessões vivas em `ctx.sessions.list()` (só principais).
- `POST http://127.0.0.1:4747/api/mod/inbox` com `{session, account: '.dsh'}`.
- Entrega cada mensagem com `sessionController.prompt({sessionId, content, requestId, mode: 'followup'})`.
- Confirma em `POST /api/mod/inbox/ack`.
- Não lê credenciais e só fala com `127.0.0.1`.

## Remover

Apague `~/.dsh/profiles/desktop/habblaud-inbox.mjs` e o bloco `habblaud-dsh-inbox` do `cordis.patch.yml`.
