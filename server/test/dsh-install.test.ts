// Instalador da integração com o DeepSeek Harness (scripts/dsh-install.ts): planos puros do cordis.patch.yml, o
// serviço de cada plataforma e o comando de verdade sobre um HOME FALSO (nunca toca em ~/.dsh nem no launchd).
// O ponto principal: o bloco do Habblaud nunca aparece duas vezes no cordis.patch.yml.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseProfile,
  PLUGIN_SOURCE,
  discoverProfiles,
  INBOX_BLOCK,
  INBOX_ID,
  launchdPlist,
  parseArgs,
  patchState,
  PATCH_FILE,
  planPatch,
  planRemovePatch,
  profilesRoot,
  resolveProfile,
  run,
  serviceSpec,
  systemdUnit,
  tsxCli,
  type ExecResult,
  type Health,
  type RunContext,
  type RunOptions,
  type ServiceInput,
} from '../../scripts/dsh-install';
import { tempDir } from './fixtures';

const SERVICE_INPUT: ServiceInput = {
  home: '/Users/ana',
  repo: '/Users/ana/habblaud',
  node: '/usr/local/bin/node',
  tsx: '/Users/ana/habblaud/node_modules/tsx/dist/cli.mjs',
  port: 4747,
};

describe('planPatch: o bloco do Habblaud no cordis.patch.yml', () => {
  it('acrescenta o bloco num arquivo vazio e não duplica na segunda vez', () => {
    const first = planPatch('');
    expect(first.action).toBe('install');
    expect(patchState(first.text)).toEqual({ ids: 1, blocks: 1 });
    expect(first.text).toBe(INBOX_BLOCK);
    const second = planPatch(first.text);
    expect(second.action).toBe('none');
    expect(second.text).toBe(first.text);
  });

  it('preserva o conteúdo que já estava no arquivo (comentários, outros plugins)', () => {
    const original = '- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n';
    const plan = planPatch(original);
    expect(plan.action).toBe('install');
    expect(plan.text.startsWith(original.trimEnd())).toBe(true);
    expect(plan.text).toContain('ui-theme');
    expect(patchState(plan.text)).toEqual({ ids: 1, blocks: 1 });
  });

  it('não acrescenta nada quando o bloco já está lá, mesmo com o arquivo terminando sem quebra de linha', () => {
    const withoutNewline = INBOX_BLOCK.trimEnd();
    expect(planPatch(withoutNewline).action).toBe('none');
  });

  it('tira as cópias repetidas idênticas (bloco colado duas vezes)', () => {
    const doubled = `${INBOX_BLOCK}\n${INBOX_BLOCK}`;
    expect(patchState(doubled)).toEqual({ ids: 2, blocks: 2 });
    const plan = planPatch(doubled);
    expect(plan.action).toBe('dedupe');
    expect(patchState(plan.text)).toEqual({ ids: 1, blocks: 1 });
  });

  it('não mexe quando o id existe com outra forma (editado à mão): avisa em vez de arriscar', () => {
    const handEdited = '- insert:\n    - id: habblaud-dsh-inbox\n      name: "./outro.mjs"\n';
    const plan = planPatch(handEdited);
    expect(plan.action).toBe('none');
    expect(plan.text).toBe(handEdited);
    expect(plan.message).toContain(INBOX_ID);
  });

  it('para com conflito quando o id aparece no bloco do projeto e também fora dele', () => {
    const mixed = `${INBOX_BLOCK}\n- insert:\n    - id: habblaud-dsh-inbox\n`;
    const plan = planPatch(mixed);
    expect(plan.action).toBe('conflict');
    expect(plan.text).toBe(mixed);
  });

  it('o uninstall tira só o bloco do Habblaud e deixa o resto do arquivo', () => {
    const before = '- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n';
    const installed = planPatch(before).text;
    const plan = planRemovePatch(installed);
    expect(plan.action).toBe('remove');
    expect(patchState(plan.text)).toEqual({ ids: 0, blocks: 0 });
    expect(plan.text).toContain('ui-theme');
    expect(plan.text.endsWith('\n')).toBe(true);
  });

  it('o uninstall não faz nada quando o bloco não está lá', () => {
    expect(planRemovePatch('- id: ui-theme\n').action).toBe('absent');
    expect(planRemovePatch('').action).toBe('absent');
  });
});

