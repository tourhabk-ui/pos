/**
 * Раздел /zh — объявление языка документа (аудит 15.10, CN-quick).
 *
 * Китайская страница отдавалась под корневым `<html lang="ru">`: lang="zh-CN"
 * стоял только на <main>, ни заголовка, ни мета Content-Language не было.
 * Корневой `<html lang>`: с 19.10 (вариант А) layout ставит lang="zh-CN" по
 * первому сегменту пути (lib/i18n/root-lang), поэтому этот meta — второй,
 * страховочный сигнал рядом с заголовком `Content-Language: zh-CN`
 * (next.config.js, правило /zh/:path*) — React 19 поднимает <meta> из тела
 * в <head> сам. Сигнал честный и ничего не стоит, убирать его не стали.
 *
 * Layout экспортирует только default (правило Next), поэтому код языка — в
 * lib/zh/pages. Сторож — рендер документа: tests/unit/zh-quick.test.tsx.
 */
import { ZH_CONTENT_LANGUAGE } from '@/lib/zh/pages';

export default function ZhLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <meta httpEquiv="content-language" content={ZH_CONTENT_LANGUAGE} />
      {children}
    </>
  );
}
