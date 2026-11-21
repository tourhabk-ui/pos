/**
 * Строка предупреждения называет того, кто сообщил (21.11, слово владельца
 * «карт-бланш» на вопрос о подписи сводки).
 *
 * До этой правки каждая строка под ответом Кузьмича и на дне плана начиналась
 * с «МЧС»: «МЧС о вулкане Шивелуч: не ближе 10 км к вершине (источник
 * t.me/visitkamchatka41/…)». Выборка предупреждений (`volcanic_eruption`,
 * `road_closure`) берёт строки любой ленты — сводку с турпортала края, пост
 * КБГС РАН об извержении, — и слова сейсмологов шли туристу под подписью МЧС.
 *
 * Сторож держит — вызовом:
 *   - кто сообщил выводится из номера записи ленты тем же правилом, что
 *     подписывает тревоги в обстановке по краю (`alertOrigin`);
 *   - строка КБГС РАН и строка турпортала не начинаются с «МЧС»;
 *   - источник не узнан — «Сводка», а не ведомство наугад;
 *   - сводка-итог из разных лент называет все;
 *   - блок промпта несёт «кто сообщил» и разбор возвращает его;
 *   - правка плана узнаёт строку с любым «кто сообщил» и прежнюю «МЧС …».
 */
import { describe, expect, it } from 'vitest';
import {
  appendOfferingFlags, formatWarningBlock, isOfferingNote, offeringSentence, UNKNOWN_SPEAKER,
  warningDigest, warningSpeaker, warningsFromBlock, warningsFromRows, type AlertWarningRow,
} from '@/lib/safety/mchs-bulletin';
import { classifyMessage } from '@/lib/services/safety/seismic-parser';

const KBGS_ROW: AlertWarningRow = {
  alert_type: 'volcanic_eruption', title: 'Извержение вулкана Шивелуч — высота 5.7 км', volcano_name: 'Шивелуч',
  description: 'Пепловый выброс до 5700 м над уровнем моря.', source_url: 'https://t.me/kbgsras/7001', external_id: 't.me/kbgsras/7001',
};
const PORTAL_ROW: AlertWarningRow = {
  alert_type: 'volcanic_eruption', title: 'Вулкан Шивелуч: не ближе 10 км к вершине', volcano_name: 'Шивелуч',
  description: 'Шивелуч — разрешено приближение радиусе не более, чем на 10 км от вершины.',
  source_url: 'https://t.me/visitkamchatka41/4983', external_id: 'visitkamchatka/2026-11-19/vshv',
};
const MCHS_ROAD: AlertWarningRow = {
  alert_type: 'road_closure', title: 'Мильковский округ: проезд закрыт', description: 'Проезд закрыт.',
  source_url: 'https://vk.com/wall-45534680_11612', external_id: 'vk_mchs/2026-11-19/r1',
};
const NOBODY_ROW: AlertWarningRow = {
  alert_type: 'volcanic_eruption', title: 'Вулкан Мутновский: не приближаться', volcano_name: 'Мутновский',
  description: '', source_url: null, external_id: null,
};

describe('кто сообщил — по номеру записи ленты', () => {
  it.each([
    ['vk_mchs/2026-11-19/t1', null, 'МЧС'],
    ['mchs/2026-11-19/x', null, 'МЧС'],
    ['max_mchs/2026-11-19/x', null, 'МЧС'],
    ['visitkamchatka/2026-11-19/vshv', 'https://t.me/visitkamchatka41/4983', 'Турпортал края'],
    ['t.me/kbgsras/7001', null, 'КБГС РАН'],
    ['manual-1', null, 'Запись администратора Ведара'],
    ['t.me/some_channel/5', null, 'Telegram-канал @some_channel'],
  ])('%s → %s', (id, url, who) => {
    expect(warningSpeaker(id, url)).toBe(who);
  });

  it('номер не узнан — null, а не «МЧС»', () => {
    expect(warningSpeaker(null, null)).toBeNull();
    expect(warningSpeaker('что-то/1', 'https://example.org/1')).toBeNull();
  });

  it('пост КБГС РАН об извержении попадает в выборку и подписан «КБГС РАН»', () => {
    // Строка ленты — та, что пишет разбор поста КБГС РАН.
    const event = classifyMessage('t.me/kbgsras/7001', 'На вулкане Шивелуч пепловый выброс до 5700 м над уровнем моря.', '2026-11-20T00:00:00Z');
    expect(event?.alert_type).toBe('volcanic_eruption');
    const [w] = warningsFromRows([{ ...KBGS_ROW, title: event!.title, external_id: event!.source_id }]);
    expect(offeringSentence(w)).toMatch(/^КБГС РАН о вулкане Шивелуч: /);
  });
});

