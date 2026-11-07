#!/usr/bin/env node
// Ponte entre o DeepSeek Harness e o Habblaud: lê as sessões do DSH (JSONL comprimido com zstd em
// ~/.dsh/sessions/<projeto>/session-*/session.v4.jsonl.zstd) e manda os eventos para POST /api/dsh/events.
//
// Uso:
//   npm run dsh:bridge                         # todas as sessões recentes do diretório atual
//   npm run dsh:bridge -- --workspace <pasta>  # as sessões recentes daquela pasta
//   npm run dsh:bridge -- --all                # todas as sessões abertas, de qualquer projeto
//   npm run dsh:bridge -- --session <arquivo>  # uma sessão específica
//
// Só fala com 127.0.0.1. Não escreve nada na sessão do DSH: é uma ponte de observação, como os hooks do Codex.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const PORT = Number(process.env.HABBLAUD_PORT ?? 4747) || 4747;
const POLL_MS = 700;
const DISCOVER_MS = 5_000;
/** Sessões mais velhas que isto ficam de fora (o escritório mostra o dia, não o histórico inteiro). */
const MAX_AGE_MS = 24 * 3600_000;
const SESSIONS_DIR = join(homedir(), '.dsh', 'sessions');
/** Eventos que o servidor entende (o resto do JSONL é ruído de execução). */
const SEND = new Set([
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
]);

interface Args {
  session?: string;
  workspace?: string;
  all?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') out.session = argv[++i];
    else if (argv[i] === '--workspace') out.workspace = argv[++i];
    else if (argv[i] === '--all') out.all = true;
  }
  return out;
}

function zstd(file: string): string {
  return execFileSync('zstd', ['-dc', file], { maxBuffer: 128 * 1024 * 1024 }).toString('utf8');
}

