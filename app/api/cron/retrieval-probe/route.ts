/**
 * GET /api/cron/retrieval-probe — что на самом деле находит поиск Кузьмича.
 * Bearer CRON_SECRET, только чтение.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Прогон оценки 07.09 (`/api/cron/kuzmich-eval?source=live`) вернул
 * `context_len: 0` во ВСЕХ десяти живых вопросах, и судья по каждому написал
 * одно и то же: «контекст пуст, retrieval ничего не нашёл». Ответы при этом
 * были полными и уверенными — включая живой факт безопасности:
 *
 *   «Статус вулкана сейчас зелёный» — при нулевом контексте.
 *
 * По §8 такие факты берутся только из инструментов и БД: это был самоотчёт
 * модели там, где самоотчёту верить нельзя.
 *
 * ── Что проверяет проба ────────────────────────────────────────────────────
 *
 * Разбор по коду говорит: поиск мест строит условие через `plainto_tsquery`,
 * а он соединяет ВСЕ слова через И. На вопрос «Иду на Авачинский в сентябре
 * один, из снаряжения кроссовки и ветровка. Нормально?» требуется документ,
 * содержащий одновременно все восемь слов — такого нет и быть не может.
 *
 * Но разбор по коду — ещё не замер, а сегодня одна моя догадка уже оказалась
 * неверной. Поэтому проба гоняет ОБА пути на одних и тех же вопросах и
 * печатает, что вернул каждый:
 *
 *   сейчас  — searchPlaceKnowledge / searchRoutes / searchLegislation как есть;
 *   если ИЛИ — тот же корпус, но слова соединены `|` с ранжированием.
 *
 * Если первый даёт ноль, а второй — попадания, механизм подтверждён числом,
 * а не рассуждением. Если оба дают ноль — причина в другом, и чинить надо не
 * это.
 *
 * Ничего не пишет и ничего не решает.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { searchPlaceKnowledge } from '@/lib/kuzmich/core';
import { searchRoutes } from '@/lib/ai/route-knowledge';
import { searchLegislation } from '@/lib/services/ingest/legislation-importer';
import questionsFixture from '@/lib/agents/eval/kuzmich-eval-questions.json';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Слова для запроса «через ИЛИ».
 *
 * Санитайзер строгий не для красоты: `to_tsquery` — не `plainto_tsquery`, он
 * разбирает операторы и падает на постороннем символе. Оставляем только буквы
 * и цифры, слова короче трёх букв выкидываем (предлоги ранг только шумят).
 */
export function orTsQuery(question: string): string | null {
  const words = question
    .replace(/[^\wа-яёА-ЯЁ ]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3)
    .slice(0, 12);
  return words.length ? words.join(' | ') : null;
}

interface Hit { title: string; rank: number }

async function orSearch(question: string): Promise<{ query: string | null; hits: Hit[]; error: string | null }> {
  const q = orTsQuery(question);
  if (!q) return { query: null, hits: [], error: null };
  try {
    const { rows } = await pool.query<{ title: string; rank: number }>(
      `SELECT title, ts_rank(search_text, to_tsquery('russian', $1)) AS rank
         FROM agent_route_knowledge
        WHERE search_text @@ to_tsquery('russian', $1)
          AND lat IS NOT NULL AND lat != 0
        ORDER BY rank DESC
        LIMIT 5`,
      [q],
    );
    return { query: q, hits: rows.map((r) => ({ title: r.title, rank: Number(r.rank) })), error: null };
  } catch (err) {
    // Отказ запроса — «не смог спросить», а не «ничего не нашлось» (§4.0).
    const message = err instanceof Error ? err.message : String(err);
    console.error('[retrieval-probe] запрос через ИЛИ не выполнен:', message);
    return { query: q, hits: [], error: message };
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const extra = url.searchParams.getAll('q').filter((s) => s.trim().length > 2);
  const questions = [
    ...(questionsFixture as Array<{ id: string; question: string }>).slice(0, 8)
      .map((q) => ({ id: q.id, question: q.question })),
    ...extra.map((question, i) => ({ id: `q${i + 1}`, question })),
  ];

  try {
    const items = [];
    for (const q of questions) {
      const [placeCtx, routeCtx, legalCtx, or] = await Promise.all([
        searchPlaceKnowledge(q.question).catch(() => ''),
        searchRoutes(q.question).catch(() => ''),
        searchLegislation(q.question).catch(() => ''),
        orSearch(q.question),
      ]);
      items.push({
        id: q.id,
        question: q.question,
        now: {
          place_len: placeCtx.length,
          route_len: routeCtx.length,
          legal_len: legalCtx.length,
          total_len: placeCtx.length + routeCtx.length + legalCtx.length,
        },
        or_query: { query: or.query, hits: or.hits.map((h) => h.title), error: or.error },
      });
    }

    const emptyNow = items.filter((i) => i.now.total_len === 0).length;
    const orFinds = items.filter((i) => i.or_query.hits.length > 0).length;

    return NextResponse.json({
      probe: 'retrieval_probe_v1',
      contract_version: 1,
      checked_at: new Date().toISOString(),
      asked: items.length,
      // Приговор выносит пара чисел, а не одно: «сейчас пусто» само по себе
      // может значить и «поиск сломан», и «в базе правда нечего найти».
      empty_now: emptyNow,
      or_query_finds: orFinds,
      verdict: emptyNow === 0
        ? 'поиск находит — причина пустого контекста в другом'
        : orFinds > 0
          ? 'нынешний поиск пуст там, где запрос через ИЛИ находит: подтверждено, что дело в И-семантике plainto_tsquery'
          : 'пусты оба пути — дело не в семантике запроса, искать причину дальше',
      items,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[retrieval-probe] проба не выполнена:', message);
    return NextResponse.json(
      { probe: 'retrieval_probe_v1', contract_version: 1, verdict: 'unknown', error: message },
      { status: 500 },
    );
  }
}
