/**
 * Четыре записи 04.10, которые стояли на главной и в MCP действующими
 * тревогами, не будучи ими (prod-check run 89, скрин владельца 04.10 15:03):
 *
 *   425878 weather/2 — «Так, 12 января 2026 года мощный охотоморский циклон
 *          обрушился на Камчатку…» — очерк ко Дню гражданской обороны; пуш
 *          ушёл, 228 мест Авачинской группы пожелтели;
 *   425877 flood/1   — «Спасатели участвуют в противопаводковых мероприятиях…»
 *          — описание профессии из того же очерка;
 *   425808 flood/1   — «Экстренное предупреждение … прекратило свое действие»;
 *   425491 flood/1   — «Прогнозировался подъем уровней воды…».
 *
 * И соседи, которых правило задевать НЕ должно: действующее ограничение с
 * прошлой датой начала, прогноз в настоящем, отрицание, свежее событие.
 */
import { describe, it, expect } from 'vitest';
import { classifyMchsItem, isRetrospectivePost, isServiceDuties } from '@/lib/services/safety/seismic-parser';
import { isPastForecast, isResolutionNotice, isWarningEnded } from '@/lib/safety/resolution-notice';
import { rejectedGenre, pruneRejectedGenres, type QueryFn } from '@/lib/services/safety/alert-prune';

const PUB = new Date('2026-10-04T02:53:00Z');
const PUB_S = PUB.toUTCString();

const JANUARY_TITLE = 'Так, 12 января 2026 года мощный охотоморский циклон обрушился на Камчатку, вызвав рекордные снегопады, сильный ветер и непроходимые дороги';
const JANUARY_BODY = `${JANUARY_TITLE}. В Петропавловске-Камчатском был введён режим ЧС. Пока коммунальщики расчищали снежные завалы, спасатели помогали медицинским работникам и горожанам справляться с последствиями стихии.`;
const DUTIES_TITLE = 'Спасатели участвуют в противопаводковых мероприятиях, тушении природных пожаров, ликвидации последствий мощных циклонов';
const DUTIES_BODY = `${DUTIES_TITLE}. Проводят аварийно-спасательные работы, например, после крушения самолёта или вертолётов, при поисках людей в горах или на воде.`;
const ENDED = 'Экстренное предупреждение по возможному подъёму уровней воды на реках южной половины края прекратило свое действие';
const PAST_FORECAST = 'Прогнозировался подъем уровней воды на реках южной половины края';

const classify = (title: string, body = title) => classifyMchsItem('t', title, body, PUB_S, 'https://x');

describe('записи 04.10 — не тревоги', () => {
  it('очерк о январском циклоне не становится погодой', () => {
    expect(isRetrospectivePost(JANUARY_BODY, PUB)).toBe(true);
    expect(classify(JANUARY_TITLE, JANUARY_BODY)).toBeNull();
  });

  it('описание работы спасателей не становится паводком', () => {
    expect(isServiceDuties(DUTIES_BODY)).toBe(true);
    expect(classify(DUTIES_TITLE, DUTIES_BODY)).toBeNull();
  });

  it('предупреждение, объявившее о своём окончании, — не паводок', () => {
    expect(isWarningEnded(ENDED)).toBe(true);
    expect(isResolutionNotice(ENDED)).toBe(true);
    expect(classify(ENDED, `${ENDED}.`)).toBeNull();
    // Те же слова другим порядком; шаблон сверен с PostgreSQL (~*) 04.10 —
    // ответы совпали на всех шести фразах этого файла.
    expect(isWarningEnded('Действие штормового предупреждения прекращено')).toBe(true);
    expect(isWarningEnded('Прекращено действие экстренного предупреждения')).toBe(true);
  });

  it('прогноз в прошедшем времени — не паводок', () => {
    expect(isPastForecast(PAST_FORECAST, `${PAST_FORECAST}.`)).toBe(true);
    expect(classify(PAST_FORECAST, `${PAST_FORECAST}.`)).toBeNull();
  });
});

