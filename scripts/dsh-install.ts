// Instala (ou remove) a integração do Habblaud com o DeepSeek Harness (DSH). Roda no HOST, com tsx:
//
//   npm run dsh:install     # copia o plugin do inbox para o perfil do DSH, acrescenta o bloco no cordis.patch.yml
//                           # (com backup) e instala o serviço do `npm run dsh:bridge` (--all)
//   npm run dsh:uninstall   # tira o serviço, o bloco do cordis.patch.yml (com backup) e o plugin copiado
//   npm run dsh:status      # confere cada peça: dependências, plugin, bloco, serviço e o /api/health
//   (opções: --dry-run, --no-service, --profile <nome>, --port <n>)
//
// Duas peças ligam o DSH ao escritório:
// - a PONTE (`scripts/dsh-bridge.ts`), que lê as sessões em ~/.dsh/sessions e manda os eventos: sem ela o personagem
//   não aparece. Precisa de `zstd` (descomprime a sessão) e de `lsof` (descobre a sessão aberta; sem ele vale a
//   atividade recente). O serviço abaixo a mantém rodando e reiniciando sozinha, no login;
// - o PLUGIN do inbox (`mod/habblaud-dsh-inbox`), que o DSH carrega pelo perfil: é ele que traz a caixa
//   "Mandar mensagem" para dentro da sessão. O Habblaud não escreve no perfil do DSH sozinho; este instalador copia o
//   plugin para <perfil>/habblaud-inbox.mjs e acrescenta um bloco no <perfil>/cordis.patch.yml.
//
// O bloco do YAML é reconhecido por `id: habblaud-dsh-inbox`. A regra de ouro: se o id já aparece no arquivo, o
// instalador NUNCA acrescenta outro — só remove cópias repetidas idênticas (arquivo editado à mão com o bloco colado
// duas vezes) e, se o que sobrou não for o bloco deste projeto, para e manda conferir à mão. Antes de qualquer
// gravação, uma cópia do cordis.patch.yml vai para cordis.patch.yml.habblaud-backup-<data>.
//
// Serviço: LaunchAgent ~/Library/LaunchAgents/com.habblaud.dsh-bridge.plist (macOS) ou unidade systemd de usuário
// habblaud-dsh-bridge.service (Linux e WSL, com loginctl enable-linger). Log em ~/.habblaud/dsh-bridge.log.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** O plugin que o DSH carrega (fonte, no repositório). */
export function pluginSource(repo: string): string {
  return join(repo, 'mod', 'habblaud-dsh-inbox', 'plugin.mjs');
}
export const PLUGIN_SOURCE = pluginSource(ROOT);
/** Nome do arquivo copiado para o perfil do DSH (o nome citado no bloco do YAML). */
export const INBOX_FILE = 'habblaud-inbox.mjs';
/** O id do bloco no cordis.patch.yml: é por ele que o instalador reconhece o que é dele. */
export const INBOX_ID = 'habblaud-dsh-inbox';
export const PATCH_FILE = 'cordis.patch.yml';
export const PROFILES_DIR = join('.dsh', 'profiles');
export const DEFAULT_PROFILE = 'desktop';
export const DEFAULT_PORT = 4747;
export const SERVICE_LABEL = 'com.habblaud.dsh-bridge';
export const SYSTEMD_UNIT = 'habblaud-dsh-bridge.service';
/** O script da ponte, que o serviço roda. */
export const BRIDGE_SCRIPT = join(ROOT, 'scripts', 'dsh-bridge.ts');
/** Argumentos da ponte: todas as sessões abertas, de qualquer projeto (o serviço não pode depender de uma pasta). */
export const BRIDGE_ARGS = ['--all'] as const;

/** O bloco que o instalador acrescenta no fim do cordis.patch.yml. */
export const INBOX_BLOCK = `# Habblaud: caixa de mensagens do escritório -> sessão do DSH (plugin local).
- insert:
    - id: ${INBOX_ID}
      name: "./${INBOX_FILE}"
`;

