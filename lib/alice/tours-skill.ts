/**
 * Навык «Туры Камчатки» для Алисы — список operator_tours голосом.
 *
 * Чистая логика диалога, без обращения к БД: запрос туров приходит извне
 * как функция (FetchTours), чтобы разбирать намерения и собирать ответ можно
 * было тестировать без поднятой базы.
 *
 * Источник туров — ТОЛЬКО lib/search/tour-search.ts (queryMarketplaceTours):
 * тот же движок «Поиск», что кормит каталог и маркетплейс. Свой SQL здесь не
 * заводим — CLAUDE.md прямо запрещает «новый движок подбора вне трёх
 * существующих».
 *
 * Что НЕ отдаём голосом (решение по итогам вопроса пользователя 24.08):
 * точку сбора (meeting_point) и бронирование. У фильтра каталога этого поля
 * вообще нет в выборке, и намеренно: навык — канал ОБНАРУЖЕНИЯ, не канал
 * БРОНИРОВАНИЯ (в отличие от OCTO-выдачи, которая полноценно продаёт вовне —
 * CLAUDE.md §4.1, «готовых к выкладке на чужую витрину: 0 из 8»). За деталями
 * и бронью навык всегда отправляет на сайт — это не обход проблемы
 * пустого meeting_point у всех восьми туров, а честная граница того, что
 * этот канал вообще делает.
 */

import { z } from 'zod';
import type { AliceRequest, AliceResponse, AliceButton, AliceEntity } from './types';
import type { MarketplaceTourRow, MarketplaceToursFilters, MarketplaceToursResult } from '@/lib/search/tour-search';

export type FetchTours = (
  filters: Partial<MarketplaceToursFilters>,
) => Promise<MarketplaceToursResult>;

const PAGE_SIZE = 5;

// ── Состояние диалога, которое Алиса носит между ходами за нас ─────────────

const StateSchema = z.object({
  v: z.literal(1),
  items: z.array(z.object({ id: z.number().int(), title: z.string() })).max(PAGE_SIZE),
  offset: z.number().int().min(0),
  sort: z.enum(['recommended', 'price_asc', 'price_desc', 'recent']),
  total: z.number().int().min(0),
});
type SkillState = z.infer<typeof StateSchema>;

function parseState(raw: unknown): SkillState | null {
  const res = StateSchema.safeParse(raw);
  return res.success ? res.data : null;
}

// ── Текст с защитным потолком длины ─────────────────────────────────────────
//
// Точное ограничение ответа Алисы сегодня не подтверждено — доступ к
// yandex.ru закрыт egress-прокси песочницы (проверял 24.08). Берём заведомо
// небольшой потолок, а не догадываемся о точном числе.
const TEXT_LIMIT = 900;
function cap(s: string): string {
  return s.length <= TEXT_LIMIT ? s : `${s.slice(0, TEXT_LIMIT - 1).trimEnd()}…`;
}

// ── Разбор намерения ─────────────────────────────────────────────────────────

type Intent =
  | { kind: 'list' }
  | { kind: 'more' }
  | { kind: 'sort'; sort: 'price_asc' | 'price_desc' }
  | { kind: 'details_by_position'; n: number }
  | { kind: 'details_by_query'; q: string }
  | { kind: 'help' }
  | { kind: 'end' }
  /** Порядковое слово/цифра сказаны без предъявленного списка — нечему соответствовать. */
  | { kind: 'need_list_first' }
  | { kind: 'unknown' };

const POSITION_WORDS: Record<string, number> = {
  'перв': 1, 'втор': 2, 'трет': 3, 'четверт': 4, 'пят': 5,
  'один': 1, 'два': 2, 'три': 3, 'четыре': 4, 'пять': 5,
};

