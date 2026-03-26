/**
 * Совместимость: раньше здесь был черновик вынесенного HTTP-слоя (см. scripts/assemble-http-server-app.py).
 * Не подключён в npm start (точка входа — server.js → ./server.js).
 * Поведение идентично src/server.js: один процесс, один listen.
 */
require('./server.js');