const USAGE = tr(
  `Uso: npm run dsh:<install|uninstall|status> [-- opções]

  install     liga o DSH ao escritório: copia o plugin do inbox para o perfil do DSH, acrescenta o bloco
              no cordis.patch.yml (backup antes) e instala o serviço que roda a ponte (--all)
  uninstall   tira o serviço, o bloco do cordis.patch.yml (backup antes) e o plugin copiado
  status      confere dependências, plugin, bloco, serviço e o /api/health do Habblaud

Opções:
  --dry-run          mostra o que mudaria, sem gravar nada
  --no-service       não instala nem mexe no serviço (só o plugin e o bloco)
  --profile <nome>   perfil do DSH (padrão: {0}, se existir)
  --port <n>         porta do Habblaud (padrão: HABBLAUD_PORT ou {1})
  -h, --help         mostra esta ajuda

O DSH é procurado em ~/.dsh/profiles. O serviço fica em ~/Library/LaunchAgents (macOS) ou em
~/.config/systemd/user (Linux e WSL). Depois de instalar, abra o DSH: o perfil recarrega sozinho.`,
  [DEFAULT_PROFILE, DEFAULT_PORT],
);

/** Onde o DSH guarda os perfis (DSH_HOME/profiles ou ~/.dsh/profiles). */
export function profilesRoot(env: NodeJS.ProcessEnv, home: string): string {
  const custom = env.DSH_HOME?.trim();
  return custom ? join(resolve(custom.replace(/^~(?=\/|$)/, home)), 'profiles') : join(home, PROFILES_DIR);
}

