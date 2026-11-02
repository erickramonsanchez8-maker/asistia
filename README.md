# ASISTIA

Aplicación de control de asistencia para Windows, con funcionamiento local y sin necesidad de contratar un servidor externo.

## Versión 0.5.0

- Aplicación de escritorio Electron con instalador NSIS de 64 bits.
- El servicio API local se incluye en el mismo instalador y se inicia junto con la aplicación en `127.0.0.1:43177`.
- La base SQLite del servicio local se almacena en la carpeta de datos de ASISTIA del usuario de Windows.
- La interfaz heredada conserva los datos de asistencia en almacenamiento local; no se realiza una migración automática de esos registros a la base SQLite de la API.
- Pausa de comida con dos marcas (salida y regreso), duración variable y descuento del tiempo de comida del tiempo efectivo de trabajo.
- Rango de comida orientativo de 30 a 90 minutos; no impone una hora fija de regreso.
- Estilo Liquid Glass y transiciones administrativas más ligeras.

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
