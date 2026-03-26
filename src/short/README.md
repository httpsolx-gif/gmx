# Short — бекенд сокращения ссылок

Хранилище: `short/data/links.json` (формат `{ "code": "https://..." }`).

## API модуля (используется в server.js)

- **getLinks()** — объект `{ code: url, ... }`
- **writeLinks(obj)** — записать весь объект
- **createShortLink(url)** — создать с автокодом, вернуть `{ code, url }`
- **createShortLinkWithCode(code, url)** — создать с заданным кодом
- **resolveShortLink(code)** — вернуть URL или `null`
- **listShortLinks()** — массив `[{ code, url }]`
- **deleteShortLink(code)** — удалить, вернуть `true/false`
- **generateCode()** — сгенерировать случайный код (8 символов)

## HTTP (в основном сервере)

- `GET /s/:code` — редирект на сохранённый URL
- В админке Config — управление короткими ссылками (slug + url)

При первом запуске данные из `data/shortlinks.json` автоматически переносятся в `short/data/links.json`.
