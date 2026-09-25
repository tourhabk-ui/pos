/**
 * Над AI-дайджестом — превью первой статьи выпуска (решение владельца 26.09).
 *
 * История: 02.09 выпуск стоял в ленте голым текстом среди постов с картинкой;
 * до 24.09 обложку рисовал генератор (к выпуску про AutoCAD — серое здание);
 * 24.09 её заменила своя карточка с датой и заголовками, и 26.09 владелец
 * назвал её «полным кринжем»: карточка повторяла заголовок, стоящий прямо
 * под ней. Выбран вариант «а» — убрать карточку, показать превью статьи.
 *
 * Требование 02.09 «не голым текстом» остаётся: превью — картинка источника.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIGEST = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
const CODE = DIGEST.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('превью над AI-дайджестом', () => {
  it('ссылка превью — первая статья выпуска, заданная явно (иначе Telegram взял бы реферальную из подвала)', () => {
    expect(CODE).toMatch(/const coverUrl = aiPostMaterials\(aiDigest\)\[0\]\?\.url/);
    expect(CODE).toMatch(/aiSent = await tgSendRich\([^)]*coverUrl[,)]/);
  });

  it('превью крупное и над полным текстом, а не подпись к фото', () => {
    expect(CODE).toMatch(/link_preview_options/);
    expect(CODE).toMatch(/prefer_large_media: true/);
    expect(CODE).toMatch(/show_above_text: true/);
    expect(CODE).not.toMatch(/disable_web_page_preview: false/);
  });

  it('карточка-обложка и сцена генератора из выпуска ушли целиком, без мёртвого маршрута', () => {
    expect(CODE).not.toMatch(/digestCoverUrl|resolveCoverImage/);
    expect(existsSync(join(process.cwd(), 'lib/notifications/digest-cover.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'app/api/og/digest-cover/route.tsx'))).toBe(false);
  });
});