describe('соседи остаются тревогами', () => {
  it('действующий прогноз паводка', () => {
    const t = 'Прогнозируется подъем уровней воды на реках южной половины края';
    expect(isPastForecast(t)).toBe(false);
    expect(classify(t, `${t}. Прогноз действует до 5 октября включительно.`)?.alert_type).toBe('flood');
  });

  it('«противопаводковые мероприятия» без паводка — не паводок', () => {
    expect(classify('Администрация Елизовского округа провела противопаводковые мероприятия на реке Авача')?.alert_type).not.toBe('flood');
  });

  it('паводок рядом с противопаводковыми мероприятиями — паводок', () => {
    const t = 'В связи с паводком на реке Авача проводятся противопаводковые мероприятия';
    expect(classify(t)?.alert_type).toBe('flood');
  });

  it('отрицание окончания — действующее предупреждение', () => {
    const t = 'Экстренное предупреждение о подъёме уровней воды на реках не прекратило свое действие';
    expect(isWarningEnded(t)).toBe(false);
    expect(classify(t)?.alert_type).toBe('flood');
  });

  it('«как и прогнозировалось» и прогноз в прошедшем рядом с настоящим — не прошедший прогноз', () => {
    expect(isPastForecast('Как и прогнозировалось, уровень воды на реках продолжает расти')).toBe(false);
    expect(isPastForecast('Прогнозировался подъём воды, уровень продолжает расти')).toBe(false);
  });

  it('прошлая дата начала действующего ограничения — не рассказ', () => {
    const t = 'Вилючинский перевал: с 15 июля проезд строго по пропускам';
    expect(isRetrospectivePost(t, PUB)).toBe(false);
  });

  it('режим, введённый давно и действующий сейчас, — не рассказ', () => {
    expect(isRetrospectivePost('20 августа в крае был введён режим ЧС в связи с паводком. Режим сохраняется', PUB)).toBe(false);
  });

  it('свежее событие с датой — не рассказ', () => {
    expect(isRetrospectivePost('2 октября произошло землетрясение магнитудой 6,2', PUB)).toBe(false);
  });

  it('рассказ с взглядом вперёд — предупреждение', () => {
    const t = '12 января 2026 года циклон обрушился на Камчатку. Ожидается повторение: не рекомендуется выход в горы';
    expect(isRetrospectivePost(t, PUB)).toBe(false);
  });

  it('рассказ о прошлогоднем событии без года — рассказ', () => {
    expect(isRetrospectivePost('12 января циклон обрушился на Камчатку', PUB)).toBe(true);
    // Опубликовано 20 января: восемь дней назад — свежее событие, не рассказ.
    expect(isRetrospectivePost('12 января циклон обрушился на Камчатку', new Date('2026-01-20T00:00:00Z'))).toBe(false);
  });

  it('служба, которая проводит работы сейчас и предупреждает, — не описание профессии', () => {
    expect(isServiceDuties('Спасатели участвуют в поисках; туристам не рекомендуется выходить на маршрут')).toBe(false);
  });
});

describe('чистка снимает уже лежащее тем же правилом', () => {
  it('жанры названы', () => {
    expect(rejectedGenre(JANUARY_TITLE, JANUARY_BODY, PUB)).toBe('retrospective');
    expect(rejectedGenre(DUTIES_TITLE, DUTIES_BODY)).toBe('service_duties');
    expect(rejectedGenre(ENDED, `${ENDED}.`)).toBe('warning_ended');
    expect(rejectedGenre(PAST_FORECAST, `${PAST_FORECAST}.`)).toBe('past_forecast');
  });

  it('без даты публикации ретроспективу не судим — «не знаю», а не «рассказ»', () => {
    expect(rejectedGenre(JANUARY_TITLE, JANUARY_BODY, null)).toBeNull();
  });

  it('pruneRejectedGenres удаляет записи 04.10 и оставляет действующий прогноз', async () => {
    const deleted: string[][] = [];
    const q: QueryFn = async <T,>(sql: string, params: unknown[]) => {
      if (sql.includes('SELECT id::text')) {
        return { rows: [
          { id: '425878', title: JANUARY_TITLE, description: JANUARY_BODY, created_at: PUB },
          { id: '425877', title: DUTIES_TITLE, description: DUTIES_BODY, created_at: PUB },
          { id: '425808', title: ENDED, description: `${ENDED}.`, created_at: PUB },
          { id: '425491', title: PAST_FORECAST, description: `${PAST_FORECAST}.`, created_at: PUB },
          { id: '425162', title: 'Прогнозируется подъем уровней воды на реках южной половины края', description: 'Прогноз действует до 5 октября включительно.', created_at: PUB },
        ] as unknown as T[] };
      }
      if (sql.startsWith('DELETE')) deleted.push(params[0] as string[]);
      return { rows: [] as T[] };
    };
    const r = await pruneRejectedGenres(q);
    expect(deleted[0]?.sort()).toEqual(['425491', '425808', '425877', '425878']);
    expect(r.by_genre).toMatchObject({ retrospective: 1, service_duties: 1, warning_ended: 1, past_forecast: 1 });
  });
});
