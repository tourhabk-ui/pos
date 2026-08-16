/**
 * Разовый запрос к закрытой диагностике не требует носить секрет с собой.
 *
 * Endpoint закрыт CRON_SECRET, а прод доступен не с любой машины. Соблазн —
 * взять ключ себе «на один curl»; после этого он живёт в истории терминала и
 * в переписке. В Actions секрет уже есть, и сеть есть: разовый запрос делается
 * там, ответ читается в логе.
 *
 * Здесь держатся три свойства этого инструмента.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WF = readFileSync(join(process.cwd(), '.github/workflows/catalog-diag.yml'), 'utf-8');

describe('диагностика зовётся вручную и только вручную', () => {
  it('единственный триггер — workflow_dispatch', () => {
    // Регулярный опрос диагностики — это нагрузка и шум: вопрос, ради
    // которого её зовут, каждый раз новый.
    expect(WF).toMatch(/workflow_dispatch:/);
    expect(WF).not.toMatch(/^\s*schedule:/m);
    expect(WF).not.toMatch(/^\s*push:/m);
  });
});

describe('секрет остаётся в секретах', () => {
  it('берётся из secrets, а не из литерала', () => {
    expect(WF).toMatch(/CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}/);
  });

  it('не печатается ни echo, ни в URL', () => {
    // `?secret=` в URL уже приводил к утечке в access-логи — только заголовок.
    expect(WF).not.toMatch(/echo .*\$CRON_SECRET/);
    expect(WF).not.toMatch(/secret=\$/);
    expect(WF).toMatch(/Authorization: Bearer \$CRON_SECRET/);
  });
});

describe('невыполненная диагностика не выглядит выполненной', () => {
  it('без секрета прогон краснеет, а не выходит с нулём', () => {
    // Cron-workflow при отсутствии секрета выходят с нулём — пропущенная
    // задача лучше красного прогона. Для диагностики наоборот: молчаливый
    // успех означал бы «посмотрели и всё хорошо», хотя не смотрели вовсе.
    const guard = WF.slice(WF.indexOf('if [ -z "$CRON_SECRET" ]'));
    expect(guard.slice(0, 300)).toMatch(/exit 1/);
    expect(guard.slice(0, 300)).not.toMatch(/exit 0/);
  });

  it('не-200 от endpoint тоже провал', () => {
    expect(WF).toMatch(/Диагностика ответила \$HTTP/);
  });
});
