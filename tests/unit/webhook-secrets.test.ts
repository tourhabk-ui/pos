// @vitest-environment node
/**
 * Секрет вебхука сравнивается по постоянному времени и не пропускается,
 * когда его нет.
 *
 * Разбор периметра, последняя партия (07.09). Два вебхука, две разные беды.
 *
 * `/api/webhooks/travelpayouts` сравнивал токен через `!==`. Обычное
 * сравнение строк выходит на первом несовпавшем байте, и токен подбирается
 * побайтно по времени ответа. Здесь это дорого не абстрактно: ниже по коду
 * INSERT в `affiliate_payouts`, то есть подделанный запрос заводит строку о
 * выплате.
 *
 * `/api/bots/reposter/webhook` хуже: проверка стояла ВНУТРИ `if (secret)`.
 * Не задана переменная — разбор пропускался целиком, и адрес принимал что
 * угодно от кого угодно. Отказ в открытую сторону: защита исчезала ровно
 * тогда, когда её забыли настроить, а сервис при этом отвечал 200. Принимает
 * он обновление Telegram, из которого собирается пост в канал, — то есть
 * подделка означает чужой текст в нашем канале.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const TP = code('app/api/webhooks/travelpayouts/route.ts');
const REPOSTER = code('app/api/bots/reposter/webhook/route.ts');
const HEALTH = code('app/api/cron/health/route.ts');

describe('сравнение секрета — по постоянному времени', () => {
  for (const [name, src] of [['travelpayouts', TP], ['reposter', REPOSTER]] as const) {
    it(`${name}: используется общая функция, а не оператор`, () => {
      expect(src).toContain('timingSafeCompare');
      expect(src, 'сравнение оператором подбирается побайтно по времени ответа')
        .not.toMatch(/headers\.get\([^)]*\)[^\n]*!==/);
    });
  }
});

describe('нет секрета — отказ, а не пропуск', () => {
  it('reposter не пропускает проверку при пустой переменной', () => {
    // Ловится сама форма дефекта: проверка, спрятанная внутрь `if (secret)`,
    // исчезает вместе с переменной.
    expect(REPOSTER, 'проверка внутри if (secret) — отказ в открытую сторону')
      .not.toMatch(/if\s*\(\s*secret\s*\)\s*\{/);
    expect(REPOSTER).toMatch(/if\s*\(\s*!secret\s*\)/);
    // «Не настроено» — про нас, а не про вызывающего: 503, не 403.
    expect(REPOSTER).toMatch(/status:\s*503/);
  });

  it('travelpayouts тоже отказывает без токена', () => {
    expect(TP).toMatch(/!TP_WEBHOOK_TOKEN/);
  });

  it('секреты вебхуков свои, а не общие с кроном', () => {
    for (const [name, src] of [['travelpayouts', TP], ['reposter', REPOSTER]] as const) {
      expect(src, `${name}: общий секрет связал бы поворот крона с приёмом`)
        .not.toContain('CRON_SECRET');
    }
  });
});

describe('подтверждение прав в Вебмастере видно снаружи', () => {
  /**
   * Мета-тег код отдаёт всегда (app/layout.tsx, verification.yandex), но
   * только когда задана переменная — иначе Next не печатает тег молча. Без
   * подтверждения Вебмастер не считает сайт нашим, и «мало трафика»
   * становится неотличимо от «нас не индексируют».
   */
  it('health сообщает наличие переменной, а не её значение', () => {
    expect(HEALTH).toMatch(/yandex_verification:\s*!!process\.env\.YANDEX_VERIFICATION/);
  });
});
