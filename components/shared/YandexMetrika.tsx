'use client';

import Script from 'next/script';

// ID счётчика — НЕ секрет: он публично виден в HTML каждой страницы любого
// сайта с Метрикой. Дефолт зашит в код, потому что NEXT_PUBLIC_* вшивается
// на этапе сборки, а Dockerfile не пробрасывает env панели Timeweb в build —
// переменная окружения остаётся переопределением (пустая строка = выключить).
const id = process.env.NEXT_PUBLIC_YANDEX_METRIKA_ID ?? '103522218';

export default function YandexMetrika() {
  if (!id) return null;

  return (
    <>
      <Script id="yandex-metrika" strategy="afterInteractive">
        {`
          (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
          m[i].l=1*new Date();
          for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}
          k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
          (window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");
          ym(${id},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true,webvisor:true});
        `}
      </Script>
      <noscript>
        <div>
          <img
            src={`https://mc.yandex.ru/watch/${id}`}
            style={{ position: 'absolute', left: '-9999px' }}
            alt=""
          />
        </div>
      </noscript>
    </>
  );
}
