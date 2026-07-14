'use client';

/**
 * Редизайн Главной — v7 «Воронка» (превью).
 * Отдельный роут /home-v7: живая Главная (/) не трогается, пока не одобрено.
 * Порт крафтового прототипа: разметка + стили + интерактив (кольцо, компас,
 * сейсмолента, SOS-hold, «полуостров»). Шрифты — само-хостинг через next/font
 * (переменные --font-playfair / --font-manrope / --font-jetbrains). Данные пока
 * иллюстративные — следующий шаг привязать к БД (places, KVERT, лид-форма).
 */

import { useEffect } from 'react';

const CSS = `
.v7{
  --fd:var(--font-playfair),Georgia,serif;--fb:var(--font-manrope),system-ui,sans-serif;--fm:var(--font-jetbrains),ui-monospace,monospace;
  --pine:#2E5F46;--tide:#3E8CA3;--brusnika:#B23A32;--amber:#B4761F;--shroom:#D97B2E;--leaf:#4E8C5B;
}
html[data-v7theme="light"] .v7,.v7[data-v7theme="light"]{--bg:#F4F4F0;--ink:#1D2724;--muted:#66736E;--faint:#9AA5A0;--hair:rgba(29,39,36,.14);--hair-soft:rgba(29,39,36,.08);--plate:#EBECE6;--field:#FFFFFF}
html[data-v7theme="dark"] .v7,.v7[data-v7theme="dark"]{--bg:#111715;--ink:#EAEDEA;--muted:#93A09A;--faint:#5C6863;--hair:rgba(234,237,234,.16);--hair-soft:rgba(234,237,234,.08);--plate:#18201D;--field:#1A211E}
.v7 *{margin:0;padding:0;box-sizing:border-box}
.v7{font-family:var(--fb);background:var(--bg);color:var(--ink);min-height:100dvh;padding-bottom:96px;-webkit-font-smoothing:antialiased}
@media (prefers-reduced-motion:reduce){.v7 *,.v7 *::before,.v7 *::after{animation:none!important;transition:none!important}}
.v7 .wrap{max-width:480px;margin:0 auto;padding:0 20px}
.v7 .li{width:1em;height:1em;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;display:block}
.v7 a{color:inherit;text-decoration:none}
.v7 .mono{font:400 9.5px/1.5 var(--fm);letter-spacing:.06em}
.v7 .protobar{position:sticky;top:0;z-index:60;background:var(--bg);border-bottom:1px solid var(--hair);padding:9px 14px;display:flex;gap:10px;align-items:center}
.v7 .protobar .tag{font:400 9px/1 var(--fm);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-right:auto}
.v7 .seg{display:flex;gap:14px}
.v7 .seg button{font:600 10px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);background:none;border:0;padding:4px 0;cursor:pointer;border-bottom:1px solid transparent}
.v7 .seg button[aria-pressed="true"]{color:var(--ink);border-bottom-color:var(--ink)}
.v7 .topbar{position:sticky;top:39px;z-index:55;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--hair)}
.v7 .topbar .in{max-width:480px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:12px}
.v7 .topbar .brand{font:700 12px/1 var(--fb);letter-spacing:.42em;text-transform:uppercase;padding-left:.42em}
.v7 .topbar .sp{flex:1}
.v7 .icn{width:32px;height:32px;display:grid;place-items:center;color:var(--muted);font-size:15px;cursor:pointer;background:none;border:0;position:relative}
.v7 .eco-chip{display:inline-flex;align-items:center;gap:5px;font:600 10px/1 var(--fb);color:var(--leaf);border:1px solid color-mix(in srgb,var(--leaf) 32%,transparent);padding:6px 9px;border-radius:999px}
.v7 .eco-chip .li{width:11px;height:11px}
.v7 .cta-top{background:var(--shroom);color:#fff;border:0;font:700 10.5px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;padding:11px 14px;cursor:pointer;transition:transform .13s}
.v7 .cta-top:active{transform:scale(.96)}
.v7 .masthead{padding:22px 0 0;text-align:center}
.v7 .masthead .dateline{display:flex;align-items:center;gap:12px;justify-content:center;color:var(--muted)}
.v7 .masthead .dateline::before,.v7 .masthead .dateline::after{content:"";flex:0 0 34px;height:1px;background:var(--hair)}
.v7 .masthead .dateline span{font:400 9px/1 var(--fm);letter-spacing:.18em;text-transform:uppercase}
.v7 .masthead .dbl{margin:12px auto 0;max-width:200px;height:4px;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}
.v7 .hero{padding:26px 0 0;text-align:center}
.v7 .hero h1{font:500 38px/1.08 var(--fd);letter-spacing:-.012em}
.v7 .hero h1 em{font-style:italic;font-weight:600}
.v7 .hero .sub{margin-top:11px;font:500 12.5px/1.6 var(--fb);color:var(--muted);max-width:34ch;margin:11px auto 0}
.v7 .ring{position:relative;width:184px;height:184px;margin:22px auto 0;cursor:pointer;border:0;background:none;padding:0;-webkit-tap-highlight-color:transparent;display:block}
.v7 .ring svg.dial{width:100%;height:100%;transform:rotate(-90deg);color:var(--hair)}
.v7 .ring .core{position:absolute;inset:20px;border-radius:50%;border:1px solid var(--hair);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;transition:transform .18s}
.v7 .ring:active .core{transform:scale(.97)}
.v7 .ring .big{font:600 34px/1 var(--fd);font-feature-settings:"lnum"}
.v7 .ring .big i{font-style:normal;color:var(--faint);font-size:21px}
.v7 .ring .lbl{font:600 9px/1.4 var(--fb);letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.v7 .ring .tap{margin-top:5px;font:400 8.5px/1 var(--fm);letter-spacing:.12em;color:var(--tide)}
.v7 .hero .kvert{margin-top:13px;display:inline-flex;align-items:center;gap:8px;font:400 9.5px/1 var(--fm);letter-spacing:.1em;color:var(--muted)}
.v7 .hero .kvert i{width:6px;height:6px;border-radius:50%;background:var(--amber)}
.v7 .svodka{margin-top:22px;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);padding:13px 2px;display:flex;gap:12px;align-items:baseline;text-align:left}
.v7 .svodka .k{font:600 9px/1 var(--fb);letter-spacing:.2em;text-transform:uppercase;color:var(--brusnika);flex:none}
.v7 .svodka .t{font:500 13px/1.5 var(--fd);font-style:italic}
.v7 .svodka a{margin-left:auto;font:600 9.5px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:var(--tide);flex:none}
.v7 section{margin-top:42px}
.v7 .shead{display:flex;align-items:baseline;gap:14px;margin-bottom:16px}
.v7 .shead .num{font:500 11px/1 var(--fm);color:var(--faint)}
.v7 .shead h2{font:600 21px/1.2 var(--fd)}
.v7 .shead .line{flex:1;height:1px;background:var(--hair-soft)}
.v7 .shead .all{font:600 9.5px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:var(--tide)}
.v7 .plates{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;margin:0 -20px}
.v7 .plates::-webkit-scrollbar{display:none}
.v7 .plate{flex:none;width:100%;scroll-snap-align:center;padding:0 20px}
.v7 .plate .img{position:relative;aspect-ratio:4/3;overflow:hidden;background:var(--plate)}
.v7 .plate .img .art{position:absolute;inset:0;transition:transform 7s linear}
.v7 .plate.live .img .art{transform:scale(1.05)}
.v7 .plate .img::after{content:"";position:absolute;inset:7px;border:1px solid rgba(244,244,240,.4);pointer-events:none}
.v7 .plate .img .grain{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 0%,transparent 55%,rgba(17,23,21,.2) 100%)}
.v7 .plate .row{display:flex;align-items:baseline;gap:10px;padding:11px 2px 0}
.v7 .plate .row .pl{font:400 9px/1 var(--fm);letter-spacing:.16em;color:var(--faint)}
.v7 .plate .row b{font:600 15px/1.2 var(--fd)}
.v7 .plate .row .st{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font:600 8.5px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.v7 .plate .row .st i{width:5px;height:5px;border-radius:50%}
.v7 .st i.ok{background:var(--pine)}.v7 .st i.att{background:var(--amber)}.v7 .st i.cls{background:var(--brusnika)}
.v7 .plate .cap{padding:5px 2px 0;font:400 11px/1.55 var(--fb);color:var(--muted)}
.v7 .plate .buy{margin-top:9px;padding:9px 2px 0;border-top:1px solid var(--hair-soft);display:flex;align-items:baseline;gap:10px}
.v7 .plate .buy .price{font:600 14px/1 var(--fd);font-feature-settings:"lnum"}
.v7 .plate .buy .price small{font:400 8.5px/1 var(--fm);color:var(--faint);margin-left:5px;letter-spacing:.06em}
.v7 .plate .buy .eco{font:600 9px/1 var(--fb);color:var(--leaf);display:inline-flex;align-items:center;gap:4px}
.v7 .plate .buy .eco .li{width:10px;height:10px}
.v7 .plate .buy a{margin-left:auto;font:700 9.5px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:var(--shroom);border-bottom:1px solid color-mix(in srgb,var(--shroom) 45%,transparent);padding-bottom:3px}
.v7 .pl-dots{display:flex;gap:14px;justify-content:center;margin-top:16px}
.v7 .pl-dots i{font:400 9px/1 var(--fm);color:var(--faint)}
.v7 .pl-dots i.on{color:var(--ink)}
.v7 .arrivals{margin-top:20px;border-top:1px solid var(--hair-soft);padding-top:11px;display:flex;gap:10px;align-items:baseline}
.v7 .arrivals .k{font:600 8.5px/1 var(--fb);letter-spacing:.2em;text-transform:uppercase;color:var(--faint);flex:none}
.v7 .arrivals .t{font:500 11.5px/1.5 var(--fb);color:var(--muted);transition:opacity .4s}
.v7 .arrivals .t b{color:var(--ink);font-weight:600}
.v7 .arrivals .t.out{opacity:0}
.v7 .guide{border-left:2px solid var(--pine);padding:2px 0 2px 18px}
.v7 .guide q{display:block;font:500 17px/1.5 var(--fd);font-style:italic;quotes:"«" "»"}
.v7 .guide .sig{margin-top:10px;display:flex;align-items:center;gap:10px}
.v7 .guide .sig .caps{font:600 10px/1 var(--fb);letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}
.v7 .guide .sig .dot{width:4px;height:4px;border-radius:50%;background:var(--faint)}
.v7 .guide .acts{margin-top:14px;display:flex;gap:22px;align-items:center}
.v7 .guide .acts a{font:600 10px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--pine);border-bottom:1px solid color-mix(in srgb,var(--pine) 35%,transparent);padding-bottom:3px}
.v7 .guide .acts a.lead{color:var(--shroom);border-bottom-color:color-mix(in srgb,var(--shroom) 45%,transparent)}
.v7 .inst{display:grid;grid-template-columns:144px 1fr;gap:20px;align-items:center}
.v7 .compass{position:relative;width:144px;height:144px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.v7 .compass svg{width:100%;height:100%;display:block;color:var(--hair)}
.v7 .compass text{font:600 10px var(--fb);fill:var(--muted)}
.v7 .compass .deg{font:400 8px var(--fm);fill:var(--faint)}
.v7 .compass .hd{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none}
.v7 .compass .hd b{display:block;font:500 15px/1 var(--fd);font-feature-settings:"lnum"}
.v7 .compass .hd span{font:400 7.5px/1.4 var(--fm);letter-spacing:.14em;color:var(--faint)}
.v7 .compass .hint{position:absolute;left:50%;transform:translateX(-50%);bottom:-15px;color:var(--faint);white-space:nowrap;font:400 7.5px/1 var(--fm)}
.v7 .s3{display:flex;flex-direction:column}
.v7 .s3 .r{display:flex;align-items:baseline;gap:11px;padding:9px 0;border-bottom:1px solid var(--hair-soft)}
.v7 .s3 .r:last-child{border-bottom:0}
.v7 .s3 i{width:6px;height:6px;border-radius:50%;flex:none;align-self:center}
.v7 .s3 .n{font:500 23px/1 var(--fd);font-feature-settings:"lnum";min-width:32px}
.v7 .s3 .t{font:600 8.5px/1.3 var(--fb);letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.v7 .s3 .d{font:400 9.5px/1.4 var(--fb);color:var(--faint);margin-left:auto;text-align:right;max-width:12ch}
.v7 .seismo{margin-top:18px;border-top:1px solid var(--hair-soft);padding-top:10px}
.v7 .seismo .cap{display:flex;justify-content:space-between;font:400 8.5px/1 var(--fm);letter-spacing:.12em;color:var(--faint)}
.v7 .seismo canvas{width:100%;height:34px;display:block;margin-top:6px}
.v7 .dataline{display:flex;overflow-x:auto;scrollbar-width:none}
.v7 .dataline::-webkit-scrollbar{display:none}
.v7 .dl{flex:none;padding:2px 20px 2px 0;margin-right:20px;border-right:1px solid var(--hair-soft)}
.v7 .dl:last-child{border-right:0;margin-right:0}
.v7 .dl .n{font:500 26px/1 var(--fd);font-feature-settings:"lnum"}
.v7 .dl .t{margin-top:6px;font:600 8.5px/1.4 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.v7 .dl.link .t{color:var(--tide)}
.v7 .index .row{display:flex;align-items:center;gap:14px;padding:13px 2px;border-bottom:1px solid var(--hair-soft);transition:padding-left .2s}
.v7 .index .row:first-child{border-top:1px solid var(--hair-soft)}
.v7 .index .row:active{padding-left:8px}
.v7 .index .num{font:400 9.5px/1 var(--fm);color:var(--faint);width:20px}
.v7 .index .sw{width:34px;height:24px;flex:none}
.v7 .index b{font:600 14px/1.2 var(--fd)}
.v7 .index .cnt2{font:400 10px/1 var(--fm);color:var(--faint);margin-left:auto}
.v7 .index .arr{font:400 11px/1 var(--fb);color:var(--tide)}
.v7 .gallery{columns:2;column-gap:14px}
.v7 .frame{break-inside:avoid;margin-bottom:16px;display:block}
.v7 .frame .img{background:var(--plate);position:relative;overflow:hidden}
.v7 .frame .img::after{content:"";position:absolute;inset:6px;border:1px solid rgba(244,244,240,.4);pointer-events:none}
.v7 .frame .img .art{display:block;width:100%}
.v7 .frame figcaption{padding:7px 1px 0;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.v7 .frame figcaption b{font:600 11.5px/1.3 var(--fd)}
.v7 .frame figcaption span{font:400 8px/1 var(--fm);letter-spacing:.08em;color:var(--faint);white-space:nowrap}
.v7 .eco{border:1px solid var(--hair);padding:16px 16px 14px}
.v7 .eco .top{display:flex;align-items:baseline;gap:10px}
.v7 .eco .top .li{width:16px;height:16px;color:var(--leaf);align-self:center}
.v7 .eco .top b{font:600 15px/1.2 var(--fd)}
.v7 .eco .top .bal{margin-left:auto;font:500 18px/1 var(--fd);color:var(--leaf);font-feature-settings:"lnum"}
.v7 .eco .top .bal small{font:400 8.5px/1 var(--fm);color:var(--faint);margin-left:4px}
.v7 .eco .bar{margin-top:11px;height:2px;background:var(--hair-soft);position:relative}
.v7 .eco .bar i{position:absolute;left:0;top:0;bottom:0;background:var(--leaf);width:0;transition:width 1.1s cubic-bezier(.2,.8,.3,1)}
.v7 .eco .lvl{margin-top:7px;display:flex;justify-content:space-between;font:400 8.5px/1 var(--fm);color:var(--faint)}
.v7 .eco .ways{margin-top:14px;border-top:1px solid var(--hair-soft)}
.v7 .eco .way{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--hair-soft)}
.v7 .eco .way:last-child{border-bottom:0}
.v7 .eco .way .li{width:14px;height:14px;color:var(--muted)}
.v7 .eco .way span{font:500 11.5px/1.4 var(--fb)}
.v7 .eco .way b{margin-left:auto;font:600 11px/1 var(--fb);color:var(--leaf)}
.v7 .lead{border:1px solid var(--hair);padding:20px 18px}
.v7 .lead h3{font:500 25px/1.2 var(--fd)}
.v7 .lead h3 em{font-style:italic;font-weight:600}
.v7 .lead p{margin-top:9px;font:400 11.5px/1.6 var(--fb);color:var(--muted)}
.v7 .lead .chips{margin-top:14px;display:flex;flex-wrap:wrap;gap:7px}
.v7 .lead .chip{font:600 9.5px/1 var(--fb);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border:1px solid var(--hair);background:none;padding:8px 11px;cursor:pointer;transition:.15s}
.v7 .lead .chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.v7 .lead .field{margin-top:14px;display:flex;border:1px solid var(--hair);background:var(--field)}
.v7 .lead .field input{flex:1;border:0;background:none;padding:14px 13px;font:500 13px/1 var(--fb);color:var(--ink);outline:none}
.v7 .lead .field input::placeholder{color:var(--faint)}
.v7 .lead .field button{border:0;background:var(--shroom);color:#fff;font:700 10px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;padding:0 18px;cursor:pointer}
.v7 .lead .fine{margin-top:9px;font:400 8.5px/1.5 var(--fm);color:var(--faint)}
.v7 .lead .ok{margin-top:14px;padding:12px;border:1px solid color-mix(in srgb,var(--pine) 40%,transparent);font:500 12px/1.5 var(--fb);color:var(--pine);display:none}
.v7 .lead.sent .ok{display:block}
.v7 .lead.sent .field,.v7 .lead.sent .chips,.v7 .lead.sent .fine{display:none}
.v7 .hubline{display:flex;flex-wrap:wrap;gap:12px 24px}
.v7 .hubline a{font:600 10.5px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);padding-bottom:4px;border-bottom:1px solid transparent}
.v7 .hubline a:active{color:var(--ink);border-bottom-color:var(--ink)}
.v7 .note{margin:42px 0 8px;padding-top:12px;border-top:1px solid var(--hair);font:400 9px/1.7 var(--fm);color:var(--faint)}
.v7 nav.tabs{position:fixed;left:0;right:0;bottom:0;z-index:50;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(16px);border-top:1px solid var(--hair)}
.v7 nav.tabs .in{max-width:480px;margin:0 auto;display:flex}
.v7 nav.tabs a{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:11px 0 calc(10px + env(safe-area-inset-bottom));color:var(--faint);font:600 8px/1 var(--fb);letter-spacing:.18em;text-transform:uppercase}
.v7 nav.tabs a .ic{font-size:16px}
.v7 nav.tabs a.active{color:var(--ink)}
.v7 nav.tabs a.sos-tab{color:var(--shroom)}
.v7 .sos{position:fixed;right:18px;bottom:78px;z-index:55;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:var(--shroom);color:#fff;font:700 12px/1 var(--fb);letter-spacing:.12em;box-shadow:0 6px 22px color-mix(in srgb,var(--shroom) 35%,transparent);touch-action:none;user-select:none;-webkit-user-select:none}
.v7 .sos svg.hold{position:absolute;inset:-6px}
.v7 .sos circle{fill:none;stroke:var(--shroom);stroke-width:1.5;stroke-linecap:round;stroke-dasharray:213;stroke-dashoffset:213;transform:rotate(-90deg);transform-origin:center}
.v7 .scrim{position:fixed;inset:0;background:rgba(17,23,21,.5);z-index:70;opacity:0;pointer-events:none;transition:opacity .25s}
.v7 .sheet{position:fixed;left:0;right:0;bottom:0;z-index:71;transform:translateY(105%);transition:transform .32s cubic-bezier(.3,.9,.3,1);background:var(--bg);border-top:1px solid var(--hair);padding:18px 22px calc(22px + env(safe-area-inset-bottom));max-width:480px;margin:0 auto}
.v7.sos-open .sheet{transform:none}
.v7.sos-open .scrim{opacity:1;pointer-events:auto}
.v7 .sheet h3{font:600 22px/1.2 var(--fd)}
.v7 .sheet p{font:400 11.5px/1.6 var(--fb);color:var(--muted);margin-top:6px}
.v7 .proto{width:100%;display:flex;align-items:center;gap:14px;padding:13px 2px;border:0;border-bottom:1px solid var(--hair-soft);background:none;cursor:pointer;color:var(--ink);text-align:left;font-family:var(--fb)}
.v7 .protocols{margin-top:16px}
.v7 .proto:first-child{border-top:1px solid var(--hair-soft)}
.v7 .proto .ic{font-size:18px;color:var(--shroom)}
.v7 .proto b{font:600 14px/1.2 var(--fd)}
.v7 .proto span{font:400 10px/1.4 var(--fb);color:var(--muted);margin-left:auto;text-align:right}
.v7 .call112{margin-top:16px;width:100%;padding:15px;border:0;cursor:pointer;background:var(--brusnika);color:#fff;font:700 12px/1 var(--fb);letter-spacing:.2em;text-transform:uppercase}
.v7 .pen{position:fixed;inset:0;z-index:80;background:#101614;color:#EAEDEA;transform:translateY(102%);transition:transform .42s cubic-bezier(.3,.9,.25,1);overflow-y:auto;overscroll-behavior:contain}
.v7.pen-open .pen{transform:none}
.v7.pen-open{overflow:hidden}
.v7 .pen-in{max-width:480px;margin:0 auto;position:relative;padding:0 20px 44px}
.v7 .pen-head{position:sticky;top:0;z-index:5;display:flex;align-items:center;padding:14px 0;background:color-mix(in srgb,#101614 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid rgba(234,237,234,.14)}
.v7 .pen-head .k{font:400 9px/1 var(--fm);letter-spacing:.22em;text-transform:uppercase;color:#93A09A}
.v7 .pen-head .sp{flex:1}
.v7 .pen-close{border:0;background:none;color:#EAEDEA;font:600 9.5px/1 var(--fb);letter-spacing:.18em;text-transform:uppercase;cursor:pointer;padding:6px 0 6px 12px}
.v7 .pen .lat{position:absolute;right:2px;top:130px;bottom:60px;z-index:4;pointer-events:none}
.v7 .pen .lat .val{position:sticky;top:46vh;writing-mode:vertical-rl;font:400 9.5px/1 var(--fm);letter-spacing:.16em;color:#5C6863}
.v7 .pen .lat b{color:#EAEDEA;font-weight:400}
.v7 .pen-title{padding:30px 0 8px}
.v7 .pen-title h2{font:500 33px/1.1 var(--fd)}
.v7 .pen-title h2 em{font-style:italic;font-weight:600}
.v7 .pen-title p{font:400 12px/1.6 var(--fb);color:#93A09A;margin-top:10px;max-width:36ch}
.v7 .pen-title .stat{margin-top:12px;font:400 9px/1.7 var(--fm);color:#5C6863}
.v7 .journey{position:relative;padding:24px 10px 4px 0;margin-top:6px}
.v7 .journey::before{content:"";position:absolute;left:8px;top:0;bottom:0;width:1px;background:rgba(234,237,234,.14)}
.v7 .journey .trace{position:absolute;left:8px;top:0;width:1px;height:0;background:#EAEDEA}
.v7 .stop{position:relative;padding:0 0 34px 34px;opacity:0;transform:translateY(14px);transition:opacity .5s,transform .5s}
.v7 .stop.in{opacity:1;transform:none}
.v7 .stop .pin{position:absolute;left:4px;top:7px;width:9px;height:9px;border-radius:50%;background:#101614;border:1.5px solid var(--pc,#EAEDEA)}
.v7 .stop.tremor .pin::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:1px solid color-mix(in srgb,var(--pc) 45%,transparent);animation:trm 1s infinite}
@keyframes trm{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}
.v7 .stop .coords{font:400 8.5px/1 var(--fm);letter-spacing:.1em;color:#5C6863}
.v7 .stop h3{font:500 24px/1.15 var(--fd);margin-top:6px}
.v7 .stop .st2{display:inline-flex;align-items:center;gap:7px;margin-top:8px;font:600 8.5px/1 var(--fb);letter-spacing:.18em;text-transform:uppercase;color:var(--pc)}
.v7 .stop .st2 i{width:5px;height:5px;border-radius:50%;background:var(--pc)}
.v7 .stop p{font:400 11.5px/1.6 var(--fb);color:#93A09A;margin-top:9px;max-width:38ch}
.v7 .stop .act{display:inline-block;margin-top:10px;font:600 9.5px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:#EAEDEA;border-bottom:1px solid rgba(234,237,234,.3);padding-bottom:3px}
.v7 .pen-south{margin-top:10px;padding-top:20px;border-top:1px solid rgba(234,237,234,.14)}
.v7 .pen-south .k{font:400 8.5px/1 var(--fm);letter-spacing:.22em;text-transform:uppercase;color:#5C6863}
.v7 .pen-south h3{font:500 27px/1.15 var(--fd);margin-top:10px}
.v7 .pen-south p{font:400 12px/1.6 var(--fb);color:#93A09A;margin-top:9px}
.v7 .pen-south .row{display:flex;gap:26px;margin-top:16px}
.v7 .pen-south a,.v7 .pen-south button{font:600 10px/1 var(--fb);letter-spacing:.18em;text-transform:uppercase;color:#EAEDEA;background:none;border:0;border-bottom:1px solid rgba(234,237,234,.35);padding:0 0 4px;cursor:pointer}
.v7 .pen-south a{color:var(--shroom);border-bottom-color:color-mix(in srgb,var(--shroom) 45%,transparent)}
`;

