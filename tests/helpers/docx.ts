/**
 * Настоящий .docx в памяти — для сторожей разбора документа гида
 * (lib/docs/docx-text). Zip собирается по спецификации: локальные заголовки,
 * центральный каталог, конец каталога; `word/document.xml` сжат deflate, как
 * у Word. Абзац — строка; `list: true` — пункт списка (`<w:numPr>`).
 */
import { deflateRawSync } from 'node:zlib';

export interface DocxLine { text: string; list?: boolean }

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function documentXml(lines: ReadonlyArray<string | DocxLine>): string {
  const ps = lines.map((l) => {
    const line = typeof l === 'string' ? { text: l } : l;
    const pPr = line.list ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : '';
    // Слово режется на два прогона, как это делает Word: текст абзаца — их склейка.
    const half = Math.floor(line.text.length / 2);
    const runs = [line.text.slice(0, half), line.text.slice(half)]
      .filter((t) => t.length > 0)
      .map((t) => `<w:r><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`).join('');
    return `<w:p>${pPr}${runs}</w:p>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${ps}<w:sectPr/></w:body></w:document>`;
}

interface Entry { name: string; data: Buffer; method: 0 | 8; usize?: number }

export function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = e.data;
    const body = e.method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    // Контрольную сумму разбор не сверяет (его дело — текст, не целостность архива).
    const crc = 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.usize ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(e.method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.usize ?? raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** .docx с этими абзацами. */
export function docx(lines: ReadonlyArray<string | DocxLine>): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>'), method: 0 },
    { name: 'word/document.xml', data: Buffer.from(documentXml(lines), 'utf8'), method: 8 },
  ]);
}

/** Документ гида, как в его папке 30.10: название в «ёлочках», подзаголовок, разделы. */
export const GUIDE_DOC: ReadonlyArray<string | DocxLine> = [
  '«Восхождение на вулкан Горелый»',
  'Экскурсия на вулкан Горелый и лавовые пещеры',
  'О вулкане',
  'Вулкан Горелый (1829 м) — действующий вулкан на юге Камчатки.',
  'Программа дня',
  'Дорога на перевал',
  'Выезд в 7:00, дорога около 2,5 часов.',
  { text: 'Восхождение — 2–3 часа по лавовым полям.', list: true },
  'Сколько длится',
  { text: 'Около 12 часов.', list: true },
  'Что взять с собой',
  'Одежда и обувь:',
  { text: 'треккинговые ботинки;', list: true },
  { text: 'ветрозащитная куртка & шапка <тёплая>;', list: true },
  'В стоимость включено',
  { text: 'Трансфер на внедорожнике.', list: true },
  'Важно знать',
  { text: 'К активной воронке близко не подходить.', list: true },
];
