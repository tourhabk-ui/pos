/**
 * stripHtmlTags: снятие тегов, устойчивое к вложенным конструкциям.
 * Регрессия CodeQL «incomplete multi-character sanitization»: однопроходный
 * replace оставлял <script> из <scr<script>ipt>.
 */
import { describe, it, expect } from 'vitest';
import { stripHtmlTags } from '@/lib/text/strip-html';

describe('stripHtmlTags', () => {
  it('обычные теги снимаются', () => {
    expect(stripHtmlTags('<p>Однодневный <b>трек</b> к кратеру.</p>')).toBe('Однодневный трек к кратеру.');
  });

  it('вложенная конструкция не оставляет тег (кейс CodeQL)', () => {
    const out = stripHtmlTags('<scr<script>ipt>alert(1)</scr</script>ipt>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/[<>]/);
  });

  it('незакрытый тег не оставляет угловых скобок', () => {
    expect(stripHtmlTags('текст <img src=x и хвост')).not.toMatch(/[<>]/);
  });

  it('null/undefined/пусто → пустая строка', () => {
    expect(stripHtmlTags(null)).toBe('');
    expect(stripHtmlTags(undefined)).toBe('');
    expect(stripHtmlTags('')).toBe('');
  });

  it('схлопывает пробелы после снятия тегов', () => {
    expect(stripHtmlTags('a<br> <br>b')).toBe('a b');
  });
});
