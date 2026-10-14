// Матчеры jest-dom (toBeInTheDocument, toHaveTextContent…) нужны только там,
// где есть DOM. Среда по умолчанию — node (vitest.config.ts), и в ней импорт
// матчеров стоил бы ~0,25 с на каждый файл без экрана — а таких почти все.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}