/** Номер позиции из слова, из числовой сущности NLU или из голой цифры. Иначе — null. */
function detectPositionRef(cmd: string, entities: AliceEntity[] | undefined): number | null {
  for (const [stem, n] of Object.entries(POSITION_WORDS)) {
    if (cmd.includes(stem)) return n;
  }
  const numEntity = entities?.find((e) => e.type === 'YANDEX.NUMBER');
  if (numEntity && typeof numEntity.value === 'number' && numEntity.value >= 1 && numEntity.value <= PAGE_SIZE) {
    return numEntity.value;
  }
  const digitMatch = /^\s*(\d+)\s*$/.exec(cmd);
  if (digitMatch) {
    const n = Number(digitMatch[1]);
    if (n >= 1 && n <= PAGE_SIZE) return n;
  }
  return null;
}

function detectIntent(req: AliceRequest, hasState: boolean): Intent {
  if (req.request.type === 'ButtonPressed' && req.request.payload && typeof req.request.payload === 'object') {
    const p = req.request.payload as Record<string, unknown>;
    if (p.action === 'more') return { kind: 'more' };
    if (p.action === 'details' && typeof p.id === 'number') return { kind: 'details_by_query', q: String(p.id) };
    if (p.action === 'cheaper') return { kind: 'sort', sort: 'price_asc' };
  }

  const cmd = req.request.command.trim().toLowerCase();
  const intents = req.request.nlu?.intents ?? {};

  if ('YANDEX.HELP' in intents || /помощ|что ты умеешь|что умеешь/.test(cmd)) return { kind: 'help' };
  if ('YANDEX.REJECT' in intents || /^(нет|хватит|стоп|спасибо|все|всё|закончи)/.test(cmd)) return { kind: 'end' };
  if (/ещ[её]|дальше|следующ/.test(cmd)) return { kind: 'more' };
  if (/подешевле|дешевле/.test(cmd)) return { kind: 'sort', sort: 'price_asc' };
  if (/подороже|дороже/.test(cmd)) return { kind: 'sort', sort: 'price_desc' };

  // Порядковое слово/цифра распознаётся независимо от наличия состояния:
  // «второй» без списка — не «покажи список» и не «непонятно», а отдельный
  // повод сказать честно «нечего листать», а не гадать безадресно.
  const positionRef = detectPositionRef(cmd, req.request.nlu?.entities);
  if (positionRef !== null) {
    return hasState ? { kind: 'details_by_position', n: positionRef } : { kind: 'need_list_first' };
  }

  if (!hasState) {
    // Пустая реплика (типично для нового сеанса) или явная просьба списка —
    // список. Любой другой текст без состояния — не гадаем: некуда его
    // приложить (нет списка, по которому искать номер), в поиск по названию
    // на пустом состоянии он тоже не годится — предлагаем начать со списка.
    return cmd === '' || /тур|список|какие есть|что есть|покажи/.test(cmd)
      ? { kind: 'list' }
      : { kind: 'need_list_first' };
  }
  if (/тур|список|какие есть|что есть|покажи/.test(cmd)) return { kind: 'list' };
  if (cmd.length > 1) return { kind: 'details_by_query', q: cmd };
  return { kind: 'unknown' };
}

// ── Сборка ответа ────────────────────────────────────────────────────────────

function formatPrice(row: MarketplaceTourRow): string {
  return `от ${Math.round(row.base_price).toLocaleString('ru-RU')} ₽`;
}

function tourButton(row: { id: number; title: string }): AliceButton {
  return { title: row.title.slice(0, 60), payload: { action: 'details', id: row.id }, hide: true };
}

async function respondList(
  fetchTours: FetchTours,
  offset: number,
  sort: SkillState['sort'],
): Promise<AliceResponse> {
  const result = await fetchTours({ sort, limit: PAGE_SIZE, offset });

  if (result.total === 0) {
    return {
      response: { text: 'Пока ни один тур не опубликован в каталоге. Загляните позже.', end_session: false },
      version: '1.0',
    };
  }
  if (result.tours.length === 0) {
    // offset ушёл дальше total (пагинация кончилась) — не выдумываем список.
    return {
      response: { text: 'Это все туры, что у меня есть. Хотите посмотреть их с начала?', end_session: false },
      session_state: { v: 1, items: [], offset: 0, sort, total: result.total } satisfies SkillState,
      version: '1.0',
    };
  }

  const lines = result.tours.map((t, i) => `${i + 1}) ${t.title} — ${formatPrice(t)}`);
  const hasMore = offset + result.tours.length < result.total;
  const text = cap(
    `Нашла туров: ${result.total}. Вот ${result.tours.length}:\n${lines.join('\n')}\n` +
      'Назовите номер или название тура, чтобы узнать подробнее.' +
      (hasMore ? ' Или скажите «ещё».' : ''),
  );

  const buttons = result.tours.map(tourButton);
  if (hasMore) buttons.push({ title: 'Ещё туры', payload: { action: 'more' }, hide: true });

  return {
    response: { text, buttons, end_session: false },
    session_state: {
      v: 1,
      items: result.tours.map((t) => ({ id: t.id, title: t.title })),
      offset: offset + result.tours.length,
      sort,
      total: result.total,
    } satisfies SkillState,
    version: '1.0',
  };
}

