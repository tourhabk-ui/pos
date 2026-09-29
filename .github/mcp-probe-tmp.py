"""Временная проба MCP vedarai.ru (только чтение). Удаляется до мержа.

Представляется клиентом «vedar-audit-probe», чтобы вызовы в mcp_clients /
mcp_tool_calls отличались от настоящих агентов. Пишущие инструменты
(create_lead, create_booking_request) НЕ вызываются.
"""
import json
import time
import urllib.request
import urllib.error

URL = 'https://vedarai.ru/api/mcp'
UA = 'vedar-audit-probe/1.0 (Claude Code; audit 2026-09-29)'
CLIENT = {'name': 'vedar-audit-probe', 'version': '2026.09.29'}
N = [0]


def http(method, url=URL, body=None, headers=None, raw=None, timeout=90):
    h = {'User-Agent': UA}
    h.update(headers or {})
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    t = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, dict(r.headers), r.read().decode('utf-8', 'replace'), time.time() - t
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode('utf-8', 'replace'), time.time() - t
    except Exception as e:  # noqa: BLE001
        return 0, {}, f'ERR {type(e).__name__}: {e}', time.time() - t


def rpc(method, params=None, id_=1, headers=None):
    body = {'jsonrpc': '2.0', 'method': method}
    if id_ is not None:
        body['id'] = id_
    if params is not None:
        body['params'] = params
    h = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    h.update(headers or {})
    return http('POST', body=body, headers=h)


def show(title, st, hd, body, dt, limit=600):
    keys = ('Content-Type', 'Cache-Control', 'Allow', 'Access-Control-Allow-Origin', 'X-Robots-Tag', 'Mcp-Session-Id')
    hs = '; '.join(f'{k}={v}' for k, v in hd.items() if k in keys)
    print(f'\n### {title} -> {st} ({dt:.2f}s) [{hs}]')
    print(body[:limit])


def call(tool, args, limit=2200):
    N[0] += 1
    time.sleep(2.2)  # под лимитом 30/мин
    st, hd, body, dt = rpc('tools/call', {'name': tool, 'arguments': args}, id_=N[0])
    try:
        j = json.loads(body)
        res = j.get('result') or {}
        texts = [c.get('text', '') for c in res.get('content', [])]
        err = res.get('isError')
        print(f'\n=== CALL {tool} {json.dumps(args, ensure_ascii=False)} -> http {st} {dt:.2f}s isError={err} parts={len(texts)}')
        if 'error' in j:
            print('JSONRPC ERROR:', j['error'])
        for i, t in enumerate(texts):
            print(f'--- part {i} ({len(t)} chars)')
            print(t[:limit])
    except Exception:  # noqa: BLE001
        print(f'\n=== CALL {tool} -> http {st} RAW: {body[:500]}')