const MARKUP = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-home" viewBox="0 0 24 24"><path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/></symbol>
<symbol id="i-map" viewBox="0 0 24 24"><path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z"/><path d="M9 4v13m6-10.5v13"/></symbol>
<symbol id="i-bear" viewBox="0 0 24 24"><circle cx="7.5" cy="7" r="2.2"/><circle cx="16.5" cy="7" r="2.2"/><path d="M5.8 10.5A7 7 0 0 1 12 7a7 7 0 0 1 6.2 3.5A6.4 6.4 0 0 1 19 14c0 3.5-3.1 6-7 6s-7-2.5-7-6c0-1.3.3-2.4.8-3.5Z"/></symbol>
<symbol id="i-route" viewBox="0 0 24 24"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 17h6a4 4 0 0 0 0-8h-4"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4 3 19h18Z"/><path d="M12 10v4m0 2.6v.2"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></symbol>
<symbol id="i-leaf" viewBox="0 0 24 24"><path d="M5 19C4 13 8 5 19 5c0 9-5 13-11 13H5Z"/><path d="M5 19c2-5 5-8 10-10"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.4 2.4L15.5 9.6"/></symbol>
<symbol id="i-lost" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.6a2.4 2.4 0 1 1 3.4 2.6c-.8.4-1.2.9-1.2 1.8m0 2.8v.2"/></symbol>
<symbol id="i-paw" viewBox="0 0 24 24"><circle cx="7" cy="9" r="1.6"/><circle cx="12" cy="7" r="1.6"/><circle cx="17" cy="9" r="1.6"/><path d="M12 12c-3 0-5.5 2.6-5.5 5 0 1.4 1 2.3 2.3 2.3 1.2 0 2-.8 3.2-.8s2 .8 3.2.8c1.3 0 2.3-.9 2.3-2.3 0-2.4-2.5-5-5.5-5Z"/></symbol>
<symbol id="i-injury" viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="13" rx="2"/><path d="M12 10.5v6M9 13.5h6"/></symbol>
<symbol id="i-cold" viewBox="0 0 24 24"><path d="M12 4v16M6.8 7l10.4 10M17.2 7 6.8 17"/></symbol>
</defs></svg>

