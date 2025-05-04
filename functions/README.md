# WhatsApp API - Cloud Functions

Este directorio contiene las Cloud Functions de Firebase utilizadas por la aplicación WhatsApp API.

## Funciones disponibles

### Limpieza de mensajes

- `scheduledMessageCleanup`: Se ejecuta automáticamente cada 24 horas para eliminar mensajes antiguos según la configuración.
- `manualCleanup`: Permite desencadenar la limpieza manualmente a través de una llamada HTTP.

## Configuración

Las principales variables de configuración están en cada archivo de función:

- **cleanupMessages.js**:
  - `MESSAGE_RETENTION_DAYS`: Días que se retienen los mensajes (por defecto: 30 días)
  - `MIN_MESSAGES_TO_KEEP`: Número mínimo de mensajes a mantener por chat (por defecto: 100)
  - `BATCH_SIZE`: Tamaño de lote para operaciones de borrado (por defecto: 250)

## Despliegue

Para desplegar las funciones:

```bash
cd functions
npm install
firebase deploy --only functions
```

## Ejecución local para pruebas

Para probar las funciones localmente:

```bash
cd functions
npm run serve
```

## Invocación manual de la limpieza

Puedes desencadenar la limpieza manual mediante una llamada a la función `manualCleanup`. Ejemplo usando Firebase Admin SDK:

```javascript
const result = await firebase.functions().httpsCallable('manualCleanup')({
  retentionDays: 15,  // Opcional: sobrescribir días de retención
  minToKeep: 50       // Opcional: sobrescribir mínimo a mantener
});
console.log('Resultado:', result.data);
```

## Logs

Para ver los logs de las funciones:

```bash
firebase functions:log
``` 