/**
 * probe-url, режим "text": .docx читается текстом (29.10).
 *
 * Архив сообщений PTWC о землетрясении у Камчатки 29.07.2025 weather.gov
 * хранит только в .docx — это zip, и проба печатала его кашей. Проверяется
 * исполнением: снимающий разметку strip.py вынимается из самого workflow и
 * запускается настоящим python3 на собранном здесь документе.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WF = readFileSync(join(process.cwd(), '.github/workflows/probe-url.yml'), 'utf-8');

/** strip.py из heredoc шага: между `<<'PY'` и строкой `PY`, без отступа блока YAML. */
function stripPy(): string {
  const lines = WF.split('\n');
  const start = lines.findIndex((l) => l.includes("cat > /tmp/strip.py <<'PY'"));
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'PY');
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return body.map((l) => l.slice(indent)).join('\n');
}

let dir = '';
let script = '';

function run(input: Buffer): string {
  return execFileSync('python3', [script], { input }).toString('utf-8');
}

/** Минимальный .docx: zip с word/document.xml. Собирается python3 — тем же, что исполнит strip.py. */
function docx(documentXml: string): Buffer {
  const out = join(dir, `doc-${Math.random().toString(36).slice(2)}.docx`);
  const xmlPath = `${out}.xml`;
  writeFileSync(xmlPath, documentXml);
  execFileSync('python3', ['-c', [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)',
    'z.writestr("[Content_Types].xml", "<Types/>")',
    'z.write(sys.argv[2], "word/document.xml")',
    'z.close()',
  ].join('\n'), out, xmlPath]);
  return readFileSync(out);
}

describe('probe-url: strip.py читает .docx', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-docx-'));
    script = join(dir, 'strip.py');
    writeFileSync(script, stripPy());
  });

  it('абзацы и переносы — строки, табуляция сохранена, сущности раскрыты', () => {
    const xml = '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>'
      + '<w:p><w:r><w:t>TSUNAMI THREAT MESSAGE NUMBER 1</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>PETROPAVLOVSK K</w:t></w:r><w:r><w:tab/><w:t>RUSSIA</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>A &amp; B</w:t><w:br/><w:t>NEXT LINE</w:t></w:r></w:p>'
      + '<w:p></w:p>'
      + '</w:body></w:document>';
    expect(run(docx(xml)).split('\n').filter(Boolean)).toEqual([
      'TSUNAMI THREAT MESSAGE NUMBER 1',
      'PETROPAVLOVSK K\tRUSSIA',
      'A & B',
      'NEXT LINE',
    ]);
  });

  it('zip без документа Word — сказано словами, не каша', () => {
    const bad = docx('<x/>');
    // Подменяем имя внутри архива: документа word/document.xml в нём нет.
    const broken = Buffer.from(bad.toString('latin1').replace(/word\/document\.xml/g, 'word/other00.xml'), 'latin1');
    expect(run(broken)).toMatch(/^\[DOCX: текст не извлечён — /);
  });

  it('HTML по-прежнему снимается как раньше', () => {
    expect(run(Buffer.from('<p>Привет</p><p>мир</p>')).trim()).toBe('Привет\nмир');
  });
});