<div class="protobar">
  <span class="tag">Превью · v7 «Воронка»</span>
  <div class="seg" id="themeSeg">
    <button data-v="light" aria-pressed="true">Днём</button>
    <button data-v="dark" aria-pressed="false">В поле</button>
  </div>
</div>

<div class="topbar"><div class="in">
  <span class="brand">Ведар</span>
  <span class="sp"></span>
  <span class="eco-chip" title="Эко-баллы"><svg class="li"><use href="#i-leaf"/></svg>140</span>
  <button class="icn" aria-label="Поиск"><svg class="li"><use href="#i-search"/></svg></button>
  <button class="cta-top" id="ctaTop">Хочу тур</button>
</div></div>

<div class="wrap">
  <header class="masthead">
    <div class="dateline"><span id="dateline">Камчатка · сегодня</span></div>
    <div class="dbl"></div>
  </header>

  <div class="hero">
    <h1>Полуостров,<br>прочитанный <em>сегодня</em></h1>
    <p class="sub">Живая сводка по 16 маршрутам и зонам — КВЕРТ, КБГС РАН, полевые данные.</p>
    <button class="ring" id="ringBtn" aria-label="Открыть сводку по полуострову">
      <svg class="dial" viewBox="0 0 184 184" id="ringSvg"></svg>
      <span class="core">
        <span class="big"><span id="openCnt">12</span><i>/16</i></span>
        <span class="lbl">открыто</span>
        <span class="tap">тап — пройти полуостров →</span>
      </span>
    </button>
    <div class="kvert"><i></i>КВЕРТ: оранжевый · Шивелуч</div>
    <div class="svodka">
      <span class="k">Сводка</span>
      <span class="t">Вачкажец: проезд закрыт 20–27 июля, распоряжение природного парка.</span>
      <a href="#">Детали</a>
    </div>
  </div>

  <section>
    <div class="shead"><span class="num">I</span><h2>Куда сегодня</h2><span class="line"></span><a class="all" href="#">Все 233</a></div>
    <div class="plates" id="plates">
      <figure class="plate live">
        <a href="#"><div class="img"><span class="art" style="background:radial-gradient(70% 45% at 50% 18%,#C8D6CB 0%,transparent 60%),linear-gradient(180deg,#7C9E88 0%,#48725B 46%,#2E5140 100%)"></span><span class="grain"></span></div></a>
        <div class="row"><span class="pl">ПЛ. I</span><b>Курильское озеро</b><span class="st"><i class="att"></i>Нерест</span></div>
        <div class="cap">Медведей больше, чем людей. Только с инспектором · 2 дня · вертолёт</div>
        <div class="buy"><span class="price">89 000 ₽<small>/чел</small></span><span class="eco"><svg class="li"><use href="#i-leaf"/></svg>+40 эко</span><a href="#">Смотреть туры</a></div>
      </figure>
      <figure class="plate">
        <a href="#"><div class="img"><span class="art" style="background:linear-gradient(180deg,#BCD6DD 0%,#7FB4C4 40%,#4E8FA6 68%,#2E657C 100%)"></span><span class="grain"></span></div></a>
        <div class="row"><span class="pl">ПЛ. II</span><b>Бухта Русская</b><span class="st"><i class="ok"></i>Открыта</span></div>
        <div class="cap">Сивучи, косатки и старый корабль · морская прогулка, 10 часов</div>
        <div class="buy"><span class="price">14 500 ₽<small>/чел</small></span><span class="eco"><svg class="li"><use href="#i-leaf"/></svg>+15 эко</span><a href="#">Смотреть туры</a></div>
      </figure>
      <figure class="plate">
        <a href="#"><div class="img"><span class="art" style="background:linear-gradient(180deg,#B9C6CD 0%,#7E93A0 42%,#3A4A54 72%,#1E282E 100%)"></span><span class="grain"></span></div></a>
        <div class="row"><span class="pl">ПЛ. III</span><b>Халактырский пляж</b><span class="st"><i class="ok"></i>Открыт</span></div>
        <div class="cap">Чёрный песок, океан, сёрф · эко-точка: уборка пляжа</div>
        <div class="buy"><span class="price">4 500 ₽<small>/чел</small></span><span class="eco"><svg class="li"><use href="#i-leaf"/></svg>+30 эко</span><a href="#">Смотреть туры</a></div>
      </figure>
      <figure class="plate">
        <a href="#"><div class="img"><span class="art" style="background:radial-gradient(50% 38% at 46% 62%,#C9CDCB 0%,rgba(201,205,203,.3) 45%,transparent 70%),linear-gradient(180deg,#8AA878 0%,#5B8556 48%,#3A6144 100%)"></span><span class="grain"></span></div></a>
        <div class="row"><span class="pl">ПЛ. IV</span><b>Чавыча и кижуч</b><span class="st"><i class="ok"></i>Клюёт</span></div>
        <div class="cap">Реки юга, по лицензии · с гидом, снаряжение включено</div>
        <div class="buy"><span class="price">22 000 ₽<small>/чел</small></span><span class="eco"><svg class="li"><use href="#i-leaf"/></svg>+20 эко</span><a href="#">Смотреть туры</a></div>
      </figure>
    </div>
    <div class="pl-dots" id="plDots"></div>
    <div class="arrivals"><span class="k">Журнал</span><span class="t" id="feedTx"><b>Иван</b> забронировал тур на Горелый · 2 мин назад</span></div>
  </section>

  <section>
    <div class="shead"><span class="num">II</span><h2>Колонка проводника</h2><span class="line"></span></div>
    <div class="guide">
      <q id="kzQuote">Мутновский сегодня трясёт — на юг лучше через Горелый.</q>
      <div class="sig"><span class="caps">Кузьмич</span><span class="dot"></span><span class="mono" style="color:var(--faint)">по данным, не по слухам</span></div>
      <div class="acts"><a href="#">Спросить</a><a class="lead" href="#" id="ctaGuide">Подобрать тур</a></div>
    </div>
  </section>

  <section>
    <div class="shead"><span class="num">III</span><h2>Приборы и радар</h2><span class="line"></span><a class="all" href="#">Карта</a></div>
    <div class="inst">
      <div class="compass" id="compass">
        <svg viewBox="0 0 144 144" aria-hidden="true">
          <circle cx="72" cy="72" r="68" fill="none" stroke="currentColor" stroke-width="1"/>
          <circle cx="72" cy="72" r="54" fill="none" stroke="currentColor" stroke-width="1" opacity=".6"/>
          <g id="rose"></g>
          <path d="M72 2 L69 10 L75 10 Z" fill="var(--brusnika)"/>
        </svg>
        <div class="hd"><b id="hdg">—°</b><span id="hdgc">СЕВЕР</span></div>
        <div class="hint" id="cmpHint">тап — включить датчик</div>
      </div>
      <div class="s3">
        <div class="r"><i style="background:var(--pine)"></i><span class="n cnt" data-n="12">0</span><span class="t">Активно</span><span class="d">Авачинский · +11</span></div>
        <div class="r"><i style="background:var(--amber)"></i><span class="n cnt" data-n="3">0</span><span class="t">Внимание</span><span class="d">Вачкажец · Курильское</span></div>
        <div class="r"><i style="background:var(--brusnika)"></i><span class="n cnt" data-n="1">0</span><span class="t">Закрыто</span><span class="d">Мутновский</span></div>
      </div>
    </div>
    <div class="seismo"><div class="cap"><span>СЕЙСМОЛЕНТА · КБГС РАН</span><span id="seismoT">—:—</span></div><canvas id="seismoC"></canvas></div>
  </section>

  <section>
    <div class="shead"><span class="num">IV</span><h2>В цифрах</h2><span class="line"></span></div>
    <div class="dataline">
      <a class="dl link" href="#"><div class="n cnt" data-n="233">0</div><div class="t">маршрута →</div></a>
      <a class="dl link" href="#"><div class="n cnt" data-n="541">0</div><div class="t">локация →</div></a>
      <div class="dl"><div class="n cnt" data-n="152">0</div><div class="t">рег. МЧС</div></div>
      <div class="dl"><div class="n cnt" data-n="557">0</div><div class="t">профилей риска</div></div>
      <div class="dl"><div class="n">24/7</div><div class="t">SAR</div></div>
    </div>
  </section>

  <section>
    <div class="shead"><span class="num">V</span><h2>Стихии</h2><span class="line"></span><a class="all" href="#">Все места</a></div>
    <div class="index">
      <a class="row" href="#"><span class="num">01</span><span class="sw" style="background:linear-gradient(135deg,#8A3B28,#4A1F15)"></span><b>Огонь</b><span class="cnt2">98 мест</span><span class="arr">→</span></a>
      <a class="row" href="#"><span class="num">02</span><span class="sw" style="background:linear-gradient(135deg,#D7E4EC,#8FA9BC)"></span><b>Снег</b><span class="cnt2">41 место</span><span class="arr">→</span></a>
      <a class="row" href="#"><span class="num">03</span><span class="sw" style="background:linear-gradient(135deg,#79B7C7,#2E657C)"></span><b>Океан</b><span class="cnt2">76 мест</span><span class="arr">→</span></a>
      <a class="row" href="#"><span class="num">04</span><span class="sw" style="background:linear-gradient(135deg,#D9C9A8,#8FB8AE)"></span><b>Термы</b><span class="cnt2">63 места</span><span class="arr">→</span></a>
      <a class="row" href="#"><span class="num">05</span><span class="sw" style="background:linear-gradient(135deg,#7FA36B,#3A6144)"></span><b>Природа</b><span class="cnt2">189 мест</span><span class="arr">→</span></a>
      <a class="row" href="#"><span class="num">06</span><span class="sw" style="background:linear-gradient(135deg,#5E6F6A,#242E2B)"></span><b>Защита</b><span class="cnt2">статусы</span><span class="arr">→</span></a>
    </div>
  </section>

  <section>
    <div class="shead"><span class="num">VI</span><h2>Эко-баллы</h2><span class="line"></span><a class="all" href="#">История</a></div>
    <div class="eco">
      <div class="top"><svg class="li"><use href="#i-leaf"/></svg><b>Уровень 1 · Гость полуострова</b><span class="bal">140<small>/500</small></span></div>
      <div class="bar"><i id="ecoBar"></i></div>
      <div class="lvl"><span>до уровня 2 — 360 баллов</span><span>обновлено 09.07</span></div>
      <div class="ways">
        <div class="way"><svg class="li"><use href="#i-check"/></svg><span>Регистрация выхода в МЧС</span><b>+25</b></div>
        <div class="way"><svg class="li"><use href="#i-trash"/></svg><span>Уборка на эко-точке · Халактырский</span><b>+30</b></div>
        <div class="way"><svg class="li"><use href="#i-leaf"/></svg><span>Завершённый эко-тур</span><b>+15…40</b></div>
      </div>
    </div>
  </section>

  <section>
    <div class="shead"><span class="num">VII</span><h2>Собрать поездку</h2><span class="line"></span></div>
    <div class="lead" id="leadBox">
      <h3>Не знаете, <em>с чего начать</em>?</h3>
      <p>Опишите поездку — подберём маршруты и передадим проверенным операторам. Ответ сегодня.</p>
      <div class="chips" id="chips">
        <button class="chip" aria-pressed="false">Вулканы</button><button class="chip" aria-pressed="false">Рыбалка</button><button class="chip" aria-pressed="false">Медведи</button><button class="chip" aria-pressed="false">Океан</button><button class="chip" aria-pressed="false">Термы</button><button class="chip" aria-pressed="false">Хели-ски</button>
      </div>
      <div class="field"><input id="leadInput" type="text" inputmode="tel" placeholder="Телефон или Telegram" aria-label="Контакт"><button id="leadSend">Отправить</button></div>
      <div class="fine">Данные уходят только операторам по вашему запросу. Без спама и рекламы.</div>
      <div class="ok" id="leadOk">Заявка принята. Кузьмич собирает подборку — оператор ответит в течение дня.</div>
    </div>
  </section>

  <section>
    <div class="shead"><span class="num">VIII</span><h2>Разделы</h2><span class="line"></span></div>
    <div class="hubline"><a href="#">Туристам</a><a href="#">Рыбалка</a><a href="#">Операторам</a><a href="#">Гидам</a><a href="#">Жильё</a><a href="#">Снаряжение</a><a href="#">Трансферы</a></div>
  </section>

  <div class="note">Превью v7 «Воронка» на /home-v7. Данные пока иллюстративные — следующий шаг привязать платы к places, кольцо/статусы к KVERT, лид-форму к lead-processor. Живая Главная (/) не тронута.</div>
