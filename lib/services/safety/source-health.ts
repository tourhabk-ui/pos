/**
 * Сторож здоровья источников safety-ingest.
 *
 * Проблема (живой случай 24.07): пост МЧС про пеплопад Шивелуча в MAX не долетел
 * в ленту — у MAX нет открытого API, публичная страница SPA, скрейп пуст. И это
 * падало МОЛЧА: cron отдавал «ок» с нулём постов. Сторож делает провал видимым:
 * на каждом прогоне пишем статус источника, а `evaluateDeadSources` детерминированно
 * находит «мёртвые» — не настроен (нет env-ключа) или давно ничего не даёт.
 *
 * Философия репо (CLAUDE.md §8): детерминированный guard, не «правила в промпте».
 * Молчание источника — операционный риск безопасности, поэтому его надо ловить.
 */
import type { Pool } from 'pg';

export type SourceStatus = 'ok' | 'empty' | 'not_configured' | 'not_fetched' | 'error';

export interface SourceExpectation {
  key: string;
  label: string;
  /** env-переменная, без которой источник не работает (напр. VK_SERVICE_TOKEN). */
  requiresEnv?: string;
  /** Сколько часов молчания (0 релевантных постов) допустимо, прежде чем это «мёртв». */
  maxSilenceHours: number;
  /**
   * Источник мёртв У ИСТОЧНИКА, и это измерено и принято человеком (17.09).
   * Четвёртый исход рядом с тремя из §4.0 — тот же `known`, что у гео-блока
   * OpenRouter в health-кроне: не «хорошо», не «не знаем», а «плохо, известно
   * почему, решение принято». Такой источник остаётся в ожиданиях и в
   * evaluateDeadSources (оживёт — вставит событие, и отметка снимется сама),
   * но в Telegram каждые 12 часов НЕ уходит: «проверь канал/ключ» про канал,
   * который не пишет с марта, — шум, а шум учит пролистывать и настоящее.
   * В теле ответа инжеста он виден списком known_dormant_sources.
   */
  knownDormant?: { since: string; reason: string };
  /**
   * Чем источник доказывает, что жив (02.10). По умолчанию — вставленным
   * событием (`inserted`): превью Telegram каждый прогон отдаёт одни и те же
   * старые посты, и «постов разобрано» там ничего не значит (урок 07.09).
   * У бегущей RSS-ленты посты свежие по построению — там живость считается
   * по `raw_items`, а «событий нет» значит «в ленте нет угроз», не «не читаем».
   */
  aliveBy?: 'inserted' | 'raw_items';
  /**
   * Чем молчание ЭТОГО источника объяснять в тревоге вместо общего
   * «скрейп/парс сломан?». У еженедельной сводки тишина — это «выпуска не
   * было», а не поломка; общая фраза здесь врала (02.10).
   */
  deadHint?: string;
}

/**
 * Ожидаемые источники и их пороги тишины. Пороги щедрые: МЧС/сейсмо публикуют
 * часто, поэтому длинная тишина = вероятная поломка канала, а не «просто тихо».
 */
