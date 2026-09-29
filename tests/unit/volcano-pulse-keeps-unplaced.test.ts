// @vitest-environment node
/**
 * Сторож: «Пульс вулканов» не теряет вулкан оттого, что ему нет места в каталоге.
 *
 * ── Что нашлось 29.09 (сверка каналов MCP и сайта) ────────────────────────
 *
 * MCP `get_volcano_status` называл Чикурачки оранжевым по KVERT. Пульс на
 * /safety — нет: «под наблюдением 18» против 20 у MCP, «повышенный код у 4»
 * против пяти. Причина — внутреннее соединение с `places`: вулкан, которому
 * не нашлось ВИДИМОГО места (Чикурачки — на Парамушире), отбрасывался молча.
 * Оранжевый код исчезал с экрана безопасности из-за пробела в каталоге, а не
 * из-за спокойствия вулкана — тот же класс, что радар главной 02.09, где
 * непривязанный опасный код объявили `degraded`. Пульс тот урок пропустил.
 *
 * Проверено на настоящем PostgreSQL (сцена: оранжевый без места, жёлтый со
 * скрытым местом, зелёный со своим): старый запрос вернул 2 строки из 4
 * нужных, новый — 4, оранжевый первым.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*--.*$/gm, '');

const DATA = code(read('app/_home/data.ts'));
const PULSE = (() => {
  const at = DATA.indexOf('async function fetchVolcanoPulse');
  expect(at, 'fetchVolcanoPulse не найден').toBeGreaterThan(-1);
  return DATA.slice(at, DATA.indexOf('export async function getSafetyLiveData', at));
})();
const UI = code(read('components/safety/LiveStatus.tsx'));

describe('пульс не отбрасывает вулкан без места', () => {
  it('места присоединяются слева, а не внутренним соединением', () => {
    expect(PULSE, 'внутреннее соединение вернулось — вулкан без места снова пропадёт')
      .not.toMatch(/(?<!LEFT )JOIN places p ON vs\.place_ark_id/);
    expect(PULSE).toMatch(/LEFT JOIN places p ON vs\.place_ark_id = p\.ark_id AND p\.is_visible = TRUE/);
  });

  it('видимость места — условие соединения, а не отбора строк', () => {
    // В WHERE она снова превратила бы левое соединение во внутреннее.
    expect(PULSE, 'p.is_visible снова в WHERE').not.toMatch(/WHERE\s+p\.is_visible/);
  });

  it('при отсутствии места имя берётся из KVERT', () => {
    expect(PULSE).toMatch(/COALESCE\(p\.name, vs\.volcano_name\)/);
  });

  it('латиница KVERT переводится общей таблицей алиасов, а не новым словарём', () => {
    expect(PULSE).toMatch(/normalizeVolcanoName\(r\.name\)\?\.ru \?\? r\.name/);
  });

  it('при LIMIT свежий зелёный не вытесняет оранжевый', () => {
    const order = PULSE.slice(PULSE.indexOf('ORDER BY'), PULSE.indexOf('LIMIT 24'));
    expect(order).toMatch(/WHEN 'orange' THEN 2/);
    expect(order.indexOf('CASE')).toBeLessThan(order.indexOf('observed_at'));
  });

  it('неприсвоенный код по-прежнему не входит', () => {
    expect(PULSE).toMatch(/aviation_color_code <> 'unassigned'/);
  });
});

describe('экран умеет вулкан без места', () => {
  it('тип допускает отсутствие места', () => {
    expect(read('app/_home/data.ts')).toMatch(/placeId: string \| null;/);
    expect(read('components/safety/LiveStatus.tsx')).toMatch(/placeId: string \| null; acc: string;/);
  });

  it('ссылка на /places/null не строится', () => {
    // `href={`/places/${null}`}` вёл бы на несуществующую страницу.
    expect(UI).not.toMatch(/href=\{`\/places\/\$\{selected\.placeId\}`\}/);
    expect(UI).toMatch(/placeId\s*\?\s*<a className="psel" href=\{`\/places\/\$\{placeId\}`\}>/);
  });

  it('ключ столбика не «null» у нескольких вулканов сразу', () => {
    expect(UI).toMatch(/key=\{v\.placeId \?\? v\.name\}/);
  });
});