function headerOf(file: string): Record<string, unknown> | undefined {
  try {
    const first = zstd(file).split('\n', 1)[0];
    return first ? (JSON.parse(first) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

interface SessionFile {
  file: string;
  mtime: number;
}

/**
 * A sessão está aberta? O DSH mantém `session.lock` aberto pelo processo enquanto a sessão vive (o arquivo existe
 * para sempre; quem manda é o lsof). Sem lsof, vale a atividade recente.
 */
function isOpen(file: string, mtime: number): boolean {
  const lock = join(dirname(file), 'session.lock');
  if (existsSync(lock)) {
    try {
      const out = execFileSync('lsof', ['-t', lock], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) return true;
      // lsof rodou e não achou dono: a sessão está fechada.
      return false;
    } catch {
      // lsof sem resultado (ou sem lsof): cai na atividade recente.
    }
  }
  return Date.now() - mtime < 10 * 60_000;
}

/** Sessões do DSH modificadas recentemente (e, com `workspace`, só as daquela pasta). */
function discover(workspace: string, only?: string, all = false): SessionFile[] {
  if (only) return [{ file: only, mtime: Date.now() }];
  if (!existsSync(SESSIONS_DIR)) return [];
  const now = Date.now();
  const files: SessionFile[] = [];
  for (const dir of readdirSync(SESSIONS_DIR)) {
    const projectDir = join(SESSIONS_DIR, dir);
    let entries: string[];
    try {
      if (!statSync(projectDir).isDirectory()) continue;
      entries = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(projectDir, entry, 'session.v4.jsonl.zstd');
      try {
        const st = statSync(file);
        if (st.isFile() && now - st.mtimeMs < MAX_AGE_MS && isOpen(file, st.mtimeMs)) files.push({ file, mtime: st.mtimeMs });
      } catch {
        // sem sessão nesta pasta
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const matching: SessionFile[] = [];
  for (const f of files) {
    const head = headerOf(f.file);
    const cwd = typeof head?.cwd === 'string' ? resolve(head.cwd) : '';
    if (all || cwd === workspace) matching.push(f);
  }
  return matching;
}

const post = async (body: unknown): Promise<void> => {
  await fetch(`http://127.0.0.1:${PORT}/api/dsh/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4_000),
  });
};

class SessionBridge {
  private cursor = 0;
  private size = -1;
  private mtime = -1;
  private sessionId = '';
  private cwd = '';
  private stopped = false;
  private lastError = 0;

  constructor(readonly file: string) {}

  private async send(event: Record<string, unknown>): Promise<void> {
    if (!this.sessionId) return;
    try {
      await post({ sessionId: this.sessionId, cwd: this.cwd, event });
    } catch {
      if (Date.now() - this.lastError > 60_000) {
        this.lastError = Date.now();
        process.stderr.write(`[dsh-bridge] Habblaud fora do ar em 127.0.0.1:${PORT}; sigo tentando.\n`);
      }
    }
  }

  /** Lê o arquivo inteiro, processa as linhas novas e manda os eventos relevantes. */
  async poll(): Promise<void> {
    let st;
    try {
      st = statSync(this.file);
    } catch {
      return;
    }
    if (st.size === this.size && st.mtimeMs === this.mtime) return;
    this.size = st.size;
    this.mtime = st.mtimeMs;
    let text: string;
    try {
      text = zstd(this.file);
    } catch {
      return;
    }
    const lines = text.split('\n');
    if (lines.length < this.cursor) this.cursor = 0; // arquivo compactado/reescrito
    if (!this.sessionId) {
      const head = lines.find((l) => l.includes('"type":"session"'));
      if (!head) return;
      try {
        const h = JSON.parse(head) as Record<string, unknown>;
        this.sessionId = String(h.id ?? '');
        this.cwd = String(h.cwd ?? '');
      } catch {
        return;
      }
    }
    for (let i = this.cursor; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!SEND.has(String(event.type ?? ''))) continue;
      await this.send(event);
    }
    this.cursor = lines.length;
  }

  /** O escritório reiniciou: relê a sessão desde o começo para o personagem voltar. */
  reset(): void {
    this.cursor = 0;
    this.size = -1;
    this.mtime = -1;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.send({ type: 'bridge/stop', time: Date.now(), data: {} });
  }

  /** Sessão fechada no DSH: o personagem vai embora do escritório. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.send({ type: 'session/end', time: Date.now(), data: {} });
  }
}

const args = parseArgs(process.argv.slice(2));
const workspace = resolve(args.workspace ?? process.cwd());
const bridges = new Map<string, SessionBridge>();
let lastDiscover = 0;
let lastBoot: number | undefined;
let lastBootCheck = 0;

/** `bootAt` do /api/health: se mudou, o servidor reiniciou e as sessões precisam ser reenviadas. */
async function checkBoot(): Promise<void> {
  if (Date.now() - lastBootCheck < 10_000) return;
  lastBootCheck = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return;
    const health = (await res.json()) as { bootAt?: number };
    if (typeof health.bootAt !== 'number') return;
    if (lastBoot !== undefined && lastBoot !== health.bootAt) {
      for (const b of bridges.values()) b.reset();
      process.stderr.write('[dsh-bridge] Habblaud reiniciou; reenviando as sessões.\n');
    }
    lastBoot = health.bootAt;
  } catch {
    // fora do ar: tenta na próxima
  }
}

async function refresh(force: boolean): Promise<void> {
  if (!force && Date.now() - lastDiscover < DISCOVER_MS) return;
  lastDiscover = Date.now();
  const found = discover(workspace, args.session ? resolve(args.session) : undefined, args.all === true);
  const active = new Set(found.map((f) => f.file));
  for (const { file } of found) {
    if (!bridges.has(file)) {
      bridges.set(file, new SessionBridge(file));
      process.stderr.write(`[dsh-bridge] observando ${file}\n`);
    }
  }
  if (!args.session) {
    for (const [file, bridge] of bridges) {
      if (active.has(file)) continue;
      bridges.delete(file);
      process.stderr.write(`[dsh-bridge] sessão encerrada: ${basename(dirname(file))}\n`);
      await bridge.close();
    }
  }
}

await refresh(true);
if (!bridges.size) {
  process.stderr.write(`[dsh-bridge] nenhuma sessão do DSH em ${workspace}. Use --session <arquivo> ou abra uma sessão do DSH.\n`);
  process.exit(1);
}

let running = true;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    running = false;
    void Promise.all([...bridges.values()].map((b) => b.stop())).finally(() => process.exit(0));
  });
}

while (running) {
  await checkBoot();
  await refresh(false);
  for (const bridge of bridges.values()) await bridge.poll();
  await new Promise((r) => setTimeout(r, POLL_MS));
}
