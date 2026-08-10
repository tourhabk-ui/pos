/**
 * Тихих catch не становится больше.
 *
 * За вечер 10.08 этот класс вскрылся пять раз подряд в разных подсистемах, и
 * каждый раз с одинаковым исходом: отсутствие результата приняло форму
 * результата. Оценка риска по зонам отдавала пустоту, и страница объявляла
 * «Обстановка нормальная»; синк вулканов падал тринадцать дней при живом на вид
 * кроне; выкладка карты пропускалась при зелёном прогоне; ночной smoke краснел
 * впустую шесть ночей, и его перестали читать.
 *
 * Владелец сказал прямо: «кажется, у нас так много тихих поломок». Ощущение
 * стоило перевести в число — сканер нашёл 25 на 1487 файлов.
 *
 * Здесь список заморожен. Гард не чинит долг, он не даёт ему расти: новый тихий
 * catch провалит сборку, а снимать записи можно по одной, разобрав каждую.
 * Так же устроен гард фантомных колонок, и по той же причине — единовременная
 * чистка 25 мест вслепую опаснее самой проблемы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { findSilentCatches, isEmptyShape } from '@/lib/quality/silent-catch';

const ROOT = process.cwd();

/**
 * ЗАМОРОЖЕННЫЙ ДОЛГ (первый прогон, 10.08.2026). Это не разрешение — это
 * список известного. Снимать записи по одной, каждую разобрав: пустота —
 * осознанный ответ (тогда пометить сбой честно) или маскировка сбоя (тогда
 * чинить). Новая запись здесь ЗАПРЕЩЕНА без явного решения владельца.
 *
 * Две записи из app/_home/data.ts уже сняты: главная писала «Спокойно» из нуля
 * данных, и это же молчание мешало разобрать, почему коды вулканов не дошли до
 * экрана.
 */
const BASELINE = new Set<string>([
  'app/api/admin/evo/issues/route.ts',
  'app/api/admin/operators/db-status/route.ts',
  'app/api/cron/health/route.ts',
  'app/api/hub/operator/payments/webhook/route.ts',
  'lib/agents/context-hub.ts',
  'lib/auth/tourist-helpers.ts',
  'lib/collections/resolve.ts',
  'lib/kuzmich/core.ts',
  'lib/kuzmich/engagement.ts',
  'lib/notifications/post-validation.ts',
  'lib/payments/transfer-payments.ts',
  'lib/planner/data.ts',
  'lib/services/analytics.service.ts',
  'lib/services/operators/support.service.ts',
  'lib/services/rag.service.ts',
  'lib/services/tours/tour.service.ts',
  'lib/transfers/booking.ts',
  'lib/transfers/matching.ts',
]);

describe('форма-пустышка распознаётся', () => {
  it('объект из одних пустых значений — пустышка', () => {
    expect(isEmptyShape('{ zones: [], updatedAt: null }')).toBe(true);
    expect(isEmptyShape('{ activeCount: 0, alerts: [], volcanoes: [] }')).toBe(true);
    expect(isEmptyShape("{ tours: [], total: 0, hasMore: false }")).toBe(true);
  });

  it('объект с содержательным значением — не пустышка', () => {
    expect(isEmptyShape('{ items: rows }')).toBe(false);
    expect(isEmptyShape('{ total: count }')).toBe(false);
    expect(isEmptyShape('{ zones: [], updatedAt: new Date() }')).toBe(false);
  });

  it('проверка структурная: честность решается слоем выше', () => {
    // `{ zones: [], ok: false }` структурно — пустышка: `false` такое же
    // «ничего не значащее» значение, как `[]`. Но в catch это ЧЕСТНЫЙ ответ,
    // и отсекается он по всему телу блока, а не по форме объекта. Разделение
    // намеренное: форма и намерение — разные вопросы, и смешивать их значит
    // получить гард, который путается в обоих.
    expect(isEmptyShape('{ zones: [], ok: false }')).toBe(true);
    expect(findSilentCatches('try { x() } catch { return { zones: [], ok: false }; }')).toEqual([]);
  });

  it('пустой объект пустышкой не считается', () => {
    // `{}` в catch означает «ответа нет», а не «всё хорошо, данных ноль».
    expect(isEmptyShape('{}')).toBe(false);
  });
});

describe('честная деградация не обвиняется', () => {
  it('сбой помечен ok: false — не находка', () => {
    const src = `try { x() } catch { return NextResponse.json({ ok: false, zones: [] }, { status: 503 }); }`;
    expect(findSilentCatches(src)).toEqual([]);
  });

  it('сбой помечен success: false с текстом — не находка', () => {
    const src = `try { x() } catch (e) { return { success: false, error: String(e) }; }`;
    expect(findSilentCatches(src)).toEqual([]);
  });

  it('проброс наверх — не находка', () => {
    expect(findSilentCatches('try { x() } catch (e) { throw e; }')).toEqual([]);
  });

  it('код ошибки в ответе — не находка', () => {
    const src = `try { x() } catch { return NextResponse.json({ rows: [] }, { status: 500 }); }`;
    expect(findSilentCatches(src)).toEqual([]);
  });
});

describe('тихий catch виден', () => {
  it('пустая форма без пометки сбоя — находка со строкой и телом', () => {
    const src = ['const a = 1;', 'try { x() } catch {', '  return { zones: [], updatedAt: null };', '}'].join('\n');
    const hits = findSilentCatches(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
    expect(hits[0].returned).toContain('zones');
  });
});

describe('долг не растёт', () => {
  it('новых тихих catch в app/ и lib/ нет', () => {
    const files = execSync("git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'lib/**/*.ts'", { cwd: ROOT, encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      if (!/\bcatch\b/.test(src)) continue;
      for (const hit of findSilentCatches(src)) {
        if (!BASELINE.has(f)) offenders.push(`${f}:${hit.line} → ${hit.returned}`);
      }
    }

    expect(
      [...new Set(offenders)],
      'Появился catch, возвращающий форму, неотличимую от успеха.\n' +
      'Сбой обязан быть назван: ok/success: false, поле error либо код 4xx/5xx.\n' +
      'Пустой список при этом допустим — недопустимо выдавать сбой за пустой список.',
    ).toEqual([]);
  });

  it('главная больше не молчит о сбое', () => {
    // Именно это молчание 10.08 не дало понять, дошли ли коды вулканов до
    // экрана: ноль на витрине означал и «нет угроз», и «запрос упал».
    const data = readFileSync(join(ROOT, 'app/_home/data.ts'), 'utf-8');
    expect(findSilentCatches(data)).toEqual([]);
    expect(data).toMatch(/degraded:\s*true/);
  });

  it('шапка главной не объявляет спокойствие из нуля данных', () => {
    const pill = readFileSync(join(ROOT, 'lib/home/safety-pill.ts'), 'utf-8');
    // Проверка на сбой обязана стоять ДО проверки счётчика: при сбое счётчики
    // нулевые, и любая ветка ниже прочтёт их как хорошую новость.
    expect(pill.indexOf('if (degraded)')).toBeLessThan(pill.indexOf('activeCount <= 0'));
  });
});