describe('serviço: LaunchAgent no macOS e systemd no Linux/WSL', () => {
  it('o LaunchAgent roda a ponte com --all, a porta e o log, e sobe no login', () => {
    const plist = launchdPlist(SERVICE_INPUT);
    expect(plist).toContain('<string>com.habblaud.dsh-bridge</string>');
    expect(plist).toContain('/usr/local/bin/node');
    expect(plist).toContain('node_modules/tsx/dist/cli.mjs');
    expect(plist).toContain('dsh-bridge.ts');
    expect(plist).toContain('<string>--all</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('HABBLAUD_PORT');
    expect(plist).toContain('/Users/ana/.habblaud/dsh-bridge.log');
    // O PATH do launchd não lê o .zshrc: os diretórios do Homebrew vão fixos (é onde o zstd costuma estar).
    expect(plist).toContain('/opt/homebrew/bin');
  });

  it('a unidade systemd usa o mesmo log e reinicia sozinha', () => {
    const unit = systemdUnit(SERVICE_INPUT);
    expect(unit).toContain('ExecStart=/usr/local/bin/node /Users/ana/habblaud/node_modules/tsx/dist/cli.mjs /Users/ana/habblaud/scripts/dsh-bridge.ts --all');
    expect(unit).toContain('Environment=HABBLAUD_PORT=4747');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('StandardOutput=append:/Users/ana/.habblaud/dsh-bridge.log');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('cada plataforma recebe o serviço no lugar certo', () => {
    expect(serviceSpec('darwin', SERVICE_INPUT)?.path).toBe('/Users/ana/Library/LaunchAgents/com.habblaud.dsh-bridge.plist');
    expect(serviceSpec('linux', SERVICE_INPUT)?.path).toBe('/Users/ana/.config/systemd/user/habblaud-dsh-bridge.service');
    expect(serviceSpec('win32', SERVICE_INPUT)).toBeUndefined();
  });

  it('tsxCli prefere o CLI do pacote e cai no shim quando ele não existe', () => {
    const tmp = tempDir();
    try {
      expect(tsxCli(join(tmp.dir, 'nao-existe'))).toBe(join(tmp.dir, 'nao-existe', 'node_modules', '.bin', 'tsx'));
      mkdirSync(join(tmp.dir, 'node_modules', 'tsx', 'dist'), { recursive: true });
      writeFileSync(join(tmp.dir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
      expect(tsxCli(tmp.dir)).toBe(join(tmp.dir, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
    } finally {
      tmp.cleanup();
    }
  });
});

describe('perfis do DSH', () => {
  it('descobre os perfis e prefere o desktop', () => {
    expect(chooseProfile(['beta', 'desktop'])).toBe('desktop');
    expect(chooseProfile(['alpha', 'beta'])).toBe('alpha');
    expect(chooseProfile(['desktop'], 'beta')).toBeUndefined();
  });

  it('usa o perfil da sessão do DSH quando o comando roda dentro dele', () => {
    const tmp = tempDir();
    try {
      const dir = join(tmp.dir, '.dsh', 'profiles', 'trabalho');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, PATCH_FILE), '[]\n');
      const env = { DSH_HOME: join(tmp.dir, '.dsh'), DSH_PROFILE: 'trabalho', DSH_PROFILE_DIR: dir };
      expect(profilesRoot(env, tmp.dir)).toBe(join(tmp.dir, '.dsh', 'profiles'));
      expect(discoverProfiles(env, tmp.dir)).toEqual(['trabalho']);
      const { profile } = resolveProfile(env, tmp.dir);
      expect(profile?.dir).toBe(dir);
      expect(profile?.patch).toBe(join(dir, PATCH_FILE));
      expect(profile?.inbox).toBe(join(dir, 'habblaud-inbox.mjs'));
    } finally {
      tmp.cleanup();
    }
  });

  it('sem perfis, o comando termina com 1 e explica que o DSH precisa ser aberto uma vez', async () => {
    const tmp = tempDir();
    try {
      const lines: string[] = [];
      const code = await run({ command: 'install', dryRun: false, noService: true, port: 4747 }, context(tmp.dir, lines));
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('Nenhum perfil do DSH');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('parseArgs', () => {
  it('lê o comando e as opções', () => {
    expect(parseArgs(['install'], {})).toMatchObject({ command: 'install', dryRun: false, noService: false, port: 4747 });
    expect(parseArgs(['status', '--dry-run', '--no-service', '--profile', 'beta', '--port', '5000'], {})).toMatchObject({
      command: 'status',
      dryRun: true,
      noService: true,
      profile: 'beta',
      port: 5000,
    });
    expect(() => parseArgs([], { HABBLAUD_PORT: '6000' } as NodeJS.ProcessEnv)).toThrow();
    expect(parseArgs(['--help'], {})).toBe('help');
    expect(() => parseArgs([], {})).toThrow();
    expect(() => parseArgs(['install', '--port', 'abc'], {})).toThrow();
    expect(() => parseArgs(['install', '--profile'], {})).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// O comando sobre um HOME falso
// ---------------------------------------------------------------------------------------------

interface Fake {
  env: NodeJS.ProcessEnv;
  home: string;
  repo: string;
  lines: string[];
  commands: string[];
}

function context(home: string, lines: string[], opts: { health?: Health; zstd?: boolean } = {}): RunContext & { commands: string[]; lines: string[] } {
  const commands: string[] = [];
  const exec = (cmd: string, args: readonly string[]): ExecResult => {
    commands.push([cmd, ...args].join(' '));
    if (cmd === 'sh') return { ok: opts.zstd !== false, out: '' };
    return { ok: true, out: cmd === 'systemctl' ? 'active\n' : '' };
  };
  return {
    env: { HOME: home, DSH_HOME: join(home, '.dsh') },
    home,
    repo: resolve(import.meta.dirname, '..', '..'),
    platform: 'darwin',
    node: '/usr/local/bin/node',
    tsx: '/repo/habblaud/node_modules/tsx/dist/cli.mjs',
    now: new Date('2026-03-04T05:06:07'),
    out: (l) => lines.push(l),
    exec,
    health: async () => opts.health,
    commands,
    lines,
  };
}

function profileDir(home: string, name = 'desktop'): string {
  const dir = join(home, '.dsh', 'profiles', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function options(over: Partial<RunOptions> = {}): RunOptions {
  return { command: 'install', dryRun: false, noService: true, port: 4747, ...over };
}

describe('run: install, status e uninstall num HOME falso', () => {
  let tmp: ReturnType<typeof tempDir>;

  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => {
    tmp.cleanup();
  });

  it('instala o plugin e o bloco, e a segunda execução não muda nada', async () => {
    const dir = profileDir(tmp.dir);
    const patch = join(dir, PATCH_FILE);
    writeFileSync(patch, '- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n');

    const first = context(tmp.dir, []);
    expect(await run(options(), first)).toBe(0);
    expect(existsSync(join(dir, 'habblaud-inbox.mjs'))).toBe(true);
    expect(patchState(readFileSync(patch, 'utf8'))).toEqual({ ids: 1, blocks: 1 });
    expect(first.lines.join('\n')).toContain('bloco do Habblaud acrescentado');

    const before = readFileSync(patch, 'utf8');
    const second = context(tmp.dir, []);
    expect(await run(options(), second)).toBe(0);
    expect(readFileSync(patch, 'utf8')).toBe(before);
    expect(second.lines.join('\n')).toContain('já instalado');
    // Nenhum backup novo na segunda vez: nada foi gravado.
    const backups = readFileSync(patch, 'utf8');
    expect(backups).toBe(before);
  });

  it('faz backup antes de mexer no cordis.patch.yml', async () => {
    const dir = profileDir(tmp.dir);
    const patch = join(dir, PATCH_FILE);
    const original = '- id: ui-theme\n';
    writeFileSync(patch, original);
    await run(options(), context(tmp.dir, []));
    const backup = join(dir, `${PATCH_FILE}.habblaud-backup-20260304-050607`);
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, 'utf8')).toBe(original);
  });

  it('--dry-run não grava nada', async () => {
    const dir = profileDir(tmp.dir);
    const patch = join(dir, PATCH_FILE);
    writeFileSync(patch, '');
    const ctx = context(tmp.dir, []);
    expect(await run(options({ dryRun: true }), ctx)).toBe(0);
    expect(readFileSync(patch, 'utf8')).toBe('');
    expect(existsSync(join(dir, 'habblaud-inbox.mjs'))).toBe(false);
    expect(ctx.lines.join('\n')).toContain('simulação');
  });

  it('recusa (código 1) quando o bloco está duplicado de formas diferentes, sem gravar', async () => {
    const dir = profileDir(tmp.dir);
    const patch = join(dir, PATCH_FILE);
    const mixed = `${INBOX_BLOCK}\n- insert:\n    - id: habblaud-dsh-inbox\n`;
    writeFileSync(patch, mixed);
    const ctx = context(tmp.dir, []);
    expect(await run(options(), ctx)).toBe(1);
    expect(readFileSync(patch, 'utf8')).toBe(mixed);
    expect(ctx.lines.join('\n')).toContain('nada foi alterado');
  });

  it('status: tudo no lugar devolve 0 e aponta as sessões sendo acompanhadas', async () => {
    const dir = profileDir(tmp.dir);
    writeFileSync(join(dir, PATCH_FILE), INBOX_BLOCK);
    copyFileSync(PLUGIN_SOURCE, join(dir, 'habblaud-inbox.mjs'));
    const ctx = context(tmp.dir, [], { health: { dshEvents: true, sources: [{ provider: 'dsh', sessions: 2 }] } });
    // O plugin do repositório não existe no repo falso: o status só compara quando ele existe.
    expect(await run(options({ command: 'status' }), ctx)).toBe(0);
    const out = ctx.lines.join('\n');
    expect(out).toContain('bloco do Habblaud instalado');
    expect(out).toContain('2 sessão(ões)');
  });

  it('status: sem o bloco e sem o plugin devolve 1', async () => {
    profileDir(tmp.dir);
    const ctx = context(tmp.dir, [], { health: { dshEvents: true, sources: [] } });
    expect(await run(options({ command: 'status' }), ctx)).toBe(1);
    const out = ctx.lines.join('\n');
    expect(out).toContain('bloco do Habblaud ausente');
    expect(out).toContain('não existe');
  });

  it('status: Habblaud fora do ar não derruba o status', async () => {
    const dir = profileDir(tmp.dir);
    writeFileSync(join(dir, PATCH_FILE), INBOX_BLOCK);
    copyFileSync(PLUGIN_SOURCE, join(dir, 'habblaud-inbox.mjs'));
    const ctx = context(tmp.dir, [], {});
    expect(await run(options({ command: 'status' }), ctx)).toBe(0);
    expect(ctx.lines.join('\n')).toContain('fora do ar');
  });

  it('o uninstall tira o bloco, o plugin e o serviço', async () => {
    const dir = profileDir(tmp.dir);
    const patch = join(dir, PATCH_FILE);
    writeFileSync(patch, '[]\n');
    const ctx = context(tmp.dir, []);
    expect(await run(options({ noService: false }), ctx)).toBe(0);
    const plist = join(tmp.dir, 'Library', 'LaunchAgents', 'com.habblaud.dsh-bridge.plist');
    expect(existsSync(plist)).toBe(true);

    const un = context(tmp.dir, []);
    expect(await run(options({ command: 'uninstall', noService: false }), un)).toBe(0);
    expect(patchState(readFileSync(patch, 'utf8'))).toEqual({ ids: 0, blocks: 0 });
    expect(existsSync(join(dir, 'habblaud-inbox.mjs'))).toBe(false);
    expect(existsSync(plist)).toBe(false);
  });

  it('instala o serviço quando ele não existe e o reaproveita quando está igual', async () => {
    profileDir(tmp.dir);
    const first = context(tmp.dir, []);
    expect(await run(options({ noService: false }), first)).toBe(0);
    expect(first.commands.some((c) => c.includes('bootstrap'))).toBe(true);
    const second = context(tmp.dir, []);
    expect(await run(options({ noService: false }), second)).toBe(0);
    expect(second.lines.join('\n')).toContain('já instalado e rodando');
  });
});
