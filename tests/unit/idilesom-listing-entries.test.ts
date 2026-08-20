
import { describe, it, expect } from 'vitest';
import { extractPlaceEntries } from '@/lib/services/ingest/idilesom-importer';

describe('листинг идилесома: пары id+название', () => {
  it('название берётся из текста ссылки, разметка срезается', () => {
    const html = '<a class="card" href="/kam/places/123"><img src="x.jpg"/><span>Вулкан  Горелый</span></a>';
    expect(extractPlaceEntries(html)).toEqual([{ id: '123', title: 'Вулкан Горелый' }]);
  });

  it('JSON-тело с экранированными слэшами и кавычками читается', () => {
    const json = '{"html":"<a href=\\"\\/kam\\/places\\/45\\">Озеро Ажабачье<\\/a>"}';
    const entries = extractPlaceEntries(json);
    expect(entries).toContainEqual({ id: '45', title: 'Озеро Ажабачье' });
  });

  it('ссылка без текста не теряется — приходит с пустым названием', () => {
    const html = '<a href="/kam/places/7"><img/></a> и просто упоминание /kam/places/8 вне ссылки';
    const entries = extractPlaceEntries(html);
    expect(entries).toContainEqual({ id: '7', title: '' });
    expect(entries).toContainEqual({ id: '8', title: '' });
  });

  it('дубль id: непустое название побеждает пустое', () => {
    const html = '<a href="/kam/places/9"></a><a href="/kam/places/9">Мыс Шипунский</a>';
    expect(extractPlaceEntries(html)).toEqual([{ id: '9', title: 'Мыс Шипунский' }]);
  });
});
