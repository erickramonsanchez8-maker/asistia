# ASISTIA Móvil 0.1 — Diseño técnico y alcance de la rama

## Estado

- Rama de trabajo: feature/asistia-mobile-0.1
- Base: main (commit afb3cf142c4529f4b0665175b90bd69e8e8e65dd)
- Aplicación de escritorio identificada en package.json: 0.6.2.
- API local identificada en backend/package.json: 0.3.0.
- El último flujo de instalador consultado para 0.6.2 terminó correctamente el 13-11-2026.
- No se encontró un Release formal publicado en GitHub; el instalador se distribuye como artefacto de GitHub Actions.

## Hallazgos de la auditoría

1. Electron inicia la API Node en 127.0.0.1:43177.
2. La API usa SQLite en %APPDATA%/ASISTIA/database/asistia.sqlite.
3. La interfaz heredada guarda su propia asistencia en localStorage, con la clave control_asistencia_pro_v1. No llama a la API ni migra automáticamente esos eventos a SQLite.
4. La API dispone de empresas, usuarios, empleados, autenticación JWT, eventos inmutables de entrada/salida, correcciones y auditoría.
5. La API existente solo tiene tipos canónicos clock_in y clock_out; no ofrece eventos móviles de inicio/fin de descanso.
6. Las cuentas de trabajador existentes se crean con correo y contraseña y deben vincularse a un empleado. El prototipo móvil reutiliza esa autenticación; no inventa un PIN ni crea credenciales paralelas.
7. El empaquetado Electron ya incluye backend/src/**/*, por lo que los archivos del módulo backend quedan dentro del recurso del instalador sin añadir dependencias.

## Arquitectura de la primera iteración

- PWA estática en backend/src/mobile/public, servida por Express en /mobile/.
- Autenticación mediante POST /api/auth/login existente.
- Endpoints aditivos en /api/mobile/*.
- Registros de entrada/salida escritos en attendance_events, con source='mobile'; la evidencia de validación se guarda en una tabla complementaria.
- La ubicación exacta no se persiste. Se conserva únicamente la precisión GPS declarada y la distancia calculada al punto de la sucursal.
- La PWA no hace seguimiento en segundo plano y no almacena respuestas de API en caché.

## Endpoints nuevos

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| GET | /api/mobile/settings?branch=Principal | admin | Consultar geocerca y redes permitidas |
| PUT | /api/mobile/settings | admin | Configurar coordenadas, radio, precisión y CIDR IPv4 |
| GET | /api/mobile/me | worker | Perfil propio y política de registro |
| GET | /api/mobile/status | worker | Último evento y siguiente movimiento permitido |
| POST | /api/mobile/attendance | worker | Validar HTTPS, IP LAN y GPS; registrar entrada/salida |
| GET | /api/mobile/recent | admin | Consultar registros móviles y evidencia mínima |

No se reemplazan ni se modifican las rutas existentes de /api/auth, /api/employees o /api/attendance/events.

## Validaciones

- La conexión del teléfono debe ser HTTPS; la ubicación de navegadores modernos no está disponible de forma fiable en HTTP de red local.
- La solicitud debe llegar desde una dirección IPv4 incluida en los CIDR configurados para la sucursal. Se usa la dirección del socket TCP y no se confía en X-Forwarded-For.
- El sitio valida GPS con Haversine contra el punto configurado de la sucursal.
- Valores iniciales: radio de 50 m y precisión GPS máxima de 50 m. El administrador puede ajustarlos.
- Se rechazan precisión insuficiente, ubicación fuera del radio, IP no permitida, cuenta sin empleado, empleado inactivo, secuencia inválida y solicitud duplicada.
- Cada envío incluye un UUID de idempotencia.
- El servidor fija la hora; no acepta hora elegida por el teléfono.
- Se guardan distancia, precisión y hora de validación; no se guardan latitud ni longitud del trabajador.
- Las rutas móviles exigen cuenta worker; un usuario administrativo no puede registrar asistencia como empleado.

## HTTPS para la red local

La API HTTP existente permanece ligada a 127.0.0.1. Se añadió un listener HTTPS opcional y separado que solo inicia cuando se configuran ambas variables:

- MOBILE_HTTPS_KEY_PATH
- MOBILE_HTTPS_CERT_PATH

Opcionales:
- MOBILE_HTTPS_HOST (por defecto 0.0.0.0)
- MOBILE_HTTPS_PORT (por defecto 43178)

El certificado debe ser confiable en los teléfonos y contener en SAN el nombre o IP usado para abrir ASISTIA. Un certificado autofirmado no confiable generará advertencias y puede impedir geolocalización/PWA. El router no debe reenviar el puerto móvil desde internet y el Firewall de Windows debe limitar 43178 a la LAN. Esta rama prepara el listener; todavía no automatiza la emisión e instalación del certificado.

## Pruebas previstas

- Configuración administrativa de sucursal y CIDR.
- Autenticación worker y aislamiento al expediente propio.
- Rechazo de IP fuera de LAN.
- Rechazo de precisión GPS insuficiente.
- Rechazo fuera del radio.
- Registro de entrada y salida con source='mobile'.
- Rechazo de evento duplicado y secuencia inválida.
- Comprobación de entrega de la PWA y su manifiesto.

## Límites y condición para integrar

Esta rama es una capa móvil inicial, no una sustitución de la asistencia heredada.

La interfaz de escritorio 0.6.2 usa localStorage; la API SQLite es una capa paralela que no alimenta los cálculos ni las pantallas heredadas. Aunque el registro móvil aparece en attendance_events y en /api/mobile/recent, todavía no aparecerá automáticamente en los reportes ni en la vista de asistencia del HTML de escritorio. Tampoco se implementan descansos móviles en 0.1 porque la API actual no define esos tipos de evento.

Antes de integrar en main o distribuir a clientes, la siguiente fase debe:
1. Diseñar una fuente única de datos o un puente transaccional entre la interfaz heredada y SQLite, con migración verificable y sin pérdida de datos.
2. Incorporar la vista administrativa de registros móviles y reflejarlos en los cálculos/reportes.
3. Decidir y probar los eventos de descanso sobre un modelo común.
4. Integrar la configuración del certificado HTTPS y reglas de firewall al instalador.
5. Ejecutar pruebas reales en Android/iOS y en una instalación Windows limpia.

No se debe habilitar para producción ni anunciar como sincronización completa hasta cerrar esos puntos.
