/**
 * Сторож проверки зон §7 (находка аудита 15.10 AR-zones).
 *
 * Держит связку целиком, а не объявление: логику — вызовом на граничных
 * данных (PR без зоны, зона без слова, слово с цитатой и датой, две зоны и
 * слово на одну, одни комментарии), проход поверх API — тем же кодом с
 * подставным fetch, реестр — сверкой с CLAUDE.md §7 и с таблицей манифеста
 * контроля выхода, workflow — по смыслу: триггер из main, тело PR только
 * через env, скрипт тот же.
 *
 * Прямой пуш в main (аудит 15.10 ZONES, S-2) — исполнением режима --push на
 * подложенных коммитах: прямой коммит в зону без слова, со словом, влитый PR
 * с прошедшей и с красной проверкой, подложный номер PR, коммит вне зон,
 * дубль issue, «не смог»; CLI — запуском процесса. Новые пути реестра
 * (S-3) — тем же проходом: правка выключателя оплаты без слова красная.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  PROTECTED_ZONES,
  PR_CHECK_WORKFLOW,
  PUSH_ISSUE_LABEL,
  PUSH_ISSUE_TITLE,
  judgeZones,
  judgePushCommit,
  formatVerdict,
  prNumbersFromMessage,
  runPushCheck,
  runZonesCheck,
  sameCodeIgnoringComments,
  zonesOfFile,
  matchesZonePath,
} from '../../scripts/protected-zones.mjs';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const requireCjs = createRequire(import.meta.url);
const ts = requireCjs('typescript');
const { load } = requireCjs('js-yaml') as { load: (src: string) => unknown };

type File = { path: string; previousPath?: string | null; commentOnly: boolean | null; note?: string };
const code = (path: string): File => ({ path, commentOnly: false });
const commentsOnly = (path: string): File => ({ path, commentOnly: true });

const bodyWith = (...lines: string[]) =>
  ['## Что изменено', '', 'Правка.', '', '## Слово владельца', '', ...lines, '', '## Риски', '', 'Нет.'].join('\n');

describe('решение по PR: граничные случаи', () => {
  it('PR без зоны — зелёный', () => {
    const v = judgeZones({ files: [code('lib/places/aliases.ts'), code('lib/auth/middleware.ts')], body: '' });
    expect(v.outcome).toBe('clean');
    expect(formatVerdict(v).exitCode).toBe(0);
  });

  it('зона без раздела «Слово владельца» — красный, ::error:: называет зону', () => {
    const v = judgeZones({ files: [code('app/api/payments/webhook/route.ts')], body: '## Что изменено\n\nПравка вебхука.' });
    expect(v.outcome).toBe('fail');
    expect(v.sectionFound).toBe(false);
    const f = formatVerdict(v);
    expect(f.exitCode).toBe(1);
    expect(f.out.join('\n')).toContain(
      '::error::PR трогает зону §7 payments (Приём оплаты) без слова владельца — добавьте цитату с датой в раздел «Слово владельца»',
    );
  });

  it('зона с цитатой и датой — зелёный', () => {
    const v = judgeZones({
      files: [code('middleware.ts')],
      body: bodyWith('- `middleware.ts` — «S3 + разрешить видео с S3» (09.10)'),
    });
    expect(v.outcome).toBe('ok');
    expect(formatVerdict(v).exitCode).toBe(0);
  });

  it('две зоны, цитата только на одну — красный по второй', () => {
    const v = judgeZones({
      files: [code('middleware.ts'), code('lib/auth/public-api-routes.ts')],
      body: bodyWith('- middleware — «PR 2 да» (01.09)'),
    });
    expect(v.outcome).toBe('fail');
    const byZone = Object.fromEntries(v.zones.map((r) => [r.zone.id, r.status]));
    expect(byZone).toEqual({ middleware: 'word', 'public-api-routes': 'missing' });
    const out = formatVerdict(v).out.join('\n');
    expect(out).toContain('::error::PR трогает зону §7 public-api-routes');
    expect(out).not.toContain('::error::PR трогает зону §7 middleware');
  });

  it('в зоне меняются одни комментарии — предупреждение, не красный', () => {
    const v = judgeZones({ files: [commentsOnly('lib/auth.ts')], body: '' });
    expect(v.outcome).toBe('warn');
    const f = formatVerdict(v);
    expect(f.exitCode).toBe(0);
    expect(f.out.join('\n')).toMatch(/^::warning::PR меняет в зоне §7 lib-auth \(JWT-логика\) только комментарии/m);
  });

  it('«не смог определить» судится как код и называет причину', () => {
    const v = judgeZones({
      files: [{ path: 'app/api/safety/sos/route.ts', commentOnly: null, note: 'парсер TypeScript не загрузился' }],
      body: '',
    });
    expect(v.outcome).toBe('fail');
    const out = formatVerdict(v).out.join('\n');
    expect(out).toContain('::error::PR трогает зону §7 sos');
    expect(out).toContain('парсер TypeScript не загрузился');
  });

  it('один комментарий и один код в той же зоне — код решает', () => {
    const v = judgeZones({
      files: [commentsOnly('app/api/payments/check/route.ts'), code('app/api/payments/create/route.ts')],
      body: '',
    });
    expect(v.outcome).toBe('fail');
  });
});

describe('слово владельца: что засчитывается', () => {
  const pay = [code('app/api/payments/tochka/webhook/route.ts')];

  it('цитата без даты и дата без цитаты — не слово', () => {
    expect(judgeZones({ files: pay, body: bodyWith('- payments — «пока уберём оплату»') }).outcome).toBe('fail');
    expect(judgeZones({ files: pay, body: bodyWith('- payments — согласовано 05.10') }).outcome).toBe('fail');
    expect(judgeZones({ files: pay, body: bodyWith('- payments — «» 05.10') }).outcome).toBe('fail');
  });

  it('пример формата в HTML-комментарии и в блоке кода не засчитывается', () => {
    const hidden = '<!--\n## Слово владельца\n- payments — «пример» (01.01)\n-->';
    expect(judgeZones({ files: pay, body: hidden }).outcome).toBe('fail');
    const fenced = '```\n## Слово владельца\n- payments — «пример» (01.01)\n```';
    expect(judgeZones({ files: pay, body: fenced }).outcome).toBe('fail');
  });

  it('строка вне раздела не засчитывается', () => {
    const body = '## Что изменено\n\n- payments — «пока уберём оплату» (05.10)\n\n## Слово владельца\n\nнет\n';
    expect(judgeZones({ files: pay, body }).outcome).toBe('fail');
  });

  it('строка в разделе ПОСЛЕ «Слова владельца» (например, «## Риски») не засчитывается', () => {
    // Раздел кончается на следующем заголовке того же уровня: цитата под
    // «Рисками» — описание риска, а не слово владельца.
    const body = [
      '## Что изменено', '', 'Правка.', '',
      '## Слово владельца', '', 'нет', '',
      '## Риски', '', '- payments — «пока уберём оплату» (05.10)',
    ].join('\n');
    const v = judgeZones({ files: pay, body });
    expect(v.sectionFound).toBe(true);
    expect(v.outcome).toBe('fail');
  });

  it('зону можно назвать путём задетого файла или названием', () => {
    expect(
      judgeZones({ files: pay, body: bodyWith('- app/api/payments/tochka/webhook/route.ts — «QR после подтверждения» 25.09') }).outcome,
    ).toBe('ok');
    expect(
      judgeZones({ files: [code('lib/safety/trip-watch.ts')], body: bodyWith('Контроль выхода: «это новый слой безопасности» — 30.09') })
        .outcome,
    ).toBe('ok');
  });

  it('имя зоны целым словом: lib/auth/middleware.ts — не middleware.ts', () => {
    const v = judgeZones({ files: [code('middleware.ts')], body: bodyWith('- lib/auth/middleware.ts — «да» (01.09)') });
    expect(v.outcome).toBe('fail');
  });
});

describe('только комментарии — по разбору, не по строкам диффа', () => {
  const same = (a: string, b: string, path = 'lib/auth.ts') => sameCodeIgnoringComments(ts, a, b, path).same;

  it('правка JSDoc и строчного комментария — только комментарии', () => {
    const before = '/**\n * Старый текст.\n */\nexport function f(x: number) {\n  return x + 1; // хвост\n}\n';
    const after = '/**\n * Новый текст,\n * в две строки.\n */\nexport function f(x: number) {\n  return x + 1; // другой хвост\n}\n';
    expect(same(before, after)).toBe(true);
  });

  it('середина длинного блока — тоже комментарий (начало блока вне хунка)', () => {
    const block = (mid: string) => `/**\n${Array.from({ length: 20 }, (_, i) => ` * строка ${i}`).join('\n')}\n * ${mid}\n */\nexport const a = 1;\n`;
    expect(same(block('старое'), block('новое'))).toBe(true);
  });

  it('правка кода — не комментарий', () => {
    expect(same('export const LIMIT = 10;\n', 'export const LIMIT = 11;\n')).toBe(false);
  });

  it('«// x» внутри шаблонной строки — данные, а не комментарий', () => {
    expect(same('export const sql = `\n  SELECT 1\n  // a\n`;\n', 'export const sql = `\n  SELECT 1\n  // b\n`;\n')).toBe(false);
  });

  it('управляющий комментарий (webpack) — правка кода', () => {
    expect(
      same("const m = () => import(/* webpackChunkName: 'a' */ './x');\n", "const m = () => import(/* webpackIgnore: true */ './x');\n"),
    ).toBe(false);
  });

  it('файл, который не разбирается, и не-код — «не смог», а не «да»', () => {
    expect(sameCodeIgnoringComments(ts, 'export const a = 1;', 'export const a = ;;(', 'lib/auth.ts')).toMatchObject({ same: null });
    expect(sameCodeIgnoringComments(ts, '# a', '# b', 'docs/safety/WATCH_MANIFEST.md')).toMatchObject({ same: null });
    expect(sameCodeIgnoringComments(null, 'a', 'a', 'lib/auth.ts')).toMatchObject({ same: null });
  });

  it('JSX: комментарий в фигурных скобках — комментарий, текст — нет', () => {
    const p = 'app/watch/WatchClient.tsx';
    expect(same('const a = <div>{/* c */}hi</div>;\n', 'const a = <div>{/* d */}hi</div>;\n', p)).toBe(true);
    expect(same('const a = <div>hi</div>;\n', 'const a = <div>привет</div>;\n', p)).toBe(false);
  });
});

