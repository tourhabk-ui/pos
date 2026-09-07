/**
 * tests/unit/safety-source-silence-detectable.test.ts
 *
 * Исход «источник безопасности замолчал» обязан быть ДОСТИЖИМЫМ.
 *
 * ── Что нашлось 07.09 ──────────────────────────────────────────────────────
 *
 * Перепись каналов показала: `t.me/s/kbgsras` — наш первый источник сейсмики,
 * стоящий первой строкой в seismic-parser, — молчит с 24 марта, 167 дней.
 * Тревоги не было ни одной, и быть не могло.
 *
 * `last_nonempty_at` двигался при `last_status = 'ok'`, а `ok` ставится по
 * `rawItems > 0` — «сколько постов РАЗОБРАНО со страницы», не «сколько НОВЫХ».
 * Превью Telegram всегда показывает те же две с половиной сотни старых постов.
 * Каждый прогон их разбирал, ставил `ok`, двигал отметку на сейчас — и «молчит
 * 167 дней» превращалось в «молчит 0 часов». Порог maxSilenceHours был
 * недостижим ПО ПОСТРОЕНИЮ у всех пяти источников: kbgsras, eqkam, vk_mchs,
 * max_mchs, mchs_rss.
 *
 * Проверка с двумя исходами, из которых один не может наступить, — это
 * проверка с одним исходом. Молчащая сейсмика выглядела ровно как спокойная.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateDeadSources,
  SAFETY_SOURCE_EXPECTATIONS,
  type SourceHealthRow,
} from '@/lib/services/safety/source-health';

const NOW = Date.parse('2026-09-07T21:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** Строка здоровья источника, который опрашивается исправно. */
function row(over: Partial<SourceHealthRow> = {}): SourceHealthRow {
  return {
    source_key: 'kbgsras',
    label: 'КБГС РАН (сейсмо)',
    last_status: 'ok',
    last_run_at: hoursAgo(0),
    last_nonempty_at: hoursAgo(0),
    last_alerted_at: null,
    first_seen_at: hoursAgo(24 * 200),
    raw_items: 266,
    inserted: 0,
    ...over,
  } as SourceHealthRow;
}

describe('замолчавший источник безопасности обнаруживается', () => {
  it('источник, не давший НОВОГО дольше порога, назван мёртвым', () => {
    // Тот самый случай: страница отдаётся, посты разбираются, новых нет.
    const dead = evaluateDeadSources([row({ last_nonempty_at: hoursAgo(24 * 167) })], SAFETY_SOURCE_EXPECTATIONS, NOW);
    const kbgs = dead.find(d => d.key === 'kbgsras');
    expect(kbgs, 'молчание 167 дней осталось незамеченным').toBeTruthy();
    expect(kbgs?.reason).toBe('silent');
    expect(kbgs?.silentHours).toBeGreaterThan(48);
  });

  it('живой источник мёртвым не зовётся', () => {
    const dead = evaluateDeadSources([row({ last_nonempty_at: hoursAgo(3) })], SAFETY_SOURCE_EXPECTATIONS, NOW);
    expect(dead.find(d => d.key === 'kbgsras')).toBeUndefined();
  });
});

describe('отметка жизни двигается по НОВОМУ, а не по факту ответа страницы', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/services/safety/source-health.ts'), 'utf-8');

  it('условие требует inserted > 0, а не только статус ok', () => {
    // Ключевое место всей починки. Без `inserted > 0` отметка двигалась бы
    // каждым прогоном, и тест выше никогда не смог бы воспроизвестись на проде:
    // строки с last_nonempty_at недельной давности просто не возникало.
    expect(SRC).toMatch(/last_nonempty_at\s*=\s*CASE WHEN EXCLUDED\.last_status = 'ok' AND EXCLUDED\.inserted > 0/);
  });

  it('на вставке новой строки — то же правило', () => {
    // Иначе первый же прогон нового источника ставил бы ему отметку жизни
    // авансом, и отсчёт тишины начинался бы с выдуманного события.
    expect(SRC).toMatch(/CASE WHEN \$3 = 'ok' AND \$5 > 0 THEN NOW\(\)/);
  });

  it('«разобрано со страницы» больше не считается признаком жизни', () => {
    expect(SRC).not.toMatch(/last_nonempty_at\s*=\s*CASE WHEN EXCLUDED\.last_status = 'ok'\s*\n?\s*THEN NOW\(\)/);
  });
});