export const SAFETY_SOURCE_EXPECTATIONS: readonly SourceExpectation[] = [
  { key: 'vk_mchs',  label: 'VK — МЧС Камчатки',    requiresEnv: 'VK_SERVICE_TOKEN', maxSilenceHours: 72 },
  {
    key: 'max_mchs', label: 'MAX — МЧС Камчатки', maxSilenceHours: 72,
    // 09.10 владелец получил «MAX — МЧС Камчатки: молчит 757 ч — проверь
    // канал/ключ» и ответил «отключи». Ключа у MAX нет: открытого API нет,
    // публичная страница — SPA, и раннер постов не получает (случай 24.07,
    // шапка файла). Проверять нечего, а будить каждые 12 часов — шум.
    // МЧС Камчатки читается двумя другими путями — VK и RSS 41.mchs, — они
    // остаются под тревогой. Источник не выключен: раннер его по-прежнему
    // спрашивает, и оживёт — отметка снимется сама (evaluateDeadSources).
    knownDormant: { since: '2026-09-07', reason: 'MAX без открытого API, страница-SPA не отдаёт постов раннеру; МЧС Камчатки идёт через VK и RSS 41.mchs — решение владельца 09.10 «отключи»' },
  },
  { key: 'mchs_rss', label: 'МЧС RSS (41.mchs)',    maxSilenceHours: 96 },
  {
    key: 'kbgsras',  label: 'КБГС РАН (сейсмо)',    maxSilenceHours: 48,
    // Перепись 07.09: канал t.me/s/kbgsras не публикует с 24 марта. 17.09
    // владелец получил «молчит 228 ч — проверь канал/ключ»: ключа у t.me
    // нет, канал достаётся и разбирается (проба run 1669: 14 постов, все в
    // базе) — проверять нечего. Сейсмика идёт от EQKam и USGS.
    knownDormant: { since: '2026-03-24', reason: 'канал КБГС не публикует с 24.03 (перепись 07.09); ключа нет, страница читается' },
  },
  { key: 'eqkam',    label: 'EMSD/EQKam (сейсмо)',  maxSilenceHours: 48 },
  {
    // kamgov.ru — сводки Минтура «где маршрут закрыт, к какому вулкану не
    // приближаться» (#2064). Тянет только раннер (с Timeweb сайт закрыт), и
    // 26.09 проба 605 показала: раннеру он тоже отвечает 403 на все адреса.
    // До этого дня отказ читался как «источник ответил, постов нет» и не
    // доходил ни до кого — сводка не приходила неделями молча. Лента
    // правительства края пишет каждый день, поэтому 48 ч тишины — не «тихо»,
    // а «мы её не читаем». Запись здоровья пишет только POST раннера.
    key: 'kamgov', label: 'kamgov.ru — сводки Минтура', maxSilenceHours: 48,
    // Владелец 26.09 выбрал другой путь к той же сводке — kamtoday.ru ниже.
    // Молчание kamgov этим принято: будить им каждые 12 часов — шум, а
    // оживёт — отметка снимется сама (evaluateDeadSources).
    knownDormant: { since: '2026-09-26', reason: 'kamgov.ru отвечает раннеру 403 (проба 605); сводку Минтура берём с kamtoday.ru — решение владельца 26.09' },
  },
  {
    // Лента «Новостей Камчатки» (#2064) — общая и пишет каждый день: 48 ч без
    // единого поста — мы её не читаем. Живость — по постам ленты (RSS бегущая,
    // старое из неё уходит), а не по вставленным тревогам: до 02.10 считалось
    // по тревогам, и шесть дней работающего чтения ленты, в которой не было
    // сводки, уходили в Telegram как «ни разу не дал данных (парс сломан?)».
    key: 'kamtoday', label: 'kamtoday.ru — лента новостей', maxSilenceHours: 48,
    aliveBy: 'raw_items',
    deadHint: 'лента не отдаёт постов — проверь адрес RSS и ответ раннера',
  },
  {
    // Дорожный канал «Право на Руль» (10.10, lib/services/safety/road-channel):
    // закрытия проезда и приказы снимками. Живость — по вставленному
    // ограничению, а не по разобранным постам: превью Telegram каждый прогон
    // отдаёт те же старые посты (урок 07.09), и «разобрано» ничего не
    // доказывает. Закрытия на Камчатке не ежедневные — три недели без
    // единого ограничения уже повод посмотреть, читается ли канал.
    key: 'pravonarul', label: 'Право на Руль — дороги (Telegram)', maxSilenceHours: 24 * 21,
    deadHint: 'три недели ни одного закрытия из канала — или закрытий не было, или страница t.me/s/pravonarul не разбирается (разметка data-post, ответ раннера)',
  },
  {
    // Сама сводка Минтура в этой ленте — отдельный вопрос с отдельным сроком.
    // Выпуск еженедельный; «сводки не было» считается по статьям, прошедшим
    // isMinturBulletin, даже если тревог из них не вышло (все маршруты
    // открыты — тоже сводка). Десять суток — неделя и запас на задержку.
    key: 'kamtoday_bulletin', label: 'Сводка Минтура на kamtoday.ru', maxSilenceHours: 240,
    aliveBy: 'raw_items',
    deadHint: 'лента читается, но статьи-сводки в ней не было; возможно, выпуск не выходил или заголовок не содержит «Минтур»/«сводка»',
  },
  {
    // Таблица землетрясений с главной emsd.ru (24.09, решение владельца:
    // «tg не активен у них»). Порог короткий намеренно: таблица по
    // определению не пустеет — в ней всегда десять последних событий, — и
    // запись здоровья пишется только после похода, который дошёл и
    // разобрался. Тишина здесь поэтому значит одно: мы не можем прочитать
    // emsd.ru. Для главного источника диапазона M4–4.9 шесть часов слепоты —
    // уже повод.
    key: 'emsd_quakes', label: 'КФ ЕГС — землетрясения (emsd.ru)', maxSilenceHours: 6,
    // 02.10: алерт «ни разу не дал данных (скрейп/парс сломан?)» — формулировка
    // вводила в заблуждение: парс не сломан, до него дело не доходит. Проба 74
    // (01.10): emsd.ru отвечает ПРОДУ 403 (reached false). Сейсмика при этом
    // не слепа — приём исправен (EQKam через реле, USGS с порогом M4, разрыв не
    // больше 9 мин, пробы 74-76). Принято как известное состояние, а не
    // отказ; оживёт — отметка снимется сама (evaluateDeadSources).
    knownDormant: { since: '2026-09-24', reason: 'emsd.ru отвечает проду 403 (проба 74); сейсмику покрывают EQKam и USGS M4+' },
  },
  {
    // Предупреждения Росгидромета (08.10). Ответ несёт оба региона края
    // всегда — с предупреждением или с «оповещения не требуется», — поэтому
    // живость считается по регионам, а 12 часов без них значат «не читаем»,
    // а не «погода тихая». Опрос — каждый heartbeat (5 минут).
    key: 'meteoalert', label: 'Росгидромет — предупреждения (meteoalert)', maxSilenceHours: 12,
    aliveBy: 'raw_items',
    deadHint: 'meteoalert.meteoinfo.ru не отдаёт регионы Камчатки — проверь доступ с прода и форму ответа',
  },
  // 'firms' (NASA FIRMS, пожары) сюда НЕ входит осознанно: «нет термоточек»
  // неотличимо от «нет пожаров» (зимой месяцами пусто) — dead-алерт по
  // тишине был бы ложью. Health-запись пишется (видно в админке), env-ключ
  // FIRMS_MAP_KEY, ingest — lib/services/safety/wildfire-firms.ts.
] as const;

