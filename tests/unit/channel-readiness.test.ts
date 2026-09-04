/**
 * Перепись готовности туров к чужой витрине.
 *
 * Разговор про Trip.com упирается в цифру, которой ни у кого нет: сколько
 * туров вообще можно показать. Здесь проверяется, что перепись считает
 * ГОДНОСТЬ, а не строки, и что она не выдаёт ожидание за факт.
 */
import { describe, it, expect } from 'vitest';
import {
  missingFields, SCHEMA_GAPS, MIN_DESCRIPTION_CHARS, type ReadinessRow,
} from '@/app/api/cron/channel-readiness/route';

const full: ReadinessRow = {
  id: 1,
  title: 'Восхождение на Авачинский',
  description_chars: 900,
  photo_count: 5,
  base_price: 12000,
  duration_hours: 10,
  // 932: ответ на вопрос «как турист попадает на тур». `has_meeting_point`
  // остаётся рядом и отвечает на другой вопрос — есть ли текст точки сбора.
  pickup_type: 'meeting_point',
  pickup_details_chars: 40,
  has_meeting_point: true,
  has_cancellation_policy: true,
  has_coords: true,
  has_operator_contact: true,
  included_count: 4,
  program_steps: 3,
};

describe('чего не хватает туру', () => {
  it('полный тур годен', () => {
    expect(missingFields(full)).toEqual([]);
  });

  it('описание короче порога Editor’а — блокирует', () => {
    expect(missingFields({ ...full, description_chars: MIN_DESCRIPTION_CHARS - 1 }))
      .toContain('description');
    expect(missingFields({ ...full, description_chars: MIN_DESCRIPTION_CHARS }))
      .not.toContain('description');
  });

  it('без единого фото — блокирует', () => {
    expect(missingFields({ ...full, photo_count: 0 })).toContain('photos');
  });

  it('цена ноль — это отсутствие цены, а не бесплатный тур', () => {
    expect(missingFields({ ...full, base_price: 0 })).toContain('base_price');
    expect(missingFields({ ...full, base_price: null })).toContain('base_price');
  });

  it('как турист попадает на тур, координаты и контакт оператора обязательны', () => {
    // Не «точка сбора»: операторы забирают туристов сами (поправка владельца
    // 23.08). Пустое поле значит «не записано, как турист попадает на тур», а
    // не «оператор забыл» — и чинится это одной фразой на оператора.
    //
    // С 932 судим по pickup_type, а не по тексту точки сбора: прежняя проверка
    // требовала выдумать точку сбора там, где оператора забирает от отеля.
    expect(missingFields({ ...full, pickup_type: null })).toContain('pickup');
    // Текст точки сбора сам по себе больше ничего не решает.
    expect(missingFields({ ...full, has_meeting_point: false })).toEqual([]);
    // «Заберут» и «встречаемся» без подробностей покупателю бесполезны, а
    // «добирается сам» — нет: куда ехать, отвечают координаты тура.
    expect(missingFields({ ...full, pickup_type: 'hotel_pickup', pickup_details_chars: 0 })).toContain('pickup_details');
    expect(missingFields({ ...full, pickup_type: 'self_drive', pickup_details_chars: 0 })).toEqual([]);
    expect(missingFields({ ...full, has_coords: false })).toContain('coordinates');
    expect(missingFields({ ...full, has_operator_contact: false })).toContain('operator_contact');
  });

  it('условия отмены обязательны — с 931 это пробел данных, а не схемы', () => {
    // Покупатель на чужой витрине обязан знать, что будет с деньгами при
    // отмене; пустое поле — «не записано», и публиковать это нельзя.
    expect(missingFields({ ...full, has_cancellation_policy: false })).toContain('cancellation_policy');
  });

  it('программа и состав включённого НЕ блокируют — про них витрина не обязана спрашивать', () => {
    // Их отсутствие видно в ответе отдельными числами, но выдавать своё
    // ожидание за требование площадки нельзя: правил Trip.com мы не читали.
    expect(missingFields({ ...full, program_steps: 0, included_count: 0 })).toEqual([]);
  });

  it('каждое пропущенное поле названо ровно один раз', () => {
    const empty: ReadinessRow = {
      ...full, title: '  ', description_chars: 0, photo_count: 0, base_price: null,
      duration_hours: null, pickup_type: null, pickup_details_chars: 0,
      has_meeting_point: false, has_cancellation_policy: false,
      has_coords: false, has_operator_contact: false,
    };
    const missing = missingFields(empty);
    expect(new Set(missing).size).toBe(missing.length);
    expect(missing.length).toBe(9);
  });
});

describe('чего перепись не знает — названо вслух', () => {
  it('поля без колонок перечислены отдельно от нехватки данных', () => {
    const fields = SCHEMA_GAPS.map((g) => g.field);
    expect(fields).toContain('language');
    // 03.09: колонка заведена (931) — поле больше не пробел схемы. Держим,
    // чтобы список пробелов только сокращался, а не жил по памяти.
    expect(fields).not.toContain('cancellation_policy');
    expect(fields).toContain('instant_confirmation');
  });

  it('ни одно из них не считается блокирующим полем тура', () => {
    // Это факт о СХЕМЕ, а не о данных: такие поля нельзя заполнить, их надо
    // заводить. Смешать их с нехваткой данных значило бы обещать работу,
    // которой не существует.
    const blocking = missingFields({
      ...full, pickup_type: null,
    });
    for (const g of SCHEMA_GAPS) expect(blocking).not.toContain(g.field);
  });
});
