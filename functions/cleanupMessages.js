const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Inicializar la app de Firebase si aún no está inicializada
if (!admin.apps.length) {
  admin.initializeApp();
}

// Variables de configuración
const MESSAGE_RETENTION_DAYS = 30; // Días a retener mensajes
const MIN_MESSAGES_TO_KEEP = 100; // Cantidad mínima de mensajes a mantener por chat
const BATCH_SIZE = 250; // Tamaño de lote para operaciones de borrado

/**
 * Función de limpieza programada: se ejecuta cada 24 horas
 * Elimina mensajes antiguos de todas las colecciones de mensajes para todos los usuarios
 */
exports.scheduledMessageCleanup = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async (context) => {
    console.log('Iniciando limpieza programada de mensajes...');
    const db = admin.firestore();
    
    // Calcular la fecha de corte (mensajes anteriores a esta fecha serán eliminados)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MESSAGE_RETENTION_DAYS);
    console.log(`Fecha de corte para eliminar mensajes: ${cutoffDate.toISOString()}`);
    
    // Estadísticas de la operación
    const stats = {
      usersProcessed: 0,
      chatsProcessed: 0,
      messagesDeleted: 0,
      errors: 0
    };
    
    try {
      // Obtener todos los usuarios
      const usersSnapshot = await db.collection('users').get();
      
      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        console.log(`Procesando usuario: ${userId}`);
        
        try {
          // Obtener todos los chats del usuario
          const chatsSnapshot = await db.collection('users').doc(userId).collection('chats').get();
          
          for (const chatDoc of chatsSnapshot.docs) {
            const chatId = chatDoc.id;
            console.log(`  Procesando chat: ${chatId}`);
            
            // Colecciones de mensajes a limpiar
            const messageCollections = [
              'messages_all',
              'messages_human',
              'messages_bot',
              'messages_contact'
            ];
            
            // Procesar cada colección de mensajes
            for (const collectionName of messageCollections) {
              await cleanupMessageCollection(
                db, 
                userId, 
                chatId, 
                collectionName, 
                cutoffDate,
                stats,
                null // Usar el valor predeterminado MIN_MESSAGES_TO_KEEP
              );
            }
            
            stats.chatsProcessed++;
          }
          
          stats.usersProcessed++;
        } catch (userError) {
          console.error(`Error procesando usuario ${userId}:`, userError);
          stats.errors++;
        }
      }
      
      console.log('Limpieza de mensajes completada:', stats);
      return null;
    } catch (error) {
      console.error('Error en la limpieza programada:', error);
      return null;
    }
  });

/**
 * Función auxiliar para limpiar una colección de mensajes específica
 */
async function cleanupMessageCollection(db, userId, chatId, collectionName, cutoffDate, stats, customMinToKeep = null) {
  try {
    const collectionRef = db
      .collection('users')
      .doc(userId)
      .collection('chats')
      .doc(chatId)
      .collection(collectionName);
    
    // Usar el valor personalizado si se proporciona, de lo contrario usar el predeterminado
    const minToKeep = customMinToKeep !== null ? customMinToKeep : MIN_MESSAGES_TO_KEEP;
    
    // 1. Verificar cuántos mensajes hay en total
    const countSnapshot = await collectionRef.count().get();
    const totalMessages = countSnapshot.data().count;
    
    if (totalMessages <= minToKeep) {
      console.log(`    Colección ${collectionName}: Solo tiene ${totalMessages} mensajes, por debajo del mínimo (${minToKeep}). Omitiendo.`);
      return;
    }
    
    // 2. Calcular cuántos mensajes podemos eliminar
    const messagesToDelete = totalMessages - minToKeep;
    
    if (messagesToDelete <= 0) {
      return;
    }
    
    console.log(`    Colección ${collectionName}: Eliminando hasta ${messagesToDelete} mensajes antiguos`);
    
    // 3. Obtener mensajes antiguos para eliminar
    let query = collectionRef
      .where('timestamp', '<', cutoffDate)
      .orderBy('timestamp', 'asc')
      .limit(Math.min(messagesToDelete, BATCH_SIZE));
    
    let deleted = 0;
    let hasMore = true;
    
    // 4. Eliminar en lotes para evitar exceder límites de Firestore
    while (hasMore && deleted < messagesToDelete) {
      const snapshot = await query.get();
      
      if (snapshot.empty) {
        hasMore = false;
        break;
      }
      
      // Crear un lote de escritura
      const batch = db.batch();
      let batchCount = 0;
      
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
        batchCount++;
      });
      
      // Ejecutar el lote
      if (batchCount > 0) {
        await batch.commit();
        deleted += batchCount;
        stats.messagesDeleted += batchCount;
        console.log(`    Colección ${collectionName}: Eliminados ${deleted}/${messagesToDelete} mensajes`);
      }
      
      // Verificar si hemos llegado al límite
      if (deleted >= messagesToDelete || batchCount < BATCH_SIZE) {
        hasMore = false;
      }
    }
    
    console.log(`    Colección ${collectionName}: Limpieza completa. Eliminados ${deleted} mensajes.`);
  } catch (error) {
    console.error(`    Error limpiando colección ${collectionName}:`, error);
    stats.errors++;
  }
}