/** Подставной GitHub: список файлов PR, сравнение и содержимое по ref. */
function fakeGitHub(opts: {
  files: Array<{ filename: string; status: string; previous_filename?: string }>;
  contents?: Record<string, string>;
  listStatus?: number;
}) {
  const fetchImpl = async (input: string) => {
    const u = new URL(input);
    if (u.pathname.endsWith('/files')) {
      if (opts.listStatus) return new Response('{}', { status: opts.listStatus });
      const page = Number(u.searchParams.get('page'));
      return Response.json(opts.files.slice((page - 1) * 100, page * 100));
    }
    if (u.pathname.includes('/compare/')) return Response.json({ merge_base_commit: { sha: 'base0000' } });
    if (u.pathname.includes('/contents/')) {
      const path = decodeURIComponent(u.pathname.split('/contents/')[1]);
      const text = opts.contents?.[`${u.searchParams.get('ref')}:${path}`];
      return text === undefined ? new Response('not found', { status: 404 }) : new Response(text);
    }
    return new Response('', { status: 500 });
  };
  return fetchImpl as unknown as typeof fetch;
}

const ENV = { GH_TOKEN: 't', REPO: 'o/r', PR_NUMBER: '7', BASE_SHA: 'main0000', HEAD_SHA: 'head0000' };

