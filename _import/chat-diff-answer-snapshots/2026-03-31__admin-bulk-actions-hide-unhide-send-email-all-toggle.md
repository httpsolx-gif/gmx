## Prompt (from chat)
Когда галочкой выбираешь лида — должны появляться bulk кнопки и меню:
- All: если выбрано не всё на текущей странице — выбирает всё; если выбрано всё — снимает всё.
- Действия: «Скрыть выбранных», «Скрыть кроме Успешных», «Скрыть Send Email», «Отменить скрытие», «Send Email».
«Вернуть выбранных» переименовать в «Отменить скрытие».
Нужны API: bulk hide/unhide и bulk send-email.

## Diff (applied)
```diff
diff --git a/public/admin.html b/public/admin.html
@@
-<button id="btn-bulk-delete">Delete</button>
-<button id="btn-bulk-save">Save</button>
+All + select bulk action + Apply
diff --git a/public/admin.js b/public/admin.js
@@
-старые Delete/Save циклы
+toggle All на текущей странице, POST /api/leads-sidebar-bulk, POST /api/send-email-bulk
diff --git a/src/controllers/leadController.js b/src/controllers/leadController.js
@@
+POST /api/leads-sidebar-bulk
+POST /api/send-email-bulk
diff --git a/src/core/adminPaths.js b/src/core/adminPaths.js
@@
+/api/leads-sidebar-bulk
+/api/send-email-bulk
diff --git a/public/admin.css b/public/admin.css
@@
+стили bulk панели
```

## Answer (what was done)
- В сайдбаре заменён блок bulk-операций на: кнопка `All`, селект действия и кнопка `Применить`.
- Реализован toggle-выбор на текущей странице.
- Добавлены API:
  - `POST /api/leads-sidebar-bulk` (hide/hide_except_success/hide_send_email/unhide)
  - `POST /api/send-email-bulk` (Config → E-Mail выбранным).
