# ASISTIA

Sistema de control de asistencia. La versión actual conserva el HTML existente y añade una primera API de backend en `backend/` como base de la versión 0.2.

## Versiones
- **Interfaz heredada:** `ASISTIA_Control_de_Asistencia.html`; mantiene sus funciones y almacenamiento local.
- **API 0.2 (experimental):** Node.js + Express + SQLite, autenticación JWT, roles, separación por empresa, expedientes de empleados con RFC validado, eventos de asistencia, solicitudes de corrección, cambio de contraseña con revocación de sesiones, desactivación de usuarios, constancias, bitácora y reporte CSV.

## Estado de la versión 0.2
La API se encuentra en etapa inicial. La interfaz HTML todavía no está conectada a ella; son dos vías separadas hasta completar integración y pruebas. No migres datos reales ni retires el flujo anterior sin probar respaldo, restauración y reconciliación.

Consulta [arquitectura y límites de ASISTIA 0.2](docs/ASISTIA_0.2_ARQUITECTURA.md) y [modelo de datos](database/README.md).

## Ejecutar la API
Requisitos: Node.js 20+.

```bash
cd backend
npm install
npm test
```

Copia `.env.example` a `.env`, cambia `JWT_SECRET` por un valor aleatorio de al menos 32 caracteres y configura `BOOTSTRAP_ADMIN_EMAIL` y una contraseña de al menos 14 caracteres. No uses las credenciales de ejemplo en producción.

```bash
npm start
```

Verifica `http://127.0.0.1:3000/api/health`. La API escucha solo en localhost por defecto. No se incluye hosting, dominio, certificados HTTPS ni base de datos remota.

Para comprobar las cadenas de hashes de asistencia y auditoría sobre la base configurada en `DATABASE_PATH`, ejecuta `npm run integrity:check` desde `backend/`. El comando informa inconsistencias; no repara ni modifica registros. Si despliegas detrás de un proxy, configura `TRUST_PROXY_HOPS` solo con el número exacto de proxies confiables.

## Seguridad y cumplimiento
El proyecto contiene controles de seguridad iniciales, no una certificación. Antes de producción hacen falta pruebas de extremo a extremo, revisión independiente, HTTPS, secretos gestionados, respaldos externos cifrados y restauración probada, gestión de sesiones, protección contra abuso, privacidad y validación jurídica. Los hashes detectan algunas alteraciones, pero no vuelven inalterable un equipo o archivo bajo control de un administrador. El registro de acuerdos no equivale por sí solo a una firma electrónica válida ni demuestra automáticamente cumplimiento de la LFT.
