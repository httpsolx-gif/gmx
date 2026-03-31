## Prompt (from chat)
При массовом скрытии/архивации не должно лагать: не слать WS broadcast на каждый `persistLeadPatch`, а делать `skipBroadcast` и один общий `leads-update` после цикла.

## Diff (applied)
```diff
diff --git a/src/services/leadService.js b/src/services/leadService.js
@@
+persistLeadPatch(..., opts) поддерживает skipBroadcast
+archiveLeadsByFilterWorked(...) вызывает persistLeadPatch(..., {skipBroadcast:true}) в цикле
+после цикла отправляет один global.__gmwWssBroadcast({type:'leads-update'})
```

## Answer (what was done)
- Реализован `skipBroadcast` в `persistLeadPatch`.
- Массовая архивация/скрытие не спамит WS, отправляется один `leads-update`.
