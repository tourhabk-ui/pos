/**
 * lib/services/safety/telegram-source.ts — забрать превью канала Telegram
 * с ПРОДА: сначала напрямую, при блокировочном отказе через реле.
 *
 * ── Зачем (21.09) ─────────────────────────────────────────────────────────
 *
 * Сейсмические бюллетени EQKam приходят страницей `t.me/s/eqkam`. С прода
 * t.me закрыт, поэтому страницу приносил раннер GitHub: воркфлоу
 * `cron-safety-ingest` объявлен расписанием «каждые пять минут», и в нём же
 * написано зачем: «цунами от 185 км ≈ 15 мин».
 *
 * Замер 21.09 за 5,3 суток (15.09 18:19 — 21.09 01:18): **40 прогонов
 * вместо 1524**. Медианный разрыв 188 минут, худший 321. Все до одного
 * зелёные — планировщик GitHub не отказывает, он просто не запускает.
 *
 * Сведение семи получасовых кронов в один (20.09) этого не исправило: новый
 * `cron-safety-heartbeat` дал 6 прогонов вместо 30 за те же сутки. Значит
 * дело не в числе расписаний, и чинить надо не расписание, а ТРАНСПОРТ.
 *
 * ── Почему реле, и почему это не новая зависимость ────────────────────────
 *
 * Реле уже есть, и родилось оно ровно для этого. Шапка
 * `lib/agents/scout-relay.ts` говорит дословно: «03.09 сейсмо-реле
 * (infra/safety-relay, воркер Cloudflare) доказало замером, что страницы
 * t.me с края Cloudflare читаются: /selftest принёс 106 и 114 килобайт двух
 * каналов». Воркер называется safety-relay. Пользовался им дайджест
 * разведчика; лента безопасности — нет.
 *
 * Клиентская сторона берётся оттуда же целиком, включая правило «реле —
 * фолбэк, а не путь по умолчанию» и разбор того, какие отказы похожи на
 * блокировку (403/451/429/5xx и сетевая ошибка; 404 — нет, «ленты нет по
 * этому адресу, реле её не найдёт»). Своей копии здесь нет намеренно:
 * правило, реализованное дважды, — это два правила (§12).
 *
 * Имя модуля там говорит «scout», а содержимое — общий клиент реле; переезд
 * файла тронул бы разведчика, поэтому оставлен импорт и эта запись.
 *
 * ── Что возвращается, и почему трёх исходов мало ──────────────────────────
 *
 * Вызывающему нужно различать не три состояния, а ЧЕТЫРЕ, и последнее —
 * самое важное для ленты безопасности:
 *
 *   html есть, via 'direct' — прочитали сами;
 *   html есть, via 'relay'  — прочитали через Cloudflare. Это ДРУГАЯ
 *                             зависимость и другая поломка, и она обязана
 *                             быть видна в ответе (правило scout-relay);
 *   html нет, reason назван — сходили и не смогли;
 *   реле не настроено       — отдельно от «реле отказало»: первое чинится в
 *                             панели Timeweb, второе — у Cloudflare.
 *
 * Разница между «сходили и пусто» и «не смогли сходить» здесь не
 * теоретическая: на ней стоит владение здоровьем источника. Запись «пусто»
 * каждые пять минут делает канал вечно свежим на вид (разбор в шапке
 * `source-health.ts`), поэтому неудачный поход НЕ должен выглядеть походом.
 */

import {
  relayBase,
  relayConfigured,
  relayFetchUrl,
  relayHeaders,
  relayStatus,
  shouldFallbackToRelay,
  type FetchVia,
} from '@/lib/agents/scout-relay';

/** Сколько ждём страницу. Столько же стоит в воркфлоу, который её приносил. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Тот же User-Agent и язык, что слал раннер. Не маскировка: превью t.me
 * отдаёт разную разметку разным клиентам, а парсер написан под ту, что
 * приходила воркфлоу. Менять её заодно с транспортом значило бы менять две
 * вещи разом и не знать, которая сломала разбор.
 */
const FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (compatible; KamchatourBot/1.0)',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

export interface TelegramFetchResult {
  /** Разметка страницы; null — не смогли прочитать. */
  html: string | null;
  /** Каким путём получено. null — не получено вовсе. */
  via: FetchVia | null;
  /**
   * Почему не смогли — словами, для ответа и лога. null, когда html есть.
   * Пустая строка сюда не попадает: молчащая причина хуже отсутствия поля.
   */
  reason: string | null;
  /** Статус прямого запроса — чтобы в отчёте было видно, ЧТО именно ответил t.me. */
  directStatus: number | null;
}

async function fetchOnce(url: string, headers: Record<string, string>): Promise<{ status: number | null; body: string | null }> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: res.status, body: null };
    const body = await res.text();
    return { status: res.status, body };
  } catch {
    // Сеть, DNS, таймаут — прямой запрос не дошёл. Это не «страницы нет».
    return { status: null, body: null };
  }
}

/**
 * Превью канала: `https://t.me/s/<channel>`.
 *
 * Пустое тело при HTTP 200 считается НЕудачей: страница превью без разметки
 * — это не «постов нет», а отказ отдать содержимое. Разбирать такое молча
 * значило бы записать «канал жив, постов ноль».
 */
export async function fetchTelegramPreview(
  channel: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelegramFetchResult> {
  const url = `https://t.me/s/${channel}`;

  const direct = await fetchOnce(url, FETCH_HEADERS);
  if (direct.body && direct.body.trim().length > 0) {
    return { html: direct.body, via: 'direct', reason: null, directStatus: direct.status };
  }

  if (!shouldFallbackToRelay({ status: direct.status })) {
    return {
      html: null,
      via: null,
      reason: `t.me ответил ${direct.status ?? 'без статуса'} — на реле такой отказ не идёт (страницы нет по этому адресу)`,
      directStatus: direct.status,
    };
  }

  if (!relayConfigured(env)) {
    return {
      html: null,
      via: null,
      reason: `прямой запрос не прошёл (${direct.status ?? 'сеть'}), реле не настроено: ${relayStatus(env)}`,
      directStatus: direct.status,
    };
  }

  const viaRelay = await fetchOnce(
    relayFetchUrl(relayBase(env), url),
    { ...FETCH_HEADERS, ...relayHeaders(env) },
  );
  if (viaRelay.body && viaRelay.body.trim().length > 0) {
    return { html: viaRelay.body, via: 'relay', reason: null, directStatus: direct.status };
  }

  return {
    html: null,
    via: null,
    reason: `прямой ${direct.status ?? 'сеть'}, реле ${viaRelay.status ?? 'сеть'} — страницу не получили`,
    directStatus: direct.status,
  };
}
