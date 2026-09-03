// @vitest-environment node
/**
 * Условия отмены и возврата у тура (миграция 931, 03.09).
 *
 * До этого поля не было в схеме вообще (перепись channel-readiness 23.08), и
 * Кузьмичу на «а если отменю» было нечем ответить, кроме выдумки. Сверка с
 * blueprint commerce-agents: вопрос про отмену — базовый поток шопинг-агента,
 * и отвечать на него он обязан из каталога.
 *
 * Сторож держит цепочку целиком: колонка в миграции; поле в запросе карточки
 * и в самой карточке (блок только при наличии); оператор может записать
 * (форма + allow-list PATCH); Кузьмич берёт из данных, а без записи говорит,
 * что условий нет, — третье состояние, не «без условий».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('колонка и чтение', () => {
  it('миграция 931 заводит колонку идемпотентно', () => {
    const m = read('migrations/931_operator_tours_cancellation_policy.sql');
    expect(m).toMatch(/ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS cancellation_policy TEXT/);
  });

  it('запрос карточки и тип строки несут поле', () => {
    const q = read('lib/tours/tour-detail-query.ts');
    expect(q).toMatch(/cancellation_policy: string \| null/);
    expect(q).toMatch(/ot\.cancellation_policy,/);
  });
});

describe('карточка тура', () => {
  const card = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');

  it('блок «Отмена и возврат» только при записи оператора', () => {
    expect(card).toMatch(/\{tour\.cancellation_policy && \(/);
    expect(card).toMatch(/Отмена и возврат/);
  });

  it('никаких условий по умолчанию — карточка не пишет «обычно возвращают»', () => {
    expect(card).not.toMatch(/обычно возвращ/i);
  });
});

describe('оператор может записать', () => {
  it('форма редактирования: поле, пустая строка сохраняется как NULL', () => {
    const form = read('app/hub/operator/tours/[id]/_EditTourClient.tsx');
    expect(form).toMatch(/Условия отмены и возврата/);
    expect(form).toMatch(/cancellation_policy: form\.cancellation_policy\.trim\(\) \|\| null/);
  });

  it('PATCH принимает поле по allow-list', () => {
    const route = read('app/api/hub/operator/tours/[id]/route.ts');
    expect(route).toMatch(/'cancellation_policy',/);
  });
});

describe('Кузьмич — из данных, с третьим состоянием', () => {
  const core = read('lib/kuzmich/core.ts');

  it('get_tour_details читает колонку и отдаёт её модели с запретом выдумывать', () => {
    expect(core).toMatch(/what_to_bring, cancellation_policy, location_name/);
    expect(core).toMatch(/Условия отмены и возврата \(бери ТОЛЬКО отсюда, не выдумывай\)/);
  });

  it('нет записи — модель обязана сказать, что условий нет, а не молчать', () => {
    expect(core).toMatch(/Условия отмены и возврата у этого тура НЕ ЗАПИСАНЫ/);
  });
});

describe('перепись готовности', () => {
  it('поле переехало из пробелов схемы в пробелы данных', () => {
    const r = read('app/api/cron/channel-readiness/route.ts');
    expect(r).toMatch(/AS has_cancellation_policy/);
    expect(r).toMatch(/missing\.push\('cancellation_policy'\)/);
    expect(r).not.toMatch(/\{ field: 'cancellation_policy'/);
  });
});