/** Perfis do DSH (subpastas de ~/.dsh/profiles). */
export function discoverProfiles(env: NodeJS.ProcessEnv, home: string): string[] {
  const root = profilesRoot(env, home);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** O perfil a usar: o pedido, senão o `desktop`, senão o primeiro. */
export function chooseProfile(profiles: readonly string[], requested?: string): string | undefined {
  if (requested) return profiles.includes(requested) ? requested : undefined;
  if (profiles.includes(DEFAULT_PROFILE)) return DEFAULT_PROFILE;
  return profiles[0];
}

export interface Profile {
  name: string;
  dir: string;
  patch: string;
  inbox: string;
}

/**
 * O perfil do DSH, na ordem em que o próprio DSH o escolhe: `--profile`, o perfil da sessão (DSH_PROFILE_DIR /
 * DSH_PROFILE, quando o comando roda no terminal do DSH), `desktop`, o primeiro que existir.
 */
export function resolveProfile(env: NodeJS.ProcessEnv, home: string, requested?: string): { profile?: Profile; profiles: string[] } {
  const root = profilesRoot(env, home);
  const profiles = discoverProfiles(env, home);
  const make = (name: string): Profile => {
    const dir = join(root, name);
    return { name, dir, patch: join(dir, PATCH_FILE), inbox: join(dir, INBOX_FILE) };
  };
  if (requested) return { profile: profiles.includes(requested) ? make(requested) : undefined, profiles };
  const sessionDir = env.DSH_PROFILE_DIR?.trim();
  if (sessionDir) {
    const name = env.DSH_PROFILE?.trim() || basename(sessionDir);
    const dir = resolve(sessionDir.replace(/^~(?=\/|$)/, home));
    if (existsSync(dir)) return { profile: { name, dir, patch: join(dir, PATCH_FILE), inbox: join(dir, INBOX_FILE) }, profiles };
  }
  const sessionName = env.DSH_PROFILE?.trim();
  if (sessionName && profiles.includes(sessionName)) return { profile: make(sessionName), profiles };
  const name = chooseProfile(profiles);
  return { profile: name ? make(name) : undefined, profiles };
}

export interface PatchState {
  /** Quantas vezes `id: habblaud-dsh-inbox` aparece (o que define "já instalado"). */
  ids: number;
  /** Quantas vezes o bloco deste projeto aparece inteiro e idêntico. */
  blocks: number;
}

/** O que o cordis.patch.yml já tem do Habblaud (não grava nada). */
export function patchState(text: string): PatchState {
  return { ids: countOf(text, `id: ${INBOX_ID}`), blocks: countOf(text, INBOX_BLOCK) };
}

function countOf(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

export type PatchAction = 'install' | 'dedupe' | 'none' | 'conflict' | 'remove' | 'absent';

export interface PatchPlan {
  action: PatchAction;
  /** Conteúdo a gravar (só nos casos em que há gravação). */
  text: string;
  message: string;
}

/** Tira do texto todas as cópias idênticas do bloco do Habblaud. */
function withoutBlock(text: string): string {
  let out = text;
  for (let i = out.indexOf(INBOX_BLOCK); i !== -1; i = out.indexOf(INBOX_BLOCK, i)) out = out.slice(0, i) + out.slice(i + INBOX_BLOCK.length);
  return out;
}

/** Junta o texto (sem espaços no fim) e o bloco, com uma linha em branco entre os dois. */
function joinBlock(text: string): string {
  const base = text.replace(/\s+$/, '');
  return `${base ? `${base}\n\n` : ''}${INBOX_BLOCK}`;
}

/**
 * Plano para o cordis.patch.yml (não grava nada). A regra: se `id: habblaud-dsh-inbox` já aparece, NUNCA acrescentar
 * outro bloco.
 * - sem o id: acrescenta o bloco no fim (`install`);
 * - com o bloco deste projeto uma vez (e nada mais): `none`;
 * - com o bloco colado duas ou mais vezes: tira as cópias repetidas (`dedupe`);
 * - com o id em outra forma (editado à mão, ou linha com CRLF): `conflict` — para e manda conferir, em vez de
 *   arriscar duplicar ou apagar o que é do usuário.
 */
export function planPatch(text: string): PatchPlan {
  const state = patchState(text);
  if (state.ids === 0) return { action: 'install', text: joinBlock(text), message: tr('bloco do Habblaud acrescentado') };
  if (state.blocks === 0) {
    return { action: 'none', text, message: tr('o id {0} já aparece, mas não com o bloco deste projeto; nada foi alterado (confira à mão)', [INBOX_ID]) };
  }
  const otherIds = state.ids - state.blocks;
  if (otherIds > 0) {
    return { action: 'conflict', text, message: tr('o id {0} aparece {1} vez(es) além do bloco deste projeto; nada foi alterado', [INBOX_ID, otherIds]) };
  }
  if (state.blocks > 1) return { action: 'dedupe', text: joinBlock(withoutBlock(text)), message: tr('cópias repetidas do bloco removidas ({0} → 1)', [state.blocks]) };
  return { action: 'none', text, message: tr('bloco do Habblaud já instalado') };
}

/** Plano para tirar o bloco (uninstall). Sem o bloco, devolve `absent` e não grava nada. */
export function planRemovePatch(text: string): PatchPlan {
  const state = patchState(text);
  if (state.blocks === 0) {
    return state.ids > 0
      ? { action: 'conflict', text, message: tr('o id {0} existe, mas não com o bloco deste projeto; tire à mão', [INBOX_ID]) }
      : { action: 'absent', text, message: tr('bloco do Habblaud não estava no arquivo') };
  }
  const next = withoutBlock(text).replace(/\s+$/, '');
  if (patchState(next).ids > 0) return { action: 'conflict', text, message: tr('sobrou outra referência a {0}; nada foi alterado', [INBOX_ID]) };
  return { action: 'remove', text: next ? `${next}\n` : '', message: tr('bloco do Habblaud removido') };
}

// ---------------------------------------------------------------------------------------------
// Serviço (LaunchAgent no macOS, unidade systemd de usuário no Linux e no WSL)
// ---------------------------------------------------------------------------------------------

export interface ServiceSpec {
  kind: 'launchd' | 'systemd';
  /** Arquivo do serviço (plist ou unit). */
  path: string;
  content: string;
  /** Log do serviço (a ponte escreve aqui). */
  log: string;
}

export interface ServiceInput {
  home: string;
  repo: string;
  node: string;
  /** O CLI do tsx (scripts/dsh-bridge.ts é TypeScript). */
  tsx: string;
  port: number;
}

/** PATH do serviço: o do shell não vale (o launchd/systemd não lê o .zshrc), então os diretórios comuns vão fixos. */
export function servicePath(node: string): string {
  const dirs = [dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(dirs)].join(':');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** O LaunchAgent que roda a ponte. Sem `--foreground`/KeepAlive do launchd, o processo subiria e o launchd o veria sair. */
export function launchdPlist(input: ServiceInput): string {
  const log = join(input.home, '.habblaud', 'dsh-bridge.log');
  const args = [input.node, input.tsx, join(input.repo, 'scripts', 'dsh-bridge.ts'), ...BRIDGE_ARGS]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(servicePath(input.node))}</string>
    <key>HABBLAUD_PORT</key>
    <string>${input.port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

/** A unidade systemd de usuário. `append:` mantém o mesmo log do macOS (systemd 240+). */
export function systemdUnit(input: ServiceInput): string {
  const log = join(input.home, '.habblaud', 'dsh-bridge.log');
  return `[Unit]
Description=Habblaud — ponte das sessões do DeepSeek Harness
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.repo}
Environment=PATH=${servicePath(input.node)}
Environment=HABBLAUD_PORT=${input.port}
ExecStart=${input.node} ${input.tsx} ${join(input.repo, 'scripts', 'dsh-bridge.ts')} ${BRIDGE_ARGS.join(' ')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

/** O spec do serviço para a plataforma. `win32` nativo não tem: o Habblaud roda no WSL. */
export function serviceSpec(platform: NodeJS.Platform, input: ServiceInput): ServiceSpec | undefined {
  if (platform === 'darwin') {
    return {
      kind: 'launchd',
      path: join(input.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
      content: launchdPlist(input),
      log: join(input.home, '.habblaud', 'dsh-bridge.log'),
    };
  }
  if (platform === 'linux') {
    return {
      kind: 'systemd',
      path: join(input.home, '.config', 'systemd', 'user', SYSTEMD_UNIT),
      content: systemdUnit(input),
      log: join(input.home, '.habblaud', 'dsh-bridge.log'),
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Efeitos
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** --no-service: mexe só no plugin e no YAML. */
  noService: boolean;
  profile?: string;
  port: number;
}

export interface Health {
  dshEvents?: boolean;
  sources?: Array<{ label?: string; provider?: string; sessions?: number; ok?: boolean }>;
}

export interface ExecResult {
  ok: boolean;
  out: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  repo: string;
  platform: NodeJS.Platform;
  node: string;
  tsx: string;
  now: Date;
  out: (line: string) => void;
  /** Roda um comando do sistema (testes injetam um falso). */
  exec?: (cmd: string, args: readonly string[]) => ExecResult;
  /** Consulta o /api/health do Habblaud (testes injetam um falso). */
  health?: (port: number) => Promise<Health | undefined>;
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let noService = false;
  let profile: string | undefined;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--no-service') noService = true;
    else if (a === '--profile') {
      profile = argv[++i];
      if (!profile || profile.startsWith('-')) throw new FatalError(tr('--profile precisa do nome de um perfil do DSH (ex.: desktop).'));
    } else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port precisa de um número entre 1 e 65535.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('diga o que fazer: install, uninstall ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, noService, port, ...(profile ? { profile } : {}) };
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Backup + gravação atômica do cordis.patch.yml, preservando a permissão. Devolve o caminho do backup. */
function writePatch(file: string, text: string, now: Date): string | undefined {
  const exists = existsSync(file);
  const mode = exists ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.habblaud-tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  let backup = `${file}.habblaud-backup-${stamp(now)}`;
  for (let i = 2; exists && existsSync(backup); i++) backup = `${file}.habblaud-backup-${stamp(now)}-${i}`;
  if (exists) writeFileSync(backup, readFileSync(file), { mode });
  renameSync(tmp, file);
  return exists ? backup : undefined;
}

function which(cmd: string, ctx: RunContext): boolean {
  const run = ctx.exec ?? defaultExec;
  return run('sh', ['-c', `command -v ${cmd}`]).ok;
}

function defaultExec(cmd: string, args: readonly string[]): ExecResult {
  try {
    return { ok: true, out: execFileSync(cmd, [...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? e.message ?? ''}`.trim() };
  }
}

/** O CLI do tsx: o caminho interno do pacote (estável entre npm e pnpm) ou o shim do node_modules/.bin. */
export function tsxCli(repo: string): string {
  const direct = join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return existsSync(direct) ? direct : join(repo, 'node_modules', '.bin', 'tsx');
}

/** Serviço carregado agora (launchd) ou ativo (systemd). */
function serviceRunning(kind: ServiceSpec['kind'], ctx: RunContext): boolean {
  const run = ctx.exec ?? defaultExec;
  if (kind === 'launchd') return run('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${SERVICE_LABEL}`]).ok;
  return run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]).out.trim() === 'active';
}

/** Pausa curta sem soltar a thread (o launchd precisa de um instante entre bootout e bootstrap). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Instala (ou atualiza) o serviço. Devolve as linhas para a saída e se falhou. */
function ensureService(spec: ServiceSpec, ctx: RunContext, dryRun: boolean): { lines: string[]; failed: boolean } {
  const run = ctx.exec ?? defaultExec;
  const lines: string[] = [];
  const rel = spec.path.replace(ctx.home, '~');
  const current = existsSync(spec.path) ? readFileSync(spec.path, 'utf8') : undefined;
  if (current === spec.content && serviceRunning(spec.kind, ctx)) {
    return { lines: [tr('= serviço ({0}): já instalado e rodando', [rel])], failed: false };
  }
  if (dryRun) {
    const what = current === undefined ? tr('seria criado') : current === spec.content ? tr('já igual') : tr('seria atualizado');
    return { lines: [tr('~ serviço ({0}): {1} (simulação: nada gravado)', [rel, what])], failed: false };
  }
  try {
    mkdirSync(dirname(spec.path), { recursive: true });
    mkdirSync(join(ctx.home, '.habblaud'), { recursive: true });
    if (current !== spec.content) writeFileSync(spec.path, spec.content, { mode: 0o644 });
    if (spec.kind === 'launchd') {
      // O bootout seguido na hora de um bootstrap pode falhar ("Input/output error"): o launchd ainda está
      // desregistrando o serviço antigo. Tenta de novo algumas vezes antes de desistir.
      const domain = `gui/${process.getuid?.() ?? 501}`;
      const wasRunning = serviceRunning('launchd', ctx);
      run('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]);
      if (wasRunning) sleepSync(400);
      let boot = run('launchctl', ['bootstrap', domain, spec.path]);
      for (let i = 0; !boot.ok && i < 3; i++) {
        sleepSync(500);
        boot = run('launchctl', ['bootstrap', domain, spec.path]);
      }
      if (!boot.ok) {
        return { lines: [tr('✗ serviço ({0}): gravado, mas o launchd não carregou ({1})', [rel, boot.out])], failed: true };
      }
      lines.push(tr('✓ serviço ({0}): instalado e carregado (reinicia sozinho e sobe no login)', [rel]));
    } else {
      run('systemctl', ['--user', 'daemon-reload']);
      const enabled = run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
      if (!enabled.ok) {
        return { lines: [tr('✗ serviço ({0}): gravado, mas o systemd não ativou ({1})', [rel, enabled.out])], failed: true };
      }
      lines.push(tr('✓ serviço ({0}): instalado e ativado (reinicia sozinho e sobe no login)', [rel]));
      const linger = run('loginctl', ['enable-linger', ctx.env.USER ?? '']);
      lines.push(
        linger.ok
          ? tr('✓ loginctl enable-linger: o serviço sobe com a máquina, sem sessão aberta')
          : tr('! loginctl enable-linger falhou ({0}): rode `sudo loginctl enable-linger {1}` para subir sem login', [linger.out, ctx.env.USER ?? '']),
      );
    }
    return { lines, failed: false };
  } catch (err) {
    return { lines: [tr('✗ serviço ({0}): não consegui gravar ({1})', [rel, (err as Error).message])], failed: true };
  }
}

/** Remove o serviço instalado por este script. */
function removeService(spec: ServiceSpec, ctx: RunContext, dryRun: boolean): { lines: string[]; failed: boolean } {
  const run = ctx.exec ?? defaultExec;
  const rel = spec.path.replace(ctx.home, '~');
  const lines: string[] = [];
  let failed = false;
  if (dryRun) {
    return { lines: [existsSync(spec.path) ? tr('~ serviço ({0}): seria removido (simulação: nada gravado)', [rel]) : tr('= serviço ({0}): não existe', [rel])], failed: false };
  }
  if (spec.kind === 'launchd') {
    run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${SERVICE_LABEL}`]);
  } else {
    run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
    run('systemctl', ['--user', 'daemon-reload']);
  }
  if (existsSync(spec.path)) {
    try {
      unlinkSync(spec.path);
      lines.push(tr('✓ serviço ({0}): removido', [rel]));
    } catch (err) {
      lines.push(tr('✗ serviço ({0}): não consegui remover ({1})', [rel, (err as Error).message]));
      failed = true;
    }
  } else {
    lines.push(tr('= serviço ({0}): não existia', [rel]));
  }
  return { lines, failed };
}

async function fetchHealth(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as Health;
  } catch {
    return undefined;
  }
}

/** O comando de verdade. Devolve o código de saída. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { out, home } = ctx;
  const { profile, profiles } = resolveProfile(ctx.env, home, opts.profile);
  if (!profile) {
    out(
      opts.profile
        ? tr('✗ Perfil {0} não encontrado. Perfis do DSH: {1}.', [opts.profile, profiles.join(', ') || tr('nenhum')])
        : tr('✗ Nenhum perfil do DSH em {0}. Abra o DeepSeek Harness uma vez (ele cria o perfil) e rode de novo.', [profilesRoot(ctx.env, home).replace(home, '~')]),
    );
    return 1;
  }
  const patchPath = profile.patch;
  const inboxPath = profile.inbox;
  out(tr('DeepSeek Harness: perfil {0} ({1})', [profile.name, patchPath.replace(home, '~')]));
  let failures = 0;
  let serviceSpecNow: ServiceSpec | undefined;
  if (!opts.noService) {
    serviceSpecNow = serviceSpec(ctx.platform, { home, repo: ctx.repo, node: ctx.node, tsx: ctx.tsx, port: opts.port });
    if (!serviceSpecNow) {
      out(tr('✗ Serviço automático não existe no {0}: rode dentro do WSL, no Linux ou no macOS (ou use --no-service).', [ctx.platform]));
      failures++;
    }
  }

  // ---- uninstall ------------------------------------------------------------------------------
  if (opts.command === 'uninstall') {
    if (serviceSpecNow) {
      const r = removeService(serviceSpecNow, ctx, opts.dryRun);
      r.lines.forEach(out);
      if (r.failed) failures++;
    }
    const raw = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined;
    if (raw === undefined) out(tr('= bloco do Habblaud: {0} não existe', [patchPath.replace(home, '~')]));
    else {
      const plan = planRemovePatch(raw);
      if (plan.action === 'conflict') {
        out(tr('✗ {0}: {1}', [PATCH_FILE, plan.message]));
        failures++;
      } else if (plan.action === 'absent') out(`= ${plan.message}`);
      else if (opts.dryRun) out(tr('~ {0}: {1} (simulação: nada gravado)', [PATCH_FILE, plan.message]));
      else {
        try {
          const backup = writePatch(patchPath, plan.text, ctx.now);
          out(tr('✓ {0}: {1}{2}', [PATCH_FILE, plan.message, backup ? ` · backup em ${backup.replace(home, '~')}` : '']));
        } catch (err) {
          out(tr('✗ {0}: não consegui gravar ({1})', [PATCH_FILE, (err as Error).message]));
          failures++;
        }
      }
    }
    if (existsSync(inboxPath)) {
      if (opts.dryRun) out(tr('~ plugin: {0} seria removido (simulação: nada gravado)', [inboxPath.replace(home, '~')]));
      else {
        try {
          unlinkSync(inboxPath);
          out(tr('✓ plugin: {0} removido', [inboxPath.replace(home, '~')]));
        } catch (err) {
          out(tr('✗ plugin: não consegui remover ({0})', [(err as Error).message]));
          failures++;
        }
      }
    } else out(tr('= plugin: {0} não existia', [inboxPath.replace(home, '~')]));
    if (!failures) out(tr('Pronto. Reabra o DSH para ele largar o plugin do Habblaud.'));
    return failures ? 1 : 0;
  }

  // ---- status ---------------------------------------------------------------------------------
  if (opts.command === 'status') {
    const state = existsSync(patchPath) ? patchState(readFileSync(patchPath, 'utf8')) : { ids: 0, blocks: 0 };
    if (state.ids === 0) {
      out(tr('✗ {0}: bloco do Habblaud ausente; rode npm run dsh:install', [PATCH_FILE]));
      failures++;
    } else if (state.ids > 1) {
      out(tr('✗ {0}: bloco do Habblaud {1} vezes (duplicado); rode npm run dsh:install para corrigir', [PATCH_FILE, state.ids]));
      failures++;
    } else if (state.blocks === 0) {
      out(tr('! {0}: o id {1} existe, mas não com o bloco deste projeto; confira à mão', [PATCH_FILE, INBOX_ID]));
    } else out(tr('✓ {0}: bloco do Habblaud instalado', [PATCH_FILE]));
    if (!existsSync(inboxPath)) {
      out(tr('✗ plugin: {0} não existe; rode npm run dsh:install', [inboxPath.replace(home, '~')]));
      failures++;
    } else if (existsSync(pluginSource(ctx.repo)) && readFileSync(inboxPath).compare(readFileSync(pluginSource(ctx.repo))) !== 0) {
      out(tr('✗ plugin: {0} diferente do repositório; rode npm run dsh:install para atualizar', [inboxPath.replace(home, '~')]));
      failures++;
    } else out(tr('✓ plugin: {0} (igual ao repositório)', [inboxPath.replace(home, '~')]));
    if (!which('zstd', ctx)) {
      out(tr('✗ zstd: não encontrado no PATH (sem ele a ponte não lê as sessões; instale com o gerenciador de pacotes da sua máquina)'));
      failures++;
    } else out('✓ zstd: encontrado');
    if (!which('lsof', ctx)) out(tr('! lsof: não encontrado; a ponte cai na atividade recente para saber se a sessão está aberta'));
    if (serviceSpecNow) {
      const rel = serviceSpecNow.path.replace(home, '~');
      if (!existsSync(serviceSpecNow.path)) {
        out(tr('✗ serviço ({0}): não instalado; rode npm run dsh:install', [rel]));
        failures++;
      } else if (!serviceRunning(serviceSpecNow.kind, ctx)) {
        out(tr('✗ serviço ({0}): instalado, mas parado; rode npm run dsh:install ou reinicie o serviço', [rel]));
        failures++;
      } else if (readFileSync(serviceSpecNow.path, 'utf8') !== serviceSpecNow.content) {
        out(tr('! serviço ({0}): rodando, mas diferente do esperado; rode npm run dsh:install para atualizar', [rel]));
      } else out(tr('✓ serviço ({0}): rodando', [rel]));
    } else out(tr('= serviço: não verificado (--no-service ou plataforma sem serviço)'));
    const health = await (ctx.health ?? fetchHealth)(opts.port);
    if (!health) out(tr('Habblaud em http://127.0.0.1:{0}: fora do ar', [opts.port]));
    else {
      const dsh = (health.sources ?? []).filter((s) => s.provider === 'dsh');
      const sessions = dsh.reduce((n, s) => n + (s.sessions ?? 0), 0);
      if (!health.dshEvents) {
        out(tr('✗ Habblaud: no ar, mas sem a fonte do DSH (o patch da integração não está aplicado)'));
        failures++;
      } else if (!dsh.length) out(tr('! Habblaud: no ar, mas o sources não lista .dsh'));
      else if (!sessions) out(tr('! Habblaud: fonte .dsh ok, mas nenhuma sessão aberta agora (abra uma sessão do DSH)'));
      else out(tr('✓ Habblaud: fonte .dsh com {0} sessão(ões) sendo acompanhada(s)', [sessions]));
    }
    out(tr('Log da ponte: {0}', [join(home, '.habblaud', 'dsh-bridge.log').replace(home, '~')]));
    out(tr('Log do plugin: {0}', [join(home, '.habblaud', 'dsh-inbox.log').replace(home, '~')]));
    return failures ? 1 : 0;
  }

  // ---- install --------------------------------------------------------------------------------
  if (!which('zstd', ctx)) {
    out(tr('✗ zstd: não encontrado no PATH. A ponte precisa dele para ler as sessões (macOS: brew install zstd; Debian/Ubuntu: sudo apt install zstd; Fedora: sudo dnf install zstd).'));
    return 1;
  }
  if (!which('lsof', ctx)) out(tr('! lsof: não encontrado; a ponte cai na atividade recente para saber se a sessão está aberta'));
  const source = pluginSource(ctx.repo);
  if (!existsSync(source)) {
    out(tr('✗ plugin: {0} não existe (o repositório está completo?)', [source]));
    return 1;
  }
  // Plugin: só grava se mudou (idempotente).
  const same = existsSync(inboxPath) && readFileSync(inboxPath).compare(readFileSync(source)) === 0;
  if (same) out(tr('= plugin: {0} já está atualizado', [inboxPath.replace(home, '~')]));
  else if (opts.dryRun) out(tr('~ plugin: {0} seria copiado (simulação: nada gravado)', [inboxPath.replace(home, '~')]));
  else {
    try {
      copyFileSync(source, inboxPath);
      chmodSync(inboxPath, 0o644);
      out(tr('✓ plugin: copiado para {0}', [inboxPath.replace(home, '~')]));
    } catch (err) {
      out(tr('✗ plugin: não consegui copiar ({0})', [(err as Error).message]));
      failures++;
    }
  }
  // Bloco do YAML: nunca duplica (ver planPatch).
  const raw = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const plan = planPatch(raw);
  if (plan.action === 'conflict') {
    out(tr('✗ {0}: {1}', [PATCH_FILE, plan.message]));
    failures++;
  } else if (plan.action === 'none') out(tr('= {0}: {1}', [PATCH_FILE, plan.message]));
  else if (opts.dryRun) out(tr('~ {0}: {1} (simulação: nada gravado)', [PATCH_FILE, plan.message]));
  else {
    try {
      const backup = writePatch(patchPath, plan.text, ctx.now);
      out(tr('✓ {0}: {1}{2}', [PATCH_FILE, plan.message, backup ? ` · backup em ${backup.replace(home, '~')}` : '']));
    } catch (err) {
      out(tr('✗ {0}: não consegui gravar ({1})', [PATCH_FILE, (err as Error).message]));
      failures++;
    }
  }
  // Serviço da ponte.
  if (serviceSpecNow) {
    const r = ensureService(serviceSpecNow, ctx, opts.dryRun);
    r.lines.forEach(out);
    if (r.failed) failures++;
  } else if (opts.noService) out(tr('= serviço: não instalado (--no-service); rode `npm run dsh:bridge -- --all` à mão'));
  if (!failures) {
    out('');
    out(tr('Pronto. O DSH recarrega o perfil sozinho; se o plugin não aparecer, reabra o DSH.'));
    out(tr('Abra uma sessão do DSH: o personagem entra no escritório em segundos, e a caixa Mandar mensagem passa a funcionar.'));
    out(tr('Confira com npm run dsh:status · para desfazer: npm run dsh:uninstall'));
  }
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = await run(parsed, {
    env: process.env,
    home,
    repo: ROOT,
    platform: process.platform,
    node: process.execPath,
    tsx: tsxCli(ROOT),
    now: new Date(),
    out: (l) => console.log(l),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[dsh] Erro: {0}', [err.message]) : tr('[dsh] Erro inesperado: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
