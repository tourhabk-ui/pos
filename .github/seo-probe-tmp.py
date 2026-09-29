"""Временная SEO-проба vedarai.ru (только чтение). Удаляется до мержа."""
import re
import sys
import urllib.request
import urllib.error
from html.parser import HTMLParser

BASE = 'https://vedarai.ru'
UAS = {
    'google': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'yandex': 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
}
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def fetch(path, ua='google', timeout=40):
    url = path if path.startswith('http') else BASE + path
    req = urllib.request.Request(url, headers={'User-Agent': UAS[ua], 'Accept-Encoding': 'identity'})
    try:
        r = OPENER.open(req, timeout=timeout)
        return r.status, dict(r.headers), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode('utf-8', 'replace')
    except Exception as e:  # noqa: BLE001
        return 0, {}, f'ERR {type(e).__name__}: {e}'


class Meta(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_head = False
        self.head_closed = False
        self.title = None
        self._t = False
        self.desc = []
        self.robots = []
        self.canon = []
        self.og = {}
        self.h1 = []
        self.h2 = 0
        self._h1 = False
        self._buf = ''
        self.ld_types = []
        self._ld = False
        self._ldbuf = ''

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        where = 'head' if not self.head_closed else 'body'
        if tag == 'head':
            self.in_head = True
        if tag == 'body':
            self.head_closed = True
        if tag == 'title' and self.title is None:
            self._t = True
            self._buf = ''
        if tag == 'meta':
            n = (a.get('name') or '').lower()
            p = (a.get('property') or '').lower()
            if n == 'description':
                self.desc.append((where, a.get('content') or ''))
            if n in ('robots', 'googlebot', 'yandex'):
                self.robots.append((where, n, a.get('content') or ''))
            if p.startswith('og:'):
                self.og.setdefault(p, a.get('content') or '')
        if tag == 'link' and (a.get('rel') or '').lower() == 'canonical':
            self.canon.append((where, a.get('href') or ''))
        if tag == 'h1':
            self._h1 = True
            self._buf = ''
        if tag == 'h2':
            self.h2 += 1
        if tag == 'script' and (a.get('type') or '') == 'application/ld+json':
            self._ld = True
            self._ldbuf = ''

    def handle_endtag(self, tag):
        if tag == 'head':
            self.head_closed = True
        if tag == 'title' and self._t:
            self.title = self._buf.strip()
            self._t = False
        if tag == 'h1' and self._h1:
            self.h1.append(re.sub(r'\s+', ' ', self._buf).strip())
            self._h1 = False
        if tag == 'script' and self._ld:
            self.ld_types += re.findall(r'"@type"\s*:\s*"([^"]+)"', self._ldbuf)
            self._ld = False

    def handle_data(self, data):
        if self._t or self._h1:
            self._buf += data
        if self._ld:
            self._ldbuf += data


def page(path, ua='google'):
    code, h, body = fetch(path, ua)
    print(f'\n=== {path} [{ua}] -> {code}')
    for k in ('Location', 'X-Robots-Tag', 'Cache-Control', 'Content-Type', 'ETag', 'Last-Modified'):
        for hk, hv in h.items():
            if hk.lower() == k.lower():
                print(f'  {k}: {hv}')
    if code != 200 or 'html' not in (h.get('Content-Type') or h.get('content-type') or ''):
        print(f'  body[:200]: {body[:200]!r}')
        return body
    m = Meta()
    try:
        m.feed(body)
    except Exception as e:  # noqa: BLE001
        print('  parse error', e)
    print(f'  bytes: {len(body.encode())}')
    print(f'  title: {m.title!r} ({len(m.title or "")})')
    for w, d in m.desc:
        print(f'  description[{w}]: {d!r} ({len(d)})')
    for w, n, c in m.robots:
        print(f'  meta {n}[{w}]: {c}')
    for w, c in m.canon:
        print(f'  canonical[{w}]: {c}')
    print(f'  og: ' + ', '.join(f'{k}={v[:90]}' for k, v in m.og.items()))
    print(f'  h1: {m.h1}')
    print(f'  h2 count: {m.h2}')
    print(f'  ld types: {sorted(set(m.ld_types))}')
    return body


def main():
    code, h, robots = fetch('/robots.txt')
    print('=== /robots.txt ->', code, h.get('Cache-Control'))
    lines = robots.splitlines()
    # первая группа и хвост целиком — остальные одинаковые
    print('\n'.join(lines[:20]))
    print('... total lines', len(lines))
    print('\n'.join(lines[-4:]))

    code, h, sm = fetch('/sitemap.xml', timeout=90)
    locs = re.findall(r'<loc>([^<]+)</loc>', sm)
    print(f'\n=== /sitemap.xml -> {code} Cache-Control: {h.get("Cache-Control")} urls={len(locs)}')
    def cnt(rx):
        return sum(1 for u in locs if re.search(rx, u))
    print('  /routes/<uuid>:', cnt(r'/routes/' + UUID + r'$'))
    print('  /places/<uuid>:', cnt(r'/places/' + UUID + r'$'))
    print('  /routes/*:', cnt(r'/routes/'), ' /places/*:', cnt(r'/places/'))
    print('  /blog/*:', cnt(r'/blog/.'), ' /articles/*:', cnt(r'/articles/.'))
    print('  /catalog/tours/*:', cnt(r'/catalog/tours/'), ' /plans/*:', cnt(r'/plans/.'))
    route_uuid = [u for u in locs if re.search(r'/routes/' + UUID + r'$', u)]
    place_uuid = [u for u in locs if re.search(r'/places/' + UUID + r'$', u)]
    tours = [u for u in locs if '/catalog/tours/' in u]
    print('  sample route uuid:', route_uuid[:3])
    print('  sample place uuid:', place_uuid[:3])
    print('  tours:', tours)

    code, h, llms = fetch('/llms.txt', timeout=90)
    print(f'\n=== /llms.txt -> {code} Cache-Control: {h.get("Cache-Control")} bytes={len(llms)}')
    links = re.findall(r'https://vedarai\.ru(/[^\s)\]>]*)', llms)
    print('  links:', len(links), 'unique:', len(set(links)))
    print('  /routes/<uuid>:', len({l for l in links if re.search(r'^/routes/' + UUID, l)}))
    print('  /places/<uuid>:', len({l for l in links if re.search(r'^/places/' + UUID, l)}))
    print('  /routes/*:', len({l for l in links if l.startswith('/routes/')}), ' /places/*:', len({l for l in links if l.startswith('/places/')}))
    for ln in llms.splitlines():
        if re.search(r'routes/\{|/routes/\{id\}|/routes/' + UUID, ln):
            print('  LINE:', ln[:200])
            break

    for p in ['/', '/hub/fishing', '/catalog', '/catalog/tours/6', '/places', '/routes', '/blog', '/articles',
              '/about', '/plans/kamchatka-za-5-dney-vulkany', '/routes/trekking/avachinsky',
              '/places/vulkan-gorelyj', '/hub/safety']:
        page(p, 'google')
    for p in ['/', '/hub/fishing']:
        page(p, 'yandex')
    for u in route_uuid[:2] + place_uuid[:2]:
        page(u.replace(BASE, ''), 'google')

    # Блог: ссылки со страницы списка и их коды
    _, _, blog = fetch('/blog')
    posts = sorted(set(re.findall(r'href="(/blog/[^"#?]+)"', blog)))
    print(f'\n=== /blog post links: {len(posts)}')
    for p in posts[:12]:
        c, hh, _ = fetch(p)
        print(f'  {p} -> {c} {hh.get("Location") or ""}')
    _, _, arts = fetch('/articles')
    alinks = sorted(set(re.findall(r'href="(/articles/[^"#?]+)"', arts)))
    print(f'=== /articles links: {len(alinks)}')


if __name__ == '__main__':
    main()
    sys.exit(0)
