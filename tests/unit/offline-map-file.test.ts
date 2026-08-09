/**
 * Закачка карты одним файлом.
 *
 * Тысяча тайлов теряет несколько штук, один файл теряется целиком — поэтому
 * здесь стерегутся не функции, а три обещания: не выбросить уже скачанное,
 * не начать без места и никогда не сшить куски от разных версий файла.
 * Последнее — единственная ошибка, которая выяснится в поле: собранный из
 * двух версий файл не откроется там, где скачать заново нечем.
 */
import { describe, it, expect } from 'vitest';
import {
  planChunks, missingChunks, rangeHeader, decideResume, checkSpace,
  progressLabel, assembledLooksRight, CHUNK_BYTES, SPACE_HEADROOM,
  type DownloadJournal, type RemoteFileInfo,
} from '@/lib/offline/map-file';

const MB = 1024 * 1024;
const TOTAL = 92 * MB; // замер 09.08: вся Камчатка
const T0 = 1_700_000_000_000;

const remote: RemoteFileInfo = {
  url: 'https://example/kamchatka.pmtiles',
  totalBytes: TOTAL,
  version: 'v1',
  acceptsRanges: true,
};

function journal(over: Partial<DownloadJournal> = {}): DownloadJournal {
  return {
    url: remote.url,
    totalBytes: TOTAL,
    chunkBytes: CHUNK_BYTES,
    version: 'v1',
    haveIndices: [0, 1, 2],
    updatedAt: T0,
    ...over,
  };
}

describe('файл режется на куски без потерь и нахлёстов', () => {
  it('куски покрывают файл целиком и не пересекаются', () => {
    const plan = planChunks(TOTAL);
    expect(plan[0].start).toBe(0);
    expect(plan[plan.length - 1].end).toBe(TOTAL - 1);
    for (let i = 1; i < plan.length; i++) expect(plan[i].start).toBe(plan[i - 1].end + 1);
    const sum = plan.reduce((s, c) => s + (c.end - c.start + 1), 0);
    expect(sum).toBe(TOTAL);
  });

  it('92 МБ — это два десятка кусков, а не тысяча', () => {
    expect(planChunks(TOTAL).length).toBeLessThan(40);
  });

  it('пустой или битый размер не даёт плана', () => {
    expect(planChunks(0)).toEqual([]);
    expect(planChunks(-5)).toEqual([]);
    expect(planChunks(NaN)).toEqual([]);
  });

  it('заголовок Range включает обе границы', () => {
    expect(rangeHeader({ index: 0, start: 0, end: 99 })).toBe('bytes=0-99');
  });

  it('уже скачанные куски не запрашиваются повторно', () => {
    const plan = planChunks(TOTAL);
    const missing = missingChunks(plan, [0, 1, 2]);
    expect(missing.length).toBe(plan.length - 3);
    expect(missing[0].index).toBe(3);
  });
});

describe('после убийства приложения продолжаем, а не начинаем заново', () => {
  it('часть кусков дома — докачиваем остальное', () => {
    const d = decideResume(journal(), remote);
    expect(d.action).toBe('resume');
    if (d.action === 'resume') {
      expect(d.doneBytes).toBe(3 * CHUNK_BYTES);
      expect(d.missing[0].index).toBe(3);
    }
  });

  it('всё дома — закачки нет', () => {
    const all = planChunks(TOTAL).map(c => c.index);
    expect(decideResume(journal({ haveIndices: all }), remote).action).toBe('complete');
  });

  it('первый раз — начинаем с нуля и говорим об этом', () => {
    const d = decideResume(null, remote);
    expect(d.action).toBe('restart');
    if (d.action === 'restart') expect(d.reason).toBeTruthy();
  });
});

describe('куски от разных версий файла НИКОГДА не сшиваются', () => {
  it('сменилась версия — начинаем заново', () => {
    // Сшитый из двух версий файл не откроется, и выяснится это там, где
    // скачать заново нечем.
    const d = decideResume(journal(), { ...remote, version: 'v2' });
    expect(d.action).toBe('restart');
    if (d.action === 'restart') expect(d.reason).toMatch(/обновилась/);
  });

  it('сменился размер — начинаем заново', () => {
    const d = decideResume(journal(), { ...remote, totalBytes: TOTAL + 1 });
    expect(d.action).toBe('restart');
  });

  it('сменился адрес — начинаем заново', () => {
    const d = decideResume(journal(), { ...remote, url: 'https://other/x.pmtiles' });
    expect(d.action).toBe('restart');
  });

  it('журнал с индексами вне плана считается испорченным', () => {
    const d = decideResume(journal({ haveIndices: [0, 9999] }), remote);
    expect(d.action).toBe('restart');
  });

  it('сервер не отдаёт части — качаем целиком, а не делаем вид, что продолжаем', () => {
    const d = decideResume(journal(), { ...remote, acceptsRanges: false });
    expect(d.action).toBe('restart');
    if (d.action === 'restart') expect(d.reason).toMatch(/частями/);
  });
});

describe('место проверяется до первого байта', () => {
  it('места вдоволь — можно качать', () => {
    const v = checkSpace(TOTAL, { quota: 2000 * MB, usage: 100 * MB });
    expect(v.ok).toBe(true);
  });

  it('места впритык — не начинаем, и сказано сколько нужно', () => {
    // Узнать про нехватку на восьмидесяти процентах — те же выброшенные
    // мегабайты, только с обидой.
    const v = checkSpace(TOTAL, { quota: 100 * MB, usage: 50 * MB });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/Не хватает места/);
    expect(v.message).toMatch(/\d+ МБ/);
  });

  it('запас сверх размера файла заложен: при сборке он существует дважды', () => {
    expect(SPACE_HEADROOM).toBeGreaterThan(2);
    expect(checkSpace(TOTAL, { quota: 2000 * MB }).needBytes).toBeGreaterThan(TOTAL * 2);
  });

  it('браузер промолчал — не выдумываем и не запрещаем', () => {
    const v = checkSpace(TOTAL, null);
    expect(v.ok).toBe(true);
    expect(v.freeBytes).toBeNull();
    expect(v.message).toMatch(/проверить не удалось/);
  });
});

describe('прогресс говорит по-человечески', () => {
  it('есть скорость — есть и остаток времени', () => {
    const s = progressLabel(43 * MB, TOTAL, 2 * MB);
    expect(s).toContain('из 92 МБ');
    expect(s).toContain('2.0 МБ/с');
    expect(s).toMatch(/осталось \d+ с|осталось \d+ мин/);
  });

  it('скорости нет — обещания времени тоже нет', () => {
    const s = progressLabel(10 * MB, TOTAL, null);
    expect(s).not.toMatch(/осталось/);
  });
});

describe('собранный файл сверяется с обещанным', () => {
  it('длина сошлась — принимаем', () => {
    expect(assembledLooksRight(TOTAL, TOTAL)).toBe(true);
  });

  it('недобор или пустышка — отвергаем', () => {
    expect(assembledLooksRight(TOTAL - 1, TOTAL)).toBe(false);
    expect(assembledLooksRight(0, 0)).toBe(false);
  });
});
