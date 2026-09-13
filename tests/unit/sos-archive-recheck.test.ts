/**
 * Авто-архивация SOS не затирает событие, взятое в работу.
 *
 * Находка Evo Judge 13.09: в `executeArchiveSOS` SELECT и UPDATE шли без
 * транзакции, а UPDATE отбирал строки ТОЛЬКО по id — условия `status = 'sent'`
 * в нём не было. Между выборкой зависших и записью лежит время (там же, между
 * ними, строится отчёт), и за это время спасатель может взять событие в
 * работу. Тогда UPDATE затирал живой статус словом `archived` и припиской
 * «нет ответа >24ч» — на SOS-пути это ложь о том, помогли человеку или нет.
 *
 * ПОЧЕМУ НЕ ТРАНЗАКЦИЯ. Одного перепроверяющего UPDATE достаточно: он
 * атомарен сам по себе, и гонка закрывается на стороне сервера. Транзакция
 * вокруг SELECT..UPDATE держала бы блокировку дольше и не добавила бы к этому
 * ничего — а рядом, в operator-outreach, транзакция была бы прямо вредна:
 * там между INSERT и UPDATE стоит внешний HTTP-вызов.
 *
 * ЧИСЛО В ОТЧЁТЕ. Отчёт обязан называть, сколько ДЕЙСТВИТЕЛЬНО
 * заархивировано, а не сколько было намечено (§4.0): пропущенные события в
 * UPDATE не попали, и говорить о них «архивировано» нельзя. Отсюда RETURNING
 * и счёт по нему — и в changes_made, и в сообщении владельцу в Telegram.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/execution/initiative-executor.ts'), 'utf-8');
/** Тело исполнителя архивации — чтобы не поймать чужой UPDATE из файла. */
const BODY = (() => {
  const at = SRC.indexOf('async function executeArchiveSOS');
  expect(at, 'executeArchiveSOS не найдена').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n// ===', at);
  return SRC.slice(at, end > -1 ? end : at + 4000);
})();

describe('archive_sos — UPDATE перепроверяет статус', () => {
  it('UPDATE отбирает по id И по статусу, а не по одному id', () => {
    const at = BODY.indexOf('UPDATE sos_events');
    expect(at).toBeGreaterThan(-1);
    const stmt = BODY.slice(at, BODY.indexOf('`', at));
    expect(stmt).toContain("WHERE id = ANY($2::uuid[])");
    expect(stmt, 'без перепроверки статуса UPDATE затрёт событие, взятое в работу').toContain("AND status = 'sent'");
  });

  it('RETURNING есть — иначе число заархивированных неоткуда взять', () => {
    const at = BODY.indexOf('UPDATE sos_events');
    const stmt = BODY.slice(at, BODY.indexOf('`', at));
    expect(stmt).toContain('RETURNING id');
  });

  it('отчёт считает по факту записи, а не по выборке', () => {
    // ids.length — это НАМЕРЕНИЕ (что выбрали), archivedIds.size — ФАКТ.
    expect(BODY).toMatch(/const archivedIds = new Set\(archived\.rows\.map\(r => r\.id\)\)/);
    expect(BODY).toMatch(/Архивировано \$\{archivedIds\.size\} SOS-событий/);
    expect(BODY).not.toMatch(/Архивировано \$\{ids\.length\}/);
  });

  it('то же число уходит владельцу в Telegram', () => {
    // Отчёт в changes_made и сообщение в Telegram — два экземпляра одного
    // утверждения; разойдясь, они спорили бы друг с другом на SOS-пути.
    expect(BODY).toMatch(/авто-архивировал \$\{archivedIds\.size\} SOS-событий/);
    expect(BODY).not.toMatch(/авто-архивировал \$\{ids\.length\}/);
  });

  it('расхождение названо вслух, а не спрятано', () => {
    // «Выбрали 5, записали 3» — это и есть тот случай, ради которого
    // перепроверка поставлена; промолчать о нём значит спрятать гонку.
    expect(BODY).toMatch(/archivedIds\.size < ids\.length/);
    expect(BODY).toMatch(/статус изменился за время разбора/);
  });

  it('ноль записанных — отдельный исход, а не «архивировано 0»', () => {
    expect(BODY).toMatch(/archivedIds\.size === 0/);
    expect(BODY).toMatch(/взяты в работу — архивировать нечего/);
  });
});