</div>

<button class="sos" id="sosBtn" aria-label="SOS — удерживайте">SOS<svg class="hold" viewBox="0 0 72 72"><circle id="holdArc" cx="36" cy="36" r="34"/></svg></button>
<div class="scrim" id="scrim"></div>
<div class="sheet" role="dialog" aria-label="Экстренная помощь">
  <h3>Что случилось?</h3>
  <p>Категория уйдёт спасателям вместе с координатами. Работает офлайн — SMS-канал.</p>
  <div class="protocols">
    <button class="proto"><span class="ic"><svg class="li"><use href="#i-lost"/></svg></span><b>Потерялся</b><span>маяк + последняя точка</span></button>
    <button class="proto"><span class="ic"><svg class="li"><use href="#i-paw"/></svg></span><b>Медведь</b><span>протокол встречи</span></button>
    <button class="proto"><span class="ic"><svg class="li"><use href="#i-injury"/></svg></span><b>Травма</b><span>помощь + вызов SAR</span></button>
    <button class="proto"><span class="ic"><svg class="li"><use href="#i-cold"/></svg></span><b>Холод</b><span>гипотермия офлайн</span></button>
  </div>
  <button class="call112">Позвонить 112</button>
</div>

<nav class="tabs"><div class="in">
  <a href="#" class="active"><span class="ic"><svg class="li"><use href="#i-home"/></svg></span>Дом</a>
  <a href="#"><span class="ic"><svg class="li"><use href="#i-map"/></svg></span>Карта</a>
  <a href="#"><span class="ic"><svg class="li"><use href="#i-bear"/></svg></span>Кузьмич</a>
  <a href="#"><span class="ic"><svg class="li"><use href="#i-route"/></svg></span>Маршруты</a>
  <a href="#" class="sos-tab"><span class="ic"><svg class="li"><use href="#i-alert"/></svg></span>СОС</a>
