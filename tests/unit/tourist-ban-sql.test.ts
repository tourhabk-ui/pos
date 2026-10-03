/**
 * Прямой запрет туристам — один набор шаблонов для классификатора и для цвета.
 *
 * 03.10 (поправка к #2195): региональная двойка стала жёлтой, но прямой запрет
 * выхода туристам — тоже двойка, и понижать его нельзя. Признак считается в SQL
 * ТЕМИ ЖЕ шаблонами, что у классификатора. Сторож держит связку: шаблоны в
 * одном модуле, SQL несёт их дословно, оба правила цвета их спрашивают.
 * Совпадение JS и PostgreSQL на формулировках МЧС проверяет
 * tests/integration/alert-place-scope.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAN_AUDIENCE, BAN_VERB, TOURIST_BAN_SQL } from '@/lib/services/safety/tourist-ban';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('шаблоны запрета — один источник', () => {
  it('SQL несёт шаблоны дословно, в долларовых кавычках', () => {
    expect(TOURIST_BAN_SQL).toContain(`$ban_a$${BAN_AUDIENCE.source}$ban_a$`);
    expect(TOURIST_BAN_SQL).toContain(`$ban_v$${BAN_VERB.source}$ban_v$`);
  });
  it('классификатор берёт шаблоны из модуля, своей копии у него нет', () => {
    const parser = read('lib/services/safety/seismic-parser.ts');
    expect(parser).toMatch(/import \{ BAN_AUDIENCE, BAN_VERB \} from '@\/lib\/services\/safety\/tourist-ban'/);
    expect(parser).not.toMatch(/const BAN_AUDIENCE\s*=/);
    expect(parser).not.toMatch(/const BAN_VERB\s*=/);
  });
});

describe('запрет туристам не бывает зональным', () => {
  it('статус места: зональный признак исключает запрет', () => {
    expect(read('app/api/cron/safety-ingest/route.ts'))
      .toMatch(/COALESCE\(\$\{ALERT_ZONAL_ONLY_SQL\} AND NOT \$\{TOURIST_BAN_SQL\}, false\) AS zonal/);
  });
  it('вердикт маршрута: зональный признак исключает запрет и закрытие парка', () => {
    const cs = read('lib/routes/collect-signals.ts');
    // Здесь шаблоны идут параметрами ($6, $7): сторож collect-signals
    // запрещает подстановку в текст SQL.
    expect(cs).toMatch(/import \{ BAN_AUDIENCE, BAN_VERB \} from '@\/lib\/services\/safety\/tourist-ban'/);
    expect(cs).toMatch(/~ \$6\s*\n\s*AND lower\(COALESCE\(ea\.title, ''\) \|\| ' ' \|\| COALESCE\(ea\.description, ''\)\) ~ \$7/);
    expect(cs).toMatch(/routeId, BAN_AUDIENCE\.source, BAN_VERB\.source\]/);
    expect(cs).toMatch(/ea\.alert_type IS DISTINCT FROM 'park_closure'/);
    // Пропуск ответа сервера — не «зональное»: судится строже.
    expect(cs).toMatch(/zonal: r\.zonal === true/);
  });
});
