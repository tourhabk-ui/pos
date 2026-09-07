/**
 * Кабинет оператора говорит правду о витринах.
 *
 * Третье расхождение, найденное 04.09 (после переписи и лент). Кабинет считал
 * тур полным при описании в ДВАДЦАТЬ знаков, а витрины требуют триста и
 * вдобавок ответ «как турист попадает на тур» и условия отмены. Про эти два
 * поля кабинет не знал вовсе.
 *
 * Значит оператор открывал свою страницу, видел «сто процентов, всё
 * заполнено» — и его тур молча не уходил ни на Авито, ни в Яндекс. Экран,
 * который говорит «готово» там, где не готово, хуже отсутствующего: он не
 * просто молчит о работе, он сообщает, что работы нет.
 *
 * Чинится не новым порогом в кабинете, а общим правилом: судит то же
 * missingFields, которым отбирают ленты. Два правила разошлись бы снова.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingFields, blockerLabel, BLOCKER_LABELS, MIN_DESCRIPTION_CHARS, type ReadinessRow } from '@/lib/tours/readiness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const API = read('app/api/operator/completeness/route.ts');
const UI = read('app/hub/operator/completeness/_CompletenessClient.tsx');

describe('кабинет судит тем же правилом, что и витрина', () => {
  it('зовёт общее missingFields, а не свой порог', () => {
    expect(API).toMatch(/from '@\/lib\/tours\/readiness'/);
    expect(API).toMatch(/const marketplaceBlockers = missingFields\(/);
  });

  it('старый порог в двадцать знаков остаётся только для «заполненности карточки»', () => {
    // Он не выкидывается: заполненность карточки — свой, более мягкий вопрос.
    // Но витринную готовность он больше не решает.
    expect(API).toMatch(/tour\.description\.length >= 20/);
    expect(MIN_DESCRIPTION_CHARS).toBe(300);
  });

  it('читает поля витринной готовности из базы', () => {
    for (const col of ['ot.pickup_type', 'pickup_details_chars', 'has_cancellation_policy', 'has_operator_contact']) {
      expect(API, `кабинет не читает ${col}`).toContain(col);
    }
  });
});

describe('блокеры названы человеческими словами', () => {
  it('оператору говорят, что сделать, а не какого поля нет в базе', () => {
    expect(blockerLabel('pickup')).toMatch(/заберёте, встретите или он едет сам/);
    expect(blockerLabel('description')).toContain(String(MIN_DESCRIPTION_CHARS));
    expect(blockerLabel('operator_contact')).toMatch(/профиле компании/);
  });

  it('у каждого блокера правила есть формулировка', () => {
    const allBlockers: ReadinessRow = {
      id: 1, title: '', operator_id: null, operator_name: null,
      description_chars: 0, photo_count: 0, base_price: null, duration_hours: null,
      pickup_type: null, pickup_details_chars: 0, has_meeting_point: false,
      has_cancellation_policy: false, has_coords: false, has_operator_contact: false,
      included_count: 0, program_steps: 0,
    };
    for (const f of missingFields(allBlockers)) {
      expect(BLOCKER_LABELS[f], `блокер «${f}» показался бы оператору кодовым именем`).toBeTruthy();
    }
  });

  it('незнакомый код показывается как есть, а не прячется', () => {
    expect(blockerLabel('что-то новое')).toBe('что-то новое');
  });
});

describe('экран не говорит «готово» там, где не готово', () => {
  it('витрины показаны отдельной строкой и до заполненности карточки', () => {
    expect(UI).toMatch(/marketplace_ready/);
    expect(UI).toMatch(/Не уйдёт на Авито и Яндекс/);
    expect(UI).toMatch(/Готов к выкладке на Авито и Яндекс/);
    // Блок стоит ПЕРЕД обязательными полями: это ответ на вопрос «почему
    // моего тура нет на площадках», и он важнее процента заполненности.
    expect(UI.indexOf('marketplace_blockers')).toBeLessThan(UI.indexOf('missing_required.length > 0'));
  });

  it('тур со стознаковым описанием и без ответа о трансфере — не готов', () => {
    const almost: ReadinessRow = {
      id: 1, title: 'Рыбалка', operator_id: null, operator_name: null,
      description_chars: 100, photo_count: 4, base_price: 25000, duration_hours: 8,
      pickup_type: null, pickup_details_chars: 0, has_meeting_point: false,
      has_cancellation_policy: true, has_coords: true, has_operator_contact: true,
      included_count: 3, program_steps: 2,
    };
    const blockers = missingFields(almost);
    expect(blockers).toContain('description');
    expect(blockers).toContain('pickup');
    // Именно такой тур кабинет раньше показывал как полностью заполненный:
    // 100 знаков больше двадцати.
    expect(almost.description_chars).toBeGreaterThan(20);
  });
});
