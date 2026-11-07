// Fonte do DeepSeek Harness (AgentSource 'dsh'): diferente do Claude Code e do Codex, o DSH não grava um
// transcript que o servidor saiba ler. A ponte `npm run dsh:bridge` lê a sessão do DSH (JSONL comprimido com zstd)
// e manda os eventos já normalizados para POST /api/dsh/events; esta fonte mantém o agente no escritório.
//
// Só observa: não responde permissões nem manda mensagens para a sessão. O status 'waiting' aparece quando o DSH
// grava `approval/asked` (a resposta continua sendo no terminal do DSH).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import { SPECIAL, describeTool, truncate } from '../../../shared/activity';
import type { AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { DshTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

export const DSH_ACCOUNT = '.dsh';
const MAIN_ROLE = tr('Agente principal (DeepSeek Harness)');
const MAX_EVENT = 200_000;

export interface DshEventBody {
  /** Id da sessão do DSH (o mesmo `session-...` da pasta em ~/.dsh/sessions). */
  sessionId: string;
  /** Pasta do projeto, como o DSH gravou no cabeçalho da sessão. */
  cwd?: string;
  /** O evento cru do DSH: {type, time, data, seq}. */
  event: Record<string, unknown>;
}

export interface DshLive {
  applyEvent(body: DshEventBody): boolean;
}

interface Tracker {
  key: string;
  sessionId: string;
  cwd: string;
  inOffice: boolean;
  status: AgentStatus;
  waitingFor?: string;
  startedAt: number;
  turnStart?: number;
  lastAt: number;
  lastEventAt: number;
  title?: string;
  toolName?: string;
  /** Tokens somados desta sessão (assistant/message). */
  tokens?: number;
}

export interface DshSourceOptions {
  accounts: AccountsService;
  office: Office;
  home?: string;
  /** Pasta de dados do Habblaud (o espelho JSONL do terminal fica em <dataDir>/dsh). */
  dataDir?: string;
  now?: () => number;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    const p = rec(part);
    if (p?.type === 'text' && typeof p.text === 'string') return p.text;
  }
  return '';
}

/** Nomes de ferramenta do DSH (minúsculos) para os nomes que o Habblaud já sabe descrever. */
const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  subagent: 'Agent',
  workflow: 'Workflow',
  task: 'Task',
};

const RELEVANT = new Set([
  'session',
  'turn/start',
  'turn/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'approval/asked',
  'approval/decided',
  'session/title',
  'session/end',
  'bridge/stop',
]);

const ZERO_STATS = { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };

export class DshSource implements AgentSource, DshLive {
  readonly provider = 'dsh' as const;
  private readonly trackers = new Map<string, Tracker>();
  /** Contador de atividades: mantém os ids estáveis numa releitura da mesma sessão (a ponte reenvia desde o começo). */
  private actSeq = 0;
  private readonly now: () => number;
  private readonly account: string;
  private readonly dir: string;
  /** O log do DSH é zstd; o terminal do Habblaud lê JSONL, então a fonte mantém um espelho em texto. */
  private readonly mirrorDir: string;
  /** Amostras de tokens para as janelas de 5 h e 7 dias (replay da ponte). */
  private usageSamples: Array<{ at: number; tokens: number }> = [];

  constructor(private readonly opts: DshSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.dir = join(opts.home ?? homedir(), '.dsh');
    this.mirrorDir = join(opts.dataDir ?? join(homedir(), '.habblaud'), 'dsh');
    const entries = opts.accounts.setProviderAccounts('dsh', [
      {
        dir: this.dir,
        detected: { id: DSH_ACCOUNT, configDir: '~/.dsh', short: 'D', name: 'DeepSeek Harness', color: '#4d6bfe' },
      },
    ]);
    this.account = entries[0]?.id ?? DSH_ACCOUNT;
  }

  start(): void {
    // Nada para reconstruir: a ponte reenvia a sessão desde o começo quando sobe.
    this.opts.office.beginBoot();
    this.opts.office.endBoot();
  }

  stop(): void {
    for (const t of this.trackers.values()) {
      if (t.inOffice) this.opts.office.closeMain(t.key);
      t.inOffice = false;
    }
  }

