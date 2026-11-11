# ASISTIA

Aplicación de escritorio local con actualizaciones internas por paquete, sin eliminar la carpeta de datos del usuario.

Aplicación de control de asistencia para Windows, con funcionamiento local y sin necesidad de contratar un servidor externo.

## Versión 0.6.0

- Aplicación de escritorio Electron con instalador NSIS de 64 bits.
- El servicio API local se incluye en el mismo instalador y se inicia junto con la aplicación en `127.0.0.1:43177`.
- La base SQLite del servicio local se almacena en la carpeta de datos de ASISTIA del usuario de Windows.
- La interfaz heredada conserva los datos de asistencia en almacenamiento local; no se realiza una migración automática de esos registros a la base SQLite de la API.
- Descanso automático según los minutos configurados en cada horario; si se registra una pausa de comida, se descuenta el mayor entre el descanso programado y el tiempo registrado, sin duplicarlo.
- Actualizador interno: los paquetes `.asistia-update` se validan y aplican en una carpeta de versión independiente; se conserva una copia anterior para recuperación.
- Rango de comida orientativo de 30 a 90 minutos; no impone una hora fija de regreso.
- Estilo Liquid Glass y transiciones administrativas más ligeras.

## Actualizaciones

La versión 0.6.0 incorpora por primera vez el mecanismo de actualización interna. Para equipos que todavía usan 0.5.0 se requiere una actualización inicial ejecutando el instalador 0.6.0 sobre la instalación existente (sin desinstalar). El instalador NSIS conserva la carpeta de datos del usuario (`deleteAppDataOnUninstall: false`). Después, las versiones posteriores se distribuyen como un único archivo `.asistia-update`: desde **Respaldos y recuperación → Actualización de ASISTIA**, se selecciona el archivo y la aplicación valida versión, rutas permitidas y SHA-256 antes de reiniciarse. La copia de seguridad de datos del navegador se conserva para migrar el almacenamiento local cuando cambia la ruta del HTML; los paquetes anteriores quedan guardados para recuperación.

El paquete de actualización se limita a la interfaz HTML y sus mejoras de escritorio; cambios al proceso principal de Electron o al servicio local requieren un instalador de escritorio nuevo.

## Compilar el instalador

El flujo `.github/workflows/windows-installer.yml` construye el instalador en un runner de Windows y publica el archivo `ASISTIA-Setup-v0.5.0-x64` como artefacto de GitHub Actions.

Para compilar manualmente en Windows con Node.js 20:

1. `npm install`
2. `cd backend && npm ci --omit=dev`
3. Copiar `node.exe` de Node.js 20 a `backend/runtime/node.exe`
4. Volver a la raíz y ejecutar `npm run dist:win`

## Datos y respaldo

Los registros de asistencia de la interfaz se guardan localmente en el perfil de ASISTIA de Windows. Usa el módulo existente de respaldos para exportar periódicamente la información. El servicio API local mantiene su archivo SQLite separado en la carpeta de datos de la aplicación.

## Alcance técnico

El servicio API local incluido conserva autenticación, separación por empresa, auditoría y respaldos cifrados documentados en `backend/`. La interfaz de asistencia existente sigue usando su almacenamiento local; la unificación de los registros de esa interfaz con las tablas de la API y la migración desde instalaciones previas requieren una fase adicional y no se realizan automáticamente en esta versión.
