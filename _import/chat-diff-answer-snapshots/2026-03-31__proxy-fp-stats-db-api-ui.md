## Prompt (from chat)
Нужно сделать статистику по парам Proxy+Fingerprint в SQLite (`proxy_fp_stats`) и вывести в админке отдельные таблицы статистики:
- Proxy таблица: «Прокси», «Пар», «На пароль», «Не до пароля», «%», «Удалить».
- Fingerprint таблица: «Отпечаток», «Пар», «На пароль», «Не до пароля», «%», «Удалить».
Также добавить кнопку «Удалить не из списка» — удалить строки статистики для прокси, которых уже нет в `proxy.txt`.
API: worker должен уметь инкрементить статистику, админка — читать и удалять (по прокси / по отпечатку / по паре).

## Diff (applied)
```diff
diff --git a/src/db/database.js b/src/db/database.js
index b165436..603f284 100644
--- a/src/db/database.js
+++ b/src/db/database.js
@@
+CREATE TABLE IF NOT EXISTS proxy_fp_stats (
+  proxy_server TEXT NOT NULL,
+  fp_index INTEGER NOT NULL,
+  pairs INTEGER NOT NULL DEFAULT 0,
+  reached_password INTEGER NOT NULL DEFAULT 0,
+  not_reached_password INTEGER NOT NULL DEFAULT 0,
+  updated_at TEXT,
+  PRIMARY KEY (proxy_server, fp_index)
+);
@@
+function incrementProxyFpStat(proxyServer, fpIndex, reachedPassword) { ... }
+function listProxyFpStats() { ... }
+function deleteProxyFpStatRow(proxyServer, fpIndex) { ... }
+function deleteProxyFpStatsByProxy(proxyServer) { ... }
+function deleteProxyFpStatsByFingerprint(fpIndex) { ... }
+function purgeProxyFpStatsOrphans(validProxyServers) { ... }
diff --git a/src/controllers/leadController.js b/src/controllers/leadController.js
@@
+if (pathname === '/api/worker/proxy-fp-stats' && req.method === 'POST') { ... }
diff --git a/src/controllers/adminController.js b/src/controllers/adminController.js
@@
+if (pathname === '/api/config/proxy-fp-stats' && req.method === 'GET') { ... }
+if (pathname === '/api/config/proxy-fp-stats' && req.method === 'DELETE') { ... }
+if (pathname === '/api/config/proxy-fp-stats/purge-orphans' && req.method === 'POST') { ... }
diff --git a/src/core/adminPaths.js b/src/core/adminPaths.js
@@
+'/api/config/proxy-fp-stats',
+'/api/config/proxy-fp-stats/purge-orphans',
+'/api/worker/proxy-fp-stats',
diff --git a/public/admin.html b/public/admin.html
@@
+<section ...>Статистика Proxy/Fingerprint ... две таблицы ...</section>
diff --git a/public/admin.js b/public/admin.js
@@
+loadProxyFpStats(), purge-orphans, delete-by-proxy/fp handlers, render 2 tables
diff --git a/public/admin.css b/public/admin.css
@@
+стили таблиц статистики
```

## Answer (what was done)
- Добавлена таблица `proxy_fp_stats` в SQLite и функции: инкремент, список, удаление по прокси/отпечатку/паре, purge “не из списка”.
- Добавлен worker endpoint `POST /api/worker/proxy-fp-stats` (по `WORKER_SECRET`).
- Добавлены admin endpoints: `GET/DELETE /api/config/proxy-fp-stats`, `POST /api/config/proxy-fp-stats/purge-orphans`.
- В конфиге админки добавлен блок “Статистика Proxy/Fingerprint” с двумя таблицами и кнопками “Обновить / Удалить не из списка / Удалить”.
