/**
 * Честность радара на главной (фидбэк владельца 26.07):
 * «Радар безопасности» с пустым экраном читался как «безопасно», хотя главную
 * реальную опасность — медведей — техника не отслеживает. Радар не имеет права
 * обещать безопасность; медвежья приписка постоянна; наблюдения туристов
 * (включая медведей) выходят на радар — как и обещает /api/safety/reports.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// P0-3b (31.07): реализация радара переехала с главной в components/safety/
// (главная — плитка-ссылка на /safety#radar). Контракты честности не меняются
// от переезда — сторож читает новый адрес.
const client = readFileSync('components/safety/LiveStatus.tsx', 'utf8');
const data = readFileSync('app/_home/data.ts', 'utf8');

describe('радар не обещает «безопасность»', () => {
  it('название «Радар безопасности» выпилено', () => {
    expect(client).not.toMatch(/Радар безопасности/);
    expect(client).toMatch(/Радар обстановки/);
  });

  it('пустое состояние говорит только о том, что радар видит', () => {
    expect(client).not.toMatch(/Рядом опасностей нет/);
    expect(client).toMatch(/Сейсмики и тревог вулканов рядом нет/);
  });

  it('медвежья приписка постоянна и ведёт на протокол встречи', () => {
    expect(client).toMatch(/Медведей он не видит/);
    expect(client).toMatch(/\/safety\/offline/);
  });
});

describe('наблюдения туристов на радаре', () => {
  it('data.ts читает approved trail_reports со сроком годности', () => {
    expect(data).toMatch(/FROM trail_reports/);
    expect(data).toMatch(/status = 'approved'/);
    expect(data).toMatch(/INTERVAL '7 days'/);
  });

  it('медведь — отдельный kind с уровнем danger', () => {
    expect(data).toMatch(/'bear' \? 'danger'/);
    expect(client).toMatch(/bear: 'Медведь'/);
  });

  it('заметка помечает источник — наблюдение туриста', () => {
    expect(data).toMatch(/наблюдение туриста/);
  });
});

describe('z-order блипов', () => {
  it('критичные рисуются последними (поверх), а не первыми (под)', () => {
    expect(client).toMatch(/LEVEL_RANK/);
    expect(client).toMatch(/\{ warning: 0, danger: 1, critical: 2 \}/);
  });
});
