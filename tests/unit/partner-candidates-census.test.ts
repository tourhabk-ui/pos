/**
 * Перепись потенциальных партнёров (#66, фаза 0).
 *
 * Владелец просил агента, который находит небольших операторов. Прежде чем
 * строить агента — цифры: сколько вообще кандидатов и до скольких можно
 * дотянуться. Перепись отвечает на это по двум пулам: официальный реестр без
 * матча и «спящие» свои — заведённые, но не доведённые до витрины.
 *
 * Сторож держит три вещи:
 *  1. Перепись только читает. Роут, который «заодно» что-то правит в partners,
 *     превращает диагностику в мутацию прода по GET-у.
 *  2. Контакты наружу не идут — только флаги наличия. Ответ читается из логов
 *     CI, а у ИП телефон и почта это персональные данные (152-ФЗ).
 *  3. Никаких молчаливых потолков: список режется — рядом счётчик dropped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/cron/partner-candidates-census/route.ts'),
  'utf-8',
);

describe('перепись кандидатов: доступ и безопасность', () => {
  it('закрыта CRON_SECRET со сравнением за постоянное время', () => {
    expect(SRC).toMatch(/getCronSecret\(request\)/);
    expect(SRC).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });

  it('только чтение — ни одной мутации', () => {
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/);
  });
});

describe('персональные данные партнёров', () => {
  it('наружу идут флаги наличия контактов, а не сами контакты', () => {
    expect(SRC).toMatch(/has_phone/);
    expect(SRC).toMatch(/has_email/);
    // Значения контактов в выдачу не попадают: только сравнение на непустоту.
    expect(SRC).not.toMatch(/contacts->>'phone'\s*(AS|,)\s*phone\b/);
    expect(SRC).not.toMatch(/phone:\s*r\./);
    expect(SRC).not.toMatch(/email:\s*r\./);
  });

  it('решение объяснено в ответе, чтобы читатель не искал контакты зря', () => {
    expect(SRC).toMatch(/152-ФЗ/);
  });
});

describe('честность выдачи', () => {
  it('обрезанный список сопровождается счётчиком отброшенных', () => {
    expect((SRC.match(/names_dropped/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('считает оба пула — реестр и спящих своих', () => {
    expect(SRC).toMatch(/registry_pool/);
    expect(SRC).toMatch(/dormant_pool/);
    expect(SRC).toMatch(/matched_partner_id IS NULL/);
    // Профиль владельца: одна-две активности.
    expect(SRC).toMatch(/one_or_two_activities/);
  });
});
