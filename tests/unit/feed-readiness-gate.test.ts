/**
 * На чужую витрину уходят только готовые туры.
 *
 * Дыра, найденная 04.09. Перепись готовности (channel-readiness) считала, чего
 * туру не хватает для выкладки, и держала `pickup` и короткое описание в
 * блокерах у восьми туров из восьми. А обе ленты — Авито и Яндекс — отбирали
 * туры условием `is_active AND is_published` и ничем больше.
 *
 * То есть в день, когда владелец зарегистрировал бы фид на Авито (шаг 1 из
 * инструкции в панели каналов, «10 минут»), на чужую площадку уехали бы
 * карточки со стознаковым описанием и без ответа «как я туда попаду» — под
 * именем нашего оператора «Камчатская рыбалка». Правило существовало, но жило
 * в кроне, а каналы про него не знали.
 *
 * Сторож держит три вещи: правило одно на всех, ленты им пользуются,
 * придержанное называется вслух.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingFields, type ReadinessRow } from '@/lib/tours/readiness';
import { feedHeaders } from '@/lib/channels/ready-tours';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const AVITO = read('app/api/channels/avito/feed/route.ts');
const YANDEX = read('app/api/channels/yandex/feed/route.ts');
const SELECT = read('lib/channels/ready-tours.ts');
const CENSUS = read('app/api/cron/channel-readiness/route.ts');

describe('правило готовности одно на всех', () => {
  it('перепись не держит свою копию, а импортирует общее', () => {
    expect(CENSUS).toMatch(/from '@\/lib\/tours\/readiness'/);
    // Своей реализации в кроне не осталось — иначе правил снова стало бы два.
    expect(CENSUS, 'перепись снова считает готовность по-своему')
      .not.toMatch(/export function missingFields\(/);
  });

  it('обе ленты берут отбор из общего места, а не пишут SQL заново', () => {
    for (const [name, src] of [['avito', AVITO], ['yandex', YANDEX]] as const) {
      expect(src, `${name}: лента снова ходит в базу сама`).toMatch(/selectFeedTours\(\)/);
      expect(src, `${name}: в ленте остался свой запрос`).not.toMatch(/pool\.query/);
    }
  });

  it('старое условие «активен и опубликован» больше не единственное', () => {
    // Оно осталось в общем запросе как ПЕРВЫЙ фильтр, но решает не оно.
    expect(SELECT).toMatch(/ot\.is_active = true[\s\S]{0,80}ot\.is_published = true/);
    expect(SELECT).toMatch(/missingFields\(/);
    expect(SELECT).toMatch(/if \(missing\.length === 0\) \{ tours\.push/);
  });
});

describe('придержанное называется вслух', () => {
  it('счёт и причины уходят заголовками — молчание читалось бы как «туров мало»', () => {
    const h = feedHeaders({ tours: [], withheld: 3, reasons: ['description', 'pickup'] });
    expect(h['X-Withheld-Tours']).toBe('3');
    expect(h['X-Withheld-Reasons']).toBe('description,pickup');
  });

  it('ничего не придержано — так и сказано, а не пустой строкой', () => {
    expect(feedHeaders({ tours: [], withheld: 0, reasons: [] })['X-Withheld-Reasons']).toBe('none');
  });

  it('обе ленты эти заголовки отдают', () => {
    for (const [name, src] of [['avito', AVITO], ['yandex', YANDEX]] as const) {
      expect(src, `${name}: лента молчит о придержанных турах`).toMatch(/\.\.\.feedHeaders\(selection\)/);
    }
  });
});

describe('что именно не пройдёт на витрину', () => {
  const ready: ReadinessRow = {
    id: 1, title: 'Рыбалка на реке Камчатке', operator_id: null, operator_name: 'Камчатская рыбалка',
    description_chars: 900, photo_count: 6, base_price: 25000, duration_hours: 8,
    pickup_type: 'hotel_pickup', pickup_details_chars: 60, has_meeting_point: false,
    has_cancellation_policy: true, has_coords: true, has_operator_contact: true,
    included_count: 5, program_steps: 4,
  };

  it('готовый тур проходит', () => {
    expect(missingFields(ready)).toEqual([]);
  });

  it('стознаковое описание и отсутствие ответа «как попаду» — не проходят', () => {
    expect(missingFields({ ...ready, description_chars: 100 })).toContain('description');
    expect(missingFields({ ...ready, pickup_type: null })).toContain('pickup');
  });

  it('нет фото или нет контакта оператора — не проходят', () => {
    // Объявление без фото на Авито мёртвое, а без телефона лид уходит в никуда.
    expect(missingFields({ ...ready, photo_count: 0 })).toContain('photos');
    expect(missingFields({ ...ready, has_operator_contact: false })).toContain('operator_contact');
  });
});

describe('оба фида открыты Edge-гейтом — витрина не читает закрытую дверь', () => {
  // Замер 05.09 (prod-check run 11): Авито 200, Яндекс 401. Яндекса не было в
  // реестре публичных роутов, и «перечитывает фид раз в 24 часа» из шапки
  // роута относилось к двери, которую Edge держал закрытой.
  const REGISTRY = read('lib/auth/public-api-routes.ts');
  it('avito и yandex перечислены с GET', () => {
    expect(REGISTRY).toMatch(/'\/api\/channels\/avito\/feed':\s*\['GET'\]/);
    expect(REGISTRY).toMatch(/'\/api\/channels\/yandex\/feed':\s*\['GET'\]/);
  });
});