</div></nav>

<div class="pen" id="pen" role="dialog" aria-label="Сводка по полуострову">
  <div class="pen-in">
    <div class="pen-head"><span class="k">Сводка дня</span><span class="sp"></span><button class="pen-close" id="penClose">Закрыть</button></div>
    <div class="lat"><div class="val"><b id="latVal">56.9°N</b> · широта</div></div>
    <div class="pen-title"><h2>Полуостров читается <em>сверху вниз</em></h2><p>1200 км с севера на юг — как ваш экран. Каждая остановка — живой статус.</p><div class="stat">сегодня: 12/16 открыто</div></div>
    <div class="journey" id="journey">
      <div class="trace" id="trace"></div>
      <article class="stop tremor" style="--pc:var(--amber)"><span class="pin"></span><div class="coords">56.65°N · 161.36°E · 3283 м</div><h3>Шивелуч</h3><span class="st2"><i></i>КВЕРТ: оранжевый</span><p>Пепловые выбросы возможны, подходы вне троп запрещены.</p><a class="act" href="#">Статус и зона</a></article>
      <article class="stop" style="--pc:var(--pine)"><span class="pin"></span><div class="coords">56.06°N · 160.64°E · 4754 м</div><h3>Ключевская сопка</h3><span class="st2"><i></i>Спокоен</span><p>Высшая точка полуострова. Восхождение — с регистрацией МЧС и гидом.</p><a class="act" href="#">Маршруты района</a></article>
      <article class="stop" style="--pc:var(--pine)"><span class="pin"></span><div class="coords">53.26°N · 158.83°E · 2741 м</div><h3>Авачинский</h3><span class="st2"><i></i>Открыт</span><p>«Домашний вулкан». Классика первого восхождения — 6–8 часов.</p><a class="act" href="#">Собрать выход</a></article>
      <article class="stop" style="--pc:var(--brusnika)"><span class="pin"></span><div class="coords">53.17°N · 157.77°E · хребет</div><h3>Вачкажец</h3><span class="st2"><i></i>Закрыт до 27.07</span><p>Проезд закрыт распоряжением природного парка.</p><a class="act" href="#">Причина и обход</a></article>
      <article class="stop" style="--pc:var(--pine)"><span class="pin"></span><div class="coords">52.56°N · 158.03°E · 1829 м</div><h3>Горелый</h3><span class="st2"><i></i>Низкий риск</span><p>Кратеры с кислотными озёрами. Лучшее окно юга сегодня.</p><a class="act" href="#">К маршруту</a></article>
      <article class="stop tremor" style="--pc:var(--brusnika)"><span class="pin"></span><div class="coords">52.45°N · 158.20°E · 2323 м</div><h3>Мутновский</h3><span class="st2"><i></i>Закрыт — сейсмика</span><p>Рой толчков у фумарольных полей. Ждём разрядки.</p><a class="act" href="#">Сейсмолента</a></article>
      <article class="stop" style="--pc:var(--amber)"><span class="pin"></span><div class="coords">51.45°N · 157.10°E · кальдера</div><h3>Курильское озеро</h3><span class="st2"><i></i>Медведи — нерест</span><p>Крупнейший нерест нерки в Евразии. Только с инспектором.</p><a class="act" href="#">Туры с инспектором</a></article>
    </div>
    <div class="pen-south"><div class="k">51.45°N · мыс Лопатка рядом</div><h3>Юг достигнут.</h3><p>Полуостров за один скролл. В жизни на это уходит сезон — соберём ваш?</p><div class="row"><a href="#" id="ctaPen">Собрать маршрут</a><button id="penClose2">К панели</button></div></div>
  </div>
