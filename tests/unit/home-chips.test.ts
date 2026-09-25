/**
 * Чипы главной ведут туда, где фильтр реально применяется.
 *
 * Повод завести сторож: до этой правки клиент каталога ПИСАЛ `difficulty` в
 * адресную строку, но ни он сам при перезагрузке, ни серверный рендер её не
 * читали. Ссылка выглядела рабочей и не была: параметр в URL есть, выдача
 * общая. Чип «Первый раз» молча вёл бы в тот же список, что и «все маршруты» —
 * кнопка, делающая вид, что сузила выбор.
 *
 * Поэтому допустимые параметры берём ИЗ ИСХОДНИКА страницы, а не списком в
 * тесте: сузят контракт `/routes` — упадёт этот тест, а не пользовательский
 * сценарий в проде.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INTENT_CHIPS, chipTarget } from '@/lib/home/intent-chips';
import { knownLocationTypes } from '@/lib/stats/element-groups';
import { parseMarketplaceSearchParams } from '@/lib/tours/marketplace-page';
import { ACTIVITY_LABELS } from '@/lib/tours/labels';

const ROOT = process.cwd();
const ROUTES_PAGE = readFileSync(join(ROOT, 'app/routes/page.tsx'), 'utf-8');

/**
 * Какие query-параметры страница `/routes` реально разбирает.
 * Ищем обращения вида `sp.<имя>` — так страница читает searchParams.
 */
function parsedParams(): Set<string> {
  const code = ROUTES_PAGE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  return new Set([...code.matchAll(/\bsp\.([a-z_][a-z_0-9]*)/gi)].map((m) => m[1]));
}

describe('чип — это настоящий фильтр', () => {
  it('страница /routes разбирает как минимум те параметры, которыми пользуются чипы', () => {
    const parsed = parsedParams();
    expect(parsed.size, 'не разобрать чтение searchParams в app/routes/page.tsx').toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const chip of INTENT_CHIPS) {
      const { path, params } = chipTarget(chip);
      if (path !== '/routes') continue;
      for (const key of Object.keys(params)) {
        if (!parsed.has(key)) offenders.push(`${chip.key}: ${key}`);
      }
    }

    expect(
      offenders,
      'такой параметр /routes не читает — чип откроет общую выдачу и соврёт о выборе',
    ).toEqual([]);
  });

  it('ведёт в каталог мест, в витрину туров или в планировщик — четвёртого адреса нет', () => {
    // Расширено осознанно 24.09 (решение владельца, пакет П4б): '/catalog' —
    // витрина туров, та же, что в BottomNav «Туры». До этого все двери
    // первого экрана вели к местам, и тура с ценой на нём не было. Новый адрес
    // сюда добавляется только вместе с проверкой, что он фильтр применяет
    // (см. тест ниже про /catalog).
    for (const chip of INTENT_CHIPS) {
      const { path } = chipTarget(chip);
      expect(['/routes', '/catalog', '/planner'], `${chip.key}: неожиданный адрес ${path}`).toContain(path);
    }
  });

  it('чип витрины туров: каждый его параметр доходит до фильтра выдачи', () => {
    // Проверяется ВЫЗОВОМ того же разбора, которым /catalog строит SSR-выдачу:
    // параметр, который разбор выбросил, — кнопка, делающая вид, что сузила выбор.
    const catalogChips = INTENT_CHIPS.filter((c) => chipTarget(c).path === '/catalog');
    for (const chip of catalogChips) {
      const { params } = chipTarget(chip);
      expect(Object.keys(params).length, `${chip.key}: чип без фильтра — это просто ссылка`).toBeGreaterThan(0);
      const { filters } = parseMarketplaceSearchParams(params);
      const applied = filters as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(params)) {
        expect(applied[k], `${chip.key}: /catalog не применяет ${k}=${v}`).toBe(v);
      }
      if (params.activity_type) {
        expect(Object.keys(ACTIVITY_LABELS), `${chip.key}: фантомный вид активности ${params.activity_type}`)
          .toContain(params.activity_type);
      }
    }
  });

  it('два чипа не ведут в один и тот же фильтр', () => {
    // Иначе человеку предлагают два имени для одного выбора — так из макета
    // выпал чип «С детьми»: под него нет фильтра, кроме уже занятого easy.
    const targets = INTENT_CHIPS.map((c) => {
      const { path, params } = chipTarget(c);
      const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
      return `${path}?${sorted}`;
    });
    expect(new Set(targets).size, `дубли среди: ${targets.join(' | ')}`).toBe(targets.length);
  });

  it('location_type чипа существует в справочнике типов', () => {
    // Фантомные типы уже были: pass, coast, valley, nature — вечные нули.
    const known = new Set(knownLocationTypes());
    for (const chip of INTENT_CHIPS) {
      const { params } = chipTarget(chip);
      if (!params.location_type) continue;
      expect(known, `${chip.key}: типа ${params.location_type} нет в LOCATION_TYPE_LABELS`)
        .toContain(params.location_type);
    }
  });

  it('difficulty у чипа — из тех значений, что понимает каталог', () => {
    for (const chip of INTENT_CHIPS) {
      const { params } = chipTarget(chip);
      if (!params.difficulty) continue;
      expect(['easy', 'medium', 'hard']).toContain(params.difficulty);
    }
  });
});

describe('сложность переживает перезагрузку страницы', () => {
  it('серверный рендер /routes читает difficulty из адреса', () => {
    const code = ROUTES_PAGE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, 'без этого ссылка с ?difficulty= отдаёт нефильтрованный первый экран')
      .toMatch(/sp\.difficulty/);
  });

  it('клиент каталога берёт начальную сложность из адреса, а не с пустой строки', () => {
    const client = readFileSync(join(ROOT, 'app/routes/_RoutesPageClient.tsx'), 'utf-8');
    const code = client.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, 'клиент снова забудет фильтр при перезагрузке')
      .toMatch(/searchParams\.get\('difficulty'\)/);
  });
});

describe('у чипа одна логика — тур с оператором или свой маршрут (владелец 25.09)', () => {
  it('туровый чип ведёт в витрину туров, маршрутный — нет', () => {
    for (const chip of INTENT_CHIPS) {
      const { path } = chipTarget(chip);
      if (chip.logic === 'tour') expect(path, `${chip.key}: туровый чип мимо витрины`).toBe('/catalog');
      else expect(path, `${chip.key}: маршрутный чип продаёт тур`).not.toBe('/catalog');
    }
  });

  it('у обеих логик есть хотя бы один чип', () => {
    expect(INTENT_CHIPS.some((c) => c.logic === 'tour')).toBe(true);
    expect(INTENT_CHIPS.some((c) => c.logic === 'self')).toBe(true);
  });
});
