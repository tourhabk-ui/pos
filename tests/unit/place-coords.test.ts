/**
 * Правка координаты места — обещания актуатора.
 *
 * Координата отвечает на вопрос «где я», и сдвинутая ведёт человека в
 * другое место. Поэтому у правки обязан быть источник, причина, сухой
 * прогон и обратный ход, а конверт края не должен выдаваться за
 * проверку правды: 156.2 на широте 54.6 лежит внутри конверта и при
 * этом в Охотском море.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/place-coords/route.ts'), 'utf-8');

describe('актуатор координат места', () => {
  it('источник и причина обязательны — без них правка неотличима от выдумки', () => {
    expect(SRC).toMatch(/source:\s*z\.string\(\)\.min\(8/);
    expect(SRC).toMatch(/why:\s*z\.string\(\)\.min\(8/);
    // Ни у того, ни у другого нет умолчания — умолчание здесь и есть выдумка.
    expect(SRC).not.toMatch(/source:[^\n]*\.default\(/);
    expect(SRC).not.toMatch(/why:[^\n]*\.default\(/);
  });

  it('сухой прогон по умолчанию, боевая партия ограничена десятью', () => {
    expect(SRC).toMatch(/dry_run:\s*z\.boolean\(\)\.default\(true\)/);
    expect(SRC).toContain('LIVE_BATCH_MAX = 10');
    expect(SRC).toMatch(/!data\.dry_run && data\.fixes\.length > LIVE_BATCH_MAX/);
  });

  it('старая координата возвращается — это обратный ход', () => {
    expect(SRC).toMatch(/from:\s*\{\s*lat: oldLat, lng: oldLng\s*\}/);
    expect(SRC).toContain('movedKm');
  });

  it('пишет только в живое место и только координату', () => {
    expect(SRC).toMatch(/UPDATE places[\s\S]{0,200}is_visible = true/);
    expect(SRC).toMatch(/UPDATE places[\s\S]{0,200}merged_into_id IS NULL/);
    // Никаких попутных полей: правка координаты не переписывает описание.
    expect(SRC).not.toMatch(/UPDATE places[\s\S]{0,200}description\s*=/);
  });

  it('строка, которая не обновилась, попадает в отчёт, а не молчит', () => {
    expect(SRC).toContain('строка не обновилась');
  });

  it('конверт края назван грубым фильтром, а не проверкой правды', () => {
    // Сам конверт есть...
    expect(SRC).toContain('KRAI_LAT_MIN');
    expect(SRC).toContain('KRAI_LNG_MAX');
    // ...и в шапке сказано, что случай Тюшевских он не ловит: место в
    // море, но внутри конверта. Иначе через месяц кто-нибудь решит, что
    // координаты проверены.
    expect(SRC).toMatch(/НЕ ловит|не ловит/);
  });

  it('параметризованный SQL, без конкатенации', () => {
    expect(SRC).toMatch(/\$1/);
    expect(SRC).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*(WHERE|SET)/);
  });
});
