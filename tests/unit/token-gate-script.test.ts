/**
 * Token gate — измерительная инфраструктура редизайна (условие внешнего
 * ревью, июль 2026): computed styles реальных маршрутов, а не grep по CSS.
 *
 * Скрипт запускается вручную/в приёмке (BASE_URL=... node scripts/token-gate.mjs)
 * и на базовой линии 31.07 честно находит все документированные долги главной:
 * теневой --danger:#C0392B в .v7, параллельный data-v7theme, Unbounded вместо
 * Playfair. Сторож здесь держит СОСТАВ проверок — чтобы при доводке скрипта
 * какая-нибудь из них не выпала молча, и гейт не «позеленел» от потери зубов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'scripts/token-gate.mjs'), 'utf-8');
const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('token gate: состав проверок не редеет', () => {
  it('обязательные маршруты на месте', () => {
    expect(code).toContain("'/', '/map', '/sos'");
    // Именно ВЫЗОВ, не определение: подпись функции содержит ту же подстроку,
    // и сторож без await удовлетворялся бы мёртвой функцией.
    expect(code).toContain('await checkEmergency(');
    expect(code).toContain("'/routes/'");
    expect(code).toContain('"/places/"');
  });

  it('семантические проверки каскада присутствуют', () => {
    // Развод CTA/тревоги
    expect(code).toMatch(/--accent'\] === \w+\.rootResolved\['--danger'\]/);
    // Теневые переопределения на произвольном элементе — то, что grep не ловит
    expect(code).toContain('теневое переопределение токена');
    // Параллельный механизм темы
    expect(code).toContain('data-v7theme');
    // Playfair на display-заголовках
    expect(code).toMatch(/playfair/i);
    // Контраст WCAG
    expect(code).toContain('contrastRatio');
    // Вторая тема переключается настоящим механизмом (атрибут + класс)
    expect(code).toContain("classList.toggle('dark'");
  });

  it('нарушение = ненулевой выход, предупреждение — нет', () => {
    expect(code).toContain('process.exit(1)');
    expect(code).toMatch(/fails\.length/);
  });

  it('мобильный UA: главная выбирает вариант по User-Agent, не по вьюпорту', () => {
    expect(code).toContain('iPhone');
  });

  it('/emergency судится по контракту нулевых зависимостей, не по токенам', () => {
    const em = code.slice(code.indexOf('async function checkEmergency'), code.indexOf('async function discoverLink'));
    expect(em).not.toContain('rootResolved');
    expect(em).toContain('coords-value');
  });
});
