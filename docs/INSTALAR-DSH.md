# Instalar o Habblaud com o DeepSeek Harness (do zero)

Este guia leva uma máquina sem nada instalado até o escritório do Habblaud mostrando as suas sessões do **DeepSeek
Harness (DSH)** — personagem na sala, atividade ao vivo, terminal e a caixa **Mandar mensagem** funcionando.

Para o detalhe da integração (como a ponte e o plugin conversam, o que vai e o que não vai para o disco), veja
[`deepseek-harness.pt-BR.md`](deepseek-harness.pt-BR.md).

> Vale para **macOS**, **Linux** e **WSL no Windows**. No Windows, rode tudo dentro do Ubuntu do WSL — o Habblaud e o
> DSH precisam estar no mesmo sistema de arquivos.

## O que você precisa antes

| Peça | Como conferir | Se faltar |
| --- | --- | --- |
| Node.js 22.12+ | `node --version` | macOS: `brew install node` · Debian/Ubuntu: `sudo apt install nodejs npm` |
| `zstd` | `zstd --version` | macOS: `brew install zstd` · Debian/Ubuntu: `sudo apt install zstd` · Fedora: `sudo dnf install zstd` |
| `lsof` | `lsof -v` | macOS já vem · Debian/Ubuntu: `sudo apt install lsof` |
| DeepSeek Harness **já aberto uma vez** | `ls ~/.dsh/profiles` | abra o app do DSH uma vez; ele cria o perfil |
| Docker | `docker info` | macOS: Docker Desktop · Linux: `get.docker.com` |

`zstd` não é opcional: é ele que descomprime `session.v4.jsonl.zstd`. Sem ele a ponte sobe e não vê sessão nenhuma —
o sintoma é um escritório vazio sem nenhum erro na tela. O `dsh:install` confere e para com uma mensagem clara.

## 1. Instalar o Habblaud

```bash
git clone https://github.com/marmottajr/habblaud.git ~/habblaud
cd ~/habblaud
npm install
npm run docker:up
```

Ao terminar, `http://localhost:4747` abre o escritório. O `/api/health` já deve responder:

```bash
curl -s http://localhost:4747/api/health | grep -o '"dshEvents":true'
```

Se essa linha não aparecer, o clone não tem o patch da integração (veja [`deepseek-harness.pt-BR.md`](deepseek-harness.pt-BR.md)).

## 2. Ligar o DSH ao escritório

```bash
cd ~/habblaud
npm run dsh:install
```

Esse comando faz três coisas — e **não duplica nada** se você rodar de novo:

| O que | Onde | Observação |
| --- | --- | --- |
| Copia o plugin do inbox | `~/.dsh/profiles/<perfil>/habblaud-inbox.mjs` | é o que traz a caixa **Mandar mensagem** para dentro da sessão |
| Acrescenta o bloco do Habblaud | `~/.dsh/profiles/<perfil>/cordis.patch.yml` | com backup antes; se o bloco já existe, não acrescenta outro |
| Instala o serviço da ponte | macOS: `~/Library/LaunchAgents/com.habblaud.dsh-bridge.plist` · Linux/WSL: `~/.config/systemd/user/habblaud-dsh-bridge.service` | roda `npm run dsh:bridge -- --all`, reinicia sozinho e sobe no login |

**Qual perfil?** O comando usa o perfil da sessão onde ele roda (`DSH_PROFILE_DIR`/`DSH_PROFILE`, que o próprio DSH
exporta no terminal dele), depois `desktop`, depois o primeiro que existir. Para escolher outro:
`npm run dsh:install -- --profile trabalho`.

**Backups.** Antes de qualquer gravação, o `cordis.patch.yml` vai para
`cordis.patch.yml.habblaud-backup-<data>`. O plugin só é copiado se o conteúdo mudou.

**Idempotência.** Rodar de novo é seguro: o instalador reconhece o bloco pelo `id: habblaud-dsh-inbox` e **nunca**
acrescenta um segundo. Se encontrar o bloco colado duas vezes (edição à mão), tira as cópias repetidas. Se encontrar o
id em outra forma — arquivo editado à mão, outra linha — ele **para e avisa** em vez de arriscar apagar o que é seu.

**Sem o serviço automático** (para testar ou em máquina sem launchd/systemd):

```bash
npm run dsh:install -- --no-service   # só o plugin e o bloco
npm run dsh:bridge -- --all           # a ponte, à mão, em outro terminal
```

## 3. Conferir

```bash
npm run dsh:status
```

A saída esperada, com o DSH aberto:

