# ASISTIA PC + ASISTIA Móvil

Aplicación de control de asistencia para Windows con servicio local integrado y una PWA para teléfonos. Los datos permanecen en la computadora del negocio: no requiere hosting, nube ni servicios de pago.

## Versión de escritorio

**Versión 0.6.2 · Instalador Windows x64**

- Aplicación Electron con instalador NSIS.
- Servicio API y runtime Node.js incluidos en el mismo instalador.
- Base de datos SQLite local en el perfil de datos de ASISTIA.
- Arranque y cierre del servicio junto con la aplicación de escritorio.
- Conservación de datos de usuario al actualizar o desinstalar.
- Actualizador interno para cambios de interfaz; cambios al proceso Electron o al backend requieren un instalador nuevo.

## ASISTIA Móvil

ASISTIA Móvil es una aplicación web progresiva (PWA) servida por la computadora que ejecuta ASISTIA PC.

- Dirección HTTPS local: se muestra dentro de ASISTIA en **Resumen general → Ver acceso**. La dirección depende de la IP privada de la computadora; no debe copiarse una dirección de ejemplo.
- Puerto HTTPS móvil: `43178`.
- API local de escritorio: `127.0.0.1:43177`.
- Ruta PWA: `/mobile/`.
- El teléfono y la computadora deben permanecer en la misma red Wi-Fi privada del establecimiento.
- La aplicación valida la cuenta de trabajador, sucursal, red local, ubicación GPS, radio y precisión antes de aceptar una marca.
- El registro móvil admite entrada y salida. Las pausas de comida continúan administrándose desde ASISTIA PC.
- El empleado se registra una sola vez en PC. **Crear / restablecer móvil** genera credenciales vinculadas a esa misma ficha; no crea otro empleado.
- Los eventos de PC y teléfono se guardan en el historial central local y el escritorio los proyecta al historial y reportes.

## Primera configuración para probar

1. Instala y abre ASISTIA PC en Windows mientras la computadora está conectada al Wi-Fi del establecimiento.
2. En el primer inicio, ASISTIA prepara el certificado HTTPS local y crea una regla de firewall limitada a la subred local y al perfil de red Privado. Windows puede solicitar autorización de administrador mediante UAC.
3. Abre **Resumen general → Configurar móvil**. Selecciona la sucursal, captura o consulta las coordenadas del establecimiento y confirma el rango IPv4 CIDR del Wi-Fi que usarán los teléfonos. El radio inicial es 50 m y la precisión GPS máxima inicial es 50 m; ajústalos según las condiciones reales.
4. En la lista de empleados, pulsa **Crear / restablecer móvil** y entrega al trabajador su número de empleado y contraseña temporal.
5. Desde **Resumen general → Ver acceso**, copia la dirección HTTPS y abre la carpeta del certificado raíz.
6. Transfiere `asistia-local-root.cer` al teléfono del trabajador e instálalo como certificado de CA de confianza:
   - **Android:** abre el certificado y sigue el flujo del sistema para instalar un certificado de CA. La ruta exacta cambia según el fabricante y la versión.
   - **iPhone:** instala el perfil descargado y después activa la confianza completa en **Ajustes → General → Información → Ajustes de confianza de certificados**.
7. Conecta el teléfono al mismo Wi-Fi del establecimiento, abre la dirección HTTPS, inicia sesión con las credenciales móviles y permite el acceso a la ubicación precisa.
8. Registra entrada y salida. Verifica que ambos movimientos aparezcan en el resumen móvil y en el historial/reportes de ASISTIA PC.

**Importante:** el certificado raíz es propio del negocio. Compártelo únicamente con los dispositivos autorizados. Si se genera una autoridad certificadora nueva, hay que volver a instalarla en los teléfonos. La red Wi-Fi de Windows debe estar marcada como **Privada**; ASISTIA no abre el acceso móvil a Internet.

## Pruebas de aceptación antes de publicar

- [ ] Instalación y primer inicio en Windows.
- [ ] API local y HTTPS móvil activos después de reiniciar ASISTIA.
- [ ] Configuración de coordenadas y CIDR correctos.
- [ ] Alta y restablecimiento de credenciales para un empleado ya existente.
- [ ] Instalación y confianza del certificado en Android.
- [ ] Instalación y confianza del certificado en iPhone.
- [ ] Entrada desde móvil y salida desde móvil visibles en PC.
- [ ] Entrada desde PC y salida desde móvil.
- [ ] Entrada desde móvil y salida desde PC.
- [ ] Rechazo de una marca fuera de la red Wi-Fi autorizada.
- [ ] Rechazo de una marca fuera del radio GPS o con precisión insuficiente.
- [ ] Reinicio de PC y teléfono sin pérdida de registros ni necesidad de crear otra cuenta.

## Compilar el instalador

El flujo `.github/workflows/windows-installer.yml` construye el instalador NSIS x64 y el paquete de actualización como artefactos de GitHub Actions.

Para compilar manualmente en Windows con Node.js 20:

1. `npm install`
2. `cd backend && npm ci --omit=dev`
3. Copiar `node.exe` de Node.js 20 a `backend/runtime/node.exe`
4. Volver a la raíz y ejecutar `npm run dist:win`

## Datos, seguridad y límites

- SQLite permanece en el equipo Windows que ejecuta ASISTIA PC.
- El servicio API escucha en loopback; únicamente el listener HTTPS móvil se expone en la red local.
- Las rutas internas de escritorio requieren un token de puente local y no se publican a la LAN.
- Las cuentas móviles requieren rol de trabajador y un empleado activo vinculado.
- Las marcas móviles requieren HTTPS, Wi-Fi autorizado y validación GPS.
- Los registros son append-only y conservan hash de integridad y evidencia de validación.
- La compilación y las pruebas automatizadas no sustituyen las pruebas físicas de Android/iPhone enumeradas arriba.
