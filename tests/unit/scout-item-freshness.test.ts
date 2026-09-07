/**
 * tests/unit/scout-item-freshness.test.ts
 *
 * Разведчик не выдаёт архив за новость.
 *
 * ── Что случилось (07.09) ──────────────────────────────────────────────────
 *
 * В выпуск под шапкой «AI-дайджест · 7 сентября» попал релиз DeepSeek R1 —
 * январь 2025 года, двадцать месяцев назад, — с припиской «практикам стоит
 * отслеживать». Факты в заметке верные: MIT-лицензия, падение Nvidia на 17%,
 * ~$589 млрд за день. Ложью была ПОДАЧА: читатель видит дату в шапке и
 * достраивает «это произошло сейчас».
 *
 * Механизм — из §4.0, и он же был у «третьего состояния»: разбор ленты брал у
 * элемента ТОЛЬКО заголовок и ссылку. Даты не существовало вовсе, поэтому
 * архивная страница была неотличима от сегодняшней новости, а место, где
 * нельзя было сказать «не знаю, когда это вышло», заполнялось допущением
 * «раз в ленте — значит свежее».
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * Три исхода возраста и АСИММЕТРИЮ между ними: выбрасывается только то, про
 * что известно, что оно старое. Незнание элемент не убивает — у телеграм-
 * превью и части фидов даты нет вовсе, и отсев по незнанию молча обезглавил
 * бы эти источники, оставив дайджест без половины материала.
 */
import { describe, it, expect } from 'vitest';
import { classifyItemAge, MAX_ITEM_AGE_DAYS, MIN_SIGNALS_FOR_DIGEST } from '@/lib/agents/scout-digest';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-skip-reasons';

const NOW = Date.parse('2026-09-07T12:00:00Z');
const days = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('возраст элемента ленты: три исхода', () => {
  it('сегодняшнее — свежее', () => {
    expect(classifyItemAge(days(0), NOW)).toBe('fresh');
    expect(classifyItemAge(days(1), NOW)).toBe('fresh');
  });

  it('тот самый случай: релиз DeepSeek R1 из января 2025 — старьё', () => {
    expect(classifyItemAge('2025-01-20T00:00:00Z', NOW)).toBe('stale');
  });

  it('граница окна не выбрасывает то, что в него попадает', () => {
    expect(classifyItemAge(days(MAX_ITEM_AGE_DAYS), NOW)).toBe('fresh');
    expect(classifyItemAge(days(MAX_ITEM_AGE_DAYS + 1), NOW)).toBe('stale');
  });

  it('даты нет — «не знаю», и это НЕ «старьё»', () => {
    // Ключевая асимметрия. У телеграм-превью даты нет вовсе: если незнание
    // приравнять к старью, эти источники исчезнут из выпуска молча.
    expect(classifyItemAge(undefined, NOW)).toBe('unknown');
    expect(classifyItemAge('', NOW)).toBe('unknown');
  });

  it('неразобранная дата — «не знаю», а не «сейчас»', () => {
    expect(classifyItemAge('позавчера', NOW)).toBe('unknown');
    expect(classifyItemAge('30 февраля', NOW)).toBe('unknown');
  });

  it('дата из будущего доверия не заслуживает — тоже «не знаю»', () => {
    // Кривой часовой пояс или опечатка в фиде. Принять её за свежесть значило
    // бы поднять наверх выпуска запись, которой ещё нет.
    expect(classifyItemAge(new Date(NOW + 5 * 86_400_000).toISOString(), NOW)).toBe('unknown');
  });

  it('час вперёд прощается: часовые пояса и расхождение часов', () => {
    expect(classifyItemAge(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBe('fresh');
  });

  it('формат RSS (RFC 822) читается наравне с ISO', () => {
    // pubDate у RSS приходит именно так; если бы разбор его не брал, фильтр
    // молчал бы ровно на тех лентах, ради которых заведён.
    expect(classifyItemAge(new Date('Mon, 20 Jan 2025 10:00:00 GMT').toISOString(), NOW)).toBe('stale');
  });
});

describe('выпуск из одного пункта — не выпуск', () => {
  /**
   * 07.09: в канал ушёл дайджест ИЗ ОДНОГО пункта. Сбор был исправен — 16
   * источников из 16 живы, 78 материалов, — но предыдущий прогон за 25 минут
   * до этого уже разобрал ленту, и межпрогонный дедуп снял 77 из 78. Ворота
   * стояли только на НОЛЬ: ноль умел молчать, единица шла в печать.
   */
  it('порог выше нуля и не превращает осторожность в немоту', () => {
    expect(MIN_SIGNALS_FOR_DIGEST).toBeGreaterThan(1);
    // Высокий порог у ЭТОГО агента опаснее низкого: молчание при зелёном кроне
    // уже стоило семнадцати дней (см. историю ворот выпуска).
    expect(MIN_SIGNALS_FOR_DIGEST).toBeLessThanOrEqual(5);
  });

  it('у причины есть человеческое имя — иначе в алерте будет голый код', () => {
    expect(SKIP_REASON_LABELS.too_few_signals).toBeTruthy();
  });

  it('ворота стоят ДО синтеза: недобор не должен стоить вызовов модели', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
    // Якорь — ВЫЗОВ, а не импорт: `indexOf('deduplicateBySimilarity')` первым
    // находит строку импорта в шапке файла, и проверка сравнивала бы порядок с
    // ней, то есть не проверяла бы ничего.
    const gate = src.indexOf("digest_skip_reason: 'too_few_signals'");
    const synthesis = src.indexOf('deduplicateBySimilarity(freshItems');
    expect(gate, 'ворот «слишком мало сигналов» нет').toBeGreaterThan(-1);
    expect(synthesis, 'разбор сигналов не найден — якорь устарел').toBeGreaterThan(-1);
    expect(gate, 'ворота стоят после разбора — модель зовут впустую').toBeLessThan(synthesis);
  });
});

describe('разбор ленты вынимает дату, а не выдумывает её', () => {
  it('источник читает pubDate/published/updated/dc:date', async () => {
    // Проверяется ПОСТАВЛЯЕМЫЙ код: без этих полей в разборе фильтр выше
    // окажется всегда «unknown» и не отсеет ничего — зелёный и бесполезный.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
    for (const tag of ['pubDate', 'published', 'updated', 'dc:date']) {
      expect(src, `разбор ленты не берёт <${tag}>`).toContain(`<${tag}`);
    }
    expect(src, 'дата не доезжает до элемента').toMatch(/publishedAt/);
  });
});
