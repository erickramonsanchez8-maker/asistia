# ASISTIA Desktop: arquitectura de distribución y licencias

**Estado:** diseño de implementación; todavía no habilita ni valida licencias en ejecución.  
**Base inspeccionada:** API Node.js/Express/SQLite 0.3 en `backend/src/server.js`; interfaz heredada `ASISTIA_Control_de_Asistencia.html`, que aún usa `localStorage`.  
**Decisión de producto:** una computadora central por empresa, funcionamiento local sin internet durante varios días y licencia por empresa con límites de empleados y dispositivos.

## 1. Arquitectura objetivo

1. **ASISTIA Desktop (Electron):** instalador de Windows, interfaz local y proceso principal protegido. La interfaz no debe tener acceso directo a Node ni a secretos. Usar `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` y una API de preload mínima.
2. **Servicio local:** el backend existente se ejecuta como proceso administrado por la aplicación y escucha exclusivamente en `127.0.0.1`. No exponerlo a la red local salvo que el producto se rediseñe para múltiples terminales.
3. **Datos de asistencia:** SQLite local, en directorio de datos de aplicación y no dentro de la carpeta de instalación. No sincronizar datos personales de empleados con el servicio de licencias.
4. **Servicio remoto de licencias:** componente independiente que gestiona activaciones, pagos, renovaciones, límites y revocaciones. Solo intercambia datos de licencia y telemetría mínima; nunca necesita nombres, RFC ni eventos de asistencia.
5. **Respaldo:** conservar el mecanismo existente de respaldos cifrados. Crear respaldo antes de actualizaciones, migraciones y restauraciones.

## 2. Reglas de licencia

- La licencia identifica una empresa y contiene `licenseId`, `companyId`, `planCode`, `status`, `issuedAt`, `expiresAt`, `offlineGraceUntil`, `maxEmployees`, `maxDevices` y `licenseVersion`.
- El servicio remoto firma el documento de licencia con **clave privada que nunca se distribuye con el instalador**. La aplicación verifica la firma usando una clave pública incorporada. No usar un secreto compartido en el cliente para firmar licencias.
- La activación registra un identificador de instalación aleatorio persistente; no usar solo el nombre del equipo como identidad. Una activación adicional debe comprobar el límite y la política de transferencia del dispositivo.
- La licencia firmada se conserva localmente y puede verificarse sin conexión. El backend local no puede decidir por sí solo que una licencia vencida se renueve ni simular un pago.
- Propuesta inicial para piloto: renovación en línea al menos cada 7 días y periodo de gracia offline de 7 días desde la última validación confiable. Los periodos son parámetros comerciales por confirmar antes de producción.
- Registrar la última hora de validación confiable y detectar retrocesos importantes del reloj. Esto aumenta el costo de manipulación, pero no puede impedir por completo que un administrador con control total del equipo altere el sistema.
- **Continuidad laboral:** si vence la gracia offline, mostrar avisos y restringir funciones comerciales que se definan contractualmente; nunca borrar ni bloquear el acceso a registros de asistencia existentes. Mantener disponibles la consulta y exportación de datos históricos y definir explícitamente qué ocurre con nuevos registros antes de desplegarlo.

## 3. Límites por empresa

El límite de empleados se aplica en el backend, no solo ocultando botones de la interfaz. Antes de crear un empleado, contar empleados activos de la empresa y comparar con `maxEmployees` de una licencia verificada. Los límites de dispositivos se validan en el servicio remoto durante activación/renovación. En una computadora central, el uso cotidiano de empleados no debe contar como activaciones de dispositivos adicionales.

No se deben insertar valores de plan predeterminados en producción ni aceptar `maxEmployees`, `maxDevices` o `expiresAt` suministrados por la interfaz como autoridad.

## 4. Modelo de datos propuesto

Agregar mediante migraciones compatibles; nunca eliminar ni recrear las tablas actuales.

### `license_state` (una fila por instalación)

- `id` (clave primaria fija)
- `license_id`
- `company_id`
- `signed_payload` (documento firmado recibido del servicio)
- `last_validated_at`
- `last_trusted_time`
- `device_id`
- `updated_at`

### `license_events`

- `id`, `company_id`, `event_type`, `created_at`, `details_json`
- No guardar claves privadas, secretos de pago ni datos de asistencia dentro de esta tabla.

