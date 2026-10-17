# ASISTIA

Sistema de control de asistencia. La versión actual conserva el HTML existente y añade una API de backend en `backend/` en evolución hacia la versión 0.3.

## Versiones
- **Interfaz heredada:** `ASISTIA_Control_de_Asistencia.html`; mantiene sus funciones y almacenamiento local.
- **API 0.3 (experimental):** Node.js + Express + SQLite, autenticación JWT, roles, separación por empresa, expedientes de empleados con RFC validado, eventos de asistencia, solicitudes de corrección con ajustes aprobados trazables, cambio de contraseña con revocación de sesiones, desactivación de usuarios, constancias, bitácora y reporte CSV.

## Estado de la versión 0.3
La API se encuentra en etapa inicial. La interfaz HTML todavía no está conectada a ella; son dos vías separadas hasta completar integración y pruebas. El módulo Cumplimiento LFT permite generar constancias individuales y descargar una copia HTML, pero sus registros permanecen en localStorage. No migres datos reales ni retires el flujo anterior sin probar respaldo, restauración y reconciliación.

Consulta [arquitectura y límites de ASISTIA 0.3](docs/ASISTIA_0.2_ARQUITECTURA.md), [modelo de datos](database/README.md) y la [plantilla de acuerdo de uso del registro electrónico de jornada](docs/ASISTIA_Acuerdo_Uso_Registro_Electronico.md).

## Ejecutar la API
Requisitos: Node.js 20+.

```bash
cd backend
npm ci
npm test
```

Copia `.env.example` a `.env`, cambia `JWT_SECRET` por un valor aleatorio de al menos 32 caracteres y configura `BOOTSTRAP_ADMIN_EMAIL` y una contraseña de al menos 14 caracteres. No uses las credenciales de ejemplo en producción.

```bash
npm start
```

Verifica `http://127.0.0.1:3000/api/health`. La API escucha solo en localhost por defecto. No se incluye hosting, dominio, certificados HTTPS ni base de datos remota.

Para comprobar las cadenas de hashes de asistencia, ajustes y auditoría sobre la base configurada en `DATABASE_PATH`, ejecuta `npm run integrity:check` desde `backend/`. El comando informa inconsistencias; no repara ni modifica registros. Las consultas se entregan paginadas (máximo 200 por página), los rangos de consulta no superan 366 días y los CSV se limitan a 10,000 filas. Si despliegas detrás de un proxy, configura `TRUST_PROXY_HOPS` solo con el número exacto de proxies confiables.

### Respaldos cifrados y restauración
Configura `BACKUP_ENCRYPTION_KEY` con 64 caracteres hexadecimales aleatorios (32 bytes) y guarda esa clave fuera del servidor y fuera del repositorio. En PowerShell puedes generar una clave con:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Añade la clave al archivo local `.env` y define `BACKUP_DIR` en una ubicación protegida que no sea pública. Para crear un respaldo cifrado:

```powershell
npm run backup:create
```

Para restaurar primero a una ruta nueva (no sobrescribe bases existentes):

```powershell
npm run backup:restore -- .\backups\archivo.asistia.enc .\data\restaurada.sqlite
```

Prueba la restauración periódicamente. Programa `npm run backup:create` en el Programador de tareas de Windows o en el scheduler del proveedor y copia el archivo cifrado a almacenamiento externo con acceso restringido. La clave de cifrado debe respaldarse por separado; perderla impide descifrar los respaldos.

## Seguridad y cumplimiento
El proyecto contiene controles de seguridad iniciales, no una certificación. Antes de producción hacen falta pruebas de extremo a extremo, revisión independiente, HTTPS, secretos gestionados, respaldos externos cifrados y restauración probada, gestión de sesiones, protección contra abuso, privacidad y validación jurídica. Los hashes detectan algunas alteraciones, pero no vuelven inalterable un equipo o archivo bajo control de un administrador. El registro de acuerdos no equivale por sí solo a una firma electrónica válida ni demuestra automáticamente cumplimiento de la LFT.
