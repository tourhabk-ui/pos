/** Тестовая бронь платформы — имя туриста начинается с «ТЕСТ» (любой регистр). */
export function isTestTouristName(name: string | null | undefined): boolean {
  return /^\s*тест(\s|$|[^а-яё])/i.test(name ?? '') || /^\s*test(\s|$|[^a-z])/i.test(name ?? '');
}
