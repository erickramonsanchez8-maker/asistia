# ASISTIA 0.3 — arquitectura y alcance

## Objetivo
Iniciar la transición del HTML local a una API con persistencia centralizada, usuarios autenticados, separación por empresa, roles, eventos originales de asistencia, solicitudes de corrección trazables y exportación de reportes.

## Componentes
- `ASISTIA_Control_de_Asistencia.html`: interfaz existente, preservada. Todavía no consume esta API automáticamente.
- `backend/`: API Node.js/Express, validación de entradas, JWT, roles, límites de consulta, limitación de peticiones, encabezados de seguridad y comandos de respaldo/restauración cifrados.
- `backend/data/`: base SQLite local excluida de Git.
- `database/`: descripción del modelo.
- `tests/`: pruebas iniciales.
- `.github/workflows/`: validaciones automáticas de estructura y pruebas.

## Endpoints iniciales
- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/me`, `GET /api/company`
- `GET/POST /api/users`, `POST /api/users/:id/reset-password`, `PATCH /api/users/:id/deactivate` (solo administrador; gestión de cuentas con revocación de sesiones)
- `GET/POST /api/employees`, `PATCH /api/employees/:id/deactivate`
- `POST/GET /api/attendance/events`
- `POST/GET /api/attendance/corrections`, `POST /api/attendance/corrections/:id/review`
- `GET/POST /api/agreements`
- `GET /api/reports/attendance.csv`
- `GET /api/audit` (paginado)

## Seguridad ya incorporada
- Contraseñas con bcrypt; JWT con vencimiento y validación de emisor/audiencia.
- Rol y empresa revalidados contra la base en cada petición autenticada.
- Consultas limitadas por `company_id` para evitar cruces de empresas.
- Validación de payloads, límite de tamaño JSON, limitación de intentos de login, Helmet y CORS configurable.
- Los eventos originales son append-only a través de la API; las correcciones se tramitan por separado.
- Auditoría con cadena SHA-256 de detección de cambios, sin prometer inmutabilidad criptográfica.
- Secretos y datos de base fuera del repositorio.

## Endurecimiento adicional en 0.3
- Consultas de eventos, empleados, correcciones, acuerdos y auditoría con paginación (`limit` entre 1 y 200; `offset` entre 0 y 1,000,000).
- Consultas y reportes con un rango máximo de 366 días; el reporte CSV limita la exportación a 10,000 filas.
- Los reportes y la consulta de eventos consideran el horario aprobado como hora efectiva, sin sobrescribir el evento original.
- Antes de aprobar una corrección se valida que la cronología efectiva no rompa la secuencia entrada/salida.
- Existe `POST /api/users/:id/reset-password` para que un administrador restablezca contraseña y revoque sesiones anteriores.
- `npm run backup:create` crea una copia cifrada AES-256-GCM; `npm run backup:restore -- <respaldo.asistia.enc> <ruta-destino-nueva.sqlite>` descifra y verifica una copia en una ruta nueva, sin sobrescribir archivos existentes.

## Límites importantes
Esta versión es un punto de partida, no una certificación de cumplimiento legal ni un sistema listo para producción. La interfaz HTML actual no se ha conectado a la API. Los tokens se entregan como Bearer token y el despliegue debe usar HTTPS. El registro de acuerdos no prueba por sí solo identidad, consentimiento ni firma electrónica. El registro de eventos debe evolucionar a enmiendas compensatorias explícitas para ejecutar una corrección aprobada sin modificar el original. Se requieren pruebas integrales, respaldo externo cifrado, restauración ensayada, políticas de conservación, revisión de privacidad y validación laboral mexicana actual antes de usar datos reales.

## Desarrollo local
1. Instala Node.js 20 o superior.
2. Abre una terminal dentro de `backend/`.
3. Ejecuta `npm install`.
4. Copia `.env.example` como `.env` y configura `JWT_SECRET` (mínimo 32 caracteres aleatorios) y una contraseña de administrador de al menos 14 caracteres.
5. Ejecuta `npm start`.
6. Prueba `http://127.0.0.1:3000/api/health`.
7. No publiques el archivo `.env` ni compartas la base de datos con datos personales.

La API escucha por defecto en `127.0.0.1` para no exponerse accidentalmente a la red. Para un despliegue real, configurar host, HTTPS, firewall, copias de seguridad y gestión de secretos.
