// @vitest-environment node
/**
 * Сейсмика не зависит от планировщика GitHub.
 *
 * ── Повод (21.09) ─────────────────────────────────────────────────────────
 *
 * Владелец спросил: «странно ни предупреждений по вулканам 3 дня ни
 * сейсмики?» Ответ оказался хуже, чем «источники молчат».
 *
 * Живой телеграм-источник сейсмики — EQKam (канал КБГС молчит с 24 марта,
 * это записано в SAFETY_SOURCE_EXPECTATIONS как принятое состояние). Его
 * страница приходила ТОЛЬКО через воркфлоу `cron-safety-ingest`, объявленный
 * расписанием «каждые пять минут»; в самом воркфлоу написано зачем:
 * «цунами от 185 км ≈ 15 мин».
 *
 * Замер за 5,3 суток (15.09 18:19 — 21.09 01:18) по Actions API:
 *
 *   прогонов                 40   вместо 1524
 *   медианный разрыв        188 минут
 *   худший разрыв           321 минута
 *   красных прогонов          0
 *
 * Планировщик не отказывает — он просто не запускает, поэтому не краснеет
 * ничего. Сведение семи получасовых кронов в один (20.09) не помогло: новый
 * `cron-safety-heartbeat` дал 6 прогонов вместо 30 за те же сутки, значит
 * дело не в числе расписаний.
 *
 * Watchdog молчал по своей причине: `checkSeismicCronDead` судит по
 * `agent_run_history` агента `safety-ingest`, а эту строку пишет ИСПРАВНЫЙ
 * GET-путь от `start.js`. Сторож смотрел на здоровую половину.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Не «код существует», а связку: heartbeat САМ ходит за страницей, умеет
 * реле, не заводит второй копии правил реле, и — главное — не пишет здоровье
 * канала, когда сходить не смог.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchTelegramPreview } from '@/lib/services/safety/telegram-source';
import { shouldFallbackToRelay } from '@/lib/agents/scout-relay';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'lib/services/safety/telegram-source.ts'), 'utf-8');
const ROUTE = readFileSync(join(ROOT, 'app/api/cron/safety-ingest/route.ts'), 'utf-8');
/** Код без комментариев: шапки сами цитируют то, что запрещено. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('heartbeat сам добывает сейсмику, а не ждёт раннер', () => {
  it('GET зовёт добытчик страницы для обоих каналов', () => {
    const c = code(ROUTE);
    expect(c).toContain("fetchTelegramPreview('kbgsras')");
    expect(c).toContain("fetchTelegramPreview('eqkam')");
  });

  it('разобранное попадает в тот же ingestFromHtml, что и у воркфлоу', () => {
    // Второй разборщик был бы вторым правилом (§12): у POST и GET разошлись
    // бы классификация событий и счёт вставленного.
    expect(code(ROUTE)).toContain('ingestFromHtml(telegramPages.kbgsras, telegramPages.eqkam)');
  });

  it('разбор идёт только при ОБЕИХ страницах', () => {
    // Пустая строка вместо непрочитанной страницы разобралась бы как
    // «канал прислал ноль постов» — неудача похода под видом молчания
    // канала (§4.0).
    expect(code(ROUTE)).toMatch(/kbgsrasPage\.html !== null && eqkamPage\.html !== null/);
  });
});

describe('здоровье канала не пишется, когда сходить не смогли', () => {
  it('записи kbgsras/eqkam в heartbeat условны', () => {
    // Безусловная запись «пусто» каждые пять минут делает канал вечно
    // свежим на вид — ровно то, от чего защищало прежнее владение POST'а.
    const c = code(ROUTE);
    const at = c.indexOf("entryFor('kbgsras'");
    expect(at, 'записи kbgsras в heartbeat нет вовсе').toBeGreaterThan(0);
    const before = c.slice(Math.max(0, at - 200), at);
    expect(before, 'запись здоровья канала не защищена условием').toContain('telegramOk');
  });

  it('статус прогона не портится тем, за чем мы не ходили', () => {
    const c = code(ROUTE);
    const at = c.indexOf("label: 'EQKam (t.me)'");
    expect(at).toBeGreaterThan(0);
    expect(c.slice(Math.max(0, at - 300), at)).toContain('telegramOk');
  });
});

describe('реле — фолбэк, и своих правил модуль не заводит', () => {
  it('правила отката берутся из общего клиента, а не переписаны', () => {
    const c = code(SRC);
    expect(c).toContain('shouldFallbackToRelay');
    // Копия списка статусов здесь была бы вторым правилом.
    expect(c).not.toMatch(/=== 403|=== 451|=== 429/);
  });

  it('сначала прямой запрос, реле только после его отказа', () => {
    const c = code(SRC);
    const direct = c.indexOf('const direct = await fetchOnce');
    const relay = c.indexOf('relayFetchUrl(');
    expect(direct).toBeGreaterThan(0);
    expect(relay).toBeGreaterThan(direct);
  });

  it('404 на реле не идёт — там ленты нет по этому адресу', () => {
    expect(shouldFallbackToRelay({ status: 404 })).toBe(false);
    expect(shouldFallbackToRelay({ status: 403 })).toBe(true);
    expect(shouldFallbackToRelay({ status: null })).toBe(true);
  });

  it('«реле не настроено» отделено от «реле отказало»', () => {
    // Первое чинится в панели Timeweb, второе — у Cloudflare. Одно слово на
    // оба состояния отправило бы читателя не туда.
    expect(SRC).toContain('реле не настроено');
  });
});

describe('путь чтения виден снаружи', () => {
  it('ответ несёт via и причину по каждому каналу', () => {
    const c = code(ROUTE);
    expect(c).toContain('telegram_fetch');
    expect(c).toMatch(/via: kbgsrasPage\.via/);
    expect(c).toMatch(/reason: eqkamPage\.reason/);
  });

  it('секрет реле уходит заголовком, а не в адресной строке', () => {
    const c = code(SRC);
    expect(c).toContain('relayHeaders(env)');
    expect(c).not.toMatch(/secret=|token=/);
  });
});

describe('живое поведение без сети: отказ называется, а не глотается', () => {
  it('пустой ответ — не «постов нет», а неудача с причиной', async () => {
    // В среде теста сети нет: прямой запрос не дойдёт, реле не настроено.
    const r = await fetchTelegramPreview('eqkam', {} as NodeJS.ProcessEnv);
    expect(r.html).toBeNull();
    expect(r.via).toBeNull();
    expect(r.reason, 'причина обязана быть названа словами').toBeTruthy();
    expect(r.reason).toContain('реле не настроено');
  });
});
