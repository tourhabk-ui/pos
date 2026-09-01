/**
 * Почему посты канала уходят без картинок — вопрос, на который можно ответить.
 *
 * ── Повод 31.08 ────────────────────────────────────────────────────────────
 *
 * Владелец: «новости в тг канале без картинок это кринж». Обложка при этом
 * есть ВСЕГДА по построению — `resolveCoverImage` не возвращает null никогда.
 * Значит теряется она при отправке, и `tgPostPhoto` это честно записывает в
 * `ai_actions_log` (`channel_photo_fallback`) с ответом Telegram.
 *
 * Запись велась с самого начала. ЧИТАТЬ её было нечем — и вопрос решался
 * догадками. Тот же дефект, что был у очереди полевых проверок: пишем и не
 * читаем; форма без чтения — способ потерять сведения, а не собрать их.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ROUTE = strip(read('app/api/cron/channel-photo-check/route.ts'));
const CHANNEL = strip(read('lib/notifications/telegram-channel.ts'));

describe('читает ровно то, что пишет отправка', () => {
  it('род записи совпадает с тем, что кладёт tgPostPhoto', () => {
    // Разъехавшиеся имена дали бы вечно пустой отчёт, неотличимый от «всё
    // хорошо» — ровно то, против чего эта проверка и заводится.
    expect(CHANNEL).toMatch(/'channel_photo_fallback'/);
    expect(ROUTE).toMatch(/action_type = 'channel_photo_fallback'/);
  });

  it('берёт те же поля, что кладёт logPhotoFallback', () => {
    for (const f of ['photo_url', 'error', 'outcome']) {
      expect(CHANNEL, `отправка не пишет ${f}`).toContain(f);
      expect(ROUTE, `отчёт не читает ${f}`).toContain(f);
    }
  });
});

describe('только чтение под секретом', () => {
  it('ничего не пишет и не публикует', () => {
    expect(ROUTE).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    expect(ROUTE).not.toMatch(/tgPost|sendPhoto|sendMessage/);
  });

  it('закрыт CRON_SECRET', () => {
    expect(ROUTE).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
});

describe('три исхода, а не два', () => {
  it('отказ запроса не выдаётся за отсутствие откатов', () => {
    // Пустой catch превратил бы поломку журнала в «картинки уходят».
    expect(ROUTE).toMatch(/refused/);
    expect(ROUTE).toMatch(/console\.error\('\[channel-photo-check\]/);
  });

  it('пустая таблица различает «откатов нет» и «постов не было»', () => {
    expect(ROUTE).toMatch(/posts_in_period/);
    expect(ROUTE).toMatch(/канал молчал/);
  });

  it('неузнанный ответ Telegram остаётся неузнанным', () => {
    // Свалить его в «прочее» с готовым советом значило бы выдать догадку за
    // диагноз (§4.0).
    expect(ROUTE).toMatch(/не разобрано:/);
  });
});

describe('счёт постов без картинки честный', () => {
  it('откат на ЗАПАСНОЕ фото в «без картинок» не попадает', () => {
    // outcome 'fallback_photo' — пост с картинкой, просто не с первой.
    expect(ROUTE).toMatch(/posts_without_photo/);
    expect(ROUTE).toMatch(/byOutcome\['text_only'\]/);
  });

  it('интервал параметром, а не конкатенацией', () => {
    // Сторож sql-interval-not-concatenated про то же.
    expect(ROUTE).toMatch(/\(\$1 \|\| ' days'\)::interval/);
    expect(ROUTE).not.toMatch(/NOW\(\) - INTERVAL '\$\{/);
  });
});