describe('строка под ответом и на дне плана', () => {
  const ws = warningsFromRows([KBGS_ROW, PORTAL_ROW, MCHS_ROAD, NOBODY_ROW]);
  const said = ws.map(offeringSentence);

  it('каждая начинается с того, кто сообщил; чужие слова не подписаны «МЧС»', () => {
    expect(said[0]).toMatch(/^КБГС РАН о вулкане Шивелуч: извержение — высота 5\.7 км/);
    expect(said[1]).toMatch(/^Турпортал края о вулкане Шивелуч: не ближе 10 км к вершине/);
    expect(said[2]).toMatch(/^МЧС: проезд — Мильковск/);
    expect(said[3]).toBe(`${UNKNOWN_SPEAKER} о вулкане Мутновский: не приближаться.`);
    for (const s of [said[0], said[1], said[3]]) expect(s).not.toMatch(/МЧС/);
  });

  it('правка плана узнаёт строку с любым «кто сообщил» и прежнюю «МЧС …»', () => {
    for (const s of said) expect(isOfferingNote(s)).toBe(true);
    expect(isOfferingNote('МЧС о вулкане Шивелуч: не ближе 10 км к вершине (источник x).')).toBe(true);
    expect(isOfferingNote('МЧС: к вулкану Шивелуч рекомендовано не приближаться (сводка на 14.11).')).toBe(true);
    expect(isOfferingNote('Возьмите палки и термос.')).toBe(false);
    expect(isOfferingNote('Тропа идёт по осыпи: на подъёме не торопитесь.')).toBe(false);
  });

  it('ответ о Шивелуче получает строки со своими подписями', () => {
    const out = appendOfferingFlags('Хотим к подножию Шивелуча.', ws);
    expect(out).toContain('КБГС РАН о вулкане Шивелуч');
    expect(out).toContain('Турпортал края о вулкане Шивелуч');
    expect(out).not.toMatch(/МЧС о вулкане Шивелуч/);
  });
});

describe('сводка-итог', () => {
  it('из одной ленты — её имя; из разных — все в скобках', () => {
    const one = warningDigest(warningsFromRows([PORTAL_ROW]))!;
    expect(one).toMatch(/^Турпортал края о вулканах — Шивелуч: не ближе 10 км к вершине/);
    const mixed = warningDigest(warningsFromRows([KBGS_ROW, PORTAL_ROW, MCHS_ROAD]))!;
    expect(mixed).toMatch(/^Сводки \(КБГС РАН, Турпортал края, МЧС\) о вулканах — Шивелуч: /);
    expect(isOfferingNote(mixed)).toBe(false);
  });
});

describe('блок промпта', () => {
  const ws = warningsFromRows([KBGS_ROW, PORTAL_ROW, MCHS_ROAD, NOBODY_ROW]);
  const block = formatWarningBlock(ws);

  it('строка несёт «кто сообщил», модели сказано не подписывать чужое «МЧС»', () => {
    expect(block).toContain('| сообщил КБГС РАН');
    expect(block).toContain('| сообщил Турпортал края');
    expect(block).toContain('| сообщил МЧС');
    expect(block).toMatch(/не подписывай «МЧС» строку турпортала или КБГС РАН/);
    expect(block).not.toMatch(/^ПРЕДУПРЕЖДЕНИЯ МЧС/m);
  });

  it('разбор возвращает того же, кто сообщил; не узнанный остаётся не узнанным', () => {
    const back = warningsFromBlock(block);
    expect(back.map((w) => w.speaker ?? null)).toEqual(['КБГС РАН', 'Турпортал края', 'МЧС', null]);
    expect(back.map(offeringSentence)).toEqual(ws.map(offeringSentence));
  });
});
