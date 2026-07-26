/**
 * Снятие HTML-тегов, устойчивое к вложенным конструкциям.
 *
 * Однопроходный `replace(/<[^>]+>/g, '')` уязвим: `<scr<script>ipt>` после
 * одного прохода оставляет `<script>` (CodeQL: incomplete multi-character
 * sanitization). Итерируем до неподвижной точки, затем срезаем одинокие
 * угловые скобки — на выходе тегов нет ни при каком входе.
 */
export function stripHtmlTags(input: string | null | undefined): string {
  if (!input) return '';
  let out = String(input);
  let prev = '';
  while (out !== prev) {
    prev = out;
    out = out.replace(/<[^>]*>/g, '');
  }
  // Остаточные одинокие '<' (незакрытый тег) — не текстовый контент.
  return out.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}
