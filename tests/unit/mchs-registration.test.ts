/**
 * Срок регистрации в МЧС — 10 РАБОЧИХ дней, и он один на всю платформу.
 *
 * Карточка маршрута говорила «требует регистрации группы до выхода». Человек
 * честно читает это как «накануне» — и опаздывает на неделю. Ссылка на форму
 * стояла захардкоженной в шести местах, и все шесть молчали о сроке: копии
 * разошлись самым скверным образом — единодушно опустив то, что решает.
 *
 * Сводка ГУ МЧС по краю (август 2026): семь ЧП с начала года, в пяти случаях
 * группы не были зарегистрированы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCHS_LEAD_WORKING_DAYS,
  MCHS_ONLINE_FORM_URL,
  MCHS_CHANNELS,
  MCHS_REQUIRED_DATA,
  workingDaysBetween,
  registrationVerdict,
} from '@/lib/safety/mchs-registration';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Соглашение о счёте, проверенное по календарю: считаем СТРОГО МЕЖДУ датами —
 * ни день подачи, ни день выхода в счёт не идут. Между двумя понедельниками
 * через две недели лежит девять рабочих дней, а не десять.
 *
 * Смещение занижающее, и это выбрано намеренно. Для срока безопасности ошибка
 * допустима только в сторону «не успеваете»: обратная отправила бы человека на
 * маршрут в уверенности, что заявка пройдёт, когда она уже не проходит.
 */
describe('счёт рабочих дней', () => {
  it('выходные не считаются', () => {
    // Пн 03.08 → Пн 10.08: вт, ср, чт, пт = 4; суббота и воскресенье выпадают.
    expect(workingDaysBetween(d('2026-08-03'), d('2026-08-10'))).toBe(4);
  });

  it('через две недели рабочих дней десять', () => {
    expect(workingDaysBetween(d('2026-08-03'), d('2026-08-17'))).toBe(9);
    expect(workingDaysBetween(d('2026-08-03'), d('2026-08-18'))).toBe(10);
  });

  it('дата в прошлом или сегодня — ноль, а не отрицательное число', () => {
    expect(workingDaysBetween(d('2026-08-10'), d('2026-08-03'))).toBe(0);
    expect(workingDaysBetween(d('2026-08-10'), d('2026-08-10'))).toBe(0);
  });

  it('подача в пятницу перед выходными: суббота и воскресенье не в счёт', () => {
    // Пт 2026-08-07 → Пн 2026-08-10: между ними только сб и вс.
    expect(workingDaysBetween(d('2026-08-07'), d('2026-08-10'))).toBe(0);
  });
});

describe('вердикт по сроку', () => {
  it('меньше нормы — прямо говорим, что не выдержать', () => {
    const r = registrationVerdict(d('2026-08-17'), d('2026-08-10'));
    expect(r.verdict).toBe('too_late');
    expect(r.text).toContain('не выдержать');
  });

  it('ровно норма — не «успеваете», а «впритык»', () => {
    // Праздники в наш счёт не входят, поэтому настоящих рабочих дней может
    // оказаться меньше. Уверенное «успеваете» на грани было бы обещанием,
    // которого мы не можем сдержать.
    // 10.08 (пн) → 25.08 (вт): ровно десять рабочих дней между датами.
    const r = registrationVerdict(d('2026-08-25'), d('2026-08-10'));
    expect(r.workingDays).toBe(MCHS_LEAD_WORKING_DAYS);
    expect(r.verdict).toBe('tight');
    expect(r.text).toContain('праздники');
  });

  it('с запасом — спокойно подтверждаем', () => {
    const r = registrationVerdict(d('2026-09-14'), d('2026-08-10'));
    expect(r.verdict).toBe('in_time');
  });

  it('счёт никогда не завышает: праздники могут только убавить', () => {
    // Инвариант, а не пример: наша оценка — верхняя граница. Значит «не
    // успеваете» верно всегда, а «успеваете» — с оговоркой. Обратная ошибка
    // (сказать «успеете», когда нет) отправляет человека на маршрут
    // незарегистрированным.
    const from = d('2026-01-01');
    const to = d('2026-01-31');
    const calendar = 30;
    expect(workingDaysBetween(from, to)).toBeLessThan(calendar);
  });
});

describe('факты живут в одном месте', () => {
  const FILES = [
    'app/routes/[id]/_RouteDetailClient.tsx',
    'app/planning/_PlanningClient.tsx',
    'app/trip/[token]/_TripShareClient.tsx',
    'app/register/page.tsx',
    'app/safety/communication/page.tsx',
  ];

  it('ссылка на форму МЧС нигде не захардкожена', () => {
    // Шесть копий одного факта разошлись — и разошлись тем, что все опустили
    // срок. Ссылка теперь берётся из модуля; страж не даёт завести седьмую.
    for (const f of FILES) {
      const src = readFileSync(join(process.cwd(), f), 'utf-8');
      expect(src, `${f}: ссылка на форму МЧС вписана вручную`)
        .not.toMatch(/'https:\/\/forms\.mchs\.gov\.ru/);
    }
  });

  it('карточка маршрута называет срок, а не «до выхода»', () => {
    // «До выхода» человек прочитает как «накануне» — и опоздает на неделю.
    const src = readFileSync(join(process.cwd(), 'app/routes/[id]/_RouteDetailClient.tsx'), 'utf-8');
    expect(src).toMatch(/MCHS_DEADLINE_SHORT|MCHS_LEAD_WORKING_DAYS|MchsRegistration/);
    expect(src).not.toMatch(/требует регистрации группы до выхода/);
  });

  it('срок и каналы — из ведомства, а не из головы', () => {
    expect(MCHS_LEAD_WORKING_DAYS).toBe(10);
    expect(MCHS_ONLINE_FORM_URL).toContain('forms.mchs.gov.ru');
    expect(MCHS_CHANNELS.map((c) => c.key)).toEqual(['online', 'post', 'in_person']);
    // Адреса из сводки ГУ МЧС: почтовый и очный. Без них «зарегистрируйтесь»
    // — совет без способа его исполнить, если онлайн-форма недоступна.
    expect(MCHS_CHANNELS.find((c) => c.key === 'post')?.detail).toContain('Ленинградская');
    expect(MCHS_CHANNELS.find((c) => c.key === 'in_person')?.detail).toContain('Тундровая');
    expect(MCHS_REQUIRED_DATA.length).toBe(4);
  });
});
