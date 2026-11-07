// Plugin do DeepSeek Harness que liga a caixa de mensagens do Habblaud à sessão aberta.
//
// O Habblaud guarda as mensagens da página em POST /api/mod/inbox e espera o agente buscá-las a cada ~2 s.
// Para cada sessão viva, este plugin busca as mensagens, entrega como prompt (`sessionController.prompt`) e
// confirma em /api/mod/inbox/ack. É o equivalente do plugin `habblaud-mensagens` do Claude Code.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'habblaud-dsh-inbox';
/** Serviços que precisam existir para o plugin ativar. */
export const inject = ['sessions', 'sessionController'];

const LOG = join(homedir(), '.habblaud', 'dsh-inbox.log');
const PORT = Number(process.env.HABBLAUD_PORT ?? 4747) || 4747;
const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = '.dsh';
const POLL_MS = 2_000;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;

function log(message) {
  try {
    mkdirSync(join(homedir(), '.habblaud'), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // sem log: o plugin segue
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2_500),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/** Sessão principal (não subagente) e viva. */
function isMain(session) {
  const header = session?.header ?? {};
  if (session?.parent || session?.parentId || session?.parentSession) return false;
  if (header.parent || header.parentId || header.parentSession || header.parentSessionId) return false;
  return typeof session?.id === 'string' && session.id.length > 0;
}

function textOf(message) {
  return typeof message?.text === 'string' ? message.text : '';
}

export function apply(ctx, config = {}) {
  const account = typeof config.account === 'string' && config.account.trim() ? config.account.trim() : ACCOUNT;
  const controller = ctx.sessionController;
  const sessions = ctx.sessions;
  let stopped = false;
  let busy = false;
  let lastError = '';

  const fail = (message) => {
    if (message === lastError) return;
    lastError = message;
    log(message);
  };

  const poll = async (session) => {
    try {
      const res = await post('/api/mod/inbox', { session: session.id, account });
      if (res.status !== 200 || !Array.isArray(res.json?.messages)) return;
      const messages = res.json.messages;
      if (!messages.length) return;
      const results = [];
      for (const message of messages) {
        const text = textOf(message);
        if (!text.trim()) {
          results.push({ id: message.id, ok: false, error: 'mensagem vazia' });
          continue;
        }
        const requestId = randomUUID();
        try {
          await controller.prompt(
            { sessionId: session.id, content: [{ type: 'text', text }], requestId, mode: 'followup', ...(TIME_ZONE ? { clientTimeZone: TIME_ZONE } : {}) },
            new AbortController().signal,
          );
          results.push({ id: message.id, ok: true });
        } catch (err) {
          results.push({ id: message.id, ok: false, error: String(err?.message ?? err).slice(0, 300) });
        }
      }
      await post('/api/mod/inbox/ack', { session: session.id, results });
      log(`entregou ${results.filter((r) => r.ok).length}/${results.length} mensagem(ns) em ${session.id}`);
    } catch (err) {
      fail(`inbox: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };

  const round = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      for (const session of sessions.list()) {
        if (!isMain(session)) continue;
        await poll(session);
      }
    } finally {
      busy = false;
    }
  };

  log(`plugin carregado em ${BASE} (${sessions.list().length} sessão(ões))`);
  const timer = setInterval(() => void round(), POLL_MS);
  ctx.effect(() => () => {
    stopped = true;
    clearInterval(timer);
    log('plugin descarregado');
  }, 'habblaud-dsh-inbox.timer');
  void round();
}
