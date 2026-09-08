/**
 * tests/unit/partner-reach.test.ts
 *
 * Адрес партнёра — ОДИН, а не два.
 *
 * Поправка владельца 08.09 («есть у них и тг и макс») разошлась с находкой
 * воронки #1719 («нет ни MAX, ни Telegram») не потому, что кто-то ошибся, а
 * потому что адрес оператора в Telegram лежит в ДВУХ колонках, и живой код
 * читал то одну, то другую:
 *
 *   partners.telegram_chat_id      users.telegram_id (через partners.user_id)
 *   ────────────────────────       ──────────────────────────────────────────
 *   бронь с сайта                  бронь из чата Кузьмича
 *   Watchdog (обе проверки)        напоминание о неоплаченной броне
 *   находка воронки #1719
 *
 * Оператор с адресом в одной колонке был достижим для одного пути и
 * «неподключён к боту» для другого — включая сторожа, который об этом молчал.
 *
 * Сторож держит два свойства: выражение адреса объявлено ровно в одном месте,
 * и ни один читатель денежного пути не спрашивает одну колонку из двух.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reachFrom } from '@/lib/partners/reach';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Код без комментариев: судим запросы, а не рассказ о них в шапке. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/^\s*--[^\n]*$/gm, '');

/**
 * Читатели денежного пути: каждый решает «дошло ли до оператора».
 * Список закрытый намеренно — новый читатель обязан попасть сюда осознанно.
 */
const READERS: Array<[string, string]> = [
  ['бронь с сайта',        'app/api/hub/bookings/create/route.ts'],
  ['бронь из чата',        'lib/kuzmich/core.ts'],
  ['напоминание о оплате', 'app/api/cron/abandoned-bookings/route.ts'],
  ['watchdog',             'lib/agents/watchdog.ts'],
  ['находка воронки',      'lib/agents/evo/growth-agent.ts'],
];

const NONE = { telegram_chat_id: null, user_telegram_id: null, max_chat_id: null };

describe('правило адреса объявлено один раз', () => {
  it('старшинство: профиль партнёра выше аккаунта человека', () => {
    // Профиль заполняется осознанно (админом или командой «партнер» боту),
    // аккаунт — побочно входом: при расхождении верить надо первому.
    const both = reachFrom({ ...NONE, telegram_chat_id: 111, user_telegram_id: 222 });
    expect(both.telegramChatId).toBe('111');
    expect(both.telegramSource).toBe('partner');
  });

  it('адрес только в аккаунте человека — это адрес, а не пустота', () => {
    const r = reachFrom({ ...NONE, user_telegram_id: 222 });
    expect(r.telegramChatId).toBe('222');
    expect(r.telegramSource).toBe('user');
    expect(r.reachable).toBe(true);
  });

  it('BIGINT приходит числом или строкой — приводится в одном месте', () => {
    expect(reachFrom({ ...NONE, telegram_chat_id: 111 }).telegramChatId).toBe('111');
    expect(reachFrom({ ...NONE, telegram_chat_id: '111' }).telegramChatId).toBe('111');
    expect(reachFrom({ ...NONE, max_chat_id: 7 }).maxChatId).toBe('7');
  });

  it('достижим — это «есть хотя бы один канал», а не «есть телеграм»', () => {
    expect(reachFrom(NONE).reachable).toBe(false);
    expect(reachFrom({ ...NONE, telegram_chat_id: 1 }).reachable).toBe(true);
    expect(reachFrom({ ...NONE, max_chat_id: 2 }).reachable).toBe(true);
  });

  it('адреса нет нигде — источник null, а не выдуманный', () => {
    expect(reachFrom(NONE).telegramSource).toBeNull();
  });
});

describe('правило не вставляется в чужой SQL строкой', () => {
  it('модуль не экспортирует кусков запроса', () => {
    // Интерполяция ${...} в текст SQL статически неотличима от конкатенации,
    // а на её отсутствии держится защита от инъекций в этих же файлах:
    // сторож ложных находок (evo-findings-replay) на первой редакции этого
    // модуля покраснел сразу четырьмя историческими находками.
    const mod = read('lib/partners/reach.ts');
    expect(mod).not.toMatch(/export const PARTNER_\w*(EXPR|JOIN|COLUMNS)/);
  });

  for (const [name, path] of READERS) {
    it(`${name}: не подставляет кусков запроса из модуля`, () => {
      // Полностью запрещать ${...} в этих файлах нельзя: у watchdog есть свои
      // давние сборные запросы, и они не предмет этого правила. Правило —
      // про адрес партнёра: он приходит колонками, а не текстом.
      expect(code(read(path)), `${name}: кусок запроса из модуля в SQL`)
        .not.toMatch(/\$\{\s*PARTNER_\w+/);
    });
  }
});

describe('читатели денежного пути спрашивают общий адрес', () => {
  for (const [name, path] of READERS) {
    it(`${name}: не читает одну колонку из двух`, () => {
      const c = code(read(path));
      // Своя копия правила разойдётся снова — расхождение выше накопилось
      // не за день. Исключений в этом списке нет: писать колонку можно (вход
      // через Telegram, команда «партнер»), спрашивать её в одиночку нельзя.
      expect(c, `${name}: p.telegram_chat_id в одиночку — ответ на половину вопроса`)
        .not.toMatch(/\bp\.telegram_chat_id\b(?!\s*,\s*u_reach)/);
      expect(c, `${name}: адрес берётся общим модулем`)
        .toMatch(/reachFrom|reachForTour|reachForPartner|partnerReachCensus/);
    });
  }

  it('перепись достижимости — та же, что была: второй заводить нельзя', () => {
    // Своя перепись рядом с существующей — та же болезнь, что две копии
    // создания брони: расходятся молча. Чиненная — operator-reach.
    const census = code(read('app/api/cron/operator-reach/route.ts'));
    expect(census).toMatch(/partnerReachCensus/);
    expect(census).not.toMatch(/\bp\.telegram_chat_id\b/);
    // Сами chat_id перепись не отдаёт: это идентификатор живого человека в
    // чужом мессенджере, и для ответа «дойдёт ли заявка» он не нужен.
    expect(census).not.toMatch(/reach_telegram\b/);
    expect(census).toMatch(/telegram_only_in_user_account/);
  });
});

describe('недостижимость не выдаётся за молчание оператора', () => {
  it('бронь с сайта: нет ни одного адреса — это пишется в лог', () => {
    const c = code(read('app/api/hub/bookings/create/route.ts'));
    expect(c).toMatch(/reach\s*&&\s*!reach\.reachable/);
  });

  it('бронь из чата: то же самое, и отказ чтения адреса назван отдельно', () => {
    const c = code(read('lib/kuzmich/core.ts'));
    expect(c).toMatch(/нет ни Telegram, ни MAX/);
    expect(c).toMatch(/reach === null/);
  });
});