describe('проход поверх API GitHub', () => {
  it('список файлов не получен — красный «не смог проверить», а не «зон нет»', async () => {
    const res = await runZonesCheck({ env: { ...ENV, CHANGED_FILES: '1' }, fetchImpl: fakeGitHub({ files: [], listStatus: 502 }), ts });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toMatch(/^::error::Не смог проверить зоны §7: список файлов PR не получен \(HTTP 502/m);
  });

  it('список неполон против changed_files — красный', async () => {
    const res = await runZonesCheck({
      env: { ...ENV, CHANGED_FILES: '3' },
      fetchImpl: fakeGitHub({ files: [{ filename: 'README.md', status: 'modified' }] }),
      ts,
    });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toContain('получено 1 из 3');
  });

  it('правка комментария в middleware.ts — предупреждение по настоящим версиям файла', async () => {
    const before = '// Старый комментарий\nexport const config = { matcher: [] };\n';
    const after = '// Новый комментарий,\n// длиннее\nexport const config = { matcher: [] };\n';
    const res = await runZonesCheck({
      env: { ...ENV, CHANGED_FILES: '2', PR_BODY: '' },
      fetchImpl: fakeGitHub({
        files: [
          { filename: 'middleware.ts', status: 'modified' },
          { filename: 'lib/places/aliases.ts', status: 'modified' },
        ],
        contents: { 'base0000:middleware.ts': before, 'head0000:middleware.ts': after },
      }),
      ts,
    });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toMatch(/^::warning::PR меняет в зоне §7 middleware/m);
  });

  it('правка кода в приёмнике оплаты без слова — красный; со словом — зелёный', async () => {
    const path = 'app/api/payments/webhook/route.ts';
    const gh = fakeGitHub({
      files: [{ filename: path, status: 'modified' }],
      contents: { [`base0000:${path}`]: 'export const a = 1;\n', [`head0000:${path}`]: 'export const a = 2;\n' },
    });
    const red = await runZonesCheck({ env: { ...ENV, CHANGED_FILES: '1', PR_BODY: '' }, fetchImpl: gh, ts });
    expect(red.exitCode).toBe(1);
    const green = await runZonesCheck({
      env: { ...ENV, CHANGED_FILES: '1', PR_BODY: bodyWith('- payments — «пока уберём оплату» (05.10)') },
      fetchImpl: gh,
      ts,
    });
    expect(green.exitCode).toBe(0);
  });

  it('новый файл в зоне и переименование из зоны — правка кода', async () => {
    const res = await runZonesCheck({
      env: { ...ENV, CHANGED_FILES: '2', PR_BODY: '' },
      fetchImpl: fakeGitHub({
        files: [
          { filename: 'app/api/safety/sos/extra/route.ts', status: 'added' },
          { filename: 'lib/old-auth.ts', status: 'renamed', previous_filename: 'lib/auth.ts' },
        ],
      }),
      ts,
    });
    expect(res.exitCode).toBe(1);
    const out = res.out.join('\n');
    expect(out).toContain('::error::PR трогает зону §7 sos');
    expect(out).toContain('::error::PR трогает зону §7 lib-auth');
  });

  it('содержимое не получено — «не смог определить», судится как код', async () => {
    const res = await runZonesCheck({
      env: { ...ENV, CHANGED_FILES: '1', PR_BODY: '' },
      fetchImpl: fakeGitHub({ files: [{ filename: 'lib/safety/trip-watch.ts', status: 'modified' }], contents: {} }),
      ts,
    });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toMatch(/содержимое не получено: HTTP 404/);
  });

  it('путь из PR не начинает новую команду workflow', async () => {
    const evil = 'app/api/payments/x\n::notice::подмена.ts';
    const res = await runZonesCheck({
      env: { ...ENV, CHANGED_FILES: '1', PR_BODY: '' },
      fetchImpl: fakeGitHub({ files: [{ filename: evil, status: 'added' }] }),
      ts,
    });
    const lines = res.out.join('\n').split('\n');
    expect(lines.some((l) => l.startsWith('::notice::подмена'))).toBe(false);
    expect(res.exitCode).toBe(1);
  });
});

describe('реестр зон против репозитория и CLAUDE.md §7', () => {
  const CLAUDE = read('CLAUDE.md');
  const s7start = CLAUDE.indexOf('## 7. НЕ ТРОГАТЬ');
  const SECTION7 = CLAUDE.slice(s7start, CLAUDE.indexOf('\n## 8.', s7start));

  it('§7 найден и ссылается на реестр, проверку и этот сторож', () => {
    expect(s7start).toBeGreaterThan(0);
    for (const p of [
      'scripts/protected-zones.mjs',
      '.github/workflows/protected-zones.yml',
      '.github/workflows/protected-zones-push.yml',
      'tests/unit/protected-zones-gate.test.ts',
    ]) {
      expect(SECTION7, `§7 не называет ${p}`).toContain(p);
    }
  });

  it('каждый путь реестра существует; каталог зоны не пуст', () => {
    for (const z of PROTECTED_ZONES) {
      for (const p of z.paths) {
        if (p.endsWith('/**')) {
          const dir = join(ROOT, p.slice(0, -3));
          expect(existsSync(dir) && statSync(dir).isDirectory(), `${z.id}: нет каталога ${p}`).toBe(true);
          expect(readdirSync(dir).length, `${z.id}: пустой каталог ${p}`).toBeGreaterThan(0);
        } else {
          expect(existsSync(join(ROOT, p)), `${z.id}: нет файла ${p}`).toBe(true);
        }
      }
      expect(z.reason.length, `${z.id}: причина пуста`).toBeGreaterThan(20);
    }
  });

  /**
   * Пункты §7, которые зоной согласия не являются, — с причиной. Список
   * самоустаревающий: пункт ушёл из §7 — запись обязана уйти отсюда.
   */
  const NOT_A_ZONE: Record<string, string> = {
    'Ставку комиссии назначает владелец':
      'правило о данных (partners.commission_current меняет только владелец), не о файлах; держит tests/unit/commission-rate-decided.test.ts',
    Миграции: 'правило нумерации (только вперёд, max + 1), не зона согласия; держит tests/unit/migration-order.test.ts',
  };

  /** Головное слово пункта: `путь`, **жирное**, заголовок ### или слово до тире. */
  const lead = (line: string): string => {
    const tick = /^- (`[^`]+`)/.exec(line);
    if (tick) return tick[1];
    const bold = /^- (\*\*[^*]+\*\*)/.exec(line);
    if (bold) return bold[1];
    const h = /^### (.+?)(?:\s*\(|$)/.exec(line);
    if (h) return h[1].trim();
    return (/^- (.+?)\s+—/.exec(line)?.[1] ?? line).trim();
  };
  const ITEMS = SECTION7.split('\n')
    .filter((l) => /^- /.test(l) || /^### /.test(l))
    .map(lead);

  it('каждый пункт §7 — зона реестра либо записан с причиной', () => {
    expect(ITEMS.length).toBeGreaterThan(4);
    const unclaimed = ITEMS.filter((it) => !PROTECTED_ZONES.some((z) => z.claude.includes(it)) && !(it in NOT_A_ZONE));
    expect(unclaimed, 'пункт §7 без зоны и без причины').toEqual([]);
  });

  it('записи «не зона» не устарели, их сторожа существуют', () => {
    for (const [item, why] of Object.entries(NOT_A_ZONE)) {
      expect(ITEMS, `«${item}» больше нет в §7 — убрать запись`).toContain(item);
      const guard = /tests\/unit\/[\w.-]+\.test\.ts/.exec(why)?.[0];
      expect(guard && existsSync(join(ROOT, guard)), `${item}: сторож не найден`).toBe(true);
    }
  });

  it('ссылка каждой зоны на CLAUDE.md настоящая: названное ею стоит в §7', () => {
    for (const z of PROTECTED_ZONES) {
      const named = [...z.claude.matchAll(/(`[^`]+`|\*\*[^*]+\*\*)/g)].map((m) => m[1]);
      expect(named.length, `${z.id}: ссылка на §7 ничего не называет`).toBeGreaterThan(0);
      for (const n of named) expect(SECTION7, `${z.id}: в §7 нет ${n}`).toContain(n);
    }
  });

  it('реестр публичных API — зона (третье исключение §7 по слову владельца 14.10)', () => {
    expect(zonesOfFile('lib/auth/public-api-routes.ts').map((z) => z.id)).toEqual(['public-api-routes']);
    expect(zonesOfFile('lib/auth/middleware.ts')).toEqual([]);
  });

  it('граница пути зоны — каталог целиком, а не префикс строки', () => {
    // app/api/payments-x и app/returns начинаются как пути зон, но в них не
    // лежат: зона «каталог/**» — это «каталог/» и всё под ним.
    for (const outside of ['app/api/payments-x/route.ts', 'app/returns/x.ts', 'app/api/safety/sos-legacy/route.ts']) {
      expect(zonesOfFile(outside), outside).toEqual([]);
      expect(judgeZones({ files: [code(outside)], body: '' }).outcome, outside).toBe('clean');
    }
    // Контроль: внутри тех же каталогов — зона.
    expect(zonesOfFile('app/api/payments/x/route.ts').map((z) => z.id)).toEqual(['payments']);
    expect(zonesOfFile('app/return/page.tsx').map((z) => z.id)).toEqual(['trip-watch']);
  });

  it('третий приёмник оплаты вне app/api/payments — в зоне оплаты', () => {
    expect(SECTION7).toContain('/api/hub/operator/payments/webhook');
    expect(zonesOfFile('app/api/hub/operator/payments/webhook/route.ts').map((z) => z.id)).toEqual(['payments']);
  });
});

