# ASISTIA — arquitectura local y descansos

## Decisiones aprobadas
- Aplicación de escritorio Windows instalada como una sola unidad.
- Operación local sin requerir internet para registrar jornadas.
- Base SQLite persistente en el directorio de datos de usuario; nunca dentro de app.asar.
- El backend HTTP independiente y el proceso node.exe no deben ser dependencias de la versión objetivo.
- Electron Main Process coordina servicios internos mediante IPC tipado y una superficie mínima en preload.cjs.
- La migración de localStorage a SQLite debe ser respaldada, idempotente, conciliable y reversible antes de retirar el flujo anterior.

## Arquitectura objetivo
1. Renderer: interfaz HTML/CSS/JS; sin acceso directo a Node, archivos ni SQLite.
2. Preload: expone métodos concretos y validados mediante contextBridge.
3. Electron Main: autentica llamadas IPC, aplica roles/licencia y coordina servicios.
4. Servicios de dominio: autenticación, empleados, asistencia, descansos, correcciones, reportes y auditoría.
5. Repositorios SQLite: transacciones, migraciones versionadas y consultas paginadas.
6. Datos: app.getPath('userData')/data/asistia.sqlite; respaldos cifrados fuera del directorio de instalación.

## Descansos de comida
La política puede definirse a nivel empresa y admitir sobrescritura por empleado. Cada política contiene:
- mode: manual o automatic.
- durationMinutes: duración prevista configurable (1–240 minutos).
- scheduledStart: hora local HH:mm obligatoria en modalidad automática.
- countsAsWork: si el periodo debe computarse como tiempo efectivo, según las condiciones aplicables.

Manual:
- El trabajador registra salida a comida y regreso.
- Se descuenta el intervalo real; nunca la duración prevista por defecto.
- Un descanso abierto genera incidencia; no se inventa la hora de regreso.
- Los eventos originales son append-only y las correcciones se registran por separado.

Automático:
- El sistema calcula un intervalo programado usando la zona horaria y el turno del empleado.
- Descuenta únicamente la intersección entre el intervalo programado y la jornada registrada.
- La deducción se presenta como cálculo derivado, no como una marca física ficticia.
- La política y la regla aplicada deben quedar visibles en el reporte.

## Cálculo
tiempo efectivo = tiempo bruto de jornada − descansos no computables

Los intervalos se recortan a los límites de la jornada y se fusionan si se solapan, para evitar dobles descuentos. La modalidad automática debe resolver scheduledStart a un instante usando la zona horaria IANA de la empresa y la fecha/turno correspondiente; no se debe interpretar HH:mm usando la zona horaria del equipo por accidente.

## Reglas laborales y producto
La configuración countsAsWork no debe presentarse como una determinación legal automática. En México, el tratamiento del periodo depende de las condiciones reales de descanso y disponibilidad del trabajador; la empresa debe validar su política con asesoría laboral. La aplicación debe conservar evidencia de la política vigente en la fecha de cada jornada.

## Estado de implementación — 2 de noviembre de 2026

### Implementado en la rama de desarrollo
- `backend/src/meal-breaks.js`: cálculo puro de minutos brutos, descansos y tiempo efectivo; validación estricta de instantes ISO-8601 con offset; recorte y fusión de intervalos.
- Resolución de `scheduledStart` con zona horaria IANA. Las horas civiles inexistentes por el salto DST se rechazan; en una hora repetida se usa la primera ocurrencia de forma determinista.
- `backend/src/meal-break-routes.js`: tablas SQLite para política actual, historial de políticas y eventos de comida. Los eventos manuales son append-only y tienen hash encadenado.
- API: `GET/PUT /api/meal-break/policy`, `POST/GET /api/meal-break/events` y `GET /api/attendance/effective?employeeId=...`.
- El historial de políticas conserva la vigencia de cada configuración; un cambio de política no debe recalcular jornadas anteriores con la regla nueva.
- `desktop/api-client.js` y `ASISTIA_Control_de_Asistencia.html`: métodos y panel beta para configurar la política, registrar salida/regreso y consultar horas efectivas.
- Pruebas agregadas para modos manual/automático, intervalos superpuestos, DST, instantes inválidos, políticas históricas y descansos incompletos.
- Dependencias auditadas: body-parser actualizado a 1.20.9 y Zod a 4.6.7; la validación CI posterior a estos cambios sigue pendiente.

### Limitaciones que permanecen
- Esta integración de comida usa la API local heredada. **No elimina Express, el proceso Node ni el puerto localhost.**
- No está implementado todavía el acceso directo Electron Main → servicios SQLite mediante IPC.
- La política actual es por empresa; no hay todavía overrides por empleado, sucursal o turno.
- La pantalla beta se conecta a la API; todavía no es una sección nativa del panel local ni una experiencia completa para el trabajador.
- El resumen efectivo se consulta por empleado y aún no está incorporado al CSV/PDF ni a todos los reportes.
- La verificación de integridad existente todavía debe ampliarse para validar la cadena de eventos de comida.
- La migración de `localStorage` a SQLite, reconciliación de duplicados, cola offline, respaldos y pruebas de instalación/actualización Windows siguen pendientes.

No retirar el backend HTTP ni el almacenamiento heredado hasta que exista paridad funcional, migración respaldada, conciliación verificable y pruebas de restauración.