  sources(): SourceInfo[] {
    const sessions = [...this.trackers.values()].filter((t) => t.inOffice).length;
    return [{ label: DSH_ACCOUNT, provider: 'dsh', path: '~/.dsh', sessions, ok: true }];
  }

  applyEvent(body: DshEventBody): boolean {
    try {
      const event = rec(body.event);
      const type = str(event?.type);
      if (!event || !type || !RELEVANT.has(type)) return false;
      const data = rec(event.data) ?? {};
      const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : this.now();
      const t = this.touch(body.sessionId, body.cwd, at);
      if (!t) return false;
      this.mirror(body.sessionId, event, type === 'session');
      const live = this.now() - at < 120_000;

      switch (type) {
        case 'session': {
          const title = str(data.title);
          if (title) this.setTitle(t, title);
          break;
        }
        case 'session/title': {
          const title = str(data.title);
          if (title) this.setTitle(t, title);
          break;
        }
        case 'turn/start': {
          t.turnStart ??= at;
          this.decide(t, 'working', at);
          break;
        }
        case 'user/message': {
          t.turnStart = at;
          this.decide(t, 'working', at);
          const text = textOf(data.content);
          if (text) this.act(t, { kind: 'prompt', icon: '📝', text: truncate(text, 46), detail: truncate(text, 300) }, at, live);
          break;
        }
        case 'assistant/message': {
          const message = rec(data.message);
          const text = textOf(message?.content);
          if (text) this.act(t, SPECIAL.respond(truncate(text, 300)), at, live);
          const usage = rec(data.usage);
          const total = typeof usage?.totalTokens === 'number'
            ? usage.totalTokens
            : (typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0) + (typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0);
          if (total > 0) {
            t.tokens = (t.tokens ?? 0) + total;
            this.usageSamples.push({ at, tokens: total });
            this.publishUsage(at);
          }
          break;
        }
        case 'tool/call': {
          this.decide(t, 'working', at);
          const raw = str(data.name) ?? 'ferramenta';
          const name = TOOL_NAMES[raw] ?? raw;
          let input: unknown = data.arguments;
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input);
            } catch {
              input = { command: input };
            }
          }
          t.toolName = name;
          const desc = describeTool(name, input);
          this.act(t, { kind: desc.kind, icon: desc.icon, text: desc.text, ...(desc.detail ? { detail: desc.detail } : {}), tool: name }, at, live);
          break;
        }
        case 'tool/result': {
          const message = rec(data.message);
          if (message?.isError === true) {
            this.act(t, SPECIAL.error(t.toolName, truncate(textOf(message.content), 300)), at, live);
          }
          break;
        }
        case 'approval/asked': {
          this.decide(t, 'waiting', at, tr('responder no terminal'));
          this.act(t, SPECIAL.waiting(tr('aprovar no terminal')), at, live);
          break;
        }
        case 'approval/decided': {
          this.decide(t, 'working', at);
          break;
        }
        case 'turn/end': {
          const took = t.turnStart ? at - t.turnStart : undefined;
          t.turnStart = undefined;
          this.decide(t, 'idle', at);
          this.act(t, SPECIAL.turnDone(took), at, live);
          break;
        }
        case 'session/end': {
          if (t.inOffice) this.opts.office.closeMain(t.key);
          t.inOffice = false;
          this.publishUsage(at);
          break;
        }
        case 'bridge/stop': {
          this.decide(t, 'idle', at);
          break;
        }
        default:
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Cria/atualiza o tracker e garante o agente no escritório. Sem `cwd` não há sala: só entra quando a ponte manda. */
  private touch(sessionId: string, cwd: string | undefined, at: number): Tracker | undefined {
    const id = str(sessionId);
    if (!id) return undefined;
    const key = `dsh:${id}`;
    let t = this.trackers.get(key);
    if (!t) {
      if (!cwd) return undefined;
      t = {
        key,
        sessionId: id,
        cwd,
        inOffice: false,
        status: 'idle',
        startedAt: at,
        lastAt: at,
        lastEventAt: at,
      };
      this.trackers.set(key, t);
    } else if (cwd && cwd !== t.cwd) {
      t.cwd = cwd;
    }
    t.lastAt = at;
    t.lastEventAt = at;
    this.enter(t, at);
    return t;
  }

