import { describe, it, expect } from 'vitest';
import { buildRoutePhotoUrl } from '@/lib/notifications/telegram-channel';

// Тип строки поста Кузьмича (подмножество полей, нужных для фото).
type Row = Parameters<typeof buildRoutePhotoUrl>[0];
const row = (p: Partial<Row>): Row => ({
  id: '00000000-0000-0000-0000-000000000000',
  title: 'Тест',
  description: null,
  location_type: null,
  activity_type: null,
  zone: null,
  kuzmich_review: null,
  lat: null,
  lng: null,
  has_track: false,
  ...p,
});

describe('buildRoutePhotoUrl: пост Кузьмича всегда с честным фото, не текстом', () => {
  it('тип локации → реальное куратор-фото Камчатки (не карта, не AI)', () => {
    // Кейс владельца «Большой Калыгирь» — озеро: раньше пост уходил без фото.
    const url = buildRoutePhotoUrl(row({ location_type: 'lake', lat: 55, lng: 160 }));
    expect(url).toContain('/images/');
    expect(url).not.toContain('static-maps'); // фото приоритетнее карты
    expect(url).not.toContain('pollinations'); // без AI-генерации
  });

  it('вулкан/термы/бухта — из куратор-набора', () => {
    expect(buildRoutePhotoUrl(row({ location_type: 'volcano' }))).toContain('/images/categories/vulkany.jpg');
    expect(buildRoutePhotoUrl(row({ location_type: 'hot_spring' }))).toContain('/images/categories/termy.jpg');
    expect(buildRoutePhotoUrl(row({ location_type: 'bay' }))).toContain('/images/categories/morskie.jpg');
  });

  it('нет типа локации, но есть активность → фото активности', () => {
    const url = buildRoutePhotoUrl(row({ activity_type: 'fishing' }));
    expect(url).toContain('/images/activities/fishing.jpg');
  });

  it('нет ни типа, ни активности, но есть координаты → карта (крайний случай)', () => {
    const url = buildRoutePhotoUrl(row({ lat: 53.25, lng: 158.83 }));
    expect(url).toContain('static-maps.yandex.ru');
    expect(url).toContain('158.83,53.25');
  });

  it('нет вообще ничего → null (тогда пост уйдёт текстом, редкий случай)', () => {
    expect(buildRoutePhotoUrl(row({}))).toBeNull();
  });
});
