/**
 * Пустой синк KVERT — отказ слоя, а не тихий день.
 *
 * 28 июля Шивелуч дважды выбросил пепел: на 8 км и на 12 км (Камчатский филиал
 * Геофизической службы РАН). В этот самый момент наш слой авиационных цветовых
 * кодов вулканов стоял мёртвым, и по логам это выглядело здоровьем:
 *
 *   {"success":true,"fetched":0,"upserted":0,"matched":0,"unmatched":[]}
 *
 * HTTP 200, прогон зелёный, крон отчитался «success». Так было и 26.07, и
 * 28.07 — то есть слой не работал минимум двое суток, а скорее с самого
 * деплоя: адрес источника в коде помечен как «проверить на проде», и, судя по
 * нулям, проверка не состоялась.
 *
 * KVERT публикует коды по действующим вулканам постоянно. Ноль распознанных
 * блоков означает ровно одно: пришло не VONA. Зелёный прогон при несделанной
 * работе опаснее красного при сделанной — он гасит подозрение.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/cron/kvert-acc/route.ts');
const SYNC = read('lib/agents/kvert-sync.ts');

describe('ноль вулканов = провал прогона', () => {
  it('крон помечает прогон failed, а не success', () => {
    expect(ROUTE).toContain('if (result.fetched === 0)');
    expect(ROUTE).toContain("recordCronRun('kvert-acc', startedAt, 'failed'");
  });

  it('ответ перестаёт быть двухсоткой — иначе workflow останется зелёным', () => {
    const block = ROUTE.slice(ROUTE.indexOf('if (result.fetched === 0)'));
    expect(block).toContain('status: 502');
    expect(block).toContain('success: false');
  });

  it('успех по-прежнему возможен: непустой синк проходит как раньше', () => {
    expect(ROUTE).toContain("recordCronRun('kvert-acc', startedAt, 'success')");
    expect(ROUTE).toContain('success: true');
  });
});

describe('диагностика вместо гадания', () => {
  it('при нуле в ответ едет то, что реально пришло от источника', () => {
    // Без этого причина неизвестна: сменилась вёрстка, ушёл адрес, прилетела
    // заглушка — по нулю не различить, а доступа к источнику из среды нет.
    expect(SYNC).toContain('source_bytes');
    expect(SYNC).toContain('source_sample');
    expect(SYNC).toContain('if (parsed.length === 0)');
  });

  it('образец очищен от разметки и обрезан — это диагностика, не дамп', () => {
    const block = SYNC.slice(SYNC.indexOf('if (parsed.length === 0)'));
    expect(block).toContain('.slice(0, 300)');
    expect(block).toContain('<script');
  });

  it('закрывающий тег с пробелом тоже ловится', () => {
    // «</script >» — валидный HTML. Без \\s* такой тег не совпадал, скрипт
    // оставался в образце целиком и вытеснял полезный текст (нашёл CodeQL).
    const block = SYNC.slice(SYNC.indexOf('if (parsed.length === 0)'));
    expect(block).toContain('<\\/script\\s*>');
    expect(block).toContain('<\\/style\\s*>');
  });
});
