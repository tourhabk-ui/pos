/**
 * «Сплав по реке Быстрая»: доступность не должна быть выдуманной.
 *
 * Повод: миграция 060 засеяла доступность тура через generate_series по
 * КАЖДОМУ дню с 1 июля по 31 октября — 123 дня. Оператор же водит сплавы
 * через день и только по 31 августа: восемнадцать объявленных дат. Турист мог
 * забронировать 29 июля, которого у оператора нет, и узнать об этом после
 * оплаты. Для платформы, которая продаёт доверие, это дороже пустого слота.
 *
 * Тест не ходит в базу. Он сторожит сам текст миграций: generate_series по
 * датам — удобный способ «наполнить календарь», и именно так выдуманная
 * доступность появляется снова.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIR = join(ROOT, 'migrations');

/** Объявленные оператором даты (из его же анонса). */
const ANNOUNCED = [
  '2026-07-28', '2026-07-30',
  '2026-08-01', '2026-08-03', '2026-08-05', '2026-08-07',
  '2026-08-09', '2026-08-11', '2026-08-13', '2026-08-15',
  '2026-08-17', '2026-08-19', '2026-08-21', '2026-08-23',
  '2026-08-25', '2026-08-27', '2026-08-29', '2026-08-31',
];

const FIX = readFileSync(join(DIR, '788_bystraya_tour_honest_dates.sql'), 'utf-8');

/** Только исполняемый SQL: комментарии объясняют решения и цитируют имена
 *  колонок, поэтому проверять по ним — ловить собственные пояснения. */
