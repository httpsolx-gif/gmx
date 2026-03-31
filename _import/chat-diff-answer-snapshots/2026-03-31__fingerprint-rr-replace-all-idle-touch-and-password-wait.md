## Prompt (from chat)
- Сделать строгий круговой (round-robin) обход отпечатков, чтобы использовались равномерно все доступные из `webde_fingerprint_indices.txt` (не “как получится”).
- Добавить опцию полной замены пула отпечатков по флагу `WEBDE_REPLACE_FP_ALL`.
- Во время ожидания пуша/ресенда — не допускать idle-timeout: вызывать `_touch_script_activity()` в циклах.
- Уменьшить ожидание поля пароля (таймаут) с ~60с до 10с.

## Diff (applied)
```diff
diff --git a/login/lead_simulation_api.py b/login/lead_simulation_api.py
@@
+from webde_login import _touch_script_activity
+import fcntl (если доступно)
+WEBDE_REPLACE_FP_ALL: replace pool all once (flag file)
+webde_fp_rr_counter.txt: атомарный счётчик для rr_start
+pair_at_step: fingerprint выбирается от rr_start + attempts_used (строгий RR)
+poll_push_resend_request/report_push_resend_result: _touch_script_activity()
diff --git a/login/gmx_login.py b/login/gmx_login.py
@@
-max_wait_sec ... else 46
+... else 10
```

## Answer (what was done)
- `lead_simulation_api.py` теперь выбирает отпечатки строго по кругу через файл-счётчик `login/webde_fp_rr_counter.txt`.
- Добавлена опция `WEBDE_REPLACE_FP_ALL=1`: заменяет все слоты пула отпечатков один раз и ставит флаг-файл.
- Во время polling/resend пуша скрипт “трогает” idle watchdog через `_touch_script_activity()`.
- В `gmx_login.py` ожидание появления поля пароля сокращено до 10 секунд (в не-manual режиме).
