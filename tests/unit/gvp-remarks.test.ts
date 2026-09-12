/**
 * Чистая логика получения Remarks с WFS ГВП — без сети/БД/AI (#1830).
 */
import { describe, it, expect } from 'vitest';
import { buildGvpRemarksUrl, parseGvpRemarks } from '@/lib/geo/gvp-remarks';

describe('buildGvpRemarksUrl', () => {
  it('запрашивает VolcanoNumber и Remarks, bbox в порядке lng,lat,lng,lat', () => {
    const url = buildGvpRemarksUrl({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 });
    expect(url).toContain('webservices.volcano.si.edu/geoserver/GVP-VOTW/wfs');
    expect(url).toContain('Remarks');
    expect(url).toMatch(/bbox=155%2C50%2C167%2C64%2CEPSG%3A4326/);
  });
});

describe('parseGvpRemarks', () => {
  const feature = (props: Record<string, unknown>) => ({ type: 'Feature', properties: props });

  it('разбирает реальную форму ответа', () => {
    const data = {
      features: [feature({ VolcanoNumber: 300260, Remarks: 'Klyuchevskoy is the tallest active volcano...' })],
    };
    expect(parseGvpRemarks(data)).toEqual([
      { volcanoNumber: 300260, remarks: 'Klyuchevskoy is the tallest active volcano...' },
    ]);
  });

  it('отсутствие Remarks у вулкана — пустая строка, не ошибка', () => {
    const data = { features: [feature({ VolcanoNumber: 1, Remarks: null })] };
    expect(parseGvpRemarks(data)).toEqual([{ volcanoNumber: 1, remarks: '' }]);
  });

  it('без VolcanoNumber — не кандидат; дедуп по номеру', () => {
    const data = {
      features: [
        feature({ Remarks: 'без номера' }),
        feature({ VolcanoNumber: 5, Remarks: 'первый' }),
        feature({ VolcanoNumber: 5, Remarks: 'дубль' }),
      ],
    };
    expect(parseGvpRemarks(data)).toEqual([{ volcanoNumber: 5, remarks: 'первый' }]);
  });

  it('пустой/чужой ответ — пустой список', () => {
    expect(parseGvpRemarks(null)).toEqual([]);
    expect(parseGvpRemarks({})).toEqual([]);
  });
});
