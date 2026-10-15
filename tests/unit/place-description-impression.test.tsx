/**
 * Описание-впечатление помечено на карточке места так же, как у Кузьмича и
 * MCP (15.10, §0 «честность»).
 *
 * С 26.09 агентам такой текст отдаётся как «Описание (впечатление, не
 * наблюдение)» (lib/places/description-voice → describeForAgent), а карточка
 * печатала его справкой. Случай дня — «Озеро Кроноцкое»: «Тишину нарушает
 * лишь плеск нерпы, вынырнувшей в сотне шагов от лодки» — у пресного озера
 * и без единого источника. Снятие 1247 убрало только заметки от первого
 * лица; голос впечатления под него не попадал.
 *
 * Подпись — рендером; признак — вызовом загрузчика с подставной базой: голос
 * впечатления без источника — пометка есть; тот же голос с источником
 * (перевод GVP) — нет; справочный голос — нет.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import PlaceDescription from '@/components/places/PlaceDescription';

afterEach(cleanup);

const IMPRESSION = 'Тишину нарушает лишь плеск волны у берега, и туман лежит над водой.';
const PLAIN = 'Озеро лежит в кальдере, его площадь записана в справочнике.';

describe('блок описания', () => {
  it('впечатление — подписано словами', () => {
    const { container } = render(<PlaceDescription name="X" essence={null} description={IMPRESSION} impression placeId="p" />);
    expect(container.textContent).toContain('Описание написано как впечатление, а не по наблюдению: его подробности не сверены с источниками.');
  });

  it('справка — без подписи', () => {
    const { container } = render(<PlaceDescription name="X" essence={null} description={PLAIN} placeId="p" />);
    expect(container.textContent).not.toContain('впечатление');
  });
});

describe('загрузчик карточки', () => {
  const main = (over: Record<string, unknown>) => ({
    place_pk: 'test-place-0001', ark_id: '22222222-2222-2222-2222-222222222222', name: 'Озеро Тестовое',
    lat: 53, lng: 158, location_type: 'lake', photo_count: 0, ...over,
  });
  const load = async (row: Record<string, unknown>) => {
    vi.resetModules();
    vi.doMock('@/lib/database', () => ({
      query: async (sql: string) => ({ rows: /FROM places p\s+LEFT JOIN place_description_drafts/.test(sql) ? [row] : [] }),
    }));
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: async () => ({ rows: [] }) } }));
    const { loadPlaceDetail } = await import('@/lib/places/place-detail');
    const r = await loadPlaceDetail('test-place-0001', { countView: false });
    return (r.body.data as { descriptionImpression?: boolean }).descriptionImpression;
  };

  it('голос впечатления без источника — признак есть', async () => {
    expect(await load(main({ description: IMPRESSION }))).toBe(true);
  });

  it('тот же голос с записанным источником — признака нет', async () => {
    expect(await load(main({ description: IMPRESSION, description_source_ref: '300130' }))).toBe(false);
  });

  it('справочный голос — признака нет', async () => {
    expect(await load(main({ description: PLAIN }))).toBe(false);
  });
});
