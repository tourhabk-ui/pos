/**
 * Соседние репозитории владельца повторяют сведения о сервере MCP — и
 * отстают молча (CLAUDE.md §22, слово владельца 13.11 «1 да»).
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * 13.11 описание сервера поменяли и опубликовали версию 2.10.2, не зная, что
 * те же сведения записаны ещё в четырёх репозиториях. Манифест в `vedar-mcp`
 * стоял на версии 1.0.0, README называли 22 и 21 инструмент из 25, выложенный
 * плагин `dsh-vedar` отличался от исходника в четырёх файлах из семи. Внутри
 * этого репозитория отстали исходник плагина («Tools (23)»), китайский абзац
 * README («20 个工具», «四种申请») и страница /mcp («те же четыре заявки»).
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 *  - правило сверки — вызовом на граничных текстах;
 *  - скрипт — исполнением: три исхода, три кода выхода;
 *  - прогон идёт при правке каждого источника сведений — по самому файлу
 *    workflow, а не по его описанию;
 *  - копии внутри этого репозитория называют нынешнее число инструментов и
 *    видов заявок: новый инструмент без правки этих текстов — красный.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import {
  SISTER_REPOS, checkSister, censusOutcome, censusTable, censusVerdict, manifestLag,
  requestCountClaims, requestCountLag, toolCountClaims, toolsLag, toolsMissingIn,
  type SisterRepo, type SourceFacts,
} from '@/lib/mcp/sister-repos';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const requireCjs = createRequire(import.meta.url);
const { load } = requireCjs('js-yaml') as { load: (src: string) => unknown };

const NAMES = PUBLIC_MCP_TOOLS.map((t) => t.name);
const LIVE: SourceFacts = {
  toolNames: NAMES,
  requestCount: WRITE_TOOL_NAMES.size,
  manifest: JSON.parse(read('server.json')) as { version: string; description: string },
};

const FACTS: SourceFacts = {
  toolNames: ['get_tours', 'get_tour_details', 'create_lead'],
  requestCount: 1,
  manifest: { version: '2.0.0', description: 'Kamchatka travel' },
};
const FULL = 'Tools (3): `get_tours`, `get_tour_details`, `create_lead`.';

describe('правило: назван ли инструмент', () => {
  it('имя считается названным только в обратных кавычках и целиком', () => {
    expect(toolsMissingIn(FULL, FACTS.toolNames)).toEqual([]);
    // `get_tours` не называет `get_tour_details`, и наоборот.
    expect(toolsMissingIn('`get_tours` and `create_lead`', FACTS.toolNames)).toEqual(['get_tour_details']);
    // Имя в тексте без кавычек — не перечень инструментов.
    expect(toolsMissingIn('get_tours, get_tour_details, create_lead', FACTS.toolNames)).toEqual(FACTS.toolNames);
  });
});

describe('правило: какое число инструментов называет текст', () => {
  it('узнаёт записи трёх языков', () => {
    expect(toolCountClaims('## Tools (23)')).toEqual([23]);
    expect(toolCountClaims('live `tools/list`, 21 tools')).toEqual([21]);
    expect(toolCountClaims('返回的 22 个工具：')).toEqual([22]);
    expect(toolCountClaims('## 工具（20 个）')).toEqual([20]);
    expect(toolCountClaims('25 инструментов: туры и их занятость')).toEqual([25]);
  });

  it('число через слово — не утверждение о составе сервера', () => {
    expect(toolCountClaims('answered by calling 17 Vedar tools, all completed')).toEqual([]);
    expect(toolCountClaims('up to 10 results')).toEqual([]);
  });
});

describe('правило: какое число видов заявок называет текст', () => {
  it('узнаёт числа словами на трёх языках', () => {
    expect(requestCountClaims('Write, five requests confirmed by a human')).toEqual([5]);
    expect(requestCountClaims('There are **six request types**.')).toEqual([6]);
    expect(requestCountClaims('Four write tools are requests confirmed by a human')).toEqual([4]);
    expect(requestCountClaims('запись — те же четыре заявки, подтверждает человек')).toEqual([4]);
    expect(requestCountClaims('Заявок шесть: поездка целиком')).toEqual([6]);
    expect(requestCountClaims('写操作只有四种申请')).toEqual([4]);
    expect(requestCountClaims('新建记录只有六种申请')).toEqual([6]);
  });

  it('цифра перед «requests» — предел частоты, а не состав', () => {
    expect(requestCountClaims('limited to 5 requests per hour')).toEqual([]);
    expect(requestCountClaims('Two-step car rental request')).toEqual([]);
  });

  it('расхождение названо числом сервера', () => {
    expect(requestCountLag('те же шесть заявок', 6)).toEqual([]);
    expect(requestCountLag('те же четыре заявки', 6)).toEqual(['названо число видов заявок 4, у сервера их 6']);
  });
});

describe('правило: сверка текста с составом сервера', () => {
  it('полный текст — расхождений нет', () => {
    expect(toolsLag(FULL, FACTS)).toEqual([]);
  });

  it('названо всё, чего нет: имена, число инструментов, число заявок', () => {
    const lag = toolsLag('Tools (2): `get_tours`, `create_lead`. Four requests.', FACTS);
    expect(lag).toEqual([
      'не названы инструменты: get_tour_details',
      'названо число инструментов 2, у сервера их 3',
      'названо число видов заявок 4, у сервера их 1',
    ]);
  });
});

describe('правило: манифест', () => {
  const same = JSON.stringify({ name: 'x', version: '2.0.0', description: 'Kamchatka travel' });

  it('версия и описание совпали — расхождений нет, прочие поля не судятся', () => {
    expect(manifestLag(same, FACTS.manifest)).toEqual([]);
  });

  it('другая версия и другое описание названы по отдельности', () => {
    expect(manifestLag(JSON.stringify({ version: '1.0.0', description: 'Kamchatka travel' }), FACTS.manifest))
      .toEqual(['версия 1.0.0, здесь 2.0.0']);
    expect(manifestLag(JSON.stringify({ version: '2.0.0', description: 'old' }), FACTS.manifest))
      .toEqual(['описание не то, что в server.json здесь']);
    expect(manifestLag(JSON.stringify({ description: 'Kamchatka travel' }), FACTS.manifest))
      .toEqual(['версия не записана, здесь 2.0.0']);
  });

  it('не JSON — «не смог», а не «совпало» и не «отстал»', () => {
    expect(manifestLag('{ version: ', FACTS.manifest)).toBeNull();
    expect(manifestLag('"строка"', FACTS.manifest)).toBeNull();
  });
});

describe('сверка одного репозитория: три исхода', () => {
  const sister: SisterRepo = {
    repo: 'o/sister',
    what: 'проба',
    checks: [
      { kind: 'tools', files: ['README.md'] },
      { kind: 'manifest', file: 'server.json' },
      { kind: 'mirror', dir: 'src/plugin', files: ['a.txt', 'b.txt'] },
    ],
  };
  const manifest = JSON.stringify({ version: '2.0.0', description: 'Kamchatka travel' });
  const own: Record<string, string> = { 'src/plugin/a.txt': 'one\ntwo\n', 'src/plugin/b.txt': 'bee\n' };
  const theirs: Record<string, string> = { 'README.md': FULL, 'server.json': manifest, 'a.txt': 'one\ntwo\n', 'b.txt': 'bee\n' };
  const from = (m: Record<string, string>) => (p: string) => (p in m ? m[p] : null);
  const run = (t: Record<string, string>, o: Record<string, string> = own, available = true) =>
    checkSister(sister, FACTS, available, from(t), from(o));

  it('всё совпало — четыре находки «совпадает»', () => {
    const f = run(theirs);
    expect(f.map((x) => x.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(censusOutcome(f)).toBe('ok');
    expect(censusVerdict(f)).toBe('соседние репозитории совпадают с этим');
  });

  it('репозиторий не склонирован — одна находка «не смог», а не четыре «отстал»', () => {
    const f = run(theirs, own, false);
    expect(f).toEqual([{ repo: 'o/sister', file: '—', status: 'unreadable', details: ['репозиторий не прочитан'] }]);
    expect(censusOutcome(f)).toBe('unreadable');
    expect(censusVerdict(f)).toBe('не прочитаны: o/sister');
  });

  it('файла со списком инструментов нет — «не смог», а не «совпадает»', () => {
    const { 'README.md': _gone, ...rest } = theirs;
    const f = run(rest);
    expect(f[0]).toMatchObject({ file: 'README.md', status: 'unreadable' });
  });

  it('манифест не разобрался — «не смог»', () => {
    const f = run({ ...theirs, 'server.json': 'не json' });
    expect(f[1]).toMatchObject({ file: 'server.json', status: 'unreadable', details: ['манифест не разобрался как JSON'] });
  });

  it('выложенная копия отличается — «отстал» с именем исходника', () => {
    const f = run({ ...theirs, 'a.txt': 'one\nTWO\n' });
    expect(f[2]).toEqual({ repo: 'o/sister', file: 'a.txt', status: 'behind', details: ['отличается от src/plugin/a.txt'] });
    expect(censusOutcome(f)).toBe('behind');
  });

  it('конец строки и хвостовые пробелы — не расхождение', () => {
    const f = run({ ...theirs, 'a.txt': 'one  \r\ntwo\r\n\r\n' });
    expect(f[2].status).toBe('ok');
  });

  it('файла нет в выложенном репозитории — «отстал»; исходника нет здесь — «не смог»', () => {
    const { 'b.txt': _gone, ...rest } = theirs;
    expect(run(rest)[3]).toMatchObject({ file: 'b.txt', status: 'behind', details: ['файла нет в выложенном репозитории'] });
    expect(run(theirs, { 'src/plugin/a.txt': 'one\ntwo\n' })[3]).toMatchObject({ file: 'b.txt', status: 'unreadable' });
  });

  it('отставание главнее непрочитанного, и оба названы', () => {
    const f = [
      ...run({ ...theirs, 'README.md': '`get_tours`' }),
      ...checkSister({ ...sister, repo: 'o/other' }, FACTS, false, from({}), from(own)),
    ];
    expect(censusOutcome(f)).toBe('behind');
    expect(censusVerdict(f)).toBe('отстали: o/sister; не прочитаны: o/other');
    expect(censusTable(f)).toContain('| o/sister | README.md | отстал | не названы инструменты: get_tour_details, create_lead |');
    expect(censusTable(f)).toContain('| o/other | — | не смог прочитать | репозиторий не прочитан |');
  });
});

describe('реестр соседних репозиториев', () => {
  it('четыре своих репозитория, без повторов', () => {
    const repos = SISTER_REPOS.map((s) => s.repo);
    expect(repos).toEqual([
      'tourhabk-ui/vedar-mcp',
      'tourhabk-ui/vedar-mcp-examples',
      'tourhabk-ui/vedar-kamchatka-mcp',
      'tourhabk-ui/dsh-vedar',
    ]);
    expect(new Set(repos).size).toBe(repos.length);
    for (const s of SISTER_REPOS) expect(s.checks.length, s.repo).toBeGreaterThan(0);
  });

  it('у каждой выложенной копии исходник здесь есть — иначе сверять не с чем', () => {
    for (const s of SISTER_REPOS) {
      for (const c of s.checks) {
        if (c.kind !== 'mirror') continue;
        for (const f of c.files) expect(existsSync(join(ROOT, c.dir, f)), `${c.dir}/${f}`).toBe(true);
      }
    }
  });
});

describe('копии внутри этого репозитория называют нынешний состав сервера', () => {
  it('исходник плагина dsh-vedar: назван каждый инструмент, число то же, видов заявок столько же', () => {
    for (const file of ['integrations/dsh-vedar/README.md', 'integrations/dsh-vedar/README.zh.md']) {
      expect(toolsLag(read(file), LIVE), file).toEqual([]);
      expect(toolCountClaims(read(file)), `${file}: число инструментов не названо`).toContain(NAMES.length);
    }
  });

  it('строка плагина: число пишущих инструментов то же, и каждый назван', () => {
    const patch = read('integrations/dsh-vedar/cordis.patch.yml');
    expect(requestCountLag(patch, LIVE.requestCount)).toEqual([]);
    expect(requestCountClaims(patch).length, 'число пишущих инструментов не названо').toBeGreaterThan(0);
    for (const name of WRITE_TOOL_NAMES) expect(patch, name).toContain(name);
  });

  it('README: оба абзаца о сервере называют нынешнее число инструментов и видов заявок', () => {
    const readme = read('README.md');
    expect(readme).toContain(`${NAMES.length} инструмент`);
    expect(readme).toContain(`${NAMES.length} 个工具`);
    expect(requestCountLag(readme, LIVE.requestCount)).toEqual([]);
    const zh = readme.split('\n').find((l) => l.includes('个工具')) ?? '';
    for (const name of WRITE_TOOL_NAMES) expect(zh, name).toContain('`' + name + '`');
  });

  it('страница /mcp не называет другого числа видов заявок', () => {
    expect(requestCountLag(read('app/mcp/page.tsx'), LIVE.requestCount)).toEqual([]);
  });
});

describe('прогон sister-repos-census.yml', () => {
  const wf = load(read('.github/workflows/sister-repos-census.yml')) as {
    on: { push?: { branches?: string[]; paths?: string[] }; schedule?: unknown; workflow_dispatch?: unknown };
    jobs: Record<string, { steps: Array<{ run?: string; name?: string }> }>;
  };
  const paths = wf.on.push?.paths ?? [];

  it('идёт при правке каждого источника сведений в main', () => {
    expect(wf.on.push?.branches).toEqual(['main']);
    for (const p of [
      'server.json',
      'lib/mcp/public-tools.ts',
      'lib/mcp/sister-repos.ts',
      'scripts/sister-repos-census.ts',
      '.github/triggers/mcp-registry-publish.json',
      '.github/triggers/sister-repos-census.json',
    ]) expect(paths, p).toContain(p);
  });

  it('каталог каждой выложенной копии из реестра запускает прогон', () => {
    for (const s of SISTER_REPOS) {
      for (const c of s.checks) if (c.kind === 'mirror') expect(paths, c.dir).toContain(`${c.dir}/**`);
    }
  });

  it('расписания нет, руками запустить можно', () => {
    expect(wf.on.schedule).toBeUndefined();
    expect('workflow_dispatch' in wf.on).toBe(true);
  });

  it('список репозиториев берёт у скрипта, сверяет скриптом, и его код выхода — код шага', () => {
    const runs = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? '')).join('\n');
    expect(runs).toMatch(/scripts\/sister-repos-census\.ts --list/);
    expect(runs).toMatch(/scripts\/sister-repos-census\.ts --dir /);
    expect(runs).toMatch(/exit "\$code"/);
    expect(runs).toMatch(/PIPESTATUS\[0\]/);
  });

  it('маркер читается и объясняет, что запускает', () => {
    const marker = JSON.parse(read('.github/triggers/sister-repos-census.json')) as { run: number; note: string };
    expect(Number.isInteger(marker.run)).toBe(true);
    for (const s of SISTER_REPOS) expect(marker.note, s.repo).toContain(s.repo.split('/')[1]);
  });
});

describe('скрипт сверки — исполнением', () => {
  const script = join(ROOT, 'scripts/sister-repos-census.ts');
  const tsx = join(ROOT, 'node_modules/.bin/tsx');

  /** Папка с копиями, которые совпадают с этим репозиторием. */
  function goodDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sisters-'));
    const list = `${NAMES.length} tools: ${NAMES.map((n) => '`' + n + '`').join(', ')}`;
    for (const s of SISTER_REPOS) {
      const base = join(dir, s.repo.split('/')[1]);
      mkdirSync(join(base, '.git'), { recursive: true });
      for (const c of s.checks) {
        if (c.kind === 'tools') for (const f of c.files) writeFileSync(join(base, f), list);
        else if (c.kind === 'manifest') writeFileSync(join(base, c.file), JSON.stringify({ ...LIVE.manifest, repository: 'свой' }));
        else for (const f of c.files) cpSync(join(ROOT, c.dir, f), join(base, f));
      }
    }
    return dir;
  }

  function census(dir: string): { code: number; out: string } {
    try {
      return { code: 0, out: execFileSync(tsx, [script, '--dir', dir], { cwd: ROOT, encoding: 'utf-8' }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { code: err.status ?? -1, out: err.stdout ?? '' };
    }
  }

  it('--list печатает репозитории реестра', () => {
    const out = execFileSync(tsx, [script, '--list'], { cwd: ROOT, encoding: 'utf-8' });
    expect(out.trim().split('\n')).toEqual(SISTER_REPOS.map((s) => s.repo));
  });

  it('совпадают — код 0; отстал — код 1 и файл назван; не склонирован — код 2', () => {
    const dir = goodDir();
    try {
      const ok = census(dir);
      expect(ok.code, ok.out).toBe(0);
      expect(ok.out).toContain('соседние репозитории совпадают с этим');
      expect(ok.out).toContain(`${NAMES.length} инструментов`);

      // Копия манифеста отстала на версию.
      writeFileSync(join(dir, 'vedar-mcp', 'server.json'), JSON.stringify({ ...LIVE.manifest, version: '1.0.0' }));
      const behind = census(dir);
      expect(behind.code, behind.out).toBe(1);
      expect(behind.out).toContain('отстали: tourhabk-ui/vedar-mcp');
      expect(behind.out).toContain(`| tourhabk-ui/vedar-mcp | server.json | отстал | версия 1.0.0, здесь ${LIVE.manifest.version} |`);
      writeFileSync(join(dir, 'vedar-mcp', 'server.json'), JSON.stringify(LIVE.manifest));

      // Репозиторий не склонировался: папки нет.
      rmSync(join(dir, 'dsh-vedar'), { recursive: true, force: true });
      const unread = census(dir);
      expect(unread.code, unread.out).toBe(2);
      expect(unread.out).toContain('не прочитаны: tourhabk-ui/dsh-vedar');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('без папки — код 2, а не «совпадают»', () => {
    let code = 0;
    try {
      execFileSync(tsx, [script], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).toBe(2);
  }, 30_000);
});

describe('правило названо агенту там, где он его прочтёт', () => {
  it('CLAUDE.md называет каждый соседний репозиторий, реестр и прогон', () => {
    const doc = read('CLAUDE.md');
    const section = doc.slice(doc.indexOf('## 22. СОСЕДНИЕ РЕПОЗИТОРИИ'));
    expect(section.length, 'раздела нет').toBeGreaterThan(200);
    for (const s of SISTER_REPOS) expect(section, s.repo).toContain('`' + s.repo + '`');
    expect(section).toContain('lib/mcp/sister-repos.ts');
    expect(section).toContain('sister-repos-census.yml');
    expect(section).toContain('.github/triggers/sister-repos-census.json');
  });
});
