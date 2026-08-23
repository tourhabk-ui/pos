/**
 * Правка «как турист попадает на тур»: сухой прогон по умолчанию, источник и
 * причина без умолчаний, откат в ответе.
 *
 * Те же правила, что у правки координат места, и по той же причине: через
 * месяц «кто сказал» и «почему» восстановить будет неоткуда, а поле это
 * читает покупатель на чужой витрине.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('app/api/cron/tour-pickup/route.ts', 'utf8');

describe('актуатор перевозки — правила разбора тела', () => {
  it('сухой прогон включён по умолчанию: писать надо попросить вслух', () => {
    expect(SRC).toMatch(/dry_run:\s*z\.boolean\(\)\.default\(true\)/);
  });

  it('источник обязателен и без умолчания', () => {
    expect(SRC).toMatch(/source:\s*z\.string\(\)[^\n]*\.min\(3/);
    // .default( рядом с source означал бы приписывание чужих слов
    const src = SRC.slice(SRC.indexOf('source:'), SRC.indexOf('dry_run:'));
    expect(src).not.toContain('.default(');
  });

  it('причина обязательна к КАЖДОЙ правке и без умолчания', () => {
    const item = SRC.slice(SRC.indexOf('const ItemSchema'), SRC.indexOf('const BodySchema'));
    expect(item).toMatch(/why:\s*z\.string\(\)[^\n]*\.min\(3/);
    expect(item).not.toContain('.default(');
  });

  it('пустая строка перевозки не принимается: она неотличима от «не знаем»', () => {
    const item = SRC.slice(SRC.indexOf('const ItemSchema'), SRC.indexOf('const BodySchema'));
    expect(item).toMatch(/pickup:\s*z\.string\(\)\.trim\(\)\.min\(5/);
  });

  it('партия ограничена десятью', () => {
    expect(SRC).toContain('export const LIVE_BATCH_MAX = 10');
    expect(SRC).toMatch(/\.max\(LIVE_BATCH_MAX\)/);
  });
});

describe('актуатор перевозки — что возвращает', () => {
  it('прежнее значение возвращается и в боевом прогоне: это откат', () => {
    const live = SRC.slice(SRC.indexOf("status: 'set'"), SRC.indexOf('const changed'));
    expect(live).toContain('was: tour.meeting_point');
  });

  it('отсутствующий тур — отказ по строке, а не молчаливый пропуск', () => {
    expect(SRC).toContain("status: 'not_found'");
    expect(SRC).toContain("not_found: results.filter");
  });

  it('ноль разобранных при ненулевом входе помечается как бессмысленный прогон', () => {
    expect(SRC).toMatch(/meaningful:\s*results\.some/);
  });

  it('маркер сборки есть и в отказе разбора тела', () => {
    // Урок пробы 107: признак сборки только в удачном ответе делает
    // настоящую ошибку неотличимой от невыкаченного кода.
    const bad = SRC.slice(SRC.indexOf('Тело запроса не разобрано'), SRC.indexOf('const results'));
    expect(bad).toContain("probe: 'tour_pickup_v1'");
  });
});
