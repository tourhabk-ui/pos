/**
 * Текст из .docx без новых зависимостей: docx — zip, текст — в
 * `word/document.xml`. Zip читается по центральному каталогу, запись
 * разжимается встроенным zlib (deflate) или берётся как есть (stored).
 *
 * Повод — гид присылает в MAX свои тексты туров теми же документами, что
 * правил в Google-документах (слово владельца 30.10 «гид должен полностью
 * управлять своей ролью из MAX»).
 *
 * Что отдаётся: абзацы по порядку, строкой каждый (`<w:p>`), с признаком
 * «пункт списка» (`<w:numPr>`) и стилем заголовка (`<w:pStyle w:val="Heading…">`).
 * Таблицы, сноски, колонтитулы и картинки не читаются — это не текст тура.
 *
 * Чужой файл — недоверенные данные: размеры ограничены до разжатия
 * (zip-бомба не разжимается сверх `MAX_XML_BYTES`), и любая неровность — отказ
 * с причиной (`not_docx`, `too_big`, `broken`), а не пустой текст.
 */

import { inflateRawSync } from 'node:zlib';

/** Сколько принимаем файла. Тексты туров — десятки килобайт. */
export const MAX_DOCX_BYTES = 2 * 1024 * 1024;
/** Сколько разжимаем document.xml. */
export const MAX_XML_BYTES = 8 * 1024 * 1024;

export interface DocxParagraph {
  text: string;
  /** Пункт нумерованного или маркированного списка. */
  listItem: boolean;
  /** Стиль заголовка Word (Heading1…Heading9, Title). */
  heading: boolean;
}

export type DocxText =
  | { ok: true; paragraphs: DocxParagraph[] }
  | { ok: false; reason: 'not_docx' | 'too_big' | 'broken' };

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Байты `word/document.xml` из zip; null — записи нет или zip битый. */
function documentXml(buf: Buffer): Buffer | 'too_big' | null {
  // Конец центрального каталога — в последних 64 КБ + 22 байта.
  const from = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== 'word/document.xml') continue;
    if (usize > MAX_XML_BYTES) return 'too_big';
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC_SIG) return null;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) return null;
    const data = buf.subarray(start, start + csize);
    if (method === 0) return data;
    if (method !== 8) return null;
    return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
  }
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return ENTITIES[k] ?? '';
  });
}

function paragraphOf(xml: string): DocxParagraph {
  const heading = /<w:pStyle\s+w:val="(?:Heading\d|Title|Subtitle|[^"]*[Hh]eading[^"]*)"/.test(xml);
  const listItem = /<w:numPr\b/.test(xml);
  let text = '';
  // Порядок важен: текст, табуляция и перенос строки — в том порядке, как стоят.
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\s*\/>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    if (m[1] !== undefined) text += decode(m[1]);
    else if (m[0].startsWith('<w:tab')) text += '\t';
    else text += '\n';
  }
  return { text: text.replace(/[ \t ]+/g, ' ').trim(), listItem, heading };
}

/** Абзацы документа; пустые отброшены. */
export function docxParagraphs(buf: Buffer): DocxText {
  if (buf.length > MAX_DOCX_BYTES) return { ok: false, reason: 'too_big' };
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOC_SIG) return { ok: false, reason: 'not_docx' };
  let xmlBuf: Buffer | 'too_big' | null;
  try {
    xmlBuf = documentXml(buf);
  } catch (err) {
    // Разжатие оборвалось (битый поток или больше предела) — отказ с причиной.
    const code = (err as { code?: string } | null)?.code ?? '';
    console.error(`[docx-text] document.xml не разжат: ${code || (err instanceof Error ? err.name : 'отказ')}`);
    return { ok: false, reason: code === 'ERR_BUFFER_TOO_LARGE' ? 'too_big' : 'broken' };
  }
  if (xmlBuf === 'too_big') return { ok: false, reason: 'too_big' };
  if (xmlBuf === null) return { ok: false, reason: 'not_docx' };
  const xml = xmlBuf.toString('utf8');
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1];
  if (body === undefined) return { ok: false, reason: 'broken' };
  const paragraphs: DocxParagraph[] = [];
  for (const m of body.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const p = paragraphOf(m[1] ?? '');
    if (p.text) paragraphs.push(p);
  }
  return { ok: true, paragraphs };
}
