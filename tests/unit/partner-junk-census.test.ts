/**
 * Перепись мусорных партнёров — только чтение и одно правило на всех.
 *
 * Повод: карточка «В031-00161-77/01529555» в админке (реестровый номер вместо
 * названия). Разбор починен, но сохранённые записи остались, и удалять их
 * можно только зная, к чему они привязаны.
 *
 * Сторож держит три вещи, каждая из которых уже подводила нас сегодня:
 *  1. Правило имени — ОДНО: перепись зовёт функцию импортёра. Своя проверка
 *     здесь повторила бы ровно ту ошибку, из-за которой мусор и появился.
 *  2. Перепись НИЧЕГО не удаляет: список кандидатов и удаление — разные шаги,
 *     и между ними стоит человек.
 *  3. Контакты наружу не идут: ответ читают в логах Actions (152-ФЗ).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/partner-junk-census/route.ts'), 'utf-8');

describe('перепись мусорных партнёров', () => {
  it('судит правилом импортёра, а не своим', () => {
    expect(SRC).toMatch(/import \{ isValidOperatorName \}/);
    expect(SRC).toMatch(/isValidOperatorName\(/);
  });

  it('ничего не удаляет и не меняет', () => {
    expect(SRC).not.toMatch(/\b(DELETE|UPDATE|INSERT)\b/);
  });

  it('закрыта CRON_SECRET со сравнением за постоянное время', () => {
    expect(SRC).toMatch(/getCronSecret\(request\)/);
    expect(SRC).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });

  it('контакты наружу не отдаются', () => {
    // Телефон и почта партнёра — персональные данные, а ответ уходит в лог.
    const out = SRC.slice(SRC.indexOf('const strip'));
    for (const field of ['phone', 'email', 'contact']) {
      expect(out, `${field} не должен уходить наружу`).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('привязанное отделено от бесхозного по ЧЕТЫРЁМ признакам', () => {
    // Партнёр с турами, бронями, живым входом в кабинет или аттестациями —
    // не мусор, чем бы ни было его имя. Аттестации гида особенно: это
    // собранные данные, и каскад при удалении партнёра снёс бы их молча.
    for (const link of ['tours', 'bookings', 'has_user', 'certifications']) {
      expect(SRC, `признак ${link} не учтён`).toMatch(new RegExp(`r\\.${link}`));
    }
    expect(SRC).toMatch(/orphan/);
    expect(SRC).toMatch(/linked/);
  });

  it('туры считаются отдельно от прочих связей', () => {
    // Владелец сказал «два партнёра с турами, остальное мусор». Список с
    // турами должен приходить целиком и отдельно — по нему сверяется цифра.
    expect(SRC).toMatch(/with_tours_count/);
    expect(SRC).toMatch(/with_tours:/);
  });

  it('видно разбиение по категориям', () => {
    // 112 гидов и 13 операторов — разные вещи, и «остальное» не должно
    // сливать их в одну кучу.
    expect(SRC).toMatch(/by_category/);
  });

  it('третий исход: не смог посчитать — это не «мусора нет»', () => {
    expect(SRC).toMatch(/ok: false/);
    expect(SRC).toMatch(/console\.error/);
  });
});
