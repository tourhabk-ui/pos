/**
 * ПД не уходят в зарубежную модель РЕЗУЛЬТАТОМ ИНСТРУМЕНТА.
 *
 * Находка аудита 08.09: инструмент броней оператора возвращал `res.rows`
 * целиком, а строка брони несёт `tourist_name`, `tourist_email` и свободный
 * текст `special_requests`. Результат инструмента уходит обратно в модель,
 * а модель у нас зарубежная — то есть трансграничная передача ПД (§8, 152-ФЗ).
 *
 * Почему это не поймал гард D1 (`pii-flow-scanner`): он ищет ПД, ВПИСАННЫЕ в
 * текст промпта. Здесь путь другой — ПД приезжают результатом инструмента, и
 * в текст их никто не интерполировал. Дыра не в настройке гарда, а в том,
 * что он смотрит на другую дорогу.
 *
 * Этот сторож закрывает именно вторую дорогу и только для SDK-инструментов:
 * строка БД не отдаётся модели целиком.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactPII } from '@/lib/security/pii-redact';

const SDK_DIR = 'lib/agents/sdk';
const TOOL_FILES = readdirSync(SDK_DIR)
  .filter((f) => f.endsWith('-tools.ts'))
  .map((f) => join(SDK_DIR, f));

describe('SDK-инструменты: строка БД не уходит модели целиком', () => {
  it('файлы инструментов найдены — сторожу есть что сторожить', () => {
    expect(TOOL_FILES.length).toBeGreaterThan(0);
  });

  // Запрет узкий намеренно. Сырой набор строк сам по себе не грех: выборка
  // агрегатов по турам никаких ПД не несёт, и запрещать её значило бы завести
  // правило, которое потом ослабят целиком. Грех — отдать строку выборки,
  // КОТОРАЯ ПД содержит.
  const PII_COLUMNS = [
    'tourist_name', 'tourist_email', 'special_requests',
    'guest_name', 'contact_phone', 'customer_email',
  ];

  for (const file of TOOL_FILES) {
    it(`${file}: строка выборки с ПД не уходит модели целиком`, () => {
      const src = readFileSync(file, 'utf8');
      // Каждый запрос — со своим возвратом: режем файл по вызовам pool.query.
      const chunks = src.split('pool.query').slice(1);
      for (const chunk of chunks) {
        const hasPiiColumn = PII_COLUMNS.some((c) => chunk.includes(c));
        if (!hasPiiColumn) continue;
        const returnsRaw = /JSON\.stringify\([^;]*\b(?:res|result)\.rows(?!\s*\.\s*map)(?!\s*\[)/.test(chunk);
        expect(returnsRaw, `${file}: выборка с ПД отдаётся моделью как есть`).toBe(false);
      }
    });
  }

  it('сторож действительно нашёл выборку с ПД — иначе он охраняет пустоту', () => {
    const src = readFileSync(join(SDK_DIR, 'operator-tools.ts'), 'utf8');
    expect(src).toContain('ob.tourist_email');
  });

  it('инструмент броней отдаёт номер брони, а не имя с почтой', () => {
    const src = readFileSync(join(SDK_DIR, 'operator-tools.ts'), 'utf8');
    expect(src).toContain('function bookingForModel');
    expect(src).toContain('booking_id: r.id');
    // Имя и почта в отдаваемом объекте отсутствуют как значения.
    expect(src).not.toMatch(/\bname: r\.tourist_name\b/);
    expect(src).not.toMatch(/\bemail: r\.tourist_email\b/);
  });

  it('свободный текст пожеланий чистится, а не отдаётся как есть', () => {
    const src = readFileSync(join(SDK_DIR, 'operator-tools.ts'), 'utf8');
    expect(src).toMatch(/special_requests: redactPII\(r\.special_requests\)/);
  });
});

describe('чистка пожеланий работает на том, что туда вписывают', () => {
  it('телефон и почта из свободного текста вырезаются', () => {
    const out = redactPII('Позвоните +7 914 782-33-11 или на ivan.petrov@mail.ru, аллергия на орехи');
    expect(out).not.toContain('9147823311');
    expect(out).not.toContain('@mail.ru');
    // Существенное для безопасности остаётся: аллергию модель обязана видеть.
    expect(out).toContain('аллергия на орехи');
  });

  it('цены и размер группы за телефон не принимаются', () => {
    expect(redactPII('цена 100000, нас 4 человека')).toBe('цена 100000, нас 4 человека');
  });
});
