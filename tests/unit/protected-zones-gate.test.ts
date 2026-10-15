/**
 * Сторож проверки зон §7 (находка аудита 15.10 AR-zones).
 *
 * Держит связку целиком, а не объявление: логику — вызовом на граничных
 * данных (PR без зоны, зона без слова, слово с цитатой и датой, две зоны и
 * слово на одну, одни комментарии), проход поверх API — тем же кодом с
 * подставным fetch, реестр — сверкой с CLAUDE.md §7 и с таблицей манифеста
 * контроля выхода, workflow — по смыслу: триггер из main, тело PR только
 * через env, скрипт тот же.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  PROTECTED_ZONES,
  judgeZones,
  formatVerdict,
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
    for (const p of ['scripts/protected-zones.mjs', '.github/workflows/protected-zones.yml', 'tests/unit/protected-zones-gate.test.ts']) {
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
   * Функции, которые таблица называет, но живущие вне зоны, — с причиной.
   * Самоустаревает: функция переехала в файл зоны — запись убрать.
   */
  const OUTSIDE: Record<string, string> = {
    isVerifiedMaxWebhook:
      'lib/max/webhook-url.ts — общая дверь вебхука MAX для всего бота Кузьмича, не только контроля выхода; внести файл в зону — решение владельца',
    sendPdAlert:
      'lib/notifications/pd-alert.ts — общий канал ПД дежурному в MAX (и лиды, и тревоги); внести файл в зону — решение владельца',
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
        expect(OUTSIDE[fn]).toContain(where[0]);
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
