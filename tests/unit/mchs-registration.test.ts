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
  MCHS_AFTER_RETURN,
  MCHS_PHONES,
  MCHS_RETURN_PHONE_UNKNOWN,
  MCHS_SOURCE,
  RU_FIXED_HOLIDAYS,
  workingDaysBetween,
  registrationVerdict,
} from '@/lib/safety/mchs-registration';
import { VERIFIED_REFERENCE, VERIFIED_REGIONAL } from '@/lib/safety/emergency-numbers';

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

/**
 * Праздники ст. 112 ТК РФ (с 10.11). До этого дня их не считали вовсе, и в
 * январе счёт завышал срок на неделю: «до выхода 8 раб. дн.», когда рабочих
 * было два. Переносы выходных постановлением Правительства по-прежнему не
 * учтены — для них остаётся исход «впритык».
 */
describe('праздники ст. 112 ТК РФ', () => {
  it('новогодние каникулы — нерабочие', () => {
    // Ср 30.12.2026 → Вт 12.01.2027: рабочие только 31.12 и 11.01.
    expect(workingDaysBetween(d('2026-12-30'), d('2027-01-12'))).toBe(2);
  });

  it('праздник в будний день выпадает', () => {
    // 12.06.2026 — пятница: между ср 10.06 и пн 15.06 рабочий только чт 11.06.
    expect(workingDaysBetween(d('2026-06-10'), d('2026-06-15'))).toBe(1);
    // 04.11.2026 — среда: между пн 02.11 и пт 06.11 — вт и чт.
    expect(workingDaysBetween(d('2026-11-02'), d('2026-11-06'))).toBe(2);
  });

  it('список — ровно даты статьи, без лишних', () => {
    expect([...RU_FIXED_HOLIDAYS].sort()).toEqual([
      '01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08',
      '02-23', '03-08', '05-01', '05-09', '06-12', '11-04',
    ]);
  });

  it('январский выход: прежний счёт сказал бы «успеваете», правда — «не выдержать»', () => {
    // Подача 22.12.2026 (вт), выход 12.01.2027 (вт). Без праздников между
    // ними 14 будних дней — «в срок». С праздниками — 8.
    const r = registrationVerdict(d('2027-01-12'), d('2026-12-22'));
    expect(r.workingDays).toBe(8);
    expect(r.verdict).toBe('too_late');
  });
});

describe('вердикт по сроку', () => {
  it('меньше нормы — прямо говорим, что не выдержать', () => {
    const r = registrationVerdict(d('2026-08-17'), d('2026-08-10'));
    expect(r.verdict).toBe('too_late');
    expect(r.text).toContain('не выдержать');
  });

  it('ровно норма — не «успеваете», а «впритык»', () => {
    // Переносы выходных в наш счёт не входят, поэтому настоящих рабочих дней
    // может оказаться меньше. Уверенное «успеваете» на грани было бы обещанием,
    // которого мы не можем сдержать.
    // 10.08 (пн) → 25.08 (вт): ровно десять рабочих дней между датами.
    const r = registrationVerdict(d('2026-08-25'), d('2026-08-10'));
    expect(r.workingDays).toBe(MCHS_LEAD_WORKING_DAYS);
    expect(r.verdict).toBe('tight');
    expect(r.text).toContain('переносы выходных');
  });

  it('с запасом — спокойно подтверждаем', () => {
    const r = registrationVerdict(d('2026-09-14'), d('2026-08-10'));
    expect(r.verdict).toBe('in_time');
  });

  it('граница запаса: двенадцать рабочих дней — ещё «впритык», тринадцать — «в срок»', () => {
    // Запас в три дня покрывает переносы выходных. Сдвинь его кто-нибудь —
    // «успеваете» прозвучит там, где дней может не хватить (ревью PR 3188).
    const twelve = registrationVerdict(d('2026-08-27'), d('2026-08-10'));
    expect(twelve.workingDays).toBe(MCHS_LEAD_WORKING_DAYS + 2);
    expect(twelve.verdict).toBe('tight');
    const thirteen = registrationVerdict(d('2026-08-28'), d('2026-08-10'));
    expect(thirteen.workingDays).toBe(MCHS_LEAD_WORKING_DAYS + 3);
    expect(thirteen.verdict).toBe('in_time');
    // Нижняя граница: девять — уже «не выдержать».
    const nine = registrationVerdict(d('2026-08-24'), d('2026-08-10'));
    expect(nine.workingDays).toBe(MCHS_LEAD_WORKING_DAYS - 1);
    expect(nine.verdict).toBe('too_late');
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
  });
});

/**
 * Памятка ГУ МЧС по Камчатскому краю «Регистрация туристических групп»
 * (MCHS_SOURCE.memoUrl), сверено 10.11. Прежний список был короче бланка:
 * турист, заполнивший форму по нему, не знал о двух контактных лицах вне
 * похода, координатах контрольных точек и согласиях на ПД.
 */