La forma definitiva de las tablas debe revisarse contra la base existente y sus migraciones antes de implementarse. No ejecutar migraciones destructivas sobre bases reales.

## 5. Contrato de API objetivo

Los siguientes endpoints son una propuesta; **no están implementados por este documento**:

- `GET /api/license/status`: estado local verificado, plan, límites y fechas; no devuelve secretos ni el documento de pago.
- `POST /api/license/activate`: validar código de activación con el servicio remoto y guardar el documento firmado.
- `POST /api/license/refresh`: renovar y verificar la firma; aplicar protección contra respuestas caducadas o repetidas.
- `POST /api/license/deactivate`: solicitar liberación del dispositivo cuando haya conexión.
- En rutas de empleados, comprobar licencia válida y límite antes de crear un empleado.
- `GET /api/health` sigue siendo un diagnóstico técnico y no debe filtrar información sensible de licencia.

Los errores de conectividad no deben convertir una licencia desconocida en válida. Deben permitir el periodo de gracia solo si existe un documento firmado que lo autorice.

## 6. Orden de implementación segura

### Fase A — Preparación (sin cambios funcionales)
1. Mantener esta implementación en `feature/desktop-licensing`, nunca directamente en `main`.
2. Ejecutar `npm ci`, `npm test`, `npm run db:check` y `npm run integrity:check` con una base de prueba.
3. Documentar las rutas de API y el esquema actual; respaldar y probar restauración.

### Fase B — Licencias locales verificables
1. Añadir migraciones no destructivas y un módulo puro de validación de licencias firmadas.
2. Añadir pruebas para firma incorrecta, licencia vencida, periodo offline, reloj retrocedido, límites y licencia ausente.
3. Añadir estado de licencia y auditoría sin bloquear registros históricos.
4. Aplicar límite de empleados dentro del endpoint de creación, con pruebas de concurrencia y de aislamiento por empresa.

### Fase C — Servicio remoto
1. Implementar servicio remoto separado con almacenamiento de licencias, activaciones y estados de pago.
2. Mantener la clave privada solo en el servidor remoto/gestor de secretos.
3. Probar activación duplicada, revocación, renovación, caída del servicio, respuesta repetida y recuperación tras volver internet.
4. No dar por pagada una suscripción hasta recibir confirmación verificada del proveedor de pagos.

### Fase D — Aplicación de escritorio
1. Conectar la interfaz existente al backend; no eliminar su funcionalidad hasta tener pruebas de equivalencia y migración.
2. Sustituir `localStorage` para los datos operativos por la API local después de reconciliar y respaldar los datos existentes.
3. Empaquetar backend y UI con Electron, aplicar controles de seguridad y firmar el instalador.
4. Probar actualización, reinicio, desconexión de red, restauración de respaldo y desinstalación sin pérdida accidental de datos.

### Fase E — Piloto
Probar primero con una empresa y datos ficticios; luego con 1–2 negocios piloto y consentimiento informado. No vender como listo hasta superar todas las pruebas de aceptación.

## 7. Criterios de aceptación

- La asistencia y reportes funcionan en una sola computadora central sin internet durante el periodo autorizado.
- Reiniciar Windows o ASISTIA no elimina la licencia ni los datos.
- La licencia no puede cambiarse editando la interfaz, el almacenamiento web o un campo enviado por el cliente.
- Los límites de empleados se aplican en el backend y nunca se mezclan datos entre empresas.
- Una licencia vencida no destruye ni oculta el historial laboral.
- La restauración de un respaldo se prueba con éxito antes de actualizar una instalación real.
- Los tests, el chequeo de base y el verificador de integridad pasan en CI.

## 8. Riesgos que no deben ocultarse

- Una licencia local puede ser manipulada por una persona con control administrativo del equipo; la firma criptográfica y la validación periódica reducen el riesgo, no lo eliminan.
- La licencia por empresa y los límites comerciales requieren términos de servicio, política de privacidad y proceso de soporte para recuperar o transferir activaciones.
- Los hashes de la base detectan ciertas alteraciones, pero no equivalen a almacenamiento inmutable ni a una certificación de cumplimiento legal.
- El sistema de licencias no debe sustituir una revisión jurídica de obligaciones laborales y de protección de datos personales.
