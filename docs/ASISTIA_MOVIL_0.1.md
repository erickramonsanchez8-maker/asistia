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
6. La interfaz heredada mantiene sus fichas en localStorage; el puente de Electron replica las fichas existentes en SQLite conservando el mismo ID de empleado. No pide volver a capturar los datos laborales.
7. El acceso móvil crea un usuario worker vinculado al ID existente; el trabajador inicia sesión con número de empleado y contraseña temporal.
8. El empaquetado Electron incluye backend/src/**/*, por lo que la PWA, el certificado local y sus recursos quedan dentro del instalador sin servicios externos de pago.

## Arquitectura de la primera iteración

- PWA estática en backend/src/mobile/public, servida por Express en /mobile/.
- Autenticación mediante POST /api/auth/login existente, ampliada para aceptar número de empleado (sin eliminar login por correo).
- Endpoints aditivos en /api/mobile/*.
- Registros de entrada/salida escritos en attendance_events, con source='mobile'; la evidencia de validación se guarda en una tabla complementaria.
- La ubicación exacta no se persiste. Se conserva únicamente la precisión GPS declarada y la distancia calculada al punto de la sucursal.
- La PWA no hace seguimiento en segundo plano y no almacena respuestas de API en caché.
- El panel de escritorio sincroniza las fichas existentes cada 8 segundos cuando cambian y permite crear/restablecer el acceso móvil desde la fila del trabajador.
- La vista principal del escritorio incorpora una lista de los registros móviles recientes.
- El panel Configurar móvil permite guardar geocerca y CIDR desde el escritorio; propone subredes privadas detectadas en las interfaces de red.
- Se reutiliza el logotipo oficial de ASISTIA en el encabezado de la PWA y en su caché offline.

## Endpoints nuevos

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| GET | /api/mobile/settings?branch=Principal | admin | Consultar geocerca y redes permitidas |
| PUT | /api/mobile/settings | admin | Configurar coordenadas, radio, precisión y CIDR IPv4 |
| GET | /api/mobile/me | worker | Perfil propio y política de registro |
| GET | /api/mobile/status | worker | Último evento y siguiente movimiento permitido |
| POST | /api/mobile/attendance | worker | Validar HTTPS, IP LAN y GPS; registrar entrada/salida |
| GET | /api/mobile/recent | admin | Consultar registros móviles y evidencia mínima |
| POST | /api/desktop/sync-employees | puente Electron local | Replicar fichas ya existentes conservando ID y estado |
| POST | /api/desktop/mobile-access | puente Electron local | Crear/restablecer usuario worker vinculado al mismo ID |
| GET/PUT | /api/desktop/mobile-settings | puente Electron local | Configurar geocerca y subred desde el escritorio |
| GET | /api/desktop/mobile-recent | puente Electron local | Alimentar la lista de registros móviles del escritorio |

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

La API HTTP administrativa permanece ligada a 127.0.0.1:43177. En Windows, Electron ejecuta el script local backend/src/mobile/ensure-certificates.ps1 al iniciar y prepara un certificado de servidor PFX firmado por una CA privada local sin contratar un emisor ni un servidor externo. El usuario actual de Windows confía en esa CA y el listener HTTPS se configura en 0.0.0.0:43178.

Variables usadas por el listener:
- MOBILE_HTTPS_PFX_PATH
- MOBILE_HTTPS_PFX_PASSPHRASE
- MOBILE_HTTPS_HOST (0.0.0.0)
- MOBILE_HTTPS_PORT (43178)

El archivo público asistia-local-root.cer queda en %APPDATA%/ASISTIA/certificates para instalarlo en cada teléfono. Los navegadores móviles solo permitirán geolocalización si la CA también está instalada y confiada en cada dispositivo. El script intenta crear una regla de Firewall de Windows para TCP 43178, perfil Privado y subred local; puede requerir permisos de administrador. El puerto HTTP 43177 nunca se publica a la LAN. El router no debe reenviar el puerto 43178 desde internet.

La generación automática es implementación de código, todavía requiere validación práctica en una PC Windows limpia y en teléfonos Android/iOS. No se debe afirmar que está lista hasta comprobar importación de CA, SAN de IP, perfil de red y firewall.

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

La interfaz heredada 0.6.2 conserva las jornadas y los cálculos existentes en localStorage. Las fichas de empleados sí se replican a SQLite con el mismo ID, y la cuenta worker de móvil referencia ese ID; no se solicita volver a capturar al trabajador. Los eventos móviles se guardan en attendance_events y se muestran en la tarjeta “Registros móviles recientes” del escritorio.

Límite importante: la tarjeta muestra los eventos móviles, pero estos todavía no se incorporan al cálculo histórico de jornadas, horas, retardos, descansos ni reportes de la interfaz heredada. No existe todavía una fuente única de asistencia. Tampoco se implementan descansos móviles en 0.1 porque la API actual solo define clock_in y clock_out.

Antes de integrar en main o distribuir a clientes, la siguiente fase debe:
1. Diseñar la fuente única de asistencia o un puente transaccional verificable entre jornadas locales y SQLite, con migración sin pérdida de datos.
2. Incorporar eventos móviles a los cálculos/reportes y resolver el cruce con registros del checador de escritorio.
3. Decidir y probar los eventos de descanso sobre un modelo común.
4. Verificar en Windows la generación de PFX, confianza local de la CA y regla del firewall; instalar la CA en teléfonos Android/iOS y probar geolocalización real.
5. Probar el acceso por Wi-Fi desde teléfonos reales, además de una instalación Windows limpia.

No se debe habilitar para producción ni anunciar como sincronización completa hasta cerrar esos puntos.