```
DeepSeek Harness: perfil desktop (~/.dsh/profiles/desktop/cordis.patch.yml)
✓ cordis.patch.yml: bloco do Habblaud instalado
✓ plugin: ~/.dsh/profiles/desktop/habblaud-inbox.mjs (igual ao repositório)
✓ zstd: encontrado
✓ serviço (~/Library/LaunchAgents/com.habblaud.dsh-bridge.plist): rodando
✓ Habblaud: fonte .dsh com 1 sessão(ões) sendo acompanhada(s)
Log da ponte: ~/.habblaud/dsh-bridge.log
Log do plugin: ~/.habblaud/dsh-inbox.log
```

Ele sai com código **1** se achar algo errado — bom para script. `!` é aviso; `✗` é problema.

## 4. Testar de verdade

1. Abra o DSH em qualquer projeto e mande uma mensagem.
2. Em `http://localhost:4747`, o personagem **DSH** entra na sala do projeto com o selo do provedor.
3. Clique nele → **Mandar mensagem** → escreva algo. Em até ~2 s o texto vira prompt na sessão do DSH.
4. `tail -2 ~/.habblaud/dsh-inbox.log` deve mostrar `entregou 1/1 mensagem(ns)`.

Se o personagem aparece mas a mensagem não chega, o problema é o plugin (passo 2), não a ponte.

## 5. Depois de reiniciar a máquina

- **macOS:** o LaunchAgent sobe no login (`RunAtLoad`) e o `KeepAlive` reinicia a ponte se ela cair.
- **Linux/WSL:** o serviço é habilitado (`enable --now`) e o `loginctl enable-linger` faz ele subir sem sessão aberta.
  Se o `dsh:install` avisou que o linger falhou, rode uma vez:

  ```bash
  sudo loginctl enable-linger $USER
  ```

O Habblaud em Docker sobe junto com o Docker (`restart: unless-stopped`). Se o Docker Desktop não inicia sozinho no
macOS, a ponte fica tentando e reconecta sozinha — mas o escritório só existe quando o Docker sobe.

## 6. Quando algo dá errado

| Sintoma | O que conferir |
| --- | --- |
| `Nenhum perfil do DSH em ~/.dsh/profiles` | abra o DSH uma vez; ele cria o perfil |
| `✗ zstd: não encontrado no PATH` | instale o `zstd` (tabela do começo) e rode de novo |
| Escritório sem personagem do DSH | `tail ~/.habblaud/dsh-bridge.log`: deve dizer `observando …/session.v4.jsonl.zstd` |
| Serviço “rodando, mas diferente do esperado” | você editou o plist/unit à mão ou atualizou o repositório: `npm run dsh:install` |
| Personagem aparece, mensagem não chega | `tail ~/.habblaud/dsh-inbox.log`; confira o bloco e o plugin com `npm run dsh:status` |
| Mensagem “na fila” e depois falha | o DSH estava fechado ou a sessão trocou; a fila do Habblaud expira em 60 s — reenvie |
| `✗ serviço: gravado, mas o launchd não carregou` | rode de novo (o launchd às vezes precisa de um instante entre remover e carregar) |
| Depois de atualizar o Habblaud | `git pull && npm install && npm run docker:up && npm run dsh:install` (o plugin copiado é atualizado) |

Logs: `~/.habblaud/dsh-bridge.log` (ponte) e `~/.habblaud/dsh-inbox.log` (plugin). No Linux/WSL, `journalctl --user -u
habblaud-dsh-bridge` também mostra o serviço.

## 7. Desfazer

```bash
cd ~/habblaud
npm run dsh:uninstall
```

Tira o serviço, o bloco do `cordis.patch.yml` (com backup antes) e o plugin copiado. O resto do seu perfil do DSH fica
intacto. Para desligar só a ponte: `npm run dsh:bridge -- --help` mostra as opções de execução manual.

## 8. O que o instalador toca

| Arquivo | Ação |
| --- | --- |
| `~/.dsh/profiles/<perfil>/habblaud-inbox.mjs` | criado/atualizado (cópia de `mod/habblaud-dsh-inbox/plugin.mjs`) |
| `~/.dsh/profiles/<perfil>/cordis.patch.yml` | bloco acrescentado/removido, **sempre** com backup `*.habblaud-backup-<data>` |
| `~/Library/LaunchAgents/com.habblaud.dsh-bridge.plist` | criado/atualizado (macOS) |
| `~/.config/systemd/user/habblaud-dsh-bridge.service` | criado/atualizado (Linux/WSL) |
| `~/.habblaud/dsh-bridge.log` | log da ponte (o serviço escreve nele) |

Nada de credenciais: a ponte só lê `~/.dsh/sessions` e fala com `127.0.0.1:4747`; o plugin só pergunta ao Habblaud se
há mensagem para a sessão.