/** Как часто повторять алерт по одному источнику. */
export const ALERT_COOLDOWN_HOURS = 12;

export interface SourceHealthRow {
  source_key: string;
  label: string | null;
  last_status: SourceStatus | null;
  last_run_at: string | Date | null;
  last_nonempty_at: string | Date | null;
  last_alerted_at: string | Date | null;
  first_seen_at: string | Date | null;
  raw_items: number | null;
  inserted: number | null;
}

export interface DeadSource {
  key: string;
  label: string;
  reason: 'not_configured' | 'silent' | 'never';
  /** Часов тишины (для 'silent'/'never' — от last_nonempty_at; иначе null). */
  silentHours: number | null;
  /** Объяснение из ожидания (deadHint), если у источника оно своё. */
  hint?: string;
}

export interface SourceHealthEntry {
  key: string;
  label: string;
  status: SourceStatus;
  rawItems: number;
  inserted: number;
  /** Чем доказана живость (см. SourceExpectation.aliveBy); нет — по inserted. */
  aliveBy?: 'inserted' | 'raw_items';
  /** Причина сбоя ЭТОГО прогона (HTTP-код / текст ошибки) — только при 'error'.
      Без неё отчёт говорил «error» и молчал, чем именно болен источник, —
      диагноз требовал лезть в логи сервера (которых у cron-прогона нет). */
  error?: string;
}