describe('контроль выхода: зона покрывает то, что называет манифест', () => {
  const MANIFEST = read('docs/safety/WATCH_MANIFEST.md');
  const TABLE = MANIFEST.slice(MANIFEST.indexOf('## Как это устроено сейчас'), MANIFEST.indexOf('## Правила'));
  const TOKENS = [...TABLE.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const watch = PROTECTED_ZONES.find((z) => z.id === 'trip-watch');

  const filesUnder = (rel: string): string[] => {
    const abs = join(ROOT, rel);
    if (!statSync(abs).isDirectory()) return [rel];
    return readdirSync(abs).flatMap((e) => filesUnder(`${rel}/${e}`));
  };
  const covered = (rel: string) => filesUnder(rel).every((f) => watch?.paths.some((p) => matchesZonePath(f, p)));

  it('таблица найдена и называет пути', () => {
    expect(watch).toBeDefined();
    expect(TOKENS.length).toBeGreaterThan(10);
  });

  it('сам манифест — в зоне: его правила меняет только владелец', () => {
    expect(MANIFEST).toContain('Правила здесь меняет только владелец');
    expect(zonesOfFile('docs/safety/WATCH_MANIFEST.md').map((z) => z.id)).toEqual(['trip-watch']);
  });

  it('каждый файл и каталог из таблицы — в зоне', () => {
    const paths = TOKENS.filter((t) => /^(app|lib|docs)\//.test(t));
    expect(paths.length).toBeGreaterThan(3);
    const missing = paths.filter((p) => !existsSync(join(ROOT, p)) || !covered(p));
    expect(missing, 'манифест называет, а зона не держит').toEqual([]);
  });

  it('каждый адрес из таблицы (страница или API) — в зоне всеми файлами', () => {
    const urls = TOKENS.map((t) => t.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, ''))
      .filter((t) => t.startsWith('/'))
      .map((t) => t.split('?')[0]);
    expect(urls.length).toBeGreaterThan(4);
    const missing = urls.filter((u) => {
      const rel = `app${u}`;
      return !existsSync(join(ROOT, rel)) || !covered(rel);
    });
    expect(missing, 'адрес из манифеста вне зоны').toEqual([]);
  });

  /**
   * Функции, которые таблица называет, но живущие вне зоны контроля выхода, —
   * с причиной и со своей зоной (аудит 15.10 ZONES, S-3: до этого дня они
   * не были ни в какой). Самоустаревает: функция переехала в файл зоны
   * контроля выхода — запись убрать.
   */
  const OUTSIDE: Record<string, { file: string; zone: string; why: string }> = {
    isVerifiedMaxWebhook: {
      file: 'lib/max/webhook-url.ts',
      zone: 'messenger-login',
      why: 'общая дверь вебхука MAX для всего бота Кузьмича, не только контроля выхода — своя зона «вход через мессенджеры»',
    },
    sendPdAlert: {
      file: 'lib/notifications/pd-alert.ts',
      zone: 'pd-route',
      why: 'общий канал ПД дежурному в MAX (и лиды, и тревоги) — своя зона «маршрут ПД»',
    },
  };

  const definedIn = (name: string): string[] => {
    const hits: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const p = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && new RegExp(`export (async )?function ${name}\\b`).test(read(p))) hits.push(p);
      }
    };
    walk('lib');
    walk('app');
    return hits;
  };

  it('функции из таблицы определены в зоне либо записаны с причиной', () => {
    const fns = [...new Set(TOKENS.filter((t) => /^[a-z]+[A-Z]\w*$/.test(t)))];
    expect(fns.length).toBeGreaterThan(2);
    for (const fn of fns) {
      const where = definedIn(fn);
      expect(where.length, `${fn} не найдена в коде — манифест устарел`).toBeGreaterThan(0);
      const inZone = where.some((p) => watch?.paths.some((z) => matchesZonePath(p, z)));
      if (fn in OUTSIDE) {
        expect(inZone, `${fn} уже в зоне — убрать запись из OUTSIDE`).toBe(false);
        expect(where[0]).toBe(OUTSIDE[fn].file);
        // Вне контроля выхода — не значит вне реестра: дверь под своей зоной.
        expect(zonesOfFile(OUTSIDE[fn].file).map((z) => z.id), `${fn}: файл вне реестра зон`).toEqual([OUTSIDE[fn].zone]);
      } else {
        expect(inZone, `${fn} (${where.join(', ')}) вне зоны и без причины`).toBe(true);
      }
    }
  });
});

describe('workflow: проверка из main, тело PR только строкой', () => {
  const SRC = read('.github/workflows/protected-zones.yml');
  const wf = load(SRC) as {
    on: Record<string, { types?: string[]; branches?: string[] }>;
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Array<{ uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }> }>;
  };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);

  it('триггер pull_request_target на четыре действия, в main', () => {
    expect(Object.keys(wf.on)).toEqual(['pull_request_target']);
    expect([...(wf.on.pull_request_target.types ?? [])].sort()).toEqual(['edited', 'opened', 'reopened', 'synchronize']);
    expect(wf.on.pull_request_target.branches).toEqual(['main']);
  });

  it('права только на чтение', () => {
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  });

  it('checkout берёт main: без ref из события, без сохранённого токена', () => {
    const co = steps.filter((s) => s.uses?.startsWith('actions/checkout'));
    expect(co.length).toBe(1);
    expect(co[0].with?.ref).toBeUndefined();
    expect(co[0].with?.['persist-credentials']).toBe(false);
  });

  it('скрипт тот же, что проверяет сторож; тело PR — только через env', () => {
    const run = steps.find((s) => s.run?.includes('scripts/protected-zones.mjs'));
    expect(run?.run).toContain('node scripts/protected-zones.mjs --run');
    expect(run?.env?.PR_BODY).toBe('${{ github.event.pull_request.body }}');
    for (const s of steps) expect(s.run ?? '', 'тело PR подставлено в shell').not.toContain('github.event.pull_request.body');
  });
});

// ── Прямой пуш в main (аудит 15.10 ZONES, S-2 и S-3) ─────────────────────────

type ApiFile = { filename: string; status: string; previous_filename?: string };
type PushCommit = { message: string; parents?: string[]; files: ApiFile[] };
type PrStub = { number: number; merged_at: string | null; merge_commit_sha: string; base: { ref: string }; head: { sha: string } };
type RunStub = { status: string; conclusion: string | null; created_at: string };

/**
 * Подставной GitHub для режима --push: сравнение диапазона, коммиты, PR по
 * номеру и по коммиту, прогоны проверки PR, содержимое по ref, поиск и
 * создание issue. Каждый запрос записывается — сторож видит, о чём
 * скрипт спрашивал и чего не спрашивал.
 */
