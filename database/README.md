# Base de datos ASISTIA 0.3

El esquema SQLite inicial se crea al arrancar `backend/src/server.js`. SQLite es útil para desarrollo y una instalación pequeña de una sola instancia; no se debe compartir el archivo SQLite entre varios servidores ni guardarlo en una carpeta pública.

## Tablas
- `companies`: tenant/empresa.
- `users`: usuarios y roles (`admin`, `supervisor`, `worker`).
- `employees`: empleados por empresa y sucursal.
- `attendance_events`: eventos originales de entrada/salida; no hay endpoint para editarlos o borrarlos.
- `correction_requests`: solicitudes y decisiones de corrección, separadas del registro original.
- `agreements`: constancias y huellas de evidencia.
- `attendance_adjustments`: enmiendas aprobadas separadas de eventos originales.
- `audit_log`: bitácora encadenada por hash a nivel aplicación.

## Migraciones
El esquema se crea con `CREATE TABLE IF NOT EXISTS` y algunas migraciones compatibles para este prototipo. Las consultas de listados usan paginación. Antes de producción, sustituir por migraciones numeradas y versionadas, revisión de cambios y procedimientos de respaldo/restauración. El hash encadenado no equivale a almacenamiento WORM: una persona con acceso al archivo o al servidor podría alterar datos y recalcular hashes.
