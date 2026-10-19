# ASISTIA para Windows — instalador beta

## Qué instala

El instalador empaqueta la interfaz existente de ASISTIA, un runtime local de Node.js y la API con SQLite. No requiere que el usuario final instale Node.js por separado. El backend escucha únicamente en `127.0.0.1:3000`; la base de datos se guarda en la carpeta de datos de usuario de Windows, separada de la carpeta de instalación para que desinstalar o actualizar la app no la borre automáticamente.

## Primera ejecución

1. Instala ASISTIA con el archivo `ASISTIA-Setup-0.4.1-x64.exe`.
2. Abre ASISTIA desde el acceso directo.
3. Escribe el nombre del negocio, el correo del administrador y una contraseña propia de al menos 14 caracteres.
4. Espera a que se inicie el servicio local.
5. En la interfaz, las funciones heredadas continúan utilizando su almacenamiento local. El panel **Conexión con API (beta)** usa la API local; inicia sesión con el correo y la contraseña creados en el asistente.

No hay credenciales predeterminadas. El secreto JWT se genera localmente. La contraseña inicial se entrega al backend por variables de entorno y el archivo temporal se elimina cuando el servicio confirma que está disponible.

## Dónde se guardan los datos

Los archivos se guardan en `%APPDATA%\ASISTIA` (la ubicación exacta la determina Electron/Windows). La base de datos de la API está en `data\asistia.sqlite`. Los datos heredados de la interfaz HTML permanecen en el almacenamiento local del navegador integrado; **no se sincronizan automáticamente con la base de datos de la API**.

No borres la carpeta de datos ni desinstales con una herramienta que elimine los datos de usuario antes de generar y comprobar un respaldo. La opción de conservar datos al desinstalar está habilitada, pero no sustituye un respaldo externo.

## Generación del instalador desde GitHub Actions

El workflow `.github/workflows/windows-installer.yml`:
- ejecuta `npm ci` y `npm test` del backend;
- prepara Node.js para Windows x64;
- genera el instalador NSIS;
- publica `ASISTIA-Windows-Installer` como artefacto descargable por 30 días.

Para generarlo manualmente, abre la pestaña **Actions**, ejecuta **ASISTIA Windows installer** con **Run workflow** y descarga el artefacto cuando el trabajo termine en verde. No descargues un artefacto de una ejecución fallida.

## Límites conocidos — no es todavía una versión comercial de producción

- La interfaz heredada y la API mantienen almacenamientos separados; no existe migración automática ni reconciliación de historiales.
- El panel de API requiere que el servicio local esté activo y no tiene cola de eventos offline ni sincronización posterior.
- Las licencias tienen componentes de código, pero el servicio remoto de licencias todavía debe desplegarse y configurarse con HTTPS, claves y monitoreo.
- No hay proveedor de pagos integrado.
- La compilación de CI no sustituye una prueba manual de instalación, actualización, restauración de respaldos, cierre del servicio ni antivirus en un equipo Windows limpio.
- Antes de utilizarlo con registros laborales reales, deben revisarse la política de privacidad, los respaldos, los permisos de Windows, el cumplimiento aplicable y la recuperación ante fallos.

Este instalador sirve para **pruebas controladas y evaluación local**, no como certificación de cumplimiento legal ni como promesa de sincronización en la nube.
