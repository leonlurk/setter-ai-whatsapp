/**
 * Firebase Cloud Functions para la WhatsApp API
 * 
 * Este archivo exporta todas las Cloud Functions disponibles.
 */

// Importar funciones desde archivos separados
const cleanupFunctions = require('./cleanupMessages');

// Exportar funciones de limpieza de mensajes
exports.scheduledMessageCleanup = cleanupFunctions.scheduledMessageCleanup;
exports.manualCleanup = cleanupFunctions.manualCleanup;

// Aquí se pueden añadir más exportaciones de otras funciones en el futuro 