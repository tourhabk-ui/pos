/**
 * Камеры вулканов КФ ФИЦ ЕГС РАН (kam.emsd.ru) — привязка к точкам.
 *
 * Владелец прислал источник живого видеонаблюдения за вулканами (01.08).
 * Ссылка показывается ТОЛЬКО на вулканах, которые реально под камерой, и
 * матчится по имени точки в разных падежах/формах. Внешний онлайн-ресурс:
 * ссылка, не iframe, не офлайн — сторож это фиксирует.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasVolcanoCamera, VOLCANO_CAMERAS_URL } from '@/lib/safety/volcano-cameras';

describe('hasVolcanoCamera — матч по покрытым вулканам', () => {
  it('покрытые вулканы в разных формах названия', () => {
    expect(hasVolcanoCamera('Авачинский')).toBe(true);
    expect(hasVolcanoCamera('Авачинская Сопка')).toBe(true);
    expect(hasVolcanoCamera('влк. Мутновский')).toBe(true);
    expect(hasVolcanoCamera('Ключевская Сопка')).toBe(true);
    expect(hasVolcanoCamera('вулкан Горелый')).toBe(true);
    expect(hasVolcanoCamera('Корякский')).toBe(true);
  });

  it('вулканы БЕЗ камеры не получают ссылку', () => {
    // Козельский, Вилючинский камерами КФ ФИЦ ЕГС РАН (в подтверждённом
    // списке 01.08) не покрыты — ссылки быть не должно.
    expect(hasVolcanoCamera('Козельский')).toBe(false);
    expect(hasVolcanoCamera('Вилючинский')).toBe(false);
  });

  it('не-вулканы и пустые имена — false', () => {
    expect(hasVolcanoCamera('Курильское озеро')).toBe(false);
    expect(hasVolcanoCamera(null)).toBe(false);
    expect(hasVolcanoCamera('')).toBe(false);
  });
});

describe('честность внешнего ресурса', () => {
  const client = readFileSync(join(process.cwd(), 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8');

  it('ссылка ведёт на канонную страницу камер, не выдуманный deep-link', () => {
    expect(VOLCANO_CAMERAS_URL).toBe('https://kam.emsd.ru/visual-observations/');
  });

  it('показывается только для вулканов под камерой', () => {
    expect(client).toMatch(/location[Tt]ype === 'volcano' && hasVolcanoCamera\(place\.name\)/);
  });

  it('внешний ресурс — ссылка, не iframe и не офлайн', () => {
    const mod = readFileSync(join(process.cwd(), 'lib/safety/volcano-cameras.ts'), 'utf-8');
    expect(mod, 'камеры не должны встраиваться iframe или прекэшироваться').not.toMatch(/<iframe|precache|CACHE_NAME/);
    expect(client).toMatch(/href=\{VOLCANO_CAMERAS_URL\}[\s\S]{0,120}target="_blank"/);
    expect(client, 'нет честной пометки про сеть').toMatch(/нужна сеть/);
  });
});