describe('памятка — по бланку ГУ', () => {
  it('источник назван: файл на сайте ГУ по краю', () => {
    expect(MCHS_SOURCE.memoUrl).toMatch(/^https:\/\/41\.mchs\.gov\.ru\//);
  });

  it('состав сведений — все пункты бланка', () => {
    const all = MCHS_REQUIRED_DATA.join(' | ');
    for (const item of ['год рождения', 'двух контактных лиц', 'координатами контрольных точек',
      'сеансов связи', 'первой помощи', 'передвижения', 'обработку персональных данных']) {
      expect(all, item).toContain(item);
    }
  });

  it('состав сведений называет протяжённость маршрута (пункт бланка, ревью PR 3188)', () => {
    expect(MCHS_REQUIRED_DATA.find((d) => d.startsWith('Маршрут'))).toContain('протяжённость');
  });

  it('снятие с контроля после возвращения названо — со ссылкой на памятку, а не командой от Ведара', () => {
    expect(MCHS_AFTER_RETURN).toMatch(/сообщите в МЧС, что маршрут завершён/);
    expect(MCHS_AFTER_RETURN).toContain('памятка ГУ МЧС по краю просит позвонить в ЦУКС');
    // Правило приказа № 270 в текст для туриста не вписано: до сверки юриста его там нет.
    expect(MCHS_AFTER_RETURN).not.toMatch(/способом из вашей заявки|приказ/i);
    expect(MCHS_RETURN_PHONE_UNKNOWN).toContain('Ведар не сверял');
    expect(MCHS_AFTER_RETURN).toContain('могут начать искать');
    // Номера во фразе нет: какой телефон принимает сообщение о возвращении, не сверено.
    expect(MCHS_AFTER_RETURN).not.toMatch(/\d{2}-\d{2}-\d{2}/);
  });

  it('дата сведений — дата памятки, а не дня, когда её читали', () => {
    expect(MCHS_SOURCE.asOf).toContain('13.06.2024');
    expect(MCHS_SOURCE.asOf).not.toMatch(/2026/);
  });
});

/**
 * Региональный номер попадает на экран только из реестра проверенных
 * (lib/safety/emergency-numbers): его сверяет владелец, а не документ. Первая
 * редакция памятки принесла литералом «30-10-82 — происшествие на маршруте»,
 * которого в реестре нет и который отличается от проверенного одной цифрой
 * (ревью PR 3188). Сравнение — с реестром, а не со списком в тесте: новый
 * номер появится здесь, когда появится там.
 */
describe('телефоны МЧС — только из реестра проверенных', () => {
  const digits = (p: string) => p.replace(/\D/g, '').replace(/^[78](?=\d{10}$)/, '');
  const verified = [...VERIFIED_REFERENCE, ...VERIFIED_REGIONAL];

  it('каждый номер памятки есть в реестре, и назначение — слово в слово оттуда', () => {
    expect(MCHS_PHONES.length).toBeGreaterThan(0);
    for (const p of MCHS_PHONES) {
      const known = verified.find((v) => digits(v.phone) === digits(p.phone));
      expect(known, `${p.phone} нет в реестре проверенных номеров`).toBeDefined();
      expect(p.purpose).toBe(known?.name);
    }
  });

  it('несверенного 30-10-82 нет ни в памятке, ни в текстах слоя МЧС', () => {
    expect(MCHS_PHONES.map((p) => digits(p.phone))).not.toContain('4152301082');
    for (const f of ['lib/safety/mchs-registration.ts', 'lib/safety/mchs-chat.ts', 'lib/safety/mchs-form-text.ts',
      'lib/safety/mchs-letter-text.ts', 'components/safety/MchsRegistrationBlock.tsx', 'app/prepare/page.tsx']) {
      const code = readFileSync(join(process.cwd(), f), 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/30[-\s]?10[-\s]?82/);
    }
  });

  it('консультации по маршрутному листу — справочная линия ЦУКС, она в списке первой', () => {
    expect(MCHS_PHONES[0]).toEqual({ phone: VERIFIED_REFERENCE[0]!.phone, purpose: VERIFIED_REFERENCE[0]!.name, kind: 'reference' });
    // Род номера — из реестра: справочные и дежурные не склеиваются в один список.
    expect(MCHS_PHONES.filter((p) => p.kind === 'reference').map((p) => p.phone)).toEqual(VERIFIED_REFERENCE.map((n) => n.phone));
    expect(MCHS_PHONES.filter((p) => p.kind === 'duty').map((p) => p.phone)).toEqual(VERIFIED_REGIONAL.map((n) => n.phone));
  });
});
