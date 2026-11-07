// Terminal do DeepSeek Harness: lê o espelho JSONL dos eventos da sessão (o log original é zstd) e monta a
// conversa como o Habblaud mostra para Claude Code e Codex: prompt, resposta, ferramentas, resultados e avisos.
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { marked, oneLine, prepare, toolView, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, type TerminalParser } from '../terminal';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;

const SEEN_MAX = 20_000;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = rec(part);
      return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Nomes minúsculos do DSH para os nomes que o toolView do Habblaud conhece. */
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

function parseArgs(raw: unknown): Rec {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Rec;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Rec) : { command: raw };
    } catch {
      return { command: raw };
    }
  }
  return {};
}

export class DshTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private readonly cwd?: string;
  private lastAt?: number;

  constructor(cwd?: string) {
    this.cwd = cwd;
  }

  push(line: string): TerminalEntry[] {
    this.out = [];
    if (line.length < 2) return this.out;
    try {
      this.line(line);
    } catch {
      // evento estranho: o que já saiu dele vale; a leitura segue
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private line(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const event = rec(parsed);
    if (!event) return;
    const type = str(event.type);
    if (!type) return;
    const data = rec(event.data) ?? {};
    const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : (this.lastAt ?? Date.now());
    this.lastAt = at;
    const key = typeof event.seq === 'number' ? String(event.seq) : `${type}:${at}`;

    switch (type) {
      case 'session': {
        const cwd = str(data.cwd);
        if (cwd) this.sys(key, at, tr('Sessão do DeepSeek Harness aberta em {0}', [cwd]));
        return;
      }
      case 'user/message': {
        // O DSH grava contexto de execução, catálogo de skills e horário como mensagens de usuário; só o prompt
        // digitado (source.kind 'user' ou sem source) entra no terminal.
        const source = rec(data.source);
        const kind = str(source?.kind);
        if (kind && kind !== 'user') return;
        const raw = textOf(data.content).trim();
        if (!raw) return;
        const text = prepare(raw, TEXT_MAX);
        const body = marked(text);
        if (body) this.emit({ kind: 'user', id: `${key}:u`, at, text: body });
        return;
      }
      case 'assistant/message': {
        const message = rec(data.message);
        const text = prepare(textOf(message?.content), TEXT_MAX);
        const body = marked(text);
        if (body) this.emit({ kind: 'assistant', id: `${key}:a`, at, text: body });
        return;
      }
      case 'tool/call': {
        const callId = str(data.callId) ?? str(data.call_id) ?? key;
        const rawName = str(data.name) ?? 'ferramenta';
        const name = TOOL_NAMES[rawName] ?? rawName;
        const view = toolView(name, parseArgs(data.arguments), this.cwd);
        const entry: ToolEntry = { kind: 'tool', id: `${callId}:t`, at, tool: name, title: maskSecrets(view.title) };
        if (view.input) {
          entry.input = view.input;
          if (view.inputKind) entry.inputKind = view.inputKind as TerminalInputKind;
        }
        this.emit(entry);
        return;
      }
      case 'tool/result': {
        const message = rec(data.message);
        const callId = str(data.toolCallId) ?? str(data.callId) ?? str(data.call_id);
        if (!callId) return;
        const p = prepare(textOf(message?.content), RESULT_MAX, RESULT_MAX_LINES);
        const entry: ResultEntry = { kind: 'result', id: `${callId}:r`, at, toolUseId: `${callId}:t`, text: p.text || tr('(sem saída)') };
        if (message?.isError === true) entry.error = true;
        if (p.truncated) entry.truncated = true;
        this.emit(entry);
        return;
      }
      case 'approval/asked': {
        const tool = str(data.toolName);
        this.sys(`${key}:ap`, at, tool ? tr('Pede aprovação para usar {0}', [tool]) : tr('Pede aprovação'), 'warn');
        return;
      }
      case 'approval/decided': {
        this.sys(`${key}:ad`, at, data.outcome === 'denied' ? tr('Aprovação recusada') : tr('Aprovação respondida'));
        return;
      }
      case 'turn/end': {
        const reason = rec(data.reason);
        const error = rec(reason?.error);
        if (error) this.sys(`${key}:err`, at, tr('Erro: {0}', [oneLine(str(error.message) ?? tr('desconhecido'), 160)]), 'error');
        return;
      }
      case 'system/message': {
        const text = textOf(data.content);
        if (text) this.sys(key, at, oneLine(text, 160));
        return;
      }
      case 'workspace/changes': {
        const changes = Array.isArray(data.changes) ? data.changes.length : 0;
        if (changes) this.sys(`${key}:ws`, at, tr('{0} arquivo(s) alterado(s)', [changes]));
        return;
      }
      default:
        return;
    }
  }

  private sys(id: string, at: number, text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (!text.trim()) return;
    this.emit({ kind: 'system', id: `${id}:s`, at, text: maskSecrets(text), level });
  }
}
