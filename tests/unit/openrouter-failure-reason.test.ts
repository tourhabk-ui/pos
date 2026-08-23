/**
 * «OpenRouter недоступен» обязан называть, ЧТО именно недоступно.
 *
 * До 24.08 предупреждение было безусловным и однословным, тогда как у соседей
 * оно молчит при незаданном ключе («не настроен» не равно «сбой») и называет
 * причину, когда ключ задан. Одно слово покрывало три разных случая: ключа
 * нет, ключ отвергнут, сеть упала.
 *
 * Цена оказалась не теоретической. Задача в бэклоге называлась «ключ OpenRouter
 * пропал с прода» — а замер 24.08 показал ключ на месте: 73 символа, верный
 * префикс, ни одного лишнего пробела. Правили бы ключ, а чинить надо площадку
 * релея. Предупреждение, не разделяющее случаи, отправляет чинить не туда — и
 * отправило.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainOpenRouterFailure } from '@/lib/ai/providers';

const SHAPE_OK = { key_len: 73, key_prefix_ok: true, key_had_outer_space: false, key_has_inner_space: false };
const RELAY = 'vedar-ai-relay.tourhabk.workers.dev';
const DENIED = '{ "success": false, "error": "Access denied by security policy." }';

const base = { route: 'relay' as const, route_host: RELAY, key_shape: SHAPE_OK };

describe('четыре случая названы по-разному', () => {
  it('ключа нет — это настройка, а не сбой', () => {
    const why = explainOpenRouterFailure({
      ...base, key_source: null, http_status: null, detail: '',
      direct_status: null, direct_detail: null,
    });
    expect(why).toMatch(/не задан/);
    expect(why).toMatch(/OPENROUTER_API_KEY/);
  });

  it('форма ключа битая — вставили не то', () => {
    const why = explainOpenRouterFailure({
      ...base, key_source: 'OPENROUTER_API_KEY',
      key_shape: { ...SHAPE_OK, key_prefix_ok: false, key_had_outer_space: true },
      http_status: 401, detail: '', direct_status: null, direct_detail: null,
    });
    expect(why).toMatch(/форма подозрительна/);
    expect(why).toMatch(/префикс не тот/);
    expect(why).toMatch(/пробелы по краям/);
  });

  it('форму не измерили — это «не знаю», а не «всё хорошо»', () => {
    // Молчание здесь читалось бы как ответ, которого у нас нет (§4.0).
    const why = explainOpenRouterFailure({
      ...base, key_source: 'OPENROUTER_API_KEY', key_shape: null,
      http_status: 403, detail: DENIED, direct_status: null, direct_detail: null,
    });
    expect(why).toMatch(/форму проверить не удалось/);
    expect(why).not.toMatch(/цел/);
  });

  it('релей и прямой путь совпали — режет край сети, не ключ', () => {
    // Ровно состояние прода на 24.08. Вывод обязан звать менять площадку
    // релея, а не ключ: ключ тут ни при чём, и время, потраченное на его
    // замену, — это время, за которое ничего не изменится.
    const why = explainOpenRouterFailure({
      ...base, key_source: 'OPENROUTER_API_KEY',
      http_status: 403, detail: DENIED, direct_status: 403, direct_detail: DENIED,
    });
    expect(why).toMatch(/совпали/);
    expect(why).toMatch(/площадку релея/);
    expect(why).toMatch(/а не ключ/);
  });

  it('ответы разные — режет именно путь к релею', () => {
    const why = explainOpenRouterFailure({
      ...base, key_source: 'OPENROUTER_API_KEY',
      http_status: 403, detail: DENIED,
      direct_status: 401, direct_detail: '{"error":{"code":401}}',
    });
    // Подстрокой, а не собранной регуляркой: экранировать точки и забыть про
    // обратный слэш — классическая половинчатая замена, и CodeQL её ловит.
    // Здесь регулярка и не нужна: ищется буквальное имя хоста.
    expect(why).toContain(RELAY);
    expect(why).not.toMatch(/совпали/);
  });
});

describe('предупреждение в здоровье прода пользуется этим', () => {
  const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/health/route.ts'), 'utf-8');
  const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('однословного предупреждения больше нет', () => {
    expect(CODE).not.toMatch(/text: 'OpenRouter недоступен' \}/);
  });

  it('причина берётся из собранной диагностики', () => {
    expect(CODE).toMatch(/explainOpenRouterFailure\(orKeyDiag\)/);
  });

  it('несобранная диагностика названа, а не подменена молчанием', () => {
    expect(CODE).toMatch(/диагностика не собралась/);
  });
});

describe('ключ в текст не попадает', () => {
  it('объяснитель говорит о длине и префиксе, но не о содержимом', () => {
    const secretish = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';
    const why = explainOpenRouterFailure({
      ...base, key_source: 'OPENROUTER_API_KEY',
      http_status: 403, detail: `отказ по ключу`, direct_status: 403, direct_detail: 'отказ по ключу',
    });
    expect(why).not.toContain(secretish);
    expect(why).not.toMatch(/sk-or-/);
  });
});