function fakePushGitHub(opts: {
  commits: Record<string, PushCommit>;
  compareStatus?: number;
  total?: number;
  pulls?: Record<number, PrStub>;
  commitPulls?: Record<string, PrStub[] | number>;
  runs?: Record<string, RunStub[]>;
  contents?: Record<string, string>;
  existingIssues?: Array<{ number: number; title: string; labels: string[] }>;
  issuesStatus?: number;
  labelStatus?: number;
}) {
  const calls: string[] = [];
  const created: Array<{ title: string; body: string; labels?: string[] }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    const p = u.pathname;
    calls.push(`${init?.method ?? 'GET'} ${p}`);
    if (p.includes('/compare/')) {
      if (opts.compareStatus) return new Response('{}', { status: opts.compareStatus });
      const order = Object.keys(opts.commits);
      const page = Number(u.searchParams.get('page') ?? '1');
      return Response.json({
        total_commits: opts.total ?? order.length,
        commits: order.slice((page - 1) * 100, page * 100).map((sha) => ({ sha })),
      });
    }
    let m = /\/commits\/([^/]+)\/pulls$/.exec(p);
    if (m) {
      const v = opts.commitPulls?.[m[1]] ?? [];
      return typeof v === 'number' ? new Response('{}', { status: v }) : Response.json(v);
    }
    m = /\/commits\/([^/]+)$/.exec(p);
    if (m) {
      const c = opts.commits[m[1]];
      if (!c) return new Response('{}', { status: 404 });
      return Response.json({
        sha: m[1],
        commit: { message: c.message },
        parents: (c.parents ?? [`${m[1].slice(0, 8)}-parent`]).map((sha) => ({ sha })),
        files: c.files,
      });
    }
    m = /\/pulls\/(\d+)$/.exec(p);
    if (m) {
      const pr = opts.pulls?.[Number(m[1])];
      return pr ? Response.json(pr) : new Response('{}', { status: 404 });
    }
    if (p.includes('/actions/workflows/')) {
      // Прогоны именно проверки PR и именно на pull_request_target.
      if (!p.endsWith(`/actions/workflows/${PR_CHECK_WORKFLOW}/runs`) || u.searchParams.get('event') !== 'pull_request_target') {
        return new Response('{}', { status: 422 });
      }
      return Response.json({ workflow_runs: opts.runs?.[u.searchParams.get('head_sha') ?? ''] ?? [] });
    }
    if (p.includes('/contents/')) {
      const path = decodeURIComponent(p.split('/contents/')[1]);
      const text = opts.contents?.[`${u.searchParams.get('ref')}:${path}`];
      return text === undefined ? new Response('not found', { status: 404 }) : new Response(text);
    }
    if (p.endsWith('/issues') && (init?.method ?? 'GET') === 'GET') {
      if (opts.issuesStatus) return new Response('{}', { status: opts.issuesStatus });
      const label = u.searchParams.get('labels');
      const page = Number(u.searchParams.get('page') ?? '1');
      const all = (opts.existingIssues ?? []).filter((i) => label === null || i.labels.includes(label));
      return Response.json(all.slice((page - 1) * 100, page * 100));
    }
    if (p.endsWith('/labels') && init?.method === 'POST') {
      return new Response('{}', { status: opts.labelStatus ?? 201 });
    }
    if (p.endsWith('/issues') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { title: string; body: string; labels?: string[] };
      created.push(body);
      return Response.json({ number: 9000 + created.length }, { status: 201 });
    }
    return new Response('', { status: 500 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, created };
}

const sha = (c: string) => c.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const PUSH_ENV = { GH_TOKEN: 't', REPO: 'o/r', BEFORE_SHA: sha('9'), AFTER_SHA: C, RUN_URL: 'https://github.com/o/r/actions/runs/1' };
const parentOf = (s: string) => `${s.slice(0, 8)}-parent`;
const ACCEPTING = 'lib/payments/accepting.ts';
const codeChange = (s: string, path: string) => ({
  [`${parentOf(s)}:${path}`]: 'export const PLATFORM_ACCEPTS_PAYMENTS = false;\n',
  [`${s}:${path}`]: 'export const PLATFORM_ACCEPTS_PAYMENTS = true;\n',
});
const mergedPr = (n: number, mergeSha: string, head = `head${n}`): PrStub => ({
  number: n,
  merged_at: '2026-10-15T10:00:00Z',
  merge_commit_sha: mergeSha,
  base: { ref: 'main' },
  head: { sha: head },
});
const run = (conclusion: string, at: string): RunStub => ({ status: 'completed', conclusion, created_at: `2026-10-15T${at}:00Z` });

describe('прямой пуш в main: каждый коммит судится по своему сообщению', () => {
  it('прямой коммит в зону без слова — красный, аннотация называет файл и зону, открыта одна issue', async () => {
    // Заодно S-3: выключатель оплаты теперь в зоне payments.
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Проба 999: включаем приём\n\nтело', files: [{ filename: ACCEPTING, status: 'modified' }] } },
      commitPulls: { [A]: [] },
      contents: codeChange(A, ACCEPTING),
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    const out = res.out.join('\n');
    expect(out).toContain(
      `::error file=${ACCEPTING}::Коммит aaaaaaa в main задел зону §7 payments (Приём оплаты) без слова владельца в сообщении коммита (коммит не пришёл влитием PR)`,
    );
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0].title).toBe(`${PUSH_ISSUE_TITLE}: ${A.slice(0, 12)}`);
    expect(gh.created[0].labels).toEqual([PUSH_ISSUE_LABEL]);
    expect(gh.created[0].body).toContain('`payments` Приём оплаты');
    expect(gh.created[0].body).toContain(`\`${ACCEPTING}\``);
    expect(gh.created[0].body).toContain('`Проба 999: включаем приём`');
    expect(gh.created[0].body).toContain(`zones-push-commit: ${A}`);
    expect(out).toContain('::notice::Коммит aaaaaaa: открыта issue #9001.');
  });

  it('слово владельца в сообщении коммита — зелёный, issue не открывается', async () => {
    const message = ['Оплата снова принимается', '', '## Слово владельца', '', '- payments — «включаем оплату» (16.10)', ''].join('\n');
    const gh = fakePushGitHub({
      commits: { [A]: { message, files: [{ filename: ACCEPTING, status: 'modified' }] } },
      contents: codeChange(A, ACCEPTING),
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toContain('::notice::Коммит aaaaaaa, зона §7 payments (Приём оплаты): слово владельца в сообщении коммита есть.');
    expect(gh.created).toHaveLength(0);
  });

  it('то же слово ВНЕ раздела (просто в теле коммита) — не слово', async () => {
    const message = 'Оплата снова принимается\n\nпо решению «включаем оплату» (16.10), payments\n';
    const gh = fakePushGitHub({
      commits: { [A]: { message, files: [{ filename: ACCEPTING, status: 'modified' }] } },
      contents: codeChange(A, ACCEPTING),
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    expect(gh.created).toHaveLength(1);
  });

  it('влитый PR с прошедшей проверкой зон — не судится повторно и содержимое не читается', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Аудит: правка оплаты (#2600)\n\n* коммит ветки', files: [{ filename: ACCEPTING, status: 'modified' }] } },
      pulls: { 2600: mergedPr(2600, A) },
      // Последняя по времени — успешная: красный прогон до правки тела PR не в счёт.
      runs: { head2600: [run('failure', '09:00'), run('success', '09:30')] },
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toContain(
      '::notice::Коммит aaaaaaa: влит PR #2600, проверка зон на нём прошла — зона payments (Приём оплаты) повторно не судится',
    );
    expect(gh.calls.some((c) => c.includes('/contents/'))).toBe(false);
    expect(gh.created).toHaveLength(0);
  });

  it('влитый PR, у которого последняя проверка зон красная, — судится сообщение: красный и issue', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Аудит: правка оплаты (#2600)', files: [{ filename: ACCEPTING, status: 'modified' }] } },
      pulls: { 2600: mergedPr(2600, A) },
      runs: { head2600: [run('success', '09:00'), run('failure', '09:30')] },
      contents: codeChange(A, ACCEPTING),
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toContain('(влит PR #2600, но последняя проверка зон на нём — failure)');
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0].body).toContain('влит PR #2600, но последняя проверка зон на нём — failure');
  });

  it('влитый PR без единого прогона проверки зон — судится сообщение', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Старый PR (#2600)', files: [{ filename: 'app/api/safety/sos/route.ts', status: 'added' }] } },
      pulls: { 2600: mergedPr(2600, A) },
      runs: {},
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toContain('влит PR #2600, но проверки зон на его голове head260 не было');
  });

  it('номер PR в заголовке прямого коммита не спасает: влитие сверяется по merge_commit_sha', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Проба 999 (#2600)', files: [{ filename: ACCEPTING, status: 'modified' }] } },
      // PR #2600 влит, но его коммит — другой; список PR этого коммита пуст.
      pulls: { 2600: mergedPr(2600, sha('e')) },
      commitPulls: { [A]: [] },
      runs: { head2600: [run('success', '09:30')] },
      contents: codeChange(A, ACCEPTING),
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toContain('(коммит не пришёл влитием PR)');
    expect(gh.created).toHaveLength(1);
  });

  it('коммит, внесённый PR merge-коммитом или rebase, находится через список PR коммита', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Правка ветки без номера в заголовке', files: [{ filename: ACCEPTING, status: 'modified' }] } },
      commitPulls: { [A]: [mergedPr(2601, sha('f'))] },
      runs: { head2601: [run('success', '09:30')] },
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toContain('влит PR #2601, проверка зон на нём прошла');
  });

  // Ревью ZONES: засчитывается только ВЛИТЫЙ PR в main. Открытый PR с
  // зелёной проверкой зон или PR в другую ветку слова владельца не дают.
  it.each([
    ['открытый PR (не влит), проверка зон на нём зелёная', { ...mergedPr(2603, sha('f')), merged_at: null }],
    ['влитый PR, но в другую ветку', { ...mergedPr(2603, sha('f')), base: { ref: 'release' } }],
  ])('%s — коммит судится как прямой', async (_name, pr) => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Правка ветки без номера в заголовке', files: [{ filename: ACCEPTING, status: 'modified' }] } },
      commitPulls: { [A]: [pr] },
      runs: { head2603: [run('success', '09:30')] },
      contents: codeChange(A, ACCEPTING),
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toContain('(коммит не пришёл влитием PR)');
    expect(gh.created).toHaveLength(1);
  });

  it.each([
    ['не влит', { ...mergedPr(2604, A), merged_at: null }],
    ['влит в другую ветку', { ...mergedPr(2604, A), base: { ref: 'release' } }],
  ])('номер PR в заголовке, но PR %s — не засчитывается', async (_name, pr) => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Правка оплаты (#2604)', files: [{ filename: ACCEPTING, status: 'modified' }] } },
      pulls: { 2604: pr },
      commitPulls: { [A]: [] },
      runs: { head2604: [run('success', '09:30')] },
      contents: codeChange(A, ACCEPTING),
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toContain('(коммит не пришёл влитием PR)');
  });

  it('коммит вне зон — зелёный, и про PR не спрашивается', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Проба 965', files: [{ filename: 'lib/places/aliases.ts', status: 'modified' }] } },
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toContain('Коммитов в пуше: 1; задели зоны или не прочитаны: 0.');
    expect(gh.calls.some((c) => /\/pulls/.test(c))).toBe(false);
    expect(gh.created).toHaveLength(0);
  });

  it('несколько коммитов: судится каждый, issue — только на нарушителя', async () => {
    const gh = fakePushGitHub({
      commits: {
        [A]: { message: 'Проба 1', files: [{ filename: 'lib/safety/registration-gate.ts', status: 'modified' }] },
        [B]: { message: 'Проба 2', files: [{ filename: 'docs/x.md', status: 'added' }] },
        [C]: { message: 'Влито (#2602)', files: [{ filename: 'middleware.ts', status: 'modified' }] },
      },
      commitPulls: { [A]: [] },
      pulls: { 2602: mergedPr(2602, C) },
      runs: { head2602: [run('success', '09:30')] },
      contents: {
        [`${parentOf(A)}:lib/safety/registration-gate.ts`]: 'export const a = 1;\n',
        [`${A}:lib/safety/registration-gate.ts`]: 'export const a = 2;\n',
      },
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    const out = res.out.join('\n');
    expect(out).toContain('::error file=lib/safety/registration-gate.ts::Коммит aaaaaaa в main задел зону §7 trip-watch (Контроль выхода)');
    expect(out).not.toMatch(/::error[^\n]*ccccccc/);
    expect(gh.created.map((i) => i.title)).toEqual([`${PUSH_ISSUE_TITLE}: ${A.slice(0, 12)}`]);
  });

  it('issue на этот коммит уже есть (хоть на второй странице) — вторая не открывается, прогон всё равно красный', async () => {
    const tag = A.slice(0, 12);
    const others = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `${PUSH_ISSUE_TITLE}: ${String(i).padStart(12, '0')}`, labels: [PUSH_ISSUE_LABEL] }));
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Проба 999', files: [{ filename: ACCEPTING, status: 'added' }] } },
      commitPulls: { [A]: [] },
      existingIssues: [...others, { number: 177, title: `${PUSH_ISSUE_TITLE}: ${tag}`, labels: [PUSH_ISSUE_LABEL] }],
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    expect(gh.created).toHaveLength(0);
    expect(res.out.join('\n')).toContain('issue уже есть — #177, вторая не открывается');
  });

  it('issue без метки проверки дублем не считается (метка — условие поиска)', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Проба 999', files: [{ filename: ACCEPTING, status: 'added' }] } },
      commitPulls: { [A]: [] },
      existingIssues: [{ number: 5, title: `Обсуждение ${A.slice(0, 12)}`, labels: ['evo'] }],
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(gh.created).toHaveLength(1);
    expect(res.exitCode).toBe(1);
  });

  it('список issue проверки или метка не получены — issue не открывается, и об этом сказано ошибкой', async () => {
    for (const [opts, re] of [
      [{ issuesStatus: 503 }, /^::error::Коммит aaaaaaa: issue не открыта — список issue проверки ответил HTTP 503/m],
      [{ labelStatus: 403 }, /^::error::Коммит aaaaaaa: issue не открыта — метка zones-push не заведена: HTTP 403/m],
    ] as const) {
      const gh = fakePushGitHub({
        commits: { [A]: { message: 'Проба 999', files: [{ filename: ACCEPTING, status: 'added' }] } },
        commitPulls: { [A]: [] },
        ...opts,
      });
      const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
      expect(res.exitCode).toBe(1);
      expect(gh.created).toHaveLength(0);
      expect(res.out.join('\n')).toMatch(re);
    }
  });

  it('метка уже заведена (422) — issue открывается', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Проба 999', files: [{ filename: ACCEPTING, status: 'added' }] } },
      commitPulls: { [A]: [] },
      labelStatus: 422,
    });
    await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(gh.created).toHaveLength(1);
  });

  it('не смог узнать, влит ли коммит PR, — красный «не смог», без issue', async () => {
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Проба 999', files: [{ filename: ACCEPTING, status: 'added' }] } },
      commitPulls: { [A]: 502 },
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toContain('Не смог проверить коммит aaaaaaa: зона §7 payments (Приём оплаты) задета без слова владельца');
    expect(res.out.join('\n')).toContain('список PR коммита ответил HTTP 502');
    expect(gh.created).toHaveLength(0);
  });

  it('коммит не прочитан — красный «не смог», а не «зон нет»', async () => {
    const gh = fakePushGitHub({ commits: { [A]: { message: 'x', files: [] } } });
    const broken = (async (input: string, init?: RequestInit) =>
      new URL(input).pathname.endsWith(`/commits/${A}`) ? new Response('{}', { status: 500 }) : gh.fetchImpl(input, init)) as unknown as typeof fetch;
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: broken, ts });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toMatch(/^::error::Не смог проверить коммит aaaaaaa: коммит не прочитан \(HTTP 500/m);
  });

  it('диапазон пуша не получен, before из нулей, ноль коммитов, неполный список — красный «не смог»', async () => {
    const one = { [A]: { message: 'x', files: [] } };
    const cases: Array<[Record<string, string>, Parameters<typeof fakePushGitHub>[0], RegExp]> = [
      [PUSH_ENV, { commits: one, compareStatus: 502 }, /коммиты пуша не получены \(сравнение ответило HTTP 502\)/],
      [{ ...PUSH_ENV, BEFORE_SHA: '0'.repeat(40) }, { commits: one }, /у пуша нет прежней головы/],
      [PUSH_ENV, { commits: {} }, /пуш не принёс новых коммитов/],
      [PUSH_ENV, { commits: one, total: 3 }, /список коммитов неполон: получено 1 из 3/],
      [{ GH_TOKEN: 't', REPO: 'o/r' }, { commits: one }, /нет переменных BEFORE_SHA, AFTER_SHA/],
    ];
    for (const [env, opts, re] of cases) {
      const res = await runPushCheck({ env, fetchImpl: fakePushGitHub(opts).fetchImpl, ts });
      expect(res.exitCode, String(re)).toBe(1);
      expect(res.out.join('\n'), String(re)).toMatch(new RegExp(`^::error::Не смог проверить зоны §7 в пуше: ${re.source}`, 'm'));
    }
  });

  it('в зоне прямым пушем меняются одни комментарии — предупреждение, без issue', async () => {
    const path = 'lib/max/webhook-url.ts';
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Комментарий', files: [{ filename: path, status: 'modified' }] } },
      commitPulls: { [A]: [] },
      contents: {
        [`${parentOf(A)}:${path}`]: '// старый\nexport const a = 1;\n',
        [`${A}:${path}`]: '// новый\nexport const a = 1;\n',
      },
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toContain(`::warning file=${path}::Коммит aaaaaaa меняет в зоне §7 messenger-login (Вход через мессенджеры) только комментарии`);
    expect(gh.created).toHaveLength(0);
  });

  it('путь с запятой и двоеточием не дописывает своё свойство аннотации, перевод строки — свою команду', async () => {
    const evil = 'app/api/payments/a,title=x:y\n::notice::подмена.ts';
    const gh = fakePushGitHub({
      commits: { [A]: { message: 'Проба', files: [{ filename: evil, status: 'added' }] } },
      commitPulls: { [A]: [] },
    });
    const res = await runPushCheck({ env: PUSH_ENV, fetchImpl: gh.fetchImpl, ts });
    const lines = res.out.join('\n').split('\n');
    expect(lines.some((l) => l.startsWith('::notice::подмена'))).toBe(false);
    expect(lines.some((l) => l.startsWith('::error file=app/api/payments/a%2Ctitle=x%3Ay%0A%3A%3Anotice%3A%3Aподмена.ts::'))).toBe(true);
  });
});