def main():
    print('# TRANSPORT')
    show('GET accept=text/event-stream', *http('GET', headers={'Accept': 'text/event-stream'}))
    st, hd, body, dt = http('GET', headers={'Accept': 'application/json'})
    show('GET accept=json', st, hd, body, dt, 300)
    show('OPTIONS', *http('OPTIONS', headers={'Origin': 'https://example.com', 'Access-Control-Request-Method': 'POST'}))
    show('POST parse error', *http('POST', raw=b'{not json', headers={'Content-Type': 'application/json'}))
    show('POST batch array', *http('POST', raw=json.dumps([{'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}]).encode(), headers={'Content-Type': 'application/json'}))
    show('POST unknown method', *rpc('resources/list'))
    show('POST prompts/list', *rpc('prompts/list'))
    show('POST unknown notification (no id)', *rpc('notifications/cancelled', {'requestId': 1}, id_=None))
    show('POST notifications/initialized', *rpc('notifications/initialized', id_=None))
    show('POST ping', *rpc('ping'))
    for v in ['2025-06-18', '2025-03-26', '2024-11-05', '1999-01-01', None]:
        p = {'clientInfo': CLIENT, 'capabilities': {}}
        if v:
            p['protocolVersion'] = v
        show(f'initialize protocolVersion={v}', *rpc('initialize', p))
    show('POST jsonrpc=1.0 ping', *http('POST', body={'jsonrpc': '1.0', 'id': 7, 'method': 'ping'}, headers={'Content-Type': 'application/json'}))
    show('POST Accept=text/event-stream only (tools/list)', *http('POST', body={'jsonrpc': '2.0', 'id': 8, 'method': 'tools/list'}, headers={'Content-Type': 'application/json', 'Accept': 'text/event-stream'}), limit=200)

    st, hd, body, dt = rpc('tools/list')
    print(f'\n# TOOLS/LIST -> {st} {dt:.2f}s bytes={len(body)}')
    tools = json.loads(body)['result']['tools']
    print('count', len(tools))
    for t in tools:
        ann = t.get('annotations', {})
        req = t.get('inputSchema', {}).get('required', [])
        props = t.get('inputSchema', {}).get('properties', {})
        types = {k: v.get('type') for k, v in props.items()}
        print(f"- {t['name']} title={t.get('title')!r} ann={ann} required={req} types={types} desc_len={len(t.get('description',''))}")
        for word in ['TourHab', 'Tourhab', 'KamchatourHub', 'КамчатурХаб']:
            if word in json.dumps(t, ensure_ascii=False):
                print(f'  !! brand {word} in {t["name"]}')
    print('\n# DISCOVERY')
    for u in ['https://vedarai.ru/.well-known/mcp.json', 'https://vedarai.ru/.well-known/glama.json', 'https://vedarai.ru/mcp', 'https://vedarai.ru/.well-known/mcp-registry-auth']:
        st, hd, body, dt = http('GET', url=u)
        names = [t.get('name') for t in (json.loads(body).get('tools', []) if body.strip().startswith('{') else [])] if st == 200 else []
        print(f'{u} -> {st} {hd.get("Content-Type")} bytes={len(body)} tools={len(names)}')
        print(body[:400] if u.endswith('.json') else '')

    print('\n# TOOL CALLS (read-only)')
    call('safety_status', {})
    call('get_volcano_status', {})
    call('get_volcano_status', {'volcano': 'Ключевской'})
    call('get_volcano_status', {'volcano': 'Несуществующий вулкан'})
    call('get_tours', {})
    call('get_tours', {'activity_type': 'рыбалка'})
    call('get_tours', {'activity_type': 'вертолёт'})
    call('get_tour_details', {'name': 'рыбалка'})
    call('get_tour_details', {'name': 'zzqqxx'})
    call('get_tour_availability', {'tour': '6'})
    call('get_tour_availability', {'tour': 'сплав', 'days': '31'})
    call('get_tour_availability', {'tour': '6', 'days': '999'})
    call('get_tour_availability', {'tour': '6', 'date_from': '2020-01-01'})
    call('get_place_info', {'name': 'Курильское озеро'})
    call('get_place_info', {'name': 'Горелый'})
    call('get_place_info', {'name': "'; DROP TABLE places;--"})
    call('get_guardian_context', {'place': 'Авачинский вулкан'})
    call('get_guardian_context', {'place': 'Долина гейзеров'})
    call('get_guardian_context', {'place': 'Несуществующее место'})
    call('get_weather', {})
    call('get_weather', {'place': 'Мутновский', 'days': '3'})
    call('get_weather', {'lat': '52.45', 'lng': '158.19', 'days': '2'})
    call('get_weather', {'lat': '91', 'lng': '500'})
    call('get_weather', {'days': '30'})
    call('make_trip_plan', {'days': '7', 'interests': 'вулканы и медведи', 'when': 'июль'})
    call('make_trip_plan', {'days': '2'})
    call('make_trip_plan', {'when': '2020-01-01'})
    call('make_trip_plan', {'days': '10', 'travel_style': 'self', 'when': 'январь'})
    call('search_accommodations', {})
    call('search_accommodations', {'zone': 'Паратунка'})
    call('search_gear', {'query': 'палатка'})
    call('search_gear', {})
    call('search_transfers', {})
    call('search_transfers', {'place': 'Горелый'})
    call('search_transfers', {'from': '2026-10-01', 'to': '2027-03-01'})
    call('no_such_tool', {})
    call('get_tours', {'activity_type': 12345})
    print(f'\nTOTAL tool calls: {N[0]}')


if __name__ == '__main__':
    main()