  private enter(t: Tracker, at: number): void {
    const office = this.opts.office;
    if (t.inOffice && !office.has(t.key)) t.inOffice = false;
    if (t.inOffice) return;
    office.addMain({
      id: t.key,
      provider: 'dsh',
      account: this.account,
      sessionId: t.sessionId,
      cwd: t.cwd,
      role: MAIN_ROLE,
      startedAt: t.startedAt,
      status: t.status,
      waitingFor: t.waitingFor,
    });
    t.inOffice = office.has(t.key);
    if (!t.inOffice) return;
    office.setStatus(t.key, t.status, t.waitingFor);
    if (t.title) office.applyTranscript(t.key, { title: t.title, tasks: [], stats: ZERO_STATS });
    void at;
  }

  private decide(t: Tracker, status: AgentStatus, at: number, waitingFor?: string): void {
    t.status = status;
    t.waitingFor = status === 'waiting' ? waitingFor : undefined;
    t.lastAt = Math.max(t.lastAt, at);
    if (t.inOffice) this.opts.office.setStatus(t.key, status, waitingFor);
  }

  /** Espelha o evento cru em JSONL (o terminal lê esse arquivo; o log original é zstd). */
  private mirror(sessionId: string, event: Record<string, unknown>, reset: boolean): void {
    try {
      mkdirSync(this.mirrorDir, { recursive: true });
      const file = join(this.mirrorDir, `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`);
      const line = JSON.stringify(event) + '\n';
      if (reset) writeFileSync(file, line);
      else appendFileSync(file, line);
    } catch {
      // sem espelho o terminal não abre, mas a atividade continua
    }
  }

  private trackOf(agentId: string): Tracker | undefined {
    return this.trackers.get(agentId);
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.trackOf(agentId);
    if (!t) return undefined;
    const file = join(this.mirrorDir, `${t.sessionId.replace(/[^\w.-]/g, '_')}.jsonl`);
    return existsSync(file) ? file : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    const t = this.trackOf(agentId);
    return t ? new DshTerminalParser(t.cwd) : undefined;
  }

  /** Publica o uso em tokens da conta (5 h, 7 dias e sessões abertas). Não é cota percentual: são contagens. */
  private publishUsage(at: number): void {
    const now = this.now();
    const cutoff7 = now - 7 * 24 * 3600_000;
    this.usageSamples = this.usageSamples.filter((s) => s.at >= cutoff7);
    const fiveHour = this.usageSamples.filter((s) => s.at >= now - 5 * 3600_000).reduce((n, s) => n + s.tokens, 0);
    const sevenDay = this.usageSamples.reduce((n, s) => n + s.tokens, 0);
    const session = [...this.trackers.values()].filter((t) => t.inOffice).reduce((n, t) => n + (t.tokens ?? 0), 0);
    this.opts.accounts.setUsage(this.account, {
      source: 'dsh',
      fetchedAt: Math.max(now, at),
      tokens: { fiveHour, sevenDay, session },
    });
  }

  private setTitle(t: Tracker, title: string): void {
    if (t.title === title) return;
    t.title = title;
    if (t.inOffice) this.opts.office.applyTranscript(t.key, { title, tasks: [], stats: ZERO_STATS });
  }

  private act(t: Tracker, act: Omit<Activity, 'id' | 'at'>, at: number, feed: boolean): void {
    if (!t.inOffice) return;
    const id = `${t.key}#${at.toString(36)}:${++this.actSeq}`;
    this.opts.office.addActivity(t.key, { id, at, ...act }, true, { feed });
  }
}

export function parseDshEvent(raw: unknown): DshEventBody {
  const body = rec(raw);
  const event = rec(body?.event);
  const sessionId = str(body?.sessionId);
  const cwd = str(body?.cwd);
  if (!sessionId || !event) throw new Error('esperado {sessionId, cwd?, event: {type, ...}}');
  if (JSON.stringify(event).length > MAX_EVENT) throw new Error('evento grande demais');
  return { sessionId, ...(cwd ? { cwd } : {}), event };
}
