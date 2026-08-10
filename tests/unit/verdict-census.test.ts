/**
 * Перепись вердиктов меряет то же, что видит человек.
 *
 * Владелец назвал риск до выката: «не пережестить, а то все маршруты станут
 * красными». Перепись — способ это проверить на всём справочнике, и её
 * единственная ценность в том, что она гоняет ТЕ ЖЕ правила и ТОТ ЖЕ сбор
 * сигналов, что и карточка маршрута. Быстрая пересборка «одним запросом»
 * была бы второй реализацией правил и мерила бы саму себя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const CENSUS = read('lib/routes/verdict-census.ts');
const API = read('app/api/cron/verdict-census/route.ts');

describe('перепись считает теми же правилами, что и экран', () => {
  it('зовёт настоящий сборщик сигналов, а не свой запрос', () => {
    expect(CENSUS).toMatch(/from '@\/lib\/routes\/collect-signals'/);
    expect(CENSUS).toMatch(/collectRouteSignals\(/);
  });

  it('зовёт настоящее ядро вердикта', () => {
    expect(CENSUS).toMatch(/from '@\/lib\/routes\/go-verdict'/);
    expect(CENSUS).toMatch(/goVerdict\(/);
  });

  it('своих порогов не заводит — иначе перепись мерила бы себя', () => {
    expect(CENSUS).not.toMatch(/severity\s*>=?\s*\d/);
    expect(CENSUS).not.toMatch(/'orange'|'red'/);
  });
});

describe('перепись различает незнание и пустоту', () => {
  it('null и пустой список считаются в РАЗНЫЕ счётчики', () => {
    expect(CENSUS).toContain('signal_null');
    expect(CENSUS).toContain('signal_empty');
    // Ветка `else if` — то, что не даёт одному съесть другой.
    expect(CENSUS).toMatch(/alerts === null[\s\S]{0,120}else if[\s\S]{0,80}length === 0/);
    expect(CENSUS).toMatch(/volcanoes === null[\s\S]{0,120}else if[\s\S]{0,80}length === 0/);
  });
});

describe('цифры не приукрашиваются', () => {
  it('ноль маршрутов не даёт ста процентов зелёных', () => {
    expect(CENSUS).toMatch(/routes_counted > 0[\s\S]{0,140}:\s*0/);
  });

  it('урезанный счёт назван, а не спрятан', () => {
    // Молчаливый потолок читается как «посчитали всё».
    expect(CENSUS).toContain('limited_to');
    expect(CENSUS).toContain('routes_total');
    expect(CENSUS).toContain('routes_counted');
  });

  it('перепись ничего не пишет', () => {
    expect(CENSUS).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  });
});

describe('доступ к переписи', () => {
  it('закрыта секретом, как остальные кроны', () => {
    expect(API).toMatch(/getCronSecret\(request\)/);
    expect(API).toMatch(/timingSafeCompare/);
    expect(API).toMatch(/status:\s*401/);
  });

  it('проверка секрета идёт ДО запуска переписи', () => {
    expect(API.indexOf('timingSafeCompare')).toBeLessThan(API.indexOf('runVerdictCensus('));
  });

  it('отказ отдаётся ошибкой, а не пустой переписью', () => {
    // Пустой ответ читался бы как «маршрутов нет».
    expect(API).toMatch(/status:\s*500/);
    expect(API).not.toMatch(/catch[\s\S]{0,120}routes_total:\s*0/);
  });
});
