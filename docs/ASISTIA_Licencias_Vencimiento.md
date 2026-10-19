# ASISTIA — política de vencimiento de licencias

## Reglas comerciales acordadas
- La vigencia es personalizada por licencia; la fecha de vencimiento la define el administrador.
- El cliente recibe un aviso al iniciar sesión en la API cuando faltan 10 días o menos.
- Desde el vencimiento se bloquean las escrituras operativas, incluidos los nuevos marcajes de asistencia y las altas de empleados.
- Se conserva el acceso autenticado a consulta y exportación del historial.
- Renovaciones y suspensiones se administran manualmente; no se integran pagos.
- La gracia de conexión no extiende la vigencia comercial ni autoriza nuevas escrituras.

## Cambios de esta rama
- El backend aplica una comprobación de licencia activa al crear empleados, registrar eventos de asistencia, solicitar/revisar correcciones y registrar acuerdos cuando `ASISTIA_LICENSE_ENFORCEMENT=true`.
- `GET /api/license/status` devuelve `daysRemaining`, `showExpiryWarning` y `historyReadOnly`.
- El panel beta muestra el aviso de vencimiento al iniciar sesión de administrador.
- La política de presentación tiene pruebas unitarias para 10 días, día de vencimiento, gracia offline y ausencia de licencia.
- La exportación CSV de asistencia incluye el RFC registrado en el expediente del empleado.

## Límites y pasos restantes antes de vender
1. Confirmar que el empaquetado de producción establece `ASISTIA_LICENSE_ENFORCEMENT=true` y distribuye la clave pública correcta.
2. Integrar una licencia obligatoria en el asistente de primera instalación/alta de empresa. El bootstrap actual crea primero la empresa y su administrador; no debe describirse aún como un flujo de alta protegido por licencia.
3. Verificar el servicio remoto de emisión y administración en un entorno HTTPS real; el panel central de vendedor y su despliegue no se consideran listos solo por existir endpoints.
4. Probar instalación limpia, activación, renovaciones, suspensión, desconexión, vencimiento, consulta/exportación y restauración de respaldo.
5. Resolver la separación entre el HTML heredado y la API antes de prometer que todas las funciones de la interfaz quedan bloqueadas o que todo el historial está sincronizado.
6. Añadir pruebas de integración para confirmar que cada ruta de escritura devuelve HTTP 402 al vencer la licencia y que consultas/exportaciones continúan funcionando.
7. Revisar el RFC en la interfaz local heredada y en sus exportaciones; el RFC de la API y su CSV no significa que los datos locales y remotos estén sincronizados.

## Nota de seguridad
El panel visual es informativo; la API debe ser la autoridad para cada operación de escritura. El historial no se elimina ni se sobrescribe por vencimiento o suspensión.
