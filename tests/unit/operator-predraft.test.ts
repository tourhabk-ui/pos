import { describe, it, expect } from 'vitest';
import { predraftLines } from '@/lib/requests/operator-predraft';

describe('черновик оператору', () => {
  it('мест хватает — подсказка «Подтвердить», дату не предлагаем', () => {
    const l = predraftLines('2026-07-15', 3, { seatsOnDate: 5, nearest: { date: '2026-07-15', seats: 5 } });
    expect(l.join('\n')).toMatch(/Свободно на 2026-07-15: 5 \(просят 3\)/);
    expect(l.join('\n')).toMatch(/Подтвердить/);
    expect(l.join('\n')).not.toMatch(/Ближайшая/);
  });
  it('мест мало — ближайшая свободная дата из базы', () => {
    const t = predraftLines('2026-07-15', 4, { seatsOnDate: 2, nearest: { date: '2026-07-18', seats: 6 } }).join('\n');
    expect(t).toMatch(/Ближайшая свободная дата: 2026-07-18 \(мест 6\)/);
  });
  it('сбой базы — не выдумываем', () => {
    const t = predraftLines('2026-07-15', 2, { seatsOnDate: 'failed', nearest: 'failed' }).join('\n');
    expect(t).toMatch(/не прочитались/);
    expect(t).not.toMatch(/\d+ \(мест/);
  });
  it('гостю не отправляется и без ПД', () => {
    const t = predraftLines('2026-07-15', 2, { seatsOnDate: null, nearest: null }).join('\n');
    expect(t).toMatch(/гостю не отправлен/);
    expect(t).not.toMatch(/\+7|Телефон|Имя/);
  });
});
