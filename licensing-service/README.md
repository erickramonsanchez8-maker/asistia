# ASISTIA — Servicio remoto de licencias

Estado: **prototipo técnico en rama de desarrollo; no listo para producción ni cobros**.

Este servicio separado administra códigos de activación, dispositivos y documentos de licencia firmados. No recibe nombres de empleados, RFC, registros de asistencia ni reportes laborales.

## Configuración

1. Instala Node.js 20 o superior.
2. En esta carpeta ejecuta `npm install`.
3. Genera una clave RSA de al menos 2048 bits fuera del repositorio. Conserva la clave privada únicamente en el servidor de licencias o en un gestor de secretos.
4. Configura `LICENSING_ADMIN_TOKEN` con al menos 32 caracteres aleatorios y `LICENSING_PRIVATE_KEY` con la clave privada PEM. No uses los valores de ejemplo.
5. Configura `DATABASE_PATH` en un volumen persistente y restringe el acceso al archivo.
6. Despliega detrás de HTTPS en una infraestructura administrada. No expongas la API por HTTP público ni el token administrativo en una aplicación de escritorio.

La clave pública correspondiente debe configurarse en la API local de ASISTIA como `ASISTIA_LICENSE_PUBLIC_KEY`. **Nunca copies la clave privada al cliente ni al repositorio.**

## Flujo de operación

1. Un operador autenticado crea una licencia mediante `POST /v1/admin/licenses`. Puede definir `startsAt` y `expiresAt` exactos en ISO 8601, o usar `durationDays` para compatibilidad. El código de activación se devuelve una sola vez; guárdalo de forma segura y entrégalo al cliente por un canal privado.
2. El cliente genera un `deviceId` aleatorio persistente por instalación y llama `POST /v1/activate` con código, `companyId` y `deviceId`. El código queda invalidado al activar correctamente.
3. El cliente guarda el `activationSecret` en almacenamiento local protegido y el documento firmado en la API local. El secreto permite renovar o desactivar esa activación; no debe mostrarse ni registrarse en logs.
4. Antes de vencer la licencia, el cliente llama `POST /v1/licenses/refresh`. Una licencia revocada no recibe nuevos documentos firmados. La licencia firmada conserva la gracia offline de 7 días tras su fecha de vencimiento.
5. Para liberar un dispositivo, llama `POST /v1/licenses/deactivate`. Para renovar, el operador usa `POST /v1/admin/licenses/:id/renew`; para revocar, `POST /v1/admin/licenses/:id/revoke`.

## Panel administrativo

Tras configurar y desplegar el servicio bajo HTTPS, abre `/admin/`. Introduce el token administrativo del servidor; el navegador lo mantiene únicamente en memoria y no lo escribe en `localStorage` ni `sessionStorage`. El panel permite emitir licencias, consultar el registro, generar códigos nuevos, renovar, suspender, reactivar y revocar. El código de activación solo se devuelve al emitirlo y debe copiarse/entregarse por un canal privado. El panel interpreta las fechas de calendario en hora de Jalisco, México (UTC−6); la fecha final vence a las 23:59:59.999 de ese día local.

El panel requiere conocer el `companyId` exacto de la empresa en la API local de ASISTIA. Confírmalo desde el entorno de administración de esa instalación antes de emitir el código; no uses el nombre comercial como sustituto.

## Endpoints

- `GET /v1/health`: estado básico, sin datos de licencia.
- `GET /v1/admin/licenses`: listado paginado (Bearer administrativo).
- `POST /v1/admin/licenses`: emitir licencia (Bearer administrativo).
- `POST /v1/activate`: activar un código de un solo uso.
- `POST /v1/licenses/refresh`: renovar documento firmado de una activación.
- `POST /v1/licenses/deactivate`: desactivar dispositivo.
- `POST /v1/admin/licenses/:id/activation-code`: emitir un nuevo código de un solo uso para una licencia activa (Bearer administrativo); requiere cupo de dispositivo disponible.
- `POST /v1/admin/licenses/:id/renew`: extender vigencia mediante duración o fecha exacta de vencimiento (Bearer administrativo).
- `POST /v1/admin/licenses/:id/suspend`: suspender licencia (Bearer administrativo).
- `POST /v1/admin/licenses/:id/resume`: reactivar una licencia suspendida (Bearer administrativo).
- `POST /v1/admin/licenses/:id/revoke`: revocación permanente (Bearer administrativo).

## Límites y aspectos pendientes

- `maxDevices` se aplica en el servidor al activar; un dispositivo desactivado libera su cupo. La renovación exige la activación activa y su secreto.
- La renovación y revocación requieren conectividad. Una revocación no puede llegar instantáneamente a un equipo desconectado: el documento ya emitido sigue siendo verificable hasta su límite offline. Esto es una limitación inherente al funcionamiento sin conexión.
- El servicio no integra pagos ni webhooks. No se debe marcar una suscripción pagada hasta integrar y verificar el proveedor de pagos elegido.
- El `companyId` de la licencia debe coincidir con el identificador de empresa de la instalación local. Hace falta un proceso de alta que vincule ambos identificadores antes de entregar códigos.
- El panel administrativo web es una primera versión; antes de producción requiere despliegue HTTPS, control de acceso de red, política de sesiones, auditoría operativa, pruebas de seguridad y revisión independiente.
- La suspensión impide nuevas activaciones y renovaciones remotas, pero no revoca instantáneamente un documento ya firmado en un equipo desconectado. Para limitar esa ventana, el cliente debe sincronizar el estado remoto de forma periódica y el usuario debe comprender la política offline.
- Para producción faltan pruebas de carga, monitoreo, copias de seguridad y restauración, rotación de claves, política de transferencia de dispositivos y límites de abuso.
- La licencia vencida nunca debe borrar ni bloquear el acceso a registros históricos o exportaciones.