describe('прямой пуш: решение по коммиту и номер PR — чистыми функциями', () => {
  const files = [code(ACCEPTING)];

  it('номер PR берётся только из заголовка: squash «(#N)» в конце и «Merge pull request #N»', () => {
    expect(prNumbersFromMessage('Аудит 15.10, волна 7а (#2523)\n\n* правка (#11)')).toEqual([2523]);
    expect(prNumbersFromMessage('Merge pull request #2400 from tourhabk-ui/x\n\nтело')).toEqual([2400]);
    expect(prNumbersFromMessage('Проба 964: контуры OSM')).toEqual([]);
    expect(prNumbersFromMessage('Проба (#12) и ещё текст')).toEqual([]);
    expect(prNumbersFromMessage(null)).toEqual([]);
  });

  it('суд PR прошёл — «pr» при любом сообщении; не прошёл или PR нет — «violation»; не узнали — «unknown»', () => {
    expect(judgePushCommit({ files, message: '', pr: { state: 'passed', why: '' } }).outcome).toBe('pr');
    expect(judgePushCommit({ files, message: '', pr: { state: 'not-passed', why: '' } }).outcome).toBe('violation');
    expect(judgePushCommit({ files, message: '', pr: { state: 'none', why: '' } }).outcome).toBe('violation');
    expect(judgePushCommit({ files, message: '', pr: { state: 'unknown', why: '' } }).outcome).toBe('unknown');
    const word = bodyWith('- lib/payments/accepting.ts — «включаем оплату» (16.10)');
    expect(judgePushCommit({ files, message: word, pr: { state: 'unknown', why: '' } }).outcome).toBe('ok');
    expect(judgePushCommit({ files: [code('README.md')], message: '', pr: { state: 'none', why: '' } }).outcome).toBe('clean');
  });
});

