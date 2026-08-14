/**
 * Задержку сейсмо-канала стало видно.
 *
 * Путей два, и они разные. USGS и МЧС сервер тянет сам, вовремя. КБГС и EQKam
 * живут в Telegram, а `t.me` для хостинга гео-закрыт — их приносит GitHub
 * Actions, у которого пятиминутное расписание на практике даёт разрывы в 40–60
 * минут.
 *
 * Измерения этой задержки не было ВООБЩЕ. `checkSeismicCronDead` меряет любой
 * прогон safety-ingest, а его каждые пять минут удовлетворяет heartbeat из
 * start.js — сторож смотрел на путь, который работает, и потому был слеп к
 * пути, который опаздывает. Про задержку узнали 14.08 случайно, разбирая
 * другой сбой.
 *
 * Два уровня выбраны по цене ошибки, а не по громкости: расписание GitHub
 * владелец починить не может (КРИТ на него был бы красным, которое не гаснет
 * работой — этот урок уже стоил вечного push_undelivered), а остановка
 * воркфлоу чинится.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  seismicWorkflowDelayIssue,
  SEISMIC_WORKFLOW_WARN_MIN,
  SEISMIC_WORKFLOW_CRIT_MIN,
} from '@/lib/agents/watchdog';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');
const INGEST = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');

describe('уровень по цене ошибки', () => {
  it('свежая доставка — молчим', () => {
    expect(seismicWorkflowDelayIssue(12, 10_000)).toBeNull();
  });

  it('задержка расписания — ВНИМАНИЕ, не КРИТ', () => {
    // Нашими силами не чинится. КРИТ здесь приучал бы пролистывать красное.
    const a = seismicWorkflowDelayIssue(SEISMIC_WORKFLOW_WARN_MIN + 5, 10_000);
    expect(a?.critical).toBe(false);
    expect(a?.details).toContain('отстаёт');
  });

  it('канал встал — КРИТ: это чинится', () => {
    const a = seismicWorkflowDelayIssue(SEISMIC_WORKFLOW_CRIT_MIN + 5, 10_000);
    expect(a?.critical).toBe(true);
    expect(a?.details).toContain('воркфлоу');
  });

  it('алерт говорит, что напрямую идёт и не затронуто', () => {
    // Иначе «сейсмо-канал молчит» читается как «мы слепы к землетрясениям», а
    // это неправда: M5+ приходят от USGS напрямую.
    const a = seismicWorkflowDelayIssue(SEISMIC_WORKFLOW_CRIT_MIN + 5, 10_000);
    expect(a?.details).toMatch(/USGS/);
  });
});

describe('пустой журнал — не повод для тревоги', () => {
  it('доставок нет, но наблюдаем недолго — молчим', () => {
    // Сразу после выката строк с trigger ещё нет. Алерт здесь был бы ложной
    // тревогой на пустом месте — та же осторожность, что в evaluateDeadSources.
    expect(seismicWorkflowDelayIssue(null, 30)).toBeNull();
    expect(seismicWorkflowDelayIssue(null, SEISMIC_WORKFLOW_CRIT_MIN)).toBeNull();
  });

  it('доставок нет и наблюдаем давно — КРИТ', () => {
    const a = seismicWorkflowDelayIssue(null, SEISMIC_WORKFLOW_CRIT_MIN + 60);
    expect(a?.critical).toBe(true);
    expect(a?.details).toContain('НИ РАЗУ');
  });
});

describe('различать GET и POST стало возможно', () => {
  it('heartbeat помечает, кто отработал', () => {
    // Без метки строки журнала одинаковы, и вопрос «когда воркфлоу последний
    // раз доставил» неотвечаем в принципе.
    expect(INGEST).toMatch(/trigger\s*\}\)\]/);
    expect(INGEST).toMatch(/pushResult\.dispatched, 'heartbeat_get'\)/);
    expect(INGEST).toMatch(/pushResult\.dispatched, 'workflow_post'\)/);
  });

  it('тип метки берётся из общего IngestTrigger, а не заводится свой', () => {
    expect(INGEST).toMatch(/trigger: IngestTrigger/);
  });

  it('проверка ищет именно доставку воркфлоу', () => {
    expect(SRC).toMatch(/metadata->>'trigger' = 'workflow_post'/);
  });
});

describe('здоровье telegram-каналов принадлежит тому, кто их приносит', () => {
  it('heartbeat не пишет kbgsras и eqkam', () => {
    // t.me для хостинга гео-закрыт: heartbeat не может их получить по
    // построению, а его запись «пусто» каждые пять минут делала канал вечно
    // свежим на вид независимо от того, доставил воркфлоу или нет.
    const getBody = INGEST.slice(INGEST.indexOf("'heartbeat_get')"), INGEST.indexOf('const HtmlBodySchema'));
    expect(getBody).not.toMatch(/entryFor\('kbgsras'/);
    expect(getBody).not.toMatch(/entryFor\('eqkam'/);
  });

  it('POST их пишет — он их и приносит', () => {
    const postBody = INGEST.slice(INGEST.indexOf('const HtmlBodySchema'));
    expect(postBody).toMatch(/entryFor\('kbgsras'/);
    expect(postBody).toMatch(/entryFor\('eqkam'/);
  });
});

describe('цифру видно без алерта', () => {
  it('возраст доставки есть в ответе роута', () => {
    // Чтобы задержку можно было ПОСМОТРЕТЬ, а не ждать, пока она перевалит
    // порог. Состояний три и они не схлопнуты: поля нет — путь его не меряет
    // (POST сам и есть доставка); null — доставок в журнале нет; число —
    // возраст. Схлопнуть null и «нет поля» значило бы повторить ту самую
    // подмену, ради которой правка и делалась.
    expect(INGEST).toMatch(/telegram_seismic_age_min/);
  });
});

describe('поле возраста действительно заполняется', () => {
  it('GET считает возраст и передаёт его в ответ', () => {
    // Поле, объявленное но никем не заполняемое, вечно отдавало бы null —
    // то есть «доставок не было никогда». Ровно тот класс подмены, против
    // которого вся эта правка и затеяна; поймано в собственном коде.
    expect(INGEST).toMatch(/async function telegramSeismicAgeMin\(\)/);
    expect(INGEST).toMatch(/telegramSeismicAgeMin: await telegramSeismicAgeMin\(\)/);
  });

  it('в ответе три состояния различимы, а не два', () => {
    // Поле не форсится в null: отсутствует — путь его не меряет (POST сам и
    // есть доставка); null — доставок в журнале нет; число — возраст.
    expect(INGEST).toMatch(/telegram_seismic_age_min: extras\?\.telegramSeismicAgeMin,/);
    expect(INGEST).not.toMatch(/telegramSeismicAgeMin \?\? null/);
  });
});