</div>
`;

export default function HomeV7Client() {
  useEffect(() => {
    const root = document.getElementById('v7root');
    if (!root) return;
    document.documentElement.setAttribute('data-v7theme', 'light');
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const buzz = (n: number) => navigator.vibrate && navigator.vibrate(n);
    const cleanups: Array<() => void> = [];
    const q = <T extends Element = Element>(s: string) => root.querySelector<T>(s);
    const qa = <T extends Element = Element>(s: string) => Array.from(root.querySelectorAll<T>(s));

    try {
      const dl = q('#dateline');
      if (dl) {
        const now = new Date(Date.now() + 12 * 3600e3);
        dl.textContent = `Камчатка · ${now.getUTCDate()}.${String(now.getUTCMonth() + 1).padStart(2, '0')} · ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} КМТ`;
      }

      // кольцо
      const svg = q('#ringSvg');
      if (svg) {
        const N = 16, ok = 12, att = 3, cx = 92, cy = 92, r = 86, gap = 5.5, seg = 360 / N - gap;
        const cols = ['#2E5F46', '#B4761F', '#B23A32'];
        const col = (i: number) => (i < ok ? cols[0] : i < ok + att ? cols[1] : cols[2]);
        const P = (a: number) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
        let h = '';
        for (let t = 0; t < 64; t++) { const a = (t * (360 / 64) * Math.PI) / 180, l = t % 4 ? 2.5 : 5, r1 = r - 9, r2 = r1 - l; h += `<line x1="${cx + r1 * Math.cos(a)}" y1="${cy + r1 * Math.sin(a)}" x2="${cx + r2 * Math.cos(a)}" y2="${cy + r2 * Math.sin(a)}" stroke="currentColor" stroke-width="1"/>`; }
        for (let i = 0; i < N; i++) { const a0 = i * (360 / N) + gap / 2, a1 = a0 + seg, [x0, y0] = P(a0), [x1, y1] = P(a1); h += `<path d="M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}" stroke="${col(i)}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0" style="transition:opacity .5s ${i * 55}ms"/>`; }
        svg.innerHTML = h;
        requestAnimationFrame(() => requestAnimationFrame(() => svg.querySelectorAll('path').forEach((p) => ((p as SVGElement).style.opacity = '1'))));
      }

      // count-up + эко
      const io = new IntersectionObserver((es) => es.forEach((e) => {
        if (!e.isIntersecting) return; io.unobserve(e.target);
        const el = e.target as HTMLElement, n = +(el.dataset.n || '0');
        if (rm) { el.textContent = String(n); return; }
        const t0 = performance.now(), D = 900;
        (function step(t: number) { const k = Math.min(1, (t - t0) / D), ease = 1 - Math.pow(1 - k, 3); el.textContent = String(Math.round(n * ease)); if (k < 1) requestAnimationFrame(step); })(t0);
      }), { threshold: 0.4 });
      qa('.cnt').forEach((el) => io.observe(el));
      cleanups.push(() => io.disconnect());
      const bar = q<HTMLElement>('#ecoBar');
      if (bar) { const io2 = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { bar.style.width = (140 / 500) * 100 + '%'; io2.unobserve(e.target); } }), { threshold: 0.5 }); io2.observe(bar); cleanups.push(() => io2.disconnect()); }

      // платы
      const platesC = q<HTMLElement>('#plates');
      if (platesC) {
        const ps = Array.from(platesC.children) as HTMLElement[]; const dots = q('#plDots'); const rom = ['I', 'II', 'III', 'IV'];
        ps.forEach((_, i) => { const d = document.createElement('i'); d.textContent = rom[i]; if (!i) d.className = 'on'; dots?.appendChild(d); });
        const dEls = Array.from(dots?.children || []) as HTMLElement[]; let idx = 0; let timer: ReturnType<typeof setInterval> | null = null; let pause: ReturnType<typeof setTimeout>;
        const setIdx = (i: number) => { idx = (i + ps.length) % ps.length; dEls.forEach((d, k) => d.classList.toggle('on', k === idx)); ps.forEach((s, k) => s.classList.toggle('live', k === idx)); };
        const go = (i: number) => { setIdx(i); platesC.scrollTo({ left: idx * platesC.clientWidth, behavior: rm ? 'auto' : 'smooth' }); };
        platesC.addEventListener('scroll', () => { clearTimeout(pause); pause = setTimeout(() => { const i = Math.round(platesC.scrollLeft / platesC.clientWidth); if (i !== idx) setIdx(i); }, 80); }, { passive: true });
        ['pointerdown', 'touchstart'].forEach((ev) => platesC.addEventListener(ev, () => { if (timer) { clearInterval(timer); timer = null; } }, { passive: true }));
        const auto = () => { if (rm) return; timer = setInterval(() => go(idx + 1), 6000); };
        auto();
        platesC.addEventListener('pointerup', () => { if (!timer) setTimeout(auto, 9000); });
        cleanups.push(() => { if (timer) clearInterval(timer); });
      }

      // сейсмолента
      const cvs = q<HTMLCanvasElement>('#seismoC');
      if (cvs) {
        const ctx = cvs.getContext('2d')!;
        const fit = () => { const d = devicePixelRatio || 1; cvs.width = cvs.clientWidth * d; cvs.height = cvs.clientHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
        fit(); addEventListener('resize', fit); cleanups.push(() => removeEventListener('resize', fit));
        const buf: number[] = []; let spike = 0; let raf = 0;
        const draw = () => { const W = cvs.clientWidth, H = cvs.clientHeight, mid = H / 2; if (Math.random() < 0.005) spike = 1; const v = (Math.random() - 0.5) * 2.2 + (spike > 0 ? Math.sin(spike * 22) * spike * mid * 0.8 : 0); spike = Math.max(0, spike - 0.05); buf.push(v); if (buf.length > W) buf.shift(); ctx.clearRect(0, 0, W, H); ctx.strokeStyle = document.documentElement.getAttribute('data-v7theme') === 'dark' ? '#93A09A' : '#66736E'; ctx.lineWidth = 0.9; ctx.beginPath(); buf.forEach((y, i) => (i ? ctx.lineTo(i, mid + y) : ctx.moveTo(i, mid + y))); ctx.stroke(); if (!rm) raf = requestAnimationFrame(draw); };
        if (rm) { for (let i = 0; i < 400; i++) buf.push((Math.random() - 0.5) * 2.2); draw(); } else draw();
        cleanups.push(() => raf && cancelAnimationFrame(raf));
        const st = q('#seismoT'); const upd = () => { const d = new Date(Date.now() + 12 * 3600e3); if (st) st.textContent = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' КМТ'; }; upd(); const si = setInterval(upd, 15e3); cleanups.push(() => clearInterval(si));
      }

      // журнал + цитата
      if (!rm) {
        const items = ['<b>Иван</b> забронировал тур на Горелый · 2 мин назад', '<b>Мария</b> добавила Курильское в избранное · 5 мин назад', '<b>Олег</b> собрал маршрут на Авачинский · 9 мин назад', '<b>Аня</b> смотрит туры по рыбалке · только что'];
        const fe = q<HTMLElement>('#feedTx'); let fi = 0; const f1 = setInterval(() => { fe?.classList.add('out'); setTimeout(() => { fi = (fi + 1) % items.length; if (fe) fe.innerHTML = items[fi]; fe?.classList.remove('out'); }, 400); }, 4800); cleanups.push(() => clearInterval(f1));
        const lines = ['Мутновский сегодня трясёт — на юг лучше через Горелый.', 'На Курильском нерест: медведей больше, чем людей. Только с инспектором.', 'Скажи, что хочешь увидеть — соберу маршрут и передам оператору.'];
        const kz = q<HTMLElement>('#kzQuote'); let ki = 0; const f2 = setInterval(() => { if (!kz) return; kz.style.transition = 'opacity .45s'; kz.style.opacity = '0'; setTimeout(() => { ki = (ki + 1) % lines.length; kz.textContent = lines[ki]; kz.style.opacity = '1'; }, 480); }, 7000); cleanups.push(() => clearInterval(f2));
      }

      // лид-форма + CTA
      const chips = q('#chips'); chips?.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('.chip'); if (!b) return; const on = b.getAttribute('aria-pressed') === 'true'; b.setAttribute('aria-pressed', String(!on)); buzz(8); });
      const box = q('#leadBox'), inp = q<HTMLInputElement>('#leadInput');
      q('#leadSend')?.addEventListener('click', () => { if (!inp?.value.trim()) { inp?.focus(); return; } box?.classList.add('sent'); buzz(40); });
      const jump = () => { box?.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => inp?.focus(), 600); };
      q('#ctaTop')?.addEventListener('click', jump);
      q('#ctaGuide')?.addEventListener('click', (e) => { e.preventDefault(); jump(); });

      // тема
      const seg = q('#themeSeg'); seg?.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (!b) return; seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); document.documentElement.setAttribute('data-v7theme', (b as HTMLElement).dataset.v || 'light'); });

      // компас
      const rose = q('#rose'), hdg = q('#hdg'), hdc = q('#hdgc'), hint = q('#cmpHint'), cbox = q('#compass');
      if (rose && cbox) {
        const L: Array<[string, number]> = [['С', 0], ['В', 90], ['Ю', 180], ['З', 270]]; let g = '';
        for (let d = 0; d < 360; d += 6) { const a = ((d - 90) * Math.PI) / 180, maj = d % 30 === 0, r1 = 68, r2 = r1 - (maj ? 7 : 3.5); g += `<line x1="${72 + r1 * Math.cos(a)}" y1="${72 + r1 * Math.sin(a)}" x2="${72 + r2 * Math.cos(a)}" y2="${72 + r2 * Math.sin(a)}" stroke="currentColor" stroke-width="${maj ? 1.2 : 0.8}"/>`; }
        L.forEach(([t, d]) => { const a = ((d - 90) * Math.PI) / 180, rr = 44; g += `<text x="${72 + rr * Math.cos(a)}" y="${72 + rr * Math.sin(a) + 3.5}" text-anchor="middle"${t === 'С' ? ' fill="var(--brusnika)" style="font-weight:700"' : ''}>${t}</text>`; });
        [45, 135, 225, 315].forEach((d) => { const a = ((d - 90) * Math.PI) / 180, rr = 44; g += `<text class="deg" x="${72 + rr * Math.cos(a)}" y="${72 + rr * Math.sin(a) + 2.5}" text-anchor="middle">${d}</text>`; });
        rose.innerHTML = g;
        const names = ['СЕВЕР', 'С-В', 'ВОСТОК', 'Ю-В', 'ЮГ', 'Ю-З', 'ЗАПАД', 'С-З']; let target = 0, cur = 0, live = false, raf = 0;
        const set = (hh: number) => (target = ((hh % 360) + 360) % 360);
        const loop = () => { const d = ((target - cur + 540) % 360) - 180; cur = (cur + d * 0.08 + 360) % 360; rose.setAttribute('transform', `rotate(${-cur} 72 72)`); if (hdg) hdg.textContent = Math.round(cur) + '°'; if (hdc) hdc.textContent = names[Math.round(cur / 45) % 8]; raf = requestAnimationFrame(loop); };
        if (!rm) loop(); else if (hdg) hdg.textContent = '0°';
        cleanups.push(() => raf && cancelAnimationFrame(raf));
        const onOri = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => { let hh: number | null = null; if (typeof e.webkitCompassHeading === 'number') hh = e.webkitCompassHeading; else if (typeof e.alpha === 'number') hh = 360 - e.alpha; if (hh !== null) { live = true; if (hint) hint.textContent = 'датчик активен'; set(hh); } };
        cbox.addEventListener('click', () => { const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }; if (DOE && typeof DOE.requestPermission === 'function') { DOE.requestPermission().then((r) => { if (r === 'granted') addEventListener('deviceorientation', onOri as EventListener); }).catch(() => {}); } else { addEventListener('deviceorientationabsolute', onOri as EventListener, true); addEventListener('deviceorientation', onOri as EventListener, true); } buzz(10); });
        if (!rm) { const wob = setInterval(() => { if (!live) set(12 * Math.sin(Date.now() / 5000)); }, 400); cleanups.push(() => clearInterval(wob)); }
      }

      // полуостров
      const pen = q<HTMLElement>('#pen');
      q('#ringBtn')?.addEventListener('click', () => { root.classList.add('pen-open'); if (pen) pen.scrollTop = 0; buzz(20); requestAnimationFrame(penUpd); });
      const closePen = () => root.classList.remove('pen-open');
      q('#penClose')?.addEventListener('click', () => { closePen(); buzz(12); });
      q('#penClose2')?.addEventListener('click', closePen);
      q('#ctaPen')?.addEventListener('click', (e) => { e.preventDefault(); closePen(); jump(); });
      const journey = q<HTMLElement>('#journey'), trace = q<HTMLElement>('#trace'), latOut = q('#latVal');
      function penUpd() { if (!pen || !journey || !trace) return; const N = 56.9, S = 51.3, vh = pen.clientHeight, r = journey.getBoundingClientRect(); const total = r.height - vh * 0.35, passed = Math.min(Math.max(vh * 0.55 - r.top, 0), Math.max(total, 1)), k = total > 0 ? passed / total : 0; trace.style.height = k * r.height + 'px'; if (latOut) latOut.textContent = (N - (N - S) * k).toFixed(2) + '°N'; }
      pen?.addEventListener('scroll', penUpd, { passive: true });
      const io3 = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add('in'); }), { root: pen, threshold: 0.2 });
      qa('.stop').forEach((s) => io3.observe(s)); cleanups.push(() => io3.disconnect());

      // SOS
      const sBtn = q<HTMLElement>('#sosBtn'), arc = q<SVGElement>('#holdArc'), scrim = q('#scrim');
      if (sBtn && arc) {
        const HOLD = 1000; let t0: number | null = null; let raf = 0;
        const openS = () => { root.classList.add('sos-open'); buzz(55); };
        const closeS = () => root.classList.remove('sos-open');
        const reset = () => { if (raf) cancelAnimationFrame(raf); raf = 0; t0 = null; (arc as unknown as SVGElement).style.strokeDashoffset = '213'; };
        const tick = (ts: number) => { if (!t0) t0 = ts; const k = Math.min(1, (ts - t0) / HOLD); (arc as unknown as SVGElement).style.strokeDashoffset = String(213 * (1 - k)); if (k >= 1) { reset(); openS(); return; } raf = requestAnimationFrame(tick); };
        sBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); reset(); buzz(8); raf = requestAnimationFrame(tick); });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => sBtn.addEventListener(ev, reset));
        scrim?.addEventListener('click', closeS);
        qa('.proto,.call112').forEach((b) => b.addEventListener('click', closeS));
        cleanups.push(() => raf && cancelAnimationFrame(raf));
      }
    } catch {
      // превью-интерактив не критичен — если что-то не так, страница остаётся статичной
    }

    return () => { cleanups.forEach((c) => c()); document.documentElement.removeAttribute('data-v7theme'); };
  }, []);

  return (
    <div className="v7" id="v7root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div dangerouslySetInnerHTML={{ __html: MARKUP }} />
    </div>
  );
}