async function respondDetails(fetchTours: FetchTours, id: number): Promise<AliceResponse> {
  const result = await fetchTours({ id });
  const tour = result.tours[0];
  if (!tour) {
    return {
      response: { text: 'Не нашла такой тур — возможно, его сняли с публикации. Показать список ещё раз?', end_session: false },
      version: '1.0',
    };
  }

  const desc = tour.description?.trim() || tour.short_description?.trim();
  const descLine = desc ? desc.slice(0, 400) : 'Подробного описания пока нет — уточните у оператора.';

  const text = cap(
    `${tour.title}. ${formatPrice(tour)}. Оператор — ${tour.operator_name}.\n` +
      `${descLine}\n` +
      'Точные детали, точка сбора и бронирование — на сайте, в карточке тура. Показать другие туры?',
  );

  return {
    response: { text, end_session: false },
    version: '1.0',
  };
}

async function respondDetailsByQuery(fetchTours: FetchTours, q: string, prior: SkillState | null): Promise<AliceResponse> {
  const asId = Number(q);
  if (Number.isInteger(asId) && prior?.items.some((it) => it.id === asId)) {
    return respondDetails(fetchTours, asId);
  }
  const result = await fetchTours({ search: q, limit: 1 });
  const tour = result.tours[0];
  if (!tour) {
    return {
      response: { text: `Не нашла тур «${q.slice(0, 80)}». Могу показать список всех туров.`, end_session: false },
      version: '1.0',
    };
  }
  return respondDetails(fetchTours, tour.id);
}

const HELP_TEXT = cap(
  'Я расскажу про туры на Камчатке. Спросите «какие есть туры» — покажу список. ' +
    'Дальше можно сказать номер или название тура — расскажу подробнее, ' +
    'или «ещё» — покажу остальные, или «подешевле» — отсортирую по цене.',
);

export async function handleAliceTours(req: AliceRequest, fetchTours: FetchTours): Promise<AliceResponse> {
  const prior = parseState(req.state?.session);
  const intent = detectIntent(req, prior !== null);

  switch (intent.kind) {
    case 'list':
      return respondList(fetchTours, 0, 'recommended');
    case 'more':
      return respondList(fetchTours, prior?.offset ?? 0, prior?.sort ?? 'recommended');
    case 'sort':
      return respondList(fetchTours, 0, intent.sort);
    case 'details_by_position': {
      const item = prior?.items[intent.n - 1];
      if (!item) {
        return {
          response: { text: 'Не поняла, какой это тур по счёту. Сначала спросите список туров.', end_session: false },
          version: '1.0',
        };
      }
      return respondDetails(fetchTours, item.id);
    }
    case 'details_by_query':
      return respondDetailsByQuery(fetchTours, intent.q, prior);
    case 'need_list_first':
      return {
        response: { text: 'Не поняла, какой это тур по счёту. Сначала спросите список туров.', end_session: false },
        version: '1.0',
      };
    case 'help':
      return { response: { text: HELP_TEXT, end_session: false }, version: '1.0' };
    case 'end':
      return { response: { text: 'Хорошего дня! Приходите ещё.', end_session: true }, version: '1.0' };
    case 'unknown':
      return {
        response: {
          text: 'Не поняла. Спросите «какие есть туры» — покажу список, или скажите «помощь».',
          end_session: false,
        },
        version: '1.0',
      };
  }
}
