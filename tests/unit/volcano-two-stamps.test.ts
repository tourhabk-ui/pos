/**
 * Сторож двух отметок КВЕРТ.
 *
 * Владелец 15.09 увидел на safety-экране «Источник: КВЕРТ (вулканы) —
 * обновлено 4 дн назад» и спросил, что это значит. Правильного ответа на
 * экране не было: одна строка покрывала два несовместимых состояния —
 *
 *   «КВЕРТ четвёртый день не публикует наблюдений» — тишина на вулканах,
 *   данные верны, делать нечего;
 *   «наш синк четвёртый день лежит» — цвет на экране может быть любым, и
 *   «Опасность: Высокая» под этой же строкой посчитана по протухшему.
 *
 * Различить их обязан именно safety-экран. Поэтому отметки две, и они
 * называются разными словами: наблюдение — `observed_at` (время КВЕРТ),
 * опрос — `updated_at` (его ставит синк на КАЖДОМ прогоне, даже когда
 * ничего не изменилось).
 *
 * Тот же класс, что разбор 07.09: одна цифра на четыре источника.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dataSrc = readFileSync(join(root, 'app/_home/data.ts'), 'utf8');
const screenSrc = readFileSync(join(root, 'app/safety/_SafetyClient.tsx'), 'utf8');

/**
 * Якорь — НАПЕЧАТАННАЯ строка, а не слово «КВЕРТ»: разбор в комментарии выше
 * неё цитирует прежнюю формулировку, и поиск по имени источника попадал бы в
 * объяснение вместо кода.
 */
const PRINTED = 'КВЕРТ (вулканы): наблюдение';

describe('две отметки КВЕРТ: наблюдение и опрос', () => {
  it('срез вулканов несёт ОБЕ отметки — иначе экрану нечем их различить', () => {
    const snapshot = dataSrc.slice(
      dataSrc.indexOf('export interface VolcanoSnapshot'),
      dataSrc.indexOf('export type HazardLevel'),
    );
    expect(snapshot).toContain('updatedAt');
    expect(snapshot).toContain('checkedAt');
  });

  it('время опроса берётся из updated_at, а не из observed_at', () => {
    const q = dataSrc.slice(
      dataSrc.indexOf('async function fetchVolcanoPulse'),
      dataSrc.indexOf('export async function getSafetyLiveData'),
    );
    // Отметка опроса обязана приходить из СВОЕЙ колонки: взять её из
    // observed_at значило бы отчитаться о проверке, которой не было.
    expect(q).toMatch(/vs\.updated_at::text\s+AS\s+checked_at/);
    expect(q).toContain('checkedAt');
  });

  it('отказ запроса гасит ОБЕ отметки, а не только одну', () => {
    const fallback = dataSrc.slice(
      dataSrc.indexOf('пульс вулканов не выбрался'),
      dataSrc.indexOf('export async function getSafetyLiveData'),
    );
    // «Не смогли спросить» не равно «спросили только что» (§4.0).
    expect(fallback).toMatch(/updatedAt:\s*null/);
    expect(fallback).toMatch(/checkedAt:\s*null/);
  });

  it('экран печатает обе отметки разными словами', () => {
    const line = screenSrc.slice(
      screenSrc.indexOf(PRINTED),
      screenSrc.indexOf(PRINTED) + 600,
    );
    expect(line).toContain('наблюдение');
    expect(line).toContain('спросили');
    expect(line).toContain('volcanoes.updatedAt');
    expect(line).toContain('volcanoes.checkedAt');
  });

  it('отсутствие отметки говорится словами, а не подменяется свежестью', () => {
    const line = screenSrc.slice(
      screenSrc.indexOf(PRINTED),
      screenSrc.indexOf(PRINTED) + 600,
    );
    // Пустая строка на месте возраста читалась бы как «только что».
    expect(line).toContain('без даты');
    expect(line).toContain('неизвестно когда');
  });
});