describe('новые пути реестра (S-3) судятся как зона', () => {
  const NEW: Record<string, string> = {
    'lib/safety/registration-mark.ts': 'trip-watch',
    'lib/safety/registration-gate.ts': 'trip-watch',
    'lib/safety/registration-read.ts': 'trip-watch',
    'lib/payments/accepting.ts': 'payments',
    'lib/max/webhook-url.ts': 'messenger-login',
    'lib/notifications/pd-alert.ts': 'pd-route',
    '.github/workflows/protected-zones-push.yml': 'zones-gate',
  };

  it('каждый файл лежит в своей зоне, и правка кода в нём без слова — красный', () => {
    for (const [path, zone] of Object.entries(NEW)) {
      expect(zonesOfFile(path).map((z) => z.id), path).toEqual([zone]);
      expect(judgeZones({ files: [code(path)], body: '' }).outcome, path).toBe('fail');
    }
  });

  it('у новых зон причина словами и ссылка на §7', () => {
    for (const id of ['messenger-login', 'pd-route']) {
      const z = PROTECTED_ZONES.find((x) => x.id === id);
      expect(z, id).toBeDefined();
      expect(z!.reason.length, id).toBeGreaterThan(80);
      expect(z!.claude, id).toContain(z!.paths[0]);
    }
  });
});

