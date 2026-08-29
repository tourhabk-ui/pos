/**
 * Сторож: два пути доставки сейсмо-каналов дают ОДИНАКОВЫЕ посты.
 *
 * ── Зачем ────────────────────────────────────────────────────────────────
 *
 * Страницы t.me приносит раннер GitHub (воркфлоу cron-safety-ingest) и — с
 * 30.08 — воркер Cloudflare (infra/safety-relay). Раннер оставлен намеренно:
 * он независимая конечность на случай, если воркер встанет.
 *
 * Два пути безопасны ровно до тех пор, пока приёмник видит в их посылках
 * ОДНО И ТО ЖЕ. Дедуп постов MAX держится на id вида
 * `max/<первые 16 hex от SHA-1 строки>`; разойдись извлечение хоть в пороге
 * длины строки, хоть в длине хвоста хеша — и один и тот же пост приедет
 * дважды под разными именами. В канале МЧС это значит два наряда по одному
 * сообщению.
 *
 * Поэтому извлечение в воркере ПОВТОРЕНО, а не улучшено. Этот сторож держит
 * повтор: улучшать можно только оба места разом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKER = readFileSync(join(process.cwd(), 'infra/safety-relay/worker.js'), 'utf-8');
const WORKFLOW = readFileSync(join(process.cwd(), '.github/workflows/cron-safety-ingest.yml'), 'utf-8');

describe('разбора HTML в воркере нет — он остался в одном месте', () => {
  /**
   * Первая версия воркера тянула ещё и канал МЧС в MAX, а с ним — КОПИЮ
   * извлечения постов из HTML, скопированную из воркфлоу ради совпадения id.
   * Копию завернули сторожа `html-text` и `html-entities`, и по делу: вместе
   * с логикой копировался дефект (`<\/script>` требовался ровно таким;
   * `&amp;` разворачивался отдельной заменой).
   *
   * Чинить только в воркере было нельзя — id разошлись бы с раннером, и один
   * пост приехал бы дважды под разными именами: в канале МЧС это второй
   * наряд по одному сообщению. Поэтому MAX целиком оставлен раннеру.
   */
  it('воркер не снимает теги своей регуляркой', () => {
    expect(WORKER, 'в воркер вернулась вторая копия разбора HTML')
      .not.toMatch(/replace\(\/<\[\^>\]\+>/);
    expect(WORKER).not.toMatch(/<script\[\\s\\S\]/);
  });

  it('воркер не трогает MAX', () => {
    expect(WORKER, 'MAX вернулся в воркер — вместе с ним вернётся и копия парсера')
      .not.toContain('max.ru');
    expect(WORKER).not.toContain('max_items');
  });

  it('MAX по-прежнему приносит раннер — путь не потерян', () => {
    expect(WORKFLOW).toContain('max.ru/id4101120929_gos');
    expect(WORKFLOW).toContain('max_items');
  });
});

describe('воркер шлёт то же, что раннер', () => {
  it('те же адреса каналов', () => {
    for (const url of ['t.me/s/kbgsras', 't.me/s/eqkam', 't.me/s/minec_tourism']) {
      expect(WORKER, `воркер потерял ${url}`).toContain(url);
      expect(WORKFLOW, `раннер потерял ${url}`).toContain(url);
    }
  });

  it('те же имена полей, что ждёт приёмник', () => {
    for (const field of ['kbgsras_html', 'eqkam_html', 'minec_html', 'kamgov_xml']) {
      expect(WORKER, `воркер не кладёт ${field}`).toContain(field);
    }
  });
});

describe('осторожность воркера', () => {
  it('секрет уходит заголовком, а не в адресной строке', () => {
    expect(WORKER).toMatch(/Authorization.*Bearer/);
    expect(WORKER).not.toMatch(/\?secret=/);
  });

  it('без обязательного канала POST не отправляется', () => {
    // Приёмник вернул бы 400, и в журнале осталась бы «ошибка сервера»
    // вместо правды «Telegram не отдал страницу».
    expect(WORKER).toMatch(/posted: false/);
    expect(WORKER).toMatch(/не получены обязательные каналы/);
  });

  it('адрес приёмника не зашит в код', () => {
    // На tourhab.ru два джоба cron-job.org падали ровно потому, что домен
    // переехал, а адрес остался.
    expect(WORKER).toMatch(/env\.INGEST_BASE/);
  });

  it('есть проверка достижимости БЕЗ отправки', () => {
    // «Воркер вне РФ, значит блокировка обойдена» уже оказывалось ложью
    // (OpenRouter, infra/ai-relay). Рассуждение обязано стать замером.
    expect(WORKER).toMatch(/selftest/);
  });

  it('отказ прогона не глушится', () => {
    expect(WORKER).toMatch(/console\.error\('\[safety-relay\]/);
  });
});