function toMs(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

/**
 * Чистая функция: по строкам здоровья и ожиданиям находит мёртвые источники.
 * `now` инжектируется для тестируемости.
 */
export function evaluateDeadSources(
  rows: SourceHealthRow[],
  expectations: readonly SourceExpectation[],
  now: number,
): DeadSource[] {
  const byKey = new Map(rows.map((r) => [r.source_key, r]));
  const dead: DeadSource[] = [];

  for (const exp of expectations) {
    const row = byKey.get(exp.key);

    // Нет строки вообще — источник ещё ни разу не наблюдался (свежая таблица /
    // первый прогон не случился). Не судим — период привыкания.
    if (!row) continue;

    // Явно не настроен (нет env-ключа) — детерминированно и сразу, без привыкания.
    if (row.last_status === 'not_configured') {
      dead.push({ key: exp.key, label: exp.label, reason: 'not_configured', silentHours: null });
      continue;
    }

    // Период привыкания: пока источник наблюдается меньше порога тишины, вывод
    // «never/silent» преждевременен (на свежей таблице всё выглядело бы мёртвым).
    const firstSeen = toMs(row.first_seen_at) ?? toMs(row.last_run_at);
    const observedHours = firstSeen === null ? Infinity : (now - firstSeen) / 3_600_000;

    const lastNonEmpty = toMs(row.last_nonempty_at);
    if (lastNonEmpty === null) {
      // Опрашивался, но НИ РАЗУ не дал сырых данных — «мёртв» только если наблюдаем
      // его уже дольше порога тишины (иначе ещё рано судить).
      if (observedHours > exp.maxSilenceHours) {
        dead.push({ key: exp.key, label: exp.label, reason: 'never', silentHours: null, ...(exp.deadHint ? { hint: exp.deadHint } : {}) });
      }
      continue;
    }

    const silentHours = (now - lastNonEmpty) / 3_600_000;
    if (silentHours > exp.maxSilenceHours) {
      dead.push({ key: exp.key, label: exp.label, reason: 'silent', silentHours: Math.round(silentHours), ...(exp.deadHint ? { hint: exp.deadHint } : {}) });
    }
  }

  return dead;
}

/** Какие из мёртвых источников пора алертить (дебаунс по last_alerted_at). */
export function dueForAlert(
  dead: DeadSource[],
  rows: SourceHealthRow[],
  now: number,
  cooldownHours = ALERT_COOLDOWN_HOURS,
): DeadSource[] {
  const byKey = new Map(rows.map((r) => [r.source_key, r]));
  return dead.filter((d) => {
    const lastAlerted = toMs(byKey.get(d.key)?.last_alerted_at ?? null);
    return lastAlerted === null || (now - lastAlerted) / 3_600_000 >= cooldownHours;
  });
}

// ── DB-слой ──────────────────────────────────────────────────────────────

/**
 * Записывает статус источников за прогон.
 *
 * `last_nonempty_at` двигается, когда источник дал НОВОЕ (`inserted > 0`), а не
 * когда страница просто отрисовалась.
 *
 * ── Почему это не косметика (07.09) ────────────────────────────────────────
 *
 * Перепись каналов показала: `t.me/s/kbgsras` — наш первый источник сейсмики —
 * молчит с 24 марта, 167 дней. Тревоги не было ни одной, и быть не могло.
 *
 * Прежнее условие двигало отметку при `last_status = 'ok'`, а `ok` ставится по
 * `rawItems > 0` — это «сколько постов РАЗОБРАНО со страницы», а не «сколько
 * НОВЫХ». Превью Telegram всегда показывает те же две с половиной сотни старых
 * постов, включая мартовские. Каждый прогон их разбирал, ставил `ok`, двигал
 * отметку на сейчас — и «молчит 167 дней» превращалось в «молчит 0 часов».
 * Порог `maxSilenceHours` был недостижим ПО ПОСТРОЕНИЮ, у всех пяти источников
 * сразу: kbgsras, eqkam, vk_mchs, max_mchs, mchs_rss.
 *
 * То есть исход «источник замолчал» в коде существовал, а сработать не мог
 * никогда — §4.0 на самом дорогом направлении: молчащая сейсмика выглядела
 * ровно как спокойная сейсмика.
 *
 * Залпа тревог смена не даёт: отметка у живых источников не сбрасывается, и
 * отсчёт тишины у каждого начинается с его последнего НАСТОЯЩЕГО события.
 */
export async function recordSourceHealth(pool: Pool, entries: SourceHealthEntry[]): Promise<void> {
  for (const e of entries) {
    // Чем источник доказал живость в ЭТОМ прогоне — решается здесь, по
    // ожиданию, а не в SQL: у ленты это посты, у превью Telegram — вставка.
    const alive = e.status === 'ok' && (e.aliveBy === 'raw_items' ? e.rawItems > 0 : e.inserted > 0);
    await pool.query(
      `INSERT INTO safety_source_health
         (source_key, label, last_run_at, last_status, raw_items, inserted,
          last_nonempty_at, first_seen_at, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, $5, CASE WHEN $6::boolean THEN NOW() ELSE NULL END, NOW(), NOW())
       ON CONFLICT (source_key) DO UPDATE SET
         label            = EXCLUDED.label,
         last_run_at      = NOW(),
         last_status      = EXCLUDED.last_status,
         raw_items        = EXCLUDED.raw_items,
         inserted         = EXCLUDED.inserted,
         last_nonempty_at = CASE WHEN $6::boolean THEN NOW() ELSE safety_source_health.last_nonempty_at END,
         first_seen_at    = COALESCE(safety_source_health.first_seen_at, NOW()),
         updated_at       = NOW()`,
      [e.key, e.label, e.status, e.rawItems, e.inserted, alive],
    );
  }
}

/** Читает все строки здоровья. */
export async function loadSourceHealth(pool: Pool): Promise<SourceHealthRow[]> {
  const { rows } = await pool.query<SourceHealthRow>(
    `SELECT source_key, label, last_status, last_run_at, last_nonempty_at,
            last_alerted_at, first_seen_at, raw_items, inserted
       FROM safety_source_health`,
  );
  return rows;
}

/** Фиксирует факт алерта (дебаунс). */
export async function markAlerted(pool: Pool, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await pool.query(
    `UPDATE safety_source_health SET last_alerted_at = NOW() WHERE source_key = ANY($1)`,
    [keys],
  );
}

/**
 * Делит мёртвых на тех, о ком надо будить, и тех, чьё молчание принято
 * (knownDormant). Чистая функция; вторая половина не теряется — она уходит в
 * тело ответа инжеста, чтобы «не шумим» было отличимо от «не знаем».
 */
export function splitKnownDormant(
  dead: DeadSource[],
  expectations: readonly SourceExpectation[],
): { alertable: DeadSource[]; known: Array<DeadSource & { since: string; dormantReason: string }> } {
  const byKey = new Map(expectations.map((e) => [e.key, e]));
  const alertable: DeadSource[] = [];
  // dormantReason, не reason: у DeadSource своё поле reason ('silent' | …), и
  // оно остаётся — причина молчания и род молчания разные вещи.
  const known: Array<DeadSource & { since: string; dormantReason: string }> = [];
  for (const d of dead) {
    const kd = byKey.get(d.key)?.knownDormant;
    if (kd) known.push({ ...d, since: kd.since, dormantReason: kd.reason });
    else alertable.push(d);
  }
  return { alertable, known };
}

/** Человекочитаемая строка алерта для Telegram. */
export function formatDeadSourceAlert(dead: DeadSource[]): string {
  const lines = dead.map((d) => {
    if (d.reason === 'not_configured') return `• ${d.label}: не настроен (нет env-ключа)`;
    // Своё объяснение у источника важнее общей догадки про парсер.
    if (d.reason === 'never') return `• ${d.label}: ${d.hint ?? 'ни разу не дал данных (скрейп/парс сломан?)'}`;
    return `• ${d.label}: молчит ${d.silentHours} ч${d.hint ? ` — ${d.hint}` : ''}`;
  });
  return `Safety-ingest: источники не дают данных\n${lines.join('\n')}\n\nЛента безопасности может отставать. Проверь канал/ключ.`;
}
