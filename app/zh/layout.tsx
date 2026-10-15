/**
 * Раздел /zh — объявление языка документа (аудит 15.10, CN-quick).
 *
 * Китайская страница отдавалась под корневым `<html lang="ru">`: lang="zh-CN"
 * стоял только на <main>, ни заголовка, ни мета Content-Language не было.
 * Корневой `<html lang>` здесь не трогается: читать язык из запроса в корне
 * сделало бы динамическими все страницы, а свой корневой layout через группы
 * маршрутов — переезд всего app. Поэтому язык раздела объявлен двумя
 * дешёвыми сигналами: заголовок `Content-Language: zh-CN` (next.config.js,
 * правило /zh/:path*) и этот meta http-equiv — React 19 поднимает
 * <meta> из тела в <head> сам. Как Baidu, Shenma и Bing взвешивают его при
 * `<html lang="ru">`, не проверено; сигнал честный и ничего не стоит.
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