describe('CLI: режим выбирается флагом и не молчит', () => {
  const runCli = (args: string[]) =>
    spawnSync(process.execPath, ['scripts/protected-zones.mjs', ...args], {
      cwd: ROOT,
      // Без токена и sha; парсер не грузится намеренно — проверяется только выбор режима.
      env: { PATH: process.env.PATH ?? '', TS_MODULE: join(ROOT, 'нет-такого-модуля') },
      encoding: 'utf-8',
    });

  it('--push без окружения — красный «не смог проверить зоны в пуше»', () => {
    const r = runCli(['--push']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::Не смог проверить зоны §7 в пуше: нет переменных GH_TOKEN, REPO, BEFORE_SHA, AFTER_SHA');
  });

  it('--run без окружения — красный «не смог проверить зоны» режима PR', () => {
    const r = runCli(['--run']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::Не смог проверить зоны §7: нет переменных GH_TOKEN, REPO, PR_NUMBER, BASE_SHA, HEAD_SHA');
  });

  it('без флага модуль только импортируется: ничего не печатает', () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('workflow прямого пуша: только main, узкие права, содержимое коммита не в разметке', () => {
  const PATH = '.github/workflows/protected-zones-push.yml';
  const SRC = read(PATH);
  const wf = load(SRC) as {
    on: Record<string, { branches?: string[]; paths?: unknown; 'paths-ignore'?: unknown; 'branches-ignore'?: unknown }>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        if?: unknown;
        permissions?: unknown;
        'continue-on-error'?: unknown;
        steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: unknown; if?: unknown }>;
      }
    >;
  };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
  const runStep = steps.find((s) => s.run?.includes('scripts/protected-zones.mjs'));

  it('триггер — только push в main, без фильтра путей (судит скрипт, а не второй список зон)', () => {
    expect(Object.keys(wf.on)).toEqual(['push']);
    expect(wf.on.push.branches).toEqual(['main']);
    expect(wf.on.push.paths).toBeUndefined();
    expect(wf.on.push['paths-ignore']).toBeUndefined();
  });

  it('права: чтение кода, PR и прогонов; запись — только issues', () => {
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', actions: 'read', issues: 'write' });
    for (const j of Object.values(wf.jobs)) expect(j.permissions).toBeUndefined();
  });

  it('job не пропускается условием, отказ не глушится', () => {
    for (const j of Object.values(wf.jobs)) {
      expect(j.if).toBeUndefined();
      expect(j['continue-on-error']).toBeUndefined();
    }
    expect(runStep).toBeDefined();
    expect(runStep?.if).toBeUndefined();
    expect(runStep?.['continue-on-error']).toBeUndefined();
  });

  // Ревью ZONES: судья — скрипт из коммита ДО пуша. Прямой пуш, ослабивший
  // саму проверку, иначе судился бы уже ослабленной версией.
  it('два checkout без сохранённого токена: судья — по sha до пуша, запасной — из пуша', () => {
    const co = steps.filter((s) => s.uses?.startsWith('actions/checkout'));
    expect(co.length).toBe(2);
    for (const c of co) expect(c.with?.['persist-credentials']).toBe(false);
    const judge = co.find((c) => c.with?.path === 'judge');
    const pushed = co.find((c) => c.with?.path === 'pushed');
    expect(judge?.with?.ref).toBe('${{ github.event.before }}');
    expect(pushed?.with?.ref).toBeUndefined();
  });

  // Шаг исполняется настоящим bash: в рабочей папке лежат подложенные судья и
  // запасной скрипт, а `node` в PATH — заглушка, печатающая, что ей дали.
  describe('шаг выбирает судью исполнением', () => {
    const runBash = (judge: string | null, pushed: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'zones-push-'));
      try {
        if (judge !== null) {
          mkdirSync(join(dir, 'judge/scripts'), { recursive: true });
          writeFileSync(join(dir, 'judge/scripts/protected-zones.mjs'), judge);
        }
        mkdirSync(join(dir, 'pushed/scripts'), { recursive: true });
        writeFileSync(join(dir, 'pushed/scripts/protected-zones.mjs'), pushed);
        mkdirSync(join(dir, 'bin'));
        writeFileSync(join(dir, 'bin/node'), '#!/bin/sh\necho "NODE $*"\n');
        chmodSync(join(dir, 'bin/node'), 0o755);
        const r = spawnSync('bash', ['-e', '-c', runStep?.run ?? 'exit 99'], {
          cwd: dir,
          encoding: 'utf-8',
          env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir, BEFORE_SHA: 'b'.repeat(40) },
        });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const WITH_PUSH = "const CLI_MODE = process.argv.includes('--push') ? 'push' : null;";
    const OLD = "if (process.argv.includes('--run')) {}";

    it('судья до пуша знает --push — вызван он, без предупреждения', () => {
      const r = runBash(WITH_PUSH, WITH_PUSH);
      expect(r.status).toBe(0);
      expect(r.out).toContain('NODE judge/scripts/protected-zones.mjs --push');
      expect(r.out).not.toContain('::warning::');
    });

    it('судья до пуша не знает --push (первое включение) — скрипт из пуша и громкое предупреждение', () => {
      const r = runBash(OLD, WITH_PUSH);
      expect(r.out).toContain('NODE pushed/scripts/protected-zones.mjs --push');
      expect(r.out).toMatch(/::warning::Судьи до пуша нет или он не знает режима --push/);
    });

    it('судьи до пуша нет вовсе (before из нулей, коммит недоступен) — то же, не молча', () => {
      const r = runBash(null, WITH_PUSH);
      expect(r.out).toContain('NODE pushed/scripts/protected-zones.mjs --push');
      expect(r.out).toMatch(/::warning::/);
    });
  });

  it('скрипт в режиме --push; в env только sha диапазона, токен и адрес прогона', () => {
    expect(runStep?.run).toContain('node "$JUDGE" --push');
    expect(runStep?.env?.BEFORE_SHA).toBe('${{ github.event.before }}');
    expect(runStep?.env?.AFTER_SHA).toBe('${{ github.event.after }}');
    for (const s of steps) expect(s.run ?? '', `подстановка в run шага ${s.name ?? s.uses}`).not.toContain('${{');
    expect(SRC).not.toMatch(/github\.event\.(head_commit|commits)/);
  });

  it('прогоны, которые скрипт ищет, — той проверки PR, что есть в репозитории', () => {
    const prWf = load(read(`.github/workflows/${PR_CHECK_WORKFLOW}`)) as { on: Record<string, unknown> };
    expect(Object.keys(prWf.on)).toEqual(['pull_request_target']);
  });

  it('сам workflow — в зоне проверки зон', () => {
    expect(zonesOfFile(PATH).map((z) => z.id)).toEqual(['zones-gate']);
  });
});
