/**
 * Кабинет оператора, туры — то, что оператор сохраняет, сохраняется
 * (аудит роли оператора 25.09).
 *
 * Главное: PATCH тура строился как CreateTourSchema.partial(), а Zod 4
 * применяет `.default()` и внутри `.partial()`. Кнопка «скрыть тур» или
 * правка мест переключали тур «за человека» на «за тур» и сбрасывали
 * погодные пороги; условия отмены, подвоз и публикация выбрасывались
 * молча — «Изменения сохранены», а в базе ничего.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreateTourSchema, UpdateTourSchema } from '@/lib/api/operator-tours';
import { categoryToTourTypes } from '@/lib/tours/form-category';
import { isQuickFillField, parseQuickFillValue } from '@/lib/operator/quick-fill-fields';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('PATCH тура: без умолчаний, без потерь', () => {
  it('частичная правка не подставляет единицу цены и погодные пороги', () => {
    const out = UpdateTourSchema.parse({ is_active: false });
    expect(out).toEqual({ is_active: false });
    expect(out).not.toHaveProperty('price_unit');
    expect(out).not.toHaveProperty('weather_dependent');
    expect(out).not.toHaveProperty('min_visibility_m');
  });

  it('поля формы редактора доходят до сервера', () => {
    const out = UpdateTourSchema.parse({
      is_active: true, is_published: true, seasonal_only: true,
      cancellation_policy: 'Бесплатная отмена за 3 дня', pickup_type: 'hotel_pickup', pickup_details: 'из отеля',
    });
    expect(out).toMatchObject({
      is_active: true, is_published: true, seasonal_only: true,
      cancellation_policy: 'Бесплатная отмена за 3 дня', pickup_type: 'hotel_pickup', pickup_details: 'из отеля',
    });
  });

  it('очистка условий и подвоза — null проходит', () => {
    expect(UpdateTourSchema.parse({ cancellation_policy: null, pickup_type: null })).toEqual({ cancellation_policy: null, pickup_type: null });
  });

  it('неизвестный подвоз отвергается, а не пишется', () => {
    expect(() => UpdateTourSchema.parse({ pickup_type: 'teleport' })).toThrow();
  });
});

describe('создание тура', () => {
  const base = { title: 'Сплав по реке Быстрая', location_type: 'river', activity_type: 'rafting', location_name: 'Камчатский край', base_price: 13000, max_participants: 12 };

  it('умолчание единицы — «за человека», как у колонки', () => {
    expect(CreateTourSchema.parse(base).price_unit).toBe('per_person');
  });

  it('координаты необязательны — без выдуманных 53.0/158.7', () => {
    const out = CreateTourSchema.parse(base);
    expect(out.latitude).toBeUndefined();
    expect(read('app/hub/operator/tours/new/_NewTourClient.tsx')).not.toMatch(/latitude:\s*53|longitude:\s*158/);
    expect(read('app/hub/operator/tours/_ToursManagementClient.tsx')).not.toMatch(/latitude:\s*53\.0|longitude:\s*158\.7/);
  });

  it('маршрут тура — route_id, и createTour его пишет', () => {
    expect(CreateTourSchema.parse({ ...base, route_id: '00000000-0000-4000-8000-000000000000' }).route_id).toBeDefined();
    expect(read('lib/api/operator-tours.ts')).toMatch(/created_by, route_id\n/);
    expect(read('app/hub/operator/tours/new/_NewTourClient.tsx')).toMatch(/route_id:\s+formData\.routeId/);
  });

  it('категория формы — тип активности/местности, а не «локация»', () => {
    expect(categoryToTourTypes('rybalka')).toEqual({ activity_type: 'fishing', location_type: 'river' });
    expect(categoryToTourTypes('splav')).toEqual({ activity_type: 'rafting', location_type: 'river' });
    expect(categoryToTourTypes('нет-такой')).toEqual({ activity_type: 'other', location_type: 'other' });
    expect(read('app/hub/operator/tours/new/_NewTourClient.tsx')).not.toMatch(/location_name:\s+formData\.category/);
  });

  it('тур из PDF: без выдуманной цены, переход на существующую страницу', () => {
    const c = read('app/hub/operator/tours/_ToursManagementClient.tsx');
    expect(c).not.toMatch(/base_price \?\? 1000/);
    expect(c).not.toMatch(/tours\/\$\{data\.data\.id\}\/edit/);
  });
});

describe('расписание', () => {
  const lib = read('lib/api/operator-tours.ts');
  const route = read('app/api/hub/operator/tours/[id]/availability/route.ts');

  it('повторно открытая дата открывается и туристу', () => {
    expect(lib).toMatch(/is_cancelled = FALSE, cancellation_reason = NULL, deleted_at = NULL/);
  });

  it('отменённая дата оператору не показывается открытой', () => {
    expect(lib).toMatch(/AND a\.is_cancelled IS NOT TRUE/);
  });

  it('GET расписания — только своего тура', () => {
    const get = route.slice(route.indexOf('export async function GET'));
    expect(get).toMatch(/tour\.operator_id !== operatorId/);
  });

  it('мёртвое поле «доступность для Кузьмича» снято', () => {
    expect(read('app/hub/operator/tours/_ToursManagementClient.tsx')).not.toMatch(/available_slots: slots, next_available_date/);
  });
});

describe('прочее', () => {
  it('главное фото каталога — первое фото галереи', () => {
    expect(read('app/api/hub/operator/tours/[id]/route.ts')).toMatch(/fields\.push\(`tour_image = \$\$\{idx\+\+\}`\)/);
  });

  it('публикация ставит is_published', () => {
    expect(read('app/api/operator/tours/[id]/publish/route.ts')).toMatch(/SET is_active = true, is_published = true/);
  });

  it('AI-автозаполнение пишет только в пустое и без координат', () => {
    const a = read('app/api/operator/tours/auto-fill-ai/route.ts');
    expect(a).toMatch(/fills\.included && isEmptyList\(tour\.included\)/);
    expect(a).toMatch(/fills\.notes && !tour\.notes/);
    expect(a).not.toMatch(/"latitude": 56/);
    expect(a).not.toMatch(/half_day \(2-4h\)/);
  });

  it('быстрое заполнение: одно правило полей на клиент и сервер, значения проверяются', () => {
    expect(isQuickFillField('included')).toBe(false);
    expect(isQuickFillField('base_price')).toBe(true);
    expect(parseQuickFillValue('price_unit', 'за всех').ok).toBe(false);
    expect(parseQuickFillValue('base_price', '-5').ok).toBe(false);
    expect(parseQuickFillValue('base_price', '13 000'.replace(' ', ''))).toEqual({ ok: true, value: 13000 });
    expect(read('app/hub/operator/completeness/_CompletenessClient.tsx')).toMatch(/!isQuickFillField\(field\)/);
  });
});
