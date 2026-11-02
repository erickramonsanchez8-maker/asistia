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

## Estado de implementación
- backend/src/meal-breaks.js: motor puro de cálculo con validación de políticas, recorte y fusión de intervalos.
- backend/test/meal-breaks.test.js: pruebas unitarias del cálculo manual/automático.
- Pendiente: integración con SQLite, IPC local, interfaz de administración, UI del trabajador, reportes y migración de datos heredados.
