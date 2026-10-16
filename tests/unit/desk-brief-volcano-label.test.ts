// @vitest-environment node
/**
 * «Что меняет план» на десктоп-главной: как читается вулканическая запись,
 * которая не про извержение (16.10, сводка минтуризма, миграция 1298).
 *
 * Тип volcanic_eruption несёт и извержения из сводок вулканологов, и запреты
 * подходить к вулкану: разбор МЧС и Минтура («не рекомендуется приближаться»,
 * «риск обвалов») и ручную запись сводки. Подпись «извержение» у строки
 * «Вулкан Мутновский: приближаться не рекомендуется» была бы неправдой:
 * Мутновский 16.10 по KVERT зелёный, и запрет — от министерства, а не от
 * вулканологов.
 *
 * Сторож вызывает загрузчик строк на данных в том виде, в каком их отдаёт
 * база (правило 13.10: поведение, а не текст исходника).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...args: unknown[]) => query(...args) }));

import { loadPlanChanges } from '@/lib/home/desk-brief';

function row(over: Record<string, unknown>) {
  return { description: null, created_iso: '2026-10-16T06:00:00.000Z', source_url: null, ...over };
}

describe('«Что меняет план»: вулканическая запись', () => {
  beforeEach(() => query.mockReset());

  it('запрет из сводки — «вулкан», с местом, сутью, сроком ленты и происхождением', async () => {
    query.mockResolvedValueOnce({ rows: [row({
      title: 'Вулкан Мутновский: приближаться не рекомендуется',
      alert_type: 'volcanic_eruption',
      expires_iso: '2026-10-23T11:59:00.000Z',
      external_id: 'manual-mintur-2026-10-16-mutnovsky',
    })] });

    const rows = await loadPlanChanges();
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({
      place: 'Вулкан Мутновский',
      what: 'приближаться не рекомендуется',
      kind: 'volcano',
      kindLabel: 'вулкан',
      origin: 'ручная запись администратора Ведара',
    });
    // 11:59 UTC — конец 23 октября по Камчатке: подпись не уезжает на 24-е.
    expect(rows![0].term).toMatch(/^в ленте до 23 октября/);
  });

  it('извержение из ленты вулканологов называет сам заголовок, подпись та же', async () => {
    query.mockResolvedValueOnce({ rows: [row({
      title: 'Извержение вулкана Шивелуч — высота 10.0 км',
      alert_type: 'volcanic_eruption',
      expires_iso: '2026-10-17T06:00:00.000Z',
      external_id: 't.me/kbgsras/9999',
    })] });

    const rows = await loadPlanChanges();
    expect(rows![0]).toMatchObject({
      place: 'Извержение вулкана Шивелуч',
      what: 'высота 10.0 км',
      kind: 'volcano',
      kindLabel: 'вулкан',
      origin: 'КБГС РАН',
    });
  });

  it('у записей сводки минтуризма подписи по роду: парк, вулкан, дороги', async () => {
    const until = '2026-10-23T11:59:00.000Z';
    query.mockResolvedValueOnce({ rows: [
      row({ title: 'Парк «Ключевской»: маршруты закрыты на зимний сезон', alert_type: 'park_closure', expires_iso: until, external_id: 'manual-mintur-2026-10-16-klyuchevskoy-park' }),
      row({ title: 'Вулкан Крашенинникова: приближаться не рекомендуется', alert_type: 'volcanic_eruption', expires_iso: until, external_id: 'manual-mintur-2026-10-16-krasheninnikov' }),
      row({ title: 'Мыс Левашова (п. Октябрьский): проезд запрещён', alert_type: 'road_closure', expires_iso: until, external_id: 'manual-mintur-2026-10-16-levashov-cape' }),
    ] });

    const rows = (await loadPlanChanges())!;
    expect(rows.map((r) => [r.place, r.kindLabel])).toEqual([
      ['Парк «Ключевской»', 'парк закрыт'],
      ['Вулкан Крашенинникова', 'вулкан'],
      ['Мыс Левашова (п. Октябрьский)', 'дороги'],
    ]);
    expect(rows.map((r) => r.kindLabel)).not.toContain('извержение');
  });
});
