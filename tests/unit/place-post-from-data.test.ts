/**
 * Пост о месте собирается из записи — и ни из чего больше.
 *
 * 05.09 в канал ушёл пост про озеро Зелёное с кратером, железом и тёплой
 * водой, которых нет в данных. Ниже — та самая запись из базы и проверка, что
 * из неё нельзя получить ни одного слова из того поста.
 */
import { describe, it, expect } from 'vitest';
import { composePlacePost, clipToSentence, PLACE_LINK_LINE } from '@/lib/notifications/place-post';
import { promisesRouteOrTrack } from '@/lib/notifications/post-validation';

const ZELENOE = {
  id: 'ed134429-febe-45d4-9c55-00b12809de24',
  title: 'Озеро Зелёное',
  description:
    'Озеро Зелёное — небольшой водоём в районе Мутновского нагорья (52.73°N, 158.21°E). '
    + 'Вода зеленоватого оттенка от водорослей и минеральных взвесей. Попутная точка на маршруте '
    + 'к Мутновскому вулкану. Купание не рекомендуется — высокая минерализация.',
  has_track: true,
};
const OPTS = { appUrl: 'https://vedarai.ru', locLabel: 'Озеро' };

describe('composePlacePost: только то, что в записи', () => {
  const post = composePlacePost(ZELENOE, OPTS) ?? '';

  it('пост собран', () => {
    expect(post).not.toBe('');
  });

  it('слов из выдуманного поста 05.09 в нём нет', () => {
    for (const w of ['кратер', 'грязев', 'осып', 'термофиль', 'железо', 'тёплая', 'дышит', 'затаился']) {
      expect(post.toLowerCase(), w).not.toContain(w);
    }
  });

  it('описание записи входит целиком и без правок', () => {
    expect(post).toContain('Купание не рекомендуется — высокая минерализация.');
    expect(post).toContain('<b>Озеро Зелёное</b>');
    expect(post).toContain('<i>Озеро</i>');
  });

  it('ссылка ведёт на страницу этого же места', () => {
    expect(post).toContain(`https://vedarai.ru/routes/${ZELENOE.id}`);
  });

  it('с треком обещает трек, без трека — не произносит ни «трек», ни «маршрут»', () => {
    expect(post).toContain(PLACE_LINK_LINE.track);
    const noTrack = composePlacePost({ ...ZELENOE, description: 'Небольшое озеро у дороги. Вода холодная, берег каменистый.', has_track: false }, OPTS) ?? '';
    expect(noTrack).toContain(PLACE_LINK_LINE.noTrack);
    expect(promisesRouteOrTrack(noTrack)).toBe(false);
  });

  it('без описания поста нет — заглушка хуже молчания', () => {
    expect(composePlacePost({ ...ZELENOE, description: null }, OPTS)).toBeNull();
    expect(composePlacePost({ ...ZELENOE, description: '   ' }, OPTS)).toBeNull();
  });

  it('HTML в данных экранируется, а не уходит разметкой', () => {
    const p = composePlacePost({ ...ZELENOE, title: 'A <b>&</b> B', description: 'Описание <script> длинное и содержательное про озеро.' }, OPTS) ?? '';
    expect(p).toContain('<b>A &lt;b&gt;&amp;&lt;/b&gt; B</b>');
    expect(p).toContain('&lt;script&gt;');
  });
});

describe('clipToSentence: режет по предложению', () => {
  it('короткое не трогает', () => {
    expect(clipToSentence('Раз. Два.', 100)).toBe('Раз. Два.');
  });

  it('длинное обрывает на конце предложения', () => {
    const t = 'Первое предложение довольно длинное. Второе тоже длинное. Третье уже не влезет никак.';
    const c = clipToSentence(t, 60);
    expect(c).toBe('Первое предложение довольно длинное. Второе тоже длинное.');
  });

  it('без точек — по слову с многоточием', () => {
    const c = clipToSentence('слово '.repeat(40).trim(), 30);
    expect(c.endsWith('…')).toBe(true);
    expect(c.length).toBeLessThanOrEqual(31);
  });
});
