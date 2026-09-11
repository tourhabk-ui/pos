/**
 * Роут кабинета оператора без потребителя — провод в никуда (#1803).
 *
 * Прогулка 11.09 нашла восемь роутов `/api/operator/*`, которые отвечали 500
 * на настоящей базе И которых не звал никто: экраны давно ушли на
 * `/api/hub/operator/*`, а параллельное семейство осталось гнить. Это правило
 * 10.09 в чистом виде — объявлено (роут, тип ответа, докстрока), а ни
 * производителя, ни потребителя нет; каждый такой роут ещё и открытая дверь,
 * которую никто не проверяет.
 *
 * Сторож держит две вещи:
 * 1. Удалённые роуты не возвращаются молча.
 * 2. Новый роут под `/api/operator/` обязан иметь потребителя в репозитории
 *    либо запись в KNOWN_UNCONSUMED с причиной — как у `cron-scheduler-declared`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'app/api/operator');

/** Удалены 11.09 (#1803): 500 на настоящей БД, ни одного потребителя. */
const REMOVED = [
  'app/api/operator/analytics/dashboard/route.ts',
  'app/api/operator/profile/route.ts',
  'app/api/operator/profile/settings/route.ts',
  'app/api/operator/reports/bookings/route.ts',
  'app/api/operator/reviews/stats/route.ts',
  'app/api/operator/tours/route.ts',
  'app/api/operator/tours/[id]/route.ts',
  'app/api/operator/tours/[id]/photos/route.ts',
];

/**
 * Роуты без потребителя в коде, оставленные СОЗНАТЕЛЬНО, каждый с причиной.
 * Список самоустаревающий: появился потребитель — запись убирается.
 */
const KNOWN_UNCONSUMED: Record<string, string> = {
  'app/api/operator/tours/[id]/generate-tags/route.ts':
    'AI-путь разметки фото; зовётся вручную и описан в реестре провайдеров (lib/agents/compliance/provider-registry)',
  'app/api/operator/tours/[id]/publish/route.ts':
    'публикация тура; живой SQL, потребитель появится вместе с экраном модерации',
  'app/api/operator/tours/[id]/deactivate/route.ts':
    'снятие тура с витрины; парный к publish',
  'app/api/operator/reports/revenue/route.ts':
    'выгрузка выручки; кабинет пользуется /api/hub/operator/reports, этот остаётся для админской сверки',
  'app/api/operator/reviews/route.ts':
    'список отзывов оператора; читается вручную, экран отзывов ещё не собран',
  'app/api/operator/reviews/[id]/reply/route.ts':
    'ответ оператора на отзыв; парный к списку выше',
  'app/api/operator/messages/route.ts':
    'переписка по брони; зовётся из чата платформы по bookingId',
  'app/api/operator/mchs/[id]/route.ts':
    'карточка регистрации МЧС; открывается по прямой ссылке из панели',

  // Перепись 11.09: эти шесть нашёл сам сторож, когда его завели. В отличие
  // от восьми удалённых, они РАБОТАЮТ — проверено запросом с живой сессией
  // оператора (200, кроме block: он POST-only и отвечает 405 на GET). Значит
  // это не провода в никуда, а API без экрана; удалять работающее вслепую —
  // хуже, чем записать долг с именем. Запись уходит, когда появится
  // потребитель или решение владельца удалить.
  'app/api/operator/bookings/route.ts':
    'работает (200), экрана нет: кабинет ходит в /api/hub/operator/bookings — долг переписи 11.09',
  'app/api/operator/bookings/[id]/route.ts':
    'работает, парный к списку выше — долг переписи 11.09',
  'app/api/operator/calendar/block/route.ts':
    'POST-only блокировка даты (405 на GET), экрана нет — долг переписи 11.09',
  'app/api/operator/mchs-registrations/route.ts':
    'работает (200), панель МЧС на дашборде ходит в /api/operator/mchs — долг переписи 11.09',
  'app/api/operator/stats/route.ts':
    'работает (200), дашборд считает своим /api/operator/dashboard — долг переписи 11.09',
  'app/api/operator/templates/route.ts':
    'работает (200), шаблоны ответов оператора без экрана — долг переписи 11.09',
};

function routeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === 'route.ts') out.push(relative(ROOT, p));
  }
  return out;
}

/** Путь роута → URL, по которому его зовут (`[id]` становится шаблоном). */
function urlOf(routeFile: string): string {
  return '/' + routeFile.replace(/^app\//, '').replace(/\/route\.ts$/, '');
}

describe('мёртвые роуты кабинета не возвращаются', () => {
  it.each(REMOVED)('%s удалён и не создан заново', (f) => {
    expect(existsSync(join(ROOT, f)), `${f} вернулся — у него снова нет потребителя`).toBe(false);
  });
});

describe('у каждого роута /api/operator есть потребитель', () => {
  it('иначе — запись в KNOWN_UNCONSUMED с причиной', () => {
    const files = routeFiles(API_DIR);
    expect(files.length).toBeGreaterThan(5);

    const orphans: string[] = [];
    for (const f of files) {
      if (KNOWN_UNCONSUMED[f]) continue;
      // Ищем вызов по URL: точный путь или его шаблонная часть до [id].
      const url = urlOf(f);
      const needle = url.split('/[')[0];
      const hits = execSync(
        `grep -rl "${needle}" app components lib hooks --include=*.ts --include=*.tsx || true`,
        { cwd: ROOT, encoding: 'utf-8' },
      ).trim().split('\n').filter(Boolean)
        .filter((p) => !p.startsWith('app/api/operator/'));
      if (hits.length === 0) orphans.push(`${f} (${url})`);
    }

    expect(
      orphans,
      `Роут под /api/operator без единого потребителя:\n${orphans.join('\n')}\n` +
      'Либо подключите его к экрану, либо удалите вместе с типами, либо внесите в KNOWN_UNCONSUMED с причиной.',
    ).toEqual([]);
  });

  it('список исключений самоустаревающий: запись без файла запрещена', () => {
    const stale = Object.keys(KNOWN_UNCONSUMED).filter((f) => !existsSync(join(ROOT, f)));
    expect(stale, `запись про несуществующий файл:\n${stale.join('\n')}`).toEqual([]);
  });
});

describe('params в динамических роутах кабинета — Promise (Next 15)', () => {
  const dynamicRoutes = [
    'app/api/hub/operator/bookings/[id]/route.ts',
    'app/api/hub/operator/tours/[id]/route.ts',
    'app/api/hub/operator/tours/[id]/availability/route.ts',
  ];

  it.each(dynamicRoutes)('%s читает params через await', (f) => {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    expect(src).toMatch(/params: Promise<\{ id: string \}>/);
    expect(src).toMatch(/const \{ id \} = await params;/);
    expect(src, 'синхронный доступ к params сломается на следующем мажоре Next').not.toMatch(/params\.id/);
  });
});
