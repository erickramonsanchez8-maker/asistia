# ASISTIA Desktop — integración con la API

## Estado

Esta carpeta contiene el primer puente de comunicación para la futura aplicación de escritorio. **Todavía no cambia el comportamiento del HTML existente**: ese archivo conserva su almacenamiento local, y sus datos no se sincronizan con el backend automáticamente.

## Cliente API

`api-client.js` funciona en navegador y Node/Electron:
- Usa la API local, por defecto `http://127.0.0.1:3000`.
- Solo permite HTTP para loopback; cualquier servidor remoto debe usar HTTPS.
- Guarda el JWT solo en memoria; al cerrar la sesión o recibir HTTP 401, lo descarta.
- No usa localStorage/sessionStorage para credenciales ni registros.
- Tiene tiempo límite de petición, mensajes de error comprensibles y métodos tipados por operación.
- El servidor sigue siendo responsable de autenticar, autorizar y validar datos.

## Uso previsto en Electron

Cargar el cliente desde el proceso renderer, crear una instancia con la URL local y llamar `login` antes de operaciones autenticadas:

```js
const api = window.ASISTIAApiClient.createClient({
  baseUrl: 'http://127.0.0.1:3000'
});
const session = await api.login(email, password);
const employees = await api.employees({ limit: 100, offset: 0 });
```

No incluir credenciales administrativas del servicio remoto, claves privadas ni secretos de licencia en el renderer. La API local debe permanecer ligada a loopback y proteger cada ruta.

## Decisión importante antes de sincronizar datos

La interfaz actual guarda un objeto de aplicación completo en `localStorage` (incluyendo empleados y sesiones). El backend utiliza entidades normalizadas en SQLite (`employees`, `attendance_events`, usuarios y auditoría). No es seguro convertir esos datos en segundo plano ni sobrescribir el historial automáticamente.

La integración se hará por etapas:
1. Cliente de comunicación y pruebas unitarias.
2. Pantalla de acceso de API y diagnóstico de conexión en la interfaz de escritorio.
3. Adaptar primero consulta/alta de empleados, con confirmación de empresa y permisos.
4. Conectar marcajes de entrada/salida, conservando el historial y el comportamiento offline definido.
5. Migración/importación explícita con respaldo previo y reporte de conflictos.
6. Empaquetado Electron/Windows, instalador y pruebas de actualización.

Hasta completar la migración, la interfaz actual y la API deben considerarse dos almacenes separados. No activar sincronización bidireccional ni borrar los datos locales.

## Pruebas

`node --test desktop/api-client.test.cjs` comprueba el esquema de URL, autenticación en memoria, limpieza ante token vencido y validación del tipo de marcaje.
