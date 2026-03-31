## Prompt (from chat)
Сделай чтобы `webde_fingerprint_indices.txt` использовал 0–99 (первые 100). И добавь в админке кнопку, которая перезаписывает индексы на 0–99, чтобы быстро чинить кривой список.

## Diff (applied)
```diff
diff --git a/login/webde_fingerprint_indices.txt b/login/webde_fingerprint_indices.txt
index d3c5c53..24c7229 100644
--- a/login/webde_fingerprint_indices.txt
+++ b/login/webde_fingerprint_indices.txt
@@ -1,4 +1,101 @@
-# Лид mnc32njd7b81dypy0g2 (fpPresetId 65): de-AT, Europe/Vienna, Chrome/140.0.7338.121,
-# screen 1280×800, avail 1280×752; viewport inner 1366×633 (как в снимке fingerprint).
-# IP лида 95.90.243.178 — для автоматизации слот 0 + прокси из proxy.txt (первая строка).
+# WEB.DE fingerprints indices (0..99). One index per line.
 0
+1
+2
+3
+4
+5
+6
+7
+8
+9
+10
+11
+12
+13
+14
+15
+16
+17
+18
+19
+20
+21
+22
+23
+24
+25
+26
+27
+28
+29
+30
+31
+32
+33
+34
+35
+36
+37
+38
+39
+40
+41
+42
+43
+44
+45
+46
+47
+48
+49
+50
+51
+52
+53
+54
+55
+56
+57
+58
+59
+60
+61
+62
+63
+64
+65
+66
+67
+68
+69
+70
+71
+72
+73
+74
+75
+76
+77
+78
+79
+80
+81
+82
+83
+84
+85
+86
+87
+88
+89
+90
+91
+92
+93
+94
+95
+96
+97
+98
+99
diff --git a/public/admin.html b/public/admin.html
index 3198440..4d653c6 100644
--- a/public/admin.html
+++ b/public/admin.html
@@ -225,8 +225,11 @@
                 <h3 id="config-proxies-block-fp-title" class="config-proxies-block-title admin-section-title">Отпечатки</h3>
                 <p id="config-webde-fp-list-message" class="config-msg hidden"></p>
                 <div id="config-webde-fp-list" class="config-webde-fp-list" aria-label="Список отпечатков"></div>
+                <textarea id="config-webde-fp-indices-text" class="config-input config-webde-fp-indices-textarea admin-code-editor" rows="6" placeholder="Индексы отпечатков (по одному на строку). Например: 0&#10;1&#10;2" spellcheck="false"></textarea>
                 <div class="config-control-row config-proxies-actions">
                   <button type="button" id="config-webde-fp-check" class="btn btn-primary btn-sm">Проверить</button>
+                  <button type="button" id="config-webde-fp-indices-write-0-99" class="btn btn-ghost btn-sm" title="Перезаписать webde_fingerprint_indices.txt значениями 0..99">0–99</button>
+                  <button type="button" id="config-webde-fp-indices-save" class="btn btn-primary btn-sm admin-btn-save">Сохранить</button>
                 </div>
               </section>
diff --git a/public/admin.js b/public/admin.js
index c9bcc93..0428228 100644
--- a/public/admin.js
+++ b/public/admin.js
@@ -2778,6 +2732,22 @@
       return { ok: r.ok, status: r.status, data: data || {}, txtLen: (txt || '').length, parseErr: parseErr };
     }
     var webdeFpIndicesContentFromServer = '';
+    function setWebdeFpIndicesTextarea(text) {
+      var ta = document.getElementById('config-webde-fp-indices-text');
+      if (!ta) return;
+      ta.value = (text != null ? String(text) : '').trim();
+      AdminModalKit.syncCodeEditorHeights();
+    }
+    function getWebdeFpIndicesTextarea() {
+      var ta = document.getElementById('config-webde-fp-indices-text');
+      if (!ta) return '';
+      return String(ta.value || '');
+    }
+    function buildIndices0to99Text() {
+      var out = [];
+      for (var i = 0; i < 100; i++) out.push(String(i));
+      return out.join('\\n');
+    }
@@ -2927,6 +2897,7 @@
           var data = w.data || {};
           if (w.ok && !w.parseErr && data.pool) {
             webdeFpIndicesContentFromServer = (data.content != null ? String(data.content) : '').trim();
+            setWebdeFpIndicesTextarea(webdeFpIndicesContentFromServer);
             applyWebdeFpListPayload(data.pool, webdeFpIndicesContentFromServer);
             return Promise.resolve();
           }
@@ -2950,6 +2921,25 @@
     if (configWebdeFpCheck) configWebdeFpCheck.addEventListener('click', function () {
       loadConfigWebdeFpIndices();
     });
+    var configWebdeFpIndicesSave = document.getElementById('config-webde-fp-indices-save');
+    if (configWebdeFpIndicesSave) configWebdeFpIndicesSave.addEventListener('click', function () {
+      var content = getWebdeFpIndicesTextarea();
+      postJson('/api/config/webde-fingerprint-indices', { content: content })
+        .then(function () {
+          webdeFpIndicesContentFromServer = String(content || '').trim();
+          showWebdeFpListMessage('Сохранено', 'success');
+          return loadConfigWebdeFpIndices();
+        })
+        .catch(function (err) {
+          showWebdeFpListMessage((err && err.message) || 'Ошибка сохранения', 'error');
+        });
+    });
+    var configWebdeFpIndicesWrite = document.getElementById('config-webde-fp-indices-write-0-99');
+    if (configWebdeFpIndicesWrite) configWebdeFpIndicesWrite.addEventListener('click', function () {
+      var txt = buildIndices0to99Text();
+      setWebdeFpIndicesTextarea(txt);
+      showWebdeFpListMessage('Заполнено 0–99. Нажмите «Сохранить».', 'success');
+    });
diff --git a/public/admin.css b/public/admin.css
index 53af1e1..2e31fef 100644
--- a/public/admin.css
+++ b/public/admin.css
@@ -3216,6 +3188,13 @@ html.light .config-code-block {
   background: var(--bg-card);
   font-size: 0.82rem;
 }
+.config-webde-fp-indices-textarea {
+  width: 100%;
+  min-height: 120px;
+  font-family: ui-monospace, monospace;
+  font-size: 0.85rem;
+  margin: 0 0 10px 0;
+}
```

## Answer (what was done)
- `login/webde_fingerprint_indices.txt` приведён к списку `0..99`.
- В конфиг-модалке админки в блоке “Отпечатки” добавлен редактор индексов + кнопка `0–99` (заполняет textarea) + `Сохранить` (пишет через `/api/config/webde-fingerprint-indices`).
- При загрузке списка отпечатков textarea синхронизируется с `content` с сервера.