/**
 * Función HTTP para desencadenar limpieza manual
 * Se puede llamar via HTTP POST para ejecutar la limpieza fuera de la programación
 */
exports.manualCleanup = functions.https.onCall(async (data, context) => {
  // Verificar autenticación
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Se requiere autenticación para realizar esta operación.'
    );
  }
  
  // Opcional: verificar que el usuario tenga permisos de administrador
  // Aquí podrías verificar un claim personalizado, rol en Firestore, etc.
  
  console.log(`Limpieza manual iniciada por usuario: ${context.auth.uid}`);
  
  try {
    // Usar los mismos parámetros o permitir personalizarlos
    const retentionDays = data.retentionDays || MESSAGE_RETENTION_DAYS;
    const minToKeep = data.minToKeep || MIN_MESSAGES_TO_KEEP;
    
    // Calcular fecha de corte
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    console.log(`Limpieza manual con parámetros: retentionDays=${retentionDays}, minToKeep=${minToKeep}`);
    
    // Estadísticas
    const stats = {
      usersProcessed: 0,
      chatsProcessed: 0,
      messagesDeleted: 0,
      errors: 0
    };
    
    // Ejecutar la misma lógica que en la función programada
    const db = admin.firestore();
    
    // Si se especificó un userId en la solicitud, limitar la limpieza a ese usuario
    let usersQuery = db.collection('users');
    if (data.userId) {
      console.log(`Limpieza específica para el usuario: ${data.userId}`);
      usersQuery = usersQuery.where(admin.firestore.FieldPath.documentId(), '==', data.userId);
    }
    
    const usersSnapshot = await usersQuery.get();
    
    if (usersSnapshot.empty) {
      console.log('No se encontraron usuarios para procesar.');
      return { success: true, stats, message: 'No se encontraron usuarios para procesar.' };
    }
    
    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      console.log(`Procesando usuario: ${userId}`);
      
      try {
        // Si se especificó un chatId, limitar la limpieza a ese chat
        let chatsQuery = db.collection('users').doc(userId).collection('chats');
        if (data.chatId) {
          console.log(`Limpieza específica para el chat: ${data.chatId}`);
          chatsQuery = chatsQuery.where(admin.firestore.FieldPath.documentId(), '==', data.chatId);
        }
        
        const chatsSnapshot = await chatsQuery.get();
        
        if (chatsSnapshot.empty) {
          console.log(`No se encontraron chats para el usuario ${userId}.`);
          continue;
        }
        
        for (const chatDoc of chatsSnapshot.docs) {
          const chatId = chatDoc.id;
          console.log(`  Procesando chat: ${chatId}`);
          
          // Colecciones de mensajes a limpiar
          const messageCollections = [
            'messages_all',
            'messages_human',
            'messages_bot',
            'messages_contact'
          ];
          
          // Procesar cada colección de mensajes
          for (const collectionName of messageCollections) {
            await cleanupMessageCollection(
              db, 
              userId, 
              chatId, 
              collectionName, 
              cutoffDate,
              stats,
              minToKeep
            );
          }
          
          stats.chatsProcessed++;
        }
        
        stats.usersProcessed++;
      } catch (userError) {
        console.error(`Error procesando usuario ${userId}:`, userError);
        stats.errors++;
      }
    }
    
    console.log('Limpieza manual completada:', stats);
    return {
      success: true,
      stats,
      message: `Limpieza completada. Eliminados ${stats.messagesDeleted} mensajes de ${stats.chatsProcessed} chats.`
    };
  } catch (error) {
    console.error('Error en limpieza manual:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Error al procesar la limpieza manual',
      error.message
    );
  }
}); 