const FIX_SQL = FIX.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('миграция 788 чинит доступность сплава', () => {
  it('перечисляет ровно объявленные оператором даты', () => {
    for (const d of ANNOUNCED) {
      expect(FIX, `дата ${d} потерялась`).toContain(d);
    }
    // Ни одной даты за пределами анонса: сентябрь и октябрь оператор не заявлял.
    const dates = [...FIX.matchAll(/DATE '(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
    expect([...new Set(dates)].sort()).toEqual([...ANNOUNCED].sort());
  });

  it('не удаляет дни, на которые уже есть брони', () => {
    // Иначе бронь осиротеет: слот исчезнет, а обязательство перед туристом нет.
    expect(FIX).toMatch(/COALESCE\(ta\.booked_slots,\s*0\)\s*=\s*0/);
  });

  it('не публикует тур сама — публикация вынесена в отдельную миграцию', () => {
    // Публикация коммерческого предложения — решение владельца (дано
    // 29.07.2026), и оно живёт в 789 отдельно от починки данных. Порядок
    // существенный: сначала честный календарь, потом витрина.
    expect(FIX_SQL, 'починка данных и публикация смешались в одной миграции')
      .not.toMatch(/is_published/i);
  });

  it('идемпотентна: добор дат идёт через NOT EXISTS', () => {
    expect(FIX).toMatch(/NOT EXISTS/);
  });
});

describe('миграция 789 публикует тур, и только его', () => {
  const PUB = readFileSync(join(DIR, '789_bystraya_tour_publish.sql'), 'utf-8');
  const PUB_SQL = PUB.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  it('номер больше 788: честный календарь приезжает раньше витрины', () => {
    // Иначе на время между миграциями наружу выставится календарь с датами,
    // которых у оператора нет.
    expect(789).toBeGreaterThan(788);
    expect(PUB_SQL).toMatch(/is_published\s*=\s*TRUE/i);
  });

  it('адресована ровно одному туру одного партнёра', () => {
    // Массовая публикация чужих туров одной миграцией — не то, на что
    // владелец дал согласие.
    expect(PUB_SQL).toMatch(/p\.slug\s*=\s*'kamchatka-rafting'/);
    expect(PUB_SQL).toMatch(/СПЛАВ ПО РЕКЕ БЫСТРАЯ/);
  });

  it('не трогает удалённые записи', () => {
    expect(PUB_SQL).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it('идемпотентна: повторный прогон ничего не переписывает', () => {
    expect(PUB_SQL).toMatch(/IS\s+DISTINCT\s+FROM/i);
  });
});

describe('миграция 790 ставит настоящую вместимость', () => {
  const CAP = readFileSync(join(DIR, '790_bystraya_tour_capacity.sql'), 'utf-8');
  const CAP_SQL = CAP.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  it('29 мест и в календаре, и потолком группы', () => {
    // Расхождение между ними означало бы, что календарь предлагает места,
    // на которые форма брони не пустит.
    expect(CAP_SQL).toMatch(/available_slots\s*=\s*29/);
    expect(CAP_SQL).toMatch(/max_participants\s*=\s*29/);
  });

  it('не урезает дату, где набрано больше нового потолка', () => {
    expect(CAP_SQL).toMatch(/COALESCE\(ta\.booked_slots,\s*0\)\s*<=\s*29/);
  });

  it('идемпотентна', () => {
    expect(CAP_SQL).toMatch(/IS\s+DISTINCT\s+FROM\s+29/i);
  });
});

describe('календарь туров не наполняется днями подряд', () => {
  it('диапазон дат всегда чем-то сужается — расписанием, а не «каждый день»', () => {
    // Различие не в generate_series как таковой: 124_open_tour_slots.sql тоже
    // ей пользуется, но отбирает только субботы и воскресенья — это настоящее
    // расписание оператора. Врёт не диапазон, а диапазон БЕЗ отбора: он
    // объявляет, что тур идёт каждый божий день четыре месяца подряд.
    const offenders: string[] = [];
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.sql'))) {
      const sql = readFileSync(join(DIR, f), 'utf-8');
      if (!/INSERT\s+INTO\s+tour_availability/i.test(sql)) continue;
      if (!/generate_series\s*\(\s*'?\d{4}-\d{2}-\d{2}/i.test(sql)) continue;
      // Признак заявленного расписания — отбор по дню недели. Просто наличие
      // WHERE в файле не годится: в 060 он есть, но сужает выбор партнёра, а
      // не дней, и календарь всё равно заполнялся подряд.
      if (!/EXTRACT\s*\(\s*DOW/i.test(sql)) offenders.push(f);
    }
    // 060 — исторический источник проблемы. Текст миграции неизменяем,
    // последствия сняты миграцией 788.
    expect(offenders, 'новая миграция снова заполняет календарь выдуманными днями')
      .toEqual(['060_rafting_tour_kamchatka.sql']);
  });
});

/**
 * Выбор даты: календарь — основной путь, ручной ввод — запасной, запрос один.
 *
 * Проверяем НАМЕРЕНИЕ, а не имена внутренних переменных: прошлая версия этих
 * проверок держалась за `slotsMode === 'loading'` и рассыпалась от первой же
 * переработки компонента, хотя поведение осталось правильным.
 */
describe('поле выбора даты', () => {
  const field = readFileSync(
    join(process.cwd(), 'components/marketplace/TourDateField.tsx'),
    'utf-8',
  );
  const calendar = readFileSync(
    join(process.cwd(), 'components/routes/AvailabilityCalendar.tsx'),
    'utf-8',
  );

  it('слоты грузит только календарь — двойного запроса нет', () => {
    // Раньше поле спрашивало /slots, чтобы решить, рисовать ли календарь, а
    // календарь внутри спрашивал тот же эндпоинт второй раз.
    expect(field).not.toMatch(/fetch\(/);
    expect(calendar).toMatch(/\/slots/);
  });

  it('о пустоте календарь сообщает наверх, а не молчит', () => {
    expect(calendar).toMatch(/onEmpty/);
    expect(field).toMatch(/onEmpty=/);
  });

  it('ручной ввод остаётся доступен: слоты у операторов опциональны', () => {
    expect(field).toMatch(/type="date"/);
    expect(field).toMatch(/Ввести дату вручную/);
  });

  it('во время загрузки — скелетон, а не пустая сетка', () => {
    expect(calendar).toMatch(/ds-skeleton/);
  });
});

/**
 * Календарь: нюансы, из-за которых прежняя версия врала или мешала пальцу.
 */
describe('календарь свободных дат', () => {
  const raw = readFileSync(
    join(process.cwd(), 'components/routes/AvailabilityCalendar.tsx'),
    'utf-8',
  );
  /**
   * Только КОД, без комментариев. В шапке файла перечислены прежние ошибки
   * (`rgba(...)`, `<div onKeyDown>`, `scale-110`) — без этой очистки сторож
   * ловил бы собственное объяснение и запрещал документировать причину.
   */
  const calendar = raw
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('цвета только из токенов — хардкод rgba запрещён (§2)', () => {
    expect(calendar).not.toMatch(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+/);
    expect(calendar).toMatch(/var\(--success\)/);
    expect(calendar).toMatch(/var\(--warning\)/);
  });

  it('тач-цели не меньше 44px — календарём пользуются пальцем на ходу', () => {
    expect(calendar).toMatch(/height: 44/);
    expect(calendar).toMatch(/width: 44/);
  });

  it('за границы доступности листать нельзя', () => {
    // Тур Июн—Сен, а уйти можно было в январь и увидеть пустоту как результат.
    expect(calendar).toMatch(/canPrev/);
    expect(calendar).toMatch(/canNext/);
    expect(calendar).toMatch(/disabled=\{!can/);
  });

  it('открывается на первом месяце, где даты есть', () => {
    expect(calendar).toMatch(/bounds\.first/);
  });

  it('число свободных мест видно в ячейке, а не спрятано в title', () => {
    // На телефоне title не показывается вовсе.
    expect(calendar).not.toMatch(/title=\{/);
    expect(calendar).toMatch(/\{free\}/);
  });

  it('дни — кнопки, а не div с onKeyDown', () => {
    expect(calendar).toMatch(/<button/);
    expect(calendar).not.toMatch(/onKeyDown/);
  });

  it('выбор не растягивает ячейку поверх соседних', () => {
    expect(calendar).not.toMatch(/scale-1\d\d/);
  });

  it('дату обещает не платформа, а оператор', () => {
    expect(calendar).toMatch(/подтвердит дату при бронировании/);
  });
});
