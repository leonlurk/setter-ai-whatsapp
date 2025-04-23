require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const admin = require('firebase-admin'); // <<< Importar Firebase Admin
const { fork } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// === CONFIGURACIÓN INICIAL ===
const app = express();
const port = process.env.PORT || 3457;

// <<< DECLARED firestoreDb outside try block >>>
let firestoreDb;

// === INICIALIZACIÓN FIREBASE ===
try {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!serviceAccountPath) {
        throw new Error('La variable de entorno GOOGLE_APPLICATION_CREDENTIALS no está definida.');
    }
    if (!fs.existsSync(serviceAccountPath)) {
        throw new Error(`Archivo de clave de servicio no encontrado en: ${serviceAccountPath}`);
    }
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccountPath)
    });
    firestoreDb = admin.firestore(); // <<< ASSIGN value inside try block >>>
    console.log("Firebase Admin SDK inicializado correctamente. Conectado a Firestore.");
} catch (error) {
    console.error("[ERROR CRÍTICO] Inicializando Firebase Admin SDK:", error);
    process.exit(1); // Salir si Firebase no se puede inicializar
}
// === FIN INICIALIZACIÓN FIREBASE ===

console.log("==================================================");
console.log(`INICIANDO API PRINCIPAL (v2) EN PUERTO ${port} - ${new Date().toLocaleTimeString()}`);
console.log("==================================================");

// --- ELIMINADO: Configuración DB SQLite ---
/*
const DB_FILE = path.join(__dirname, 'whatsapp_manager_v2.db');
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error("[ERROR] Conectando a la base de datos SQLite (v2)", err.message);
    throw err; 
  } else {
    console.log("Conectado a la base de datos SQLite (v2).");
    // Crear tabla si no existe
    db.run(`CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'disconnected', 
      active_agent_id TEXT,
      last_qr_code TEXT,
      worker_pid INTEGER,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error("[ERROR] Creando tabla users:", err.message);
      } else {
         console.log("Tabla 'users' lista.");
         // Intentar añadir la nueva columna si no existe (para migraciones simples)
         db.run('ALTER TABLE users ADD COLUMN active_agent_id TEXT', (alterErr) => {
             if (alterErr && !alterErr.message.includes('duplicate column name')) {
                 console.error("[ERROR] Añadiendo columna active_agent_id:", alterErr.message);
             } else if (!alterErr) {
                 console.log("Columna 'active_agent_id' añadida (o ya existía).");
             }
         });
          // Trigger para actualizar updated_at
          db.run(`
            CREATE TRIGGER IF NOT EXISTS update_users_updated_at_v2
            AFTER UPDATE ON users
            FOR EACH ROW
            BEGIN
                UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE user_id = OLD.user_id;
            END;
          `, (err) => {
              if (err) console.error("[ERROR] Creando trigger updated_at:", err.message);
          });
      }
    });
  }
});
*/

// --- ELIMINADO: Creación de directorio de datos base (innecesario con Firestore) ---
/*
const BASE_DATA_DIR = path.join(__dirname, 'data_v2');
if (!fs.existsSync(BASE_DATA_DIR)){
    console.log(`Creando directorio base de datos de usuarios (v2): ${BASE_DATA_DIR}`);
    fs.mkdirSync(BASE_DATA_DIR);
}
*/

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// <<< ADDED: Basic API Key Authentication Middleware >>>
const API_SECRET_KEY = process.env.API_SECRET_KEY;
if (!API_SECRET_KEY) {
    console.warn('[SECURITY WARNING] API_SECRET_KEY environment variable is not set. API endpoints are unprotected!');
}

const authenticateApiKey = (req, res, next) => {
    if (!API_SECRET_KEY) {
        // If no key is set in env, bypass auth (with warning)
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid Authorization header.' });
    }

    const providedKey = authHeader.split(' ')[1];
    if (providedKey !== API_SECRET_KEY) {
        return res.status(403).json({ success: false, message: 'Forbidden: Invalid API Key.' });
    }

    next(); // Key is valid
};

// Apply the authentication middleware to all subsequent routes
app.use(authenticateApiKey);
// <<< END: Basic API Key Authentication Middleware >>>

// --- Gestión de Workers --- 
const workers = {}; // Almacena los procesos worker activos { userId: ChildProcess }

// --- Middleware para loggear todas las peticiones ---
app.use((req, res, next) => {
    console.log(`[API v2] ${req.method} ${req.url} - ${new Date().toLocaleTimeString()}`);
    next();
});

// Helper para notificar a un worker específico via IPC
function notifyWorker(userId, message) {
    if (workers[userId] && workers[userId].connected) {
        try {
            console.log(`[IPC Master] Enviando a worker ${userId} (PID: ${workers[userId].pid}):`, message);
            workers[userId].send(message);
        } catch (ipcError) {
            console.error(`[IPC Master] Error enviando mensaje a worker ${userId}:`, ipcError);
        }
    } else {
        console.log(`[IPC Master] No se notifica a worker ${userId} (no activo o no conectado).`);
    }
}

// --- Reemplazo Firestore y Async --- 
async function startWorker(userId) {
    // Verificar si ya está corriendo y conectado
    if (workers[userId] && workers[userId].connected) {
        console.log(`[Master] Worker para ${userId} ya está corriendo (PID: ${workers[userId].pid}).`);
        return workers[userId]; // Devolver la instancia existente
    }
    // Limpiar worker zombie si existe
    if (workers[userId] && !workers[userId].connected) {
        console.warn(`[Master] Worker para ${userId} existe pero no está conectado. Intentando limpiar y reiniciar.`);
        try { workers[userId].kill(); } catch (e) { console.error("Error matando worker zombie:", e); }
        delete workers[userId];
    }

    // Crear directorio de datos para sesión de WhatsApp (aún necesario para LocalAuth)
    const userDataDir = path.join(__dirname, 'data_v2', userId); // Mantener data_v2 para sesiones wwebjs
    const sessionPath = path.join(userDataDir, '.wwebjs_auth');
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log(`[Master] Creado directorio para sesión WhatsApp: ${sessionPath}`);
    }

    console.log(`[Master] Iniciando worker para usuario: ${userId}`);
    const workerScript = path.join(__dirname, 'worker.js');

    if (!fs.existsSync(workerScript)) {
        console.error(`[ERROR] No se encuentra el script del worker: ${workerScript}. No se puede iniciar el worker para ${userId}.`);
        try {
            await firestoreDb.collection('users').doc(userId).update({
                status: 'error',
                last_error: 'Worker script not found',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (dbErr) {
             console.error("[Firestore Error] Error actualizando estado a error (worker script missing):", dbErr);
        }
        return null;
    }

    try {
        // Obtener agente activo desde Firestore
        const userDocSnap = await firestoreDb.collection('users').doc(userId).get();
        let activeAgentId = null;
        if (userDocSnap.exists) {
            activeAgentId = userDocSnap.data()?.active_agent_id || null;
        } else {
            console.warn(`[Master] Documento de usuario ${userId} no encontrado en Firestore al iniciar worker.`);
            // Considerar si crear el documento aquí o dejar que falle?
            // Por ahora, continuaremos, el worker usará default.
        }
        console.log(`[Master] Agente activo inicial para ${userId}: ${activeAgentId || 'Ninguno (usará default)'}`);

        // Lanzar el proceso hijo
        const workerArgs = [userId];
        if (activeAgentId) {
            workerArgs.push(activeAgentId);
        }
        const worker = fork(workerScript, workerArgs, { stdio: 'inherit' });
        workers[userId] = worker;

        // Actualizar Firestore - Estado inicial 'connecting'
        await firestoreDb.collection('users').doc(userId).update({
            status: 'connecting',
            worker_pid: worker.pid,
            last_error: null,
            last_qr_code: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`[DB Firestore] Usuario ${userId} status -> connecting (PID: ${worker.pid})`);

        // ----- Manejadores de eventos para el worker ----- 
        worker.on('message', (message) => {
            // handleWorkerMessage ya es async y usa Firestore
            handleWorkerMessage(userId, message);
        });

        worker.on('exit', async (code, signal) => {
            console.log(`[Master] Worker para ${userId} (PID: ${worker.pid || 'N/A'}) terminó inesperadamente con código ${code}, señal ${signal}`);
            const workerExisted = !!workers[userId];
            delete workers[userId];
            try {
                const userDocRef = firestoreDb.collection('users').doc(userId);
                const userDoc = await userDocRef.get();
                if (workerExisted && userDoc.exists && userDoc.data().status !== 'disconnected') {
                    const exitErrorMsg = `Worker exited code ${code}${signal ? ` (signal ${signal})` : ``} unexpectedly`;
                    await userDocRef.update({
                        status: 'error',
                        worker_pid: null,
                        last_error: exitErrorMsg,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`[DB Firestore] Usuario ${userId} status -> error (Worker exit)`);
                } else {
                    console.log(`[Master] No se actualiza Firestore en exit para ${userId}, estado ya era ${userDoc.data()?.status} o worker no registrado.`);
                }
            } catch (dbErr) {
                console.error("[Firestore Error] Error obteniendo/actualizando status en exit:", dbErr);
            }
        });

        worker.on('error', async (error) => {
            console.error(`[Master] Error en worker ${userId} (PID: ${worker.pid || 'N/A'}):`, error);
            delete workers[userId];
            try {
                await firestoreDb.collection('users').doc(userId).update({
                    status: 'error',
                    worker_pid: null,
                    last_error: error.message || 'Unknown worker error',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`[DB Firestore] Usuario ${userId} status -> error (Worker error event)`);
            } catch (dbErr) {
                console.error("[Firestore Error] Error actualizando DB en error de worker:", dbErr);
            }
        });
        
        // <<< ADDED: Enviar configuración inicial al worker >>>
        fetchInitialConfigsAndNotifyWorker(userId, activeAgentId); 

        return worker; // Devuelve la instancia del worker

    } catch (error) {
        console.error(`[Master] Error CRÍTICO iniciando worker para ${userId}:`, error);
        // Asegurar que el estado en DB sea error si falló la inicialización
        try {
            await firestoreDb.collection('users').doc(userId).update({
                status: 'error',
                worker_pid: null,
                last_error: `Error crítico al iniciar worker: ${error.message}`,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (dbErr) { /* Ignorar error secundario */ }
        return null;
    }
}
// --- Fin Reemplazo Firestore y Async ---
/* function startWorker(userId) {
    // ... (código sqlite eliminado)
} */

// <<< ADDED: Función para obtener y enviar configuración inicial al worker >>>
async function fetchInitialConfigsAndNotifyWorker(userId, activeAgentId) {
    console.log(`[Master] Preparando configuración inicial para worker ${userId} (Agente: ${activeAgentId || 'default'})`);
    try {
        const userDocRef = firestoreDb.collection('users').doc(userId);
        
        // 1. Obtener Configuración del Agente Activo
        let agentConfigData = null;
        if (activeAgentId) {
            const agentDocRef = userDocRef.collection('agents').doc(activeAgentId);
            const agentDocSnap = await agentDocRef.get();
            if (agentDocSnap.exists) {
                agentConfigData = agentDocSnap.data();
                console.log(`   -> Configuración encontrada para agente ${activeAgentId}`);
            } else {
                console.warn(`   -> Agente ${activeAgentId} especificado pero no encontrado en Firestore. Worker usará default.`);
            }
        } else {
            console.log(`   -> No hay agente activo especificado. Worker usará default.`);
        }

        // 2. Obtener Reglas
        const rulesSnapshot = await userDocRef.collection('rules').get();
        const rulesData = rulesSnapshot.docs.map(doc => doc.data());
        console.log(`   -> Reglas cargadas: ${rulesData.length}`);

        // 3. Obtener Starters
        const startersSnapshot = await userDocRef.collection('gemini_starters').get();
        const startersData = startersSnapshot.docs.map(doc => doc.data());
        console.log(`   -> Starters cargados: ${startersData.length}`);
        
        // 4. Obtener Flujos (Globales)
        const flowsSnapshot = await firestoreDb.collection('action_flows').get();
        const flowsData = flowsSnapshot.docs.map(doc => doc.data());
        console.log(`   -> Flujos globales cargados: ${flowsData.length}`);

        // 5. Enviar configuración al worker
        const initialConfigPayload = {
            agentConfig: agentConfigData, // Puede ser null si no hay o no se encuentra
            rules: rulesData,
            starters: startersData,
            flows: flowsData
        };
        
        notifyWorker(userId, { type: 'INITIAL_CONFIG', payload: initialConfigPayload });
        console.log(`[Master] Configuración inicial enviada a worker ${userId} via IPC.`);

    } catch (error) {
        console.error(`[Master][Firestore Error] Error crítico obteniendo configuración inicial para ${userId}:`, error);
        // Notificar al worker que hubo un error? O dejar que use defaults?
        // Por ahora, logueamos y el worker usará defaults si no recibe INITIAL_CONFIG a tiempo.
         try {
            await firestoreDb.collection('users').doc(userId).update({
                 last_error: `Error obteniendo config inicial: ${error.message}`,
                 updatedAt: admin.firestore.FieldValue.serverTimestamp()
             });
         } catch (dbErr) { /* ignore */ }
    }
}
// <<< FIN Función para obtener y enviar configuración inicial al worker >>>


// --- Reemplazo Firestore --- 
async function stopWorker(userId) {
    if (workers[userId] && workers[userId].connected) {
        console.log(`[Master] Iniciando parada para worker ${userId} (PID: ${workers[userId].pid})`);
        try {
            // Actualizar Firestore PRIMERO
            await firestoreDb.collection('users').doc(userId).update({
                status: 'disconnected',
                worker_pid: null,
                last_qr_code: null,
                last_error: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[DB Firestore] Usuario ${userId} status -> disconnected (manual stop)`);

            // Enviar comando IPC DESPUÉS
            if (workers[userId] && workers[userId].connected) {
                console.log(`[IPC Master] Enviando comando SHUTDOWN a worker ${userId}`);
                workers[userId].send({ type: 'COMMAND', command: 'SHUTDOWN' });
            } else {
                console.warn(`[Master] Worker ${userId} ya no está conectado al intentar enviar SHUTDOWN.`);
                delete workers[userId];
            }
             return true; // Indica que se inició el proceso de parada
        } catch (dbErr) {
            console.error("[Firestore Error] Error actualizando DB antes de parar worker:", dbErr);
            // Si falla la DB, ¿deberíamos intentar parar el worker igualmente?
            // Por ahora sí, pero logueamos el error
            try {
                 if (workers[userId] && workers[userId].connected) { 
                       console.log(`[IPC Master] Enviando comando SHUTDOWN a worker ${userId} (a pesar de error DB)`);
                       workers[userId].send({ type: 'COMMAND', command: 'SHUTDOWN' });
                 }
            } catch (ipcErr) { console.error(`[Master] Error enviando SHUTDOWN (tras error DB) a worker ${userId}:`, ipcErr); }
             return true; // Se intentó parar
        }
    } else {
        console.log(`[Master] Worker para ${userId} no encontrado o no conectado. Asegurando estado Firestore.`);
        try {
            // Asegurar estado disconnected en Firestore si el worker no está
            await firestoreDb.collection('users').doc(userId).set(
                { status: 'disconnected', worker_pid: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, 
                { merge: true } // Usar set con merge para crear/actualizar sin sobreescribir todo
            );
             console.log(`[DB Firestore] Asegurado ${userId} status -> disconnected (worker not found)`);
        } catch (dbErr) {
            console.error("[Firestore Error] Error asegurando desconexión en Firestore (worker no encontrado):", dbErr); 
        }
        return false; // Indica que no se pudo iniciar la parada (ya estaba parado/no existía)
    }
}
// --- Fin Reemplazo Firestore ---
/* function stopWorker(userId) {
    // ... (código sqlite eliminado)
} */


// --- Reemplazo Firestore --- 
async function handleWorkerMessage(userId, message) {
    if (!message || !message.type) {
         console.warn(`[IPC Master] Mensaje inválido recibido del worker ${userId}:`, message);
         return;
    }

    let updateData = {};
    let logMsg = '';
    let newStatus = message.status || null; 
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    switch (message.type) {
        case 'STATUS_UPDATE':
            newStatus = newStatus || 'error';
            updateData = { 
                status: newStatus, 
                last_error: message.error || null,
                updatedAt: timestamp
             };
            if (newStatus === 'connected' || newStatus === 'disconnected') {
                updateData.last_qr_code = null; // Limpiar QR al conectar/desconectar
            }
            logMsg = `status -> ${newStatus}`; 
            break;
        case 'QR_CODE':
            updateData = { 
                status: 'generating_qr', 
                last_qr_code: message.qr || null, 
                updatedAt: timestamp 
            };
            logMsg = `status -> generating_qr`;
            break;
        case 'ERROR_INFO':
             newStatus = 'error';
             updateData = { 
                 status: newStatus, 
                 last_error: message.error || 'Unknown worker error', 
                 updatedAt: timestamp 
             }; 
             logMsg = `status -> error (ERROR_INFO)`;
            break;
        default:
            console.log(`[IPC Master] Mensaje tipo ${message.type} no manejado para worker ${userId}.`);
            return;
    }

    try {
        await firestoreDb.collection('users').doc(userId).update(updateData);
        console.log(`[DB Firestore] Usuario ${userId} ${logMsg}`);
    } catch (err) {
        console.error(`[IPC Master] Error actualizando Firestore para worker ${userId} por mensaje ${message.type}:`, err);
    }
}
// --- Fin Reemplazo Firestore ---
/* function handleWorkerMessage(userId, message) {
    // ... (código sqlite eliminado)
} */

// === RUTAS DE LA API ===

// --- Rutas de Gestión de Usuarios (Ejemplo Básico) ---

// Crear/Registrar un nuevo usuario
// --- Reemplazo Firestore --- 
app.post('/users', async (req, res) => {
    const { userId } = req.body;
    if (!userId || !userId.trim()) {
        return res.status(400).json({ success: false, message: 'userId es requerido y no puede estar vacío.' });
    }
    const trimmedUserId = userId.trim();
    console.log(`[API v2] POST /users - Intentando registrar usuario: ${trimmedUserId}`);

    const userDocRef = firestoreDb.collection('users').doc(trimmedUserId);

    try {
        const docSnap = await userDocRef.get();
        if (docSnap.exists) {
            console.warn(`[API v2] Conflicto: Usuario ${trimmedUserId} ya existe.`);
            return res.status(409).json({ success: false, message: 'El usuario ya existe.' });
        } else {
            // Crear el usuario
            await userDocRef.set({
                userId: trimmedUserId,
                status: 'disconnected',
                active_agent_id: null, // Inicialmente sin agente activo
                last_qr_code: null,
                worker_pid: null,
                last_error: null,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[API v2] Usuario ${trimmedUserId} registrado en Firestore.`);
            res.status(201).json({ success: true, message: 'Usuario registrado con éxito.', userId: trimmedUserId });
        }
    } catch (err) {
        console.error("[API v2][Firestore Error] Error creando/verificando usuario:", err);
        return res.status(500).json({ success: false, message: 'Error interno al crear usuario.' });
    }
});
// --- Fin Reemplazo Firestore ---
/* app.post('/users', (req, res) => {
    // ... (código sqlite eliminado)
}); */

// Obtener lista simple de usuarios y su estado
// --- Reemplazo Firestore ---
app.get('/users', async (req, res) => {
    console.log(`[API v2] GET /users`);
    try {
        const usersSnapshot = await firestoreDb.collection('users')
                                        .orderBy('createdAt', 'desc')
                                        .get();
        const users = [];
        usersSnapshot.forEach(doc => {
            const data = doc.data();
            // Convertir Timestamps a ISO string si es necesario para el cliente
            const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt;
            const updatedAt = data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt;
            
            users.push({ 
                user_id: doc.id, 
                status: data.status,
                active_agent_id: data.active_agent_id,
                // No enviar datos sensibles como QR o PID en la lista general
                created_at: createdAt,
                updated_at: updatedAt
            });
        });
        res.json({ success: true, users: users });
    } catch (err) {
        console.error("[API v2][Firestore Error] Error obteniendo usuarios:", err);
        return res.status(500).json({ success: false, message: 'Error interno al obtener usuarios.' });
    }
});
// --- Fin Reemplazo Firestore ---
/* app.get('/users', (req, res) => {
    // ... (código sqlite eliminado)
}); */

// --- Rutas de Control de Workers por Usuario ---

// Iniciar conexión para un usuario
// --- Reemplazo Firestore --- 
app.post('/users/:userId/connect', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[API v2] POST /users/${userId}/connect`);
    
    try {
        const userDoc = await firestoreDb.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        const userData = userDoc.data();
        // Verificar si ya está conectado o conectando
        if (userData.status === 'connected' || userData.status === 'connecting' || userData.status === 'generating_qr') {
             if (workers[userId] && workers[userId].connected) {
                 console.log(`[API v2] Petición connect para ${userId} pero worker ya está activo.`);
                 return res.status(200).json({ success: true, message: 'La conexión ya está activa o en proceso.', currentStatus: userData.status });
             }
             console.warn(`[API v2] Inconsistencia detectada: Firestore dice ${userData.status} para ${userId} pero no hay worker activo. Intentando iniciar.`);
        }
        
        // Intentar iniciar el worker (ahora es async)
        const workerInstance = await startWorker(userId);
        if (workerInstance) {
             res.status(202).json({ success: true, message: 'Solicitud de conexión recibida. Iniciando proceso...' });
        } else {
             // startWorker devolvió null (ej. script no encontrado o error crítico)
             // El estado ya debería haberse actualizado a error dentro de startWorker
             res.status(500).json({ success: false, message: 'Error: No se pudo iniciar el worker. Revise los logs del servidor.' });
        }
    } catch (err) {
        console.error("[API v2][Firestore Error] Error verificando usuario para conectar:", err);
        return res.status(500).json({ success: false, message: 'Error interno al verificar usuario.' });
    }
});
// --- Fin Reemplazo Firestore ---
/* app.post('/users/:userId/connect', (req, res) => {
    // ... (código sqlite eliminado)
}); */

// Detener conexión para un usuario
// --- Reemplazo Firestore --- 
app.post('/users/:userId/disconnect', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[API v2] POST /users/${userId}/disconnect`);
    
     try {
         const userDoc = await firestoreDb.collection('users').doc(userId).get();
         if (!userDoc.exists) {
             return res.status(404).json({ success: false, message: 'Usuario no encontrado.' }); 
         }

         // stopWorker ya es async y maneja Firestore
         const stopped = await stopWorker(userId);
         if (stopped) {
            res.json({ success: true, message: 'Solicitud de desconexión enviada.' });
         } else {
             res.json({ success: true, message: 'La conexión ya estaba detenida.' });
         }
     } catch (err) {
         console.error("[API v2][Firestore Error] Error verificando usuario para desconectar:", err);
         return res.status(500).json({ success: false, message: 'Error interno.' }); 
     }
});
// --- Fin Reemplazo Firestore ---
/* app.post('/users/:userId/disconnect', (req, res) => {
    // ... (código sqlite eliminado)
}); */

// Obtener estado y QR para un usuario específico
// --- Reemplazo Firestore --- 
app.get('/users/:userId/status', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[API v2] GET /users/${userId}/status`);
    
    try {
        const docSnap = await firestoreDb.collection('users').doc(userId).get();
        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        const data = docSnap.data();
        const statusResponse = {
            success: data.status !== 'error',
            clientReady: data.status === 'connected',
            qrCodeUrl: data.last_qr_code || null, // Asegurar que sea null si no existe
            status: data.status,
            errorMessage: data.last_error || null // Asegurar que sea null si no existe
        };
        res.json(statusResponse);
    } catch (err) {
        console.error("[API v2][Firestore Error] Error obteniendo estado de usuario:", err);
        return res.status(500).json({ success: false, message: 'Error interno al obtener estado.' });
    }
});
// --- Fin Reemplazo Firestore ---
/* app.get('/users/:userId/status', (req, res) => {
    // ... (código sqlite eliminado)
}); */

// Obtener el agente activo para un usuario específico
// --- Reemplazo Firestore --- 
app.get('/users/:userId/active-agent', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[API v2] GET /users/${userId}/active-agent`);

    try {
        const docSnap = await firestoreDb.collection('users').doc(userId).get();
         if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }
        res.json({ success: true, activeAgentId: docSnap.data().active_agent_id || null });
    } catch (err) {
         console.error("[API v2][Firestore Error] Error obteniendo agente activo:", err);
         return res.status(500).json({ success: false, message: 'Error interno.' });
    }
});
// --- Fin Reemplazo Firestore ---
/* app.get('/users/:userId/active-agent', (req, res) => {
    // ... (código sqlite eliminado)
}); */

// --- Rutas de Operaciones de WhatsApp por Usuario (vía IPC) ---

// Enviar mensaje desde un usuario
// --- Reemplazo Firestore (solo verificación de estado) --- 
app.post('/users/:userId/send-message', async (req, res) => {
    const userId = req.params.userId;
    const { number, message } = req.body;
    console.log(`[API v2] POST /users/${userId}/send-message`);

    if (!number || !message || !number.trim() || !message.trim()) {
        return res.status(400).json({ success: false, message: 'Número y mensaje son requeridos.' });
    }

    // Verificar si el worker está activo y conectado
    if (!workers[userId] || !workers[userId].connected) {
        console.warn(`[API v2] Intento de enviar mensaje para ${userId} pero worker no está activo/conectado.`);
         try {
             const docSnap = await firestoreDb.collection('users').doc(userId).get();
             const currentStatus = docSnap.exists ? docSnap.data().status : 'unknown';
             return res.status(400).json({ success: false, message: `Worker para usuario ${userId} no está activo (estado: ${currentStatus}). Conéctese primero.` });
         } catch (err) {
             console.error("[API v2][Firestore Error] Error verificando estado antes de enviar mensaje:", err);
              return res.status(500).json({ success: false, message: 'Error interno verificando estado.' });
         }
    }

    // Enviar comando al worker vía IPC (sin cambios)
    try {
        workers[userId].send({ 
            type: 'COMMAND', 
            command: 'SEND_MESSAGE', 
            payload: { number: number.trim(), message: message.trim() } 
        });
        res.status(202).json({ success: true, message: 'Comando de envío de mensaje enviado al worker.' }); 
    } catch (ipcError) {
        console.error(`[API v2] Error enviando comando SEND_MESSAGE a worker ${userId}:`, ipcError);
        res.status(500).json({ success: false, message: 'Error interno al comunicarse con el worker.' });
    }
});
// --- Fin Reemplazo Firestore ---
/* app.post('/users/:userId/send-message', (req, res) => {
    // ... (código sqlite eliminado)
}); */

// --- Rutas para Configuración Específica del Usuario (Continuación) ---
// --- INICIO REFACTORIZACIÓN Firestore para Reglas, Starters, Flujos --- 

// === Rutas para Reglas Simples (Firestore) ===

// GET /users/:userId/rules - Listar todas las reglas simples
app.get('/users/:userId/rules', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[API v2] GET /users/${userId}/rules`);
    try {
        const rulesSnapshot = await firestoreDb.collection('users').doc(userId).collection('rules').get();
        const rules = [];
        rulesSnapshot.forEach(doc => {
            rules.push(doc.data());
        });
        res.json({ success: true, data: rules });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error listando reglas para ${userId}:`, err);
         if (err.code === 5 || (err.message && err.message.includes("NOT_FOUND"))) { // 5 = gRPC NOT_FOUND
             console.warn(`[API v2] Usuario ${userId} no encontrado o sin colección de reglas.`);
             return res.json({ success: true, data: [] });
        }
        res.status(500).json({ success: false, message: 'Error interno al listar reglas.' });
    }
});

// POST /users/:userId/add-rule - Añadir una nueva regla simple
app.post('/users/:userId/add-rule', async (req, res) => {
    const userId = req.params.userId;
    const { trigger, response } = req.body;
    console.log(`[API v2] POST /users/${userId}/add-rule`);

    if (!trigger || !response || !trigger.trim() || !response.trim()) {
        return res.status(400).json({ success: false, message: 'Trigger y response son requeridos.' });
    }
    const trimmedTrigger = trigger.trim().toLowerCase(); 
    const trimmedResponse = response.trim();
    const rulesCollectionRef = firestoreDb.collection('users').doc(userId).collection('rules');

    try {
         // Verificar si el usuario existe
         const userDoc = await firestoreDb.collection('users').doc(userId).get();
         if (!userDoc.exists) {
             return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
         }

        // Verificar duplicados por trigger
        const duplicateQuery = await rulesCollectionRef.where('trigger', '==', trimmedTrigger).limit(1).get();
        if (!duplicateQuery.empty) {
            return res.status(409).json({ success: false, message: 'Ya existe una regla con este trigger.' });
        }

        const ruleId = uuidv4();
        const newRule = { 
            id: ruleId,
            trigger: trimmedTrigger, 
            response: trimmedResponse 
        };

        await rulesCollectionRef.doc(ruleId).set(newRule);
        // <<< UPDATED: Notificar al worker para que recargue las reglas (CON PAYLOAD) >>>
        const updatedRulesSnapshot = await rulesCollectionRef.get();
        const updatedRulesData = updatedRulesSnapshot.docs.map(doc => doc.data());
        notifyWorker(userId, { type: 'COMMAND', command: 'RELOAD_RULES', payload: { rules: updatedRulesData } }); 
        res.status(201).json({ success: true, message: 'Regla añadida.', data: newRule });

    } catch (err) {
        console.error(`[API v2][Firestore Error] Error añadiendo regla para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al guardar la regla.' });
    }
});

// DELETE /users/:userId/rules/:ruleId - Eliminar una regla simple por su ID
app.delete('/users/:userId/rules/:ruleId', async (req, res) => {
    const { userId, ruleId } = req.params;
    console.log(`[API v2] DELETE /users/${userId}/rules/${ruleId}`);
    const ruleDocRef = firestoreDb.collection('users').doc(userId).collection('rules').doc(ruleId);

    try {
        const docSnap = await ruleDocRef.get();
        if (!docSnap.exists) {
             return res.status(404).json({ success: false, message: 'Regla no encontrada.' });
        }

        await ruleDocRef.delete();
        // <<< UPDATED: Notificar al worker para que recargue las reglas (CON PAYLOAD) >>>
        const remainingRulesSnapshot = await firestoreDb.collection('users').doc(userId).collection('rules').get(); // Re-fetch remaining
        const remainingRulesData = remainingRulesSnapshot.docs.map(doc => doc.data());
        notifyWorker(userId, { type: 'COMMAND', command: 'RELOAD_RULES', payload: { rules: remainingRulesData } }); 
        res.json({ success: true, message: 'Regla eliminada.' });
    } catch (err) {
         console.error(`[API v2][Firestore Error] Error eliminando regla ${ruleId} para ${userId}:`, err);
         res.status(500).json({ success: false, message: 'Error interno al eliminar la regla.' });
    }
});


// === Rutas para Gemini Starters (Firestore) ===

// GET /users/:userId/gemini-starters - Listar todos los starters
app.get('/users/:userId/gemini-starters', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[API v2] GET /users/${userId}/gemini-starters`);
    try {
        const startersSnapshot = await firestoreDb.collection('users').doc(userId).collection('gemini_starters').get();
        const starters = [];
        startersSnapshot.forEach(doc => {
            starters.push(doc.data());
        });
        res.json({ success: true, data: starters });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error listando starters para ${userId}:`, err);
         if (err.code === 5 || (err.message && err.message.includes("NOT_FOUND"))) { // 5 = gRPC NOT_FOUND
             console.warn(`[API v2] Usuario ${userId} no encontrado o sin colección de gemini_starters.`);
             return res.json({ success: true, data: [] });
        }
        res.status(500).json({ success: false, message: 'Error interno al listar disparadores.' });
    }
});

// POST /users/:userId/add-gemini-starter - Añadir un nuevo starter
app.post('/users/:userId/add-gemini-starter', async (req, res) => {
    const userId = req.params.userId;
    const { trigger, prompt } = req.body;
    console.log(`[API v2] POST /users/${userId}/add-gemini-starter`);

    if (!trigger || !prompt || !trigger.trim() || !prompt.trim()) {
        return res.status(400).json({ success: false, message: 'Trigger y prompt son requeridos.' });
    }
    const trimmedTrigger = trigger.trim().toLowerCase(); 
    const trimmedPrompt = prompt.trim();
    const startersCollectionRef = firestoreDb.collection('users').doc(userId).collection('gemini_starters');

    try {
         const userDoc = await firestoreDb.collection('users').doc(userId).get();
         if (!userDoc.exists) {
             return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
         }

        // Verificar duplicados por trigger
        const duplicateQuery = await startersCollectionRef.where('trigger', '==', trimmedTrigger).limit(1).get();
        if (!duplicateQuery.empty) {
            return res.status(409).json({ success: false, message: 'Ya existe un disparador con este trigger.' });
        }

        const starterId = uuidv4();
        const newStarter = { 
            id: starterId,
            trigger: trimmedTrigger,
            prompt: trimmedPrompt 
        };

        await startersCollectionRef.doc(starterId).set(newStarter);
        // <<< UPDATED: Notificar al worker para que recargue los starters (CON PAYLOAD) >>>
        const updatedStartersSnapshot = await startersCollectionRef.get();
        const updatedStartersData = updatedStartersSnapshot.docs.map(doc => doc.data());
        notifyWorker(userId, { type: 'COMMAND', command: 'RELOAD_STARTERS', payload: { starters: updatedStartersData } }); 
        res.status(201).json({ success: true, message: 'Disparador añadido.', data: newStarter });

    } catch (err) {
        console.error(`[API v2][Firestore Error] Error añadiendo starter para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al guardar el disparador.' });
    }
});

// DELETE /users/:userId/gemini-starters/:starterId - Eliminar un starter por ID
app.delete('/users/:userId/gemini-starters/:starterId', async (req, res) => {
    const { userId, starterId } = req.params;
    console.log(`[API v2] DELETE /users/${userId}/gemini-starters/${starterId}`);
    const starterDocRef = firestoreDb.collection('users').doc(userId).collection('gemini_starters').doc(starterId);

    try {
         const docSnap = await starterDocRef.get();
        if (!docSnap.exists) {
             return res.status(404).json({ success: false, message: 'Disparador no encontrado.' });
        }

        await starterDocRef.delete();
         // <<< UPDATED: Notificar al worker para que recargue los starters (CON PAYLOAD) >>>
         const remainingStartersSnapshot = await firestoreDb.collection('users').doc(userId).collection('gemini_starters').get(); // Re-fetch remaining
         const remainingStartersData = remainingStartersSnapshot.docs.map(doc => doc.data());
         notifyWorker(userId, { type: 'COMMAND', command: 'RELOAD_STARTERS', payload: { starters: remainingStartersData } }); 
         res.json({ success: true, message: 'Disparador eliminado.' });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error eliminando starter ${starterId} para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al eliminar el disparador.' });
    }
});


// === Rutas para Flujos de Acción (Firestore) ===

// GET /action-flows - Listar todos los flujos
app.get('/action-flows', async (req, res) => {
    console.log(`[API v2] GET /action-flows`);
    try {
        const flowsSnapshot = await firestoreDb.collection('action_flows').orderBy('createdAt', 'desc').get();
        const flows = [];
        flowsSnapshot.forEach(doc => {
            // Convertir Timestamps si es necesario para el cliente
             let data = doc.data();
             if (data.createdAt?.toDate) data.createdAt = data.createdAt.toDate().toISOString();
             if (data.updatedAt?.toDate) data.updatedAt = data.updatedAt.toDate().toISOString();
            flows.push(data);
        });
        res.json({ success: true, data: flows });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error listando flujos de acción:`, err);
        res.status(500).json({ success: false, message: 'Error interno al listar flujos.' });
    }
});

// POST /action-flows - Crear un nuevo flujo
app.post('/action-flows', async (req, res) => {
    console.log(`[API v2] POST /action-flows`);
    const flowData = req.body;

    if (!flowData || typeof flowData !== 'object' || !flowData.name || !flowData.trigger || !Array.isArray(flowData.steps)) {
        return res.status(400).json({ success: false, message: 'Datos del flujo inválidos. Se requiere name, trigger y steps (array).' });
    }

    const flowId = uuidv4();
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const newFlow = {
        ...flowData,
        id: flowId,
        createdAt: timestamp,
        updatedAt: timestamp
    };

    try {
        await firestoreDb.collection('action_flows').doc(flowId).set(newFlow);
        console.log(`[API v2] Flujo de acción creado en Firestore: ${flowId} - ${newFlow.name}`);

        // Notificar a TODOS los workers activos
        console.log(`[API v2] Recargando y notificando flujos a todos los workers...`);
        const allFlowsSnapshot = await firestoreDb.collection('action_flows').get();
        const allFlowsData = allFlowsSnapshot.docs.map(doc => doc.data());
        // Optimization Note: Sending all flows to all workers on any change might be inefficient 
        // at scale. Consider sending only changed/new flows if performance becomes an issue.
        Object.keys(workers).forEach(workerUserId => {
             // <<< UPDATED: Notificar a todos los workers (CON PAYLOAD) >>>
             notifyWorker(workerUserId, { type: 'COMMAND', command: 'RELOAD_FLOWS', payload: { flows: allFlowsData } });
        });

        // Devolver el flujo con timestamps resueltos (aproximados ya que set no los devuelve)
        const createdFlow = { ...newFlow, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        res.status(201).json({ success: true, message: 'Flujo de acción creado.', data: createdFlow });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error creando flujo de acción:`, err);
        res.status(500).json({ success: false, message: 'Error interno al guardar el flujo.' });
    }
});

// GET /action-flows/:flowId - Obtener un flujo específico
app.get('/action-flows/:flowId', async (req, res) => {
    const flowId = req.params.flowId;
    console.log(`[API v2] GET /action-flows/${flowId}`);
    try {
        const flowDoc = await firestoreDb.collection('action_flows').doc(flowId).get();
        if (!flowDoc.exists) {
            return res.status(404).json({ success: false, message: 'Flujo de acción no encontrado.' });
        }
        // Convertir Timestamps si es necesario para el cliente
        let data = flowDoc.data();
        if (data.createdAt?.toDate) data.createdAt = data.createdAt.toDate().toISOString();
        if (data.updatedAt?.toDate) data.updatedAt = data.updatedAt.toDate().toISOString();
        res.json({ success: true, data: data });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error obteniendo flujo ${flowId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al obtener el flujo.' });
    }
});

// PUT /action-flows/:flowId - Actualizar un flujo existente
app.put('/action-flows/:flowId', async (req, res) => {
    const flowId = req.params.flowId;
    const updatedFlowData = req.body;
    console.log(`[API v2] PUT /action-flows/${flowId}`);

    if (!updatedFlowData || typeof updatedFlowData !== 'object' || !updatedFlowData.name || !updatedFlowData.trigger || !Array.isArray(updatedFlowData.steps)) {
        return res.status(400).json({ success: false, message: 'Datos del flujo inválidos. Se requiere name, trigger y steps (array).' });
    }

    const flowDocRef = firestoreDb.collection('action_flows').doc(flowId);

    try {
        // Opcional: Verificar si existe
        // const docSnap = await flowDocRef.get(); // get() cuesta una lectura
        // if (!docSnap.exists) {
        //      return res.status(404).json({ success: false, message: 'Flujo de acción no encontrado para actualizar.' });
        // }

        const dataToUpdate = {
            ...updatedFlowData,
            id: flowId, // Asegurar ID
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        delete dataToUpdate.createdAt; // No sobreescribir createdAt

        await flowDocRef.update(dataToUpdate);
        console.log(`[API v2] Flujo de acción actualizado en Firestore: ${flowId} - ${dataToUpdate.name}`);

        // Notificar a TODOS los workers activos
         console.log(`[API v2] Recargando y notificando flujos a todos los workers...`);
         const allFlowsSnapshotUpdate = await firestoreDb.collection('action_flows').get();
         const allFlowsDataUpdate = allFlowsSnapshotUpdate.docs.map(doc => doc.data());
         // Optimization Note: Sending all flows to all workers on any change might be inefficient 
         // at scale. Consider sending only changed/new flows if performance becomes an issue.
         Object.keys(workers).forEach(workerUserId => {
             // <<< UPDATED: Notificar a todos los workers (CON PAYLOAD) >>>
             notifyWorker(workerUserId, { type: 'COMMAND', command: 'RELOAD_FLOWS', payload: { flows: allFlowsDataUpdate } });
         });

        // Para devolver el objeto completo, necesitamos leerlo de nuevo o mergear localmente
        // Merge local es más rápido pero no incluye el updatedAt real
        // Leer de nuevo es más preciso pero más lento (otra lectura)
        // Por ahora, merge local aproximado:
        const approxUpdatedData = { ...updatedFlowData, id: flowId, updatedAt: new Date().toISOString() }; 
        res.json({ success: true, message: 'Flujo de acción actualizado.', data: approxUpdatedData });

    } catch (err) {
         console.error(`[API v2][Firestore Error] Error actualizando flujo ${flowId}:`, err);
         // Manejar error si el documento no existía (err.code === 5)
          if (err.code === 5) {
            return res.status(404).json({ success: false, message: 'Flujo de acción no encontrado para actualizar.' });
        }
        res.status(500).json({ success: false, message: 'Error interno al guardar el flujo actualizado.' });
    }
});

// DELETE /action-flows/:flowId - Eliminar un flujo
app.delete('/action-flows/:flowId', async (req, res) => {
    const flowId = req.params.flowId;
    console.log(`[API v2] DELETE /action-flows/${flowId}`);
    const flowDocRef = firestoreDb.collection('action_flows').doc(flowId);

    try {
        // Opcional: Verificar si existe antes de borrar
         const docSnap = await flowDocRef.get();
         if (!docSnap.exists) {
             return res.status(404).json({ success: false, message: 'Flujo de acción no encontrado para eliminar.' });
         }

        await flowDocRef.delete();
        console.log(`[API v2] Flujo de acción eliminado de Firestore: ${flowId}`);

         // Notificar a TODOS los workers activos
         console.log(`[API v2] Recargando y notificando flujos a todos los workers...`);
         const allFlowsSnapshotDelete = await firestoreDb.collection('action_flows').get();
         const allFlowsDataDelete = allFlowsSnapshotDelete.docs.map(doc => doc.data());
         // Optimization Note: Sending all flows to all workers on any change might be inefficient 
         // at scale. Consider sending only changed/new flows if performance becomes an issue.
         Object.keys(workers).forEach(workerUserId => {
             // <<< UPDATED: Notificar a todos los workers (CON PAYLOAD) >>>
             notifyWorker(workerUserId, { type: 'COMMAND', command: 'RELOAD_FLOWS', payload: { flows: allFlowsDataDelete } });
         });

        res.json({ success: true, message: 'Flujo de acción eliminado.' });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error eliminando flujo ${flowId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al eliminar el flujo.' });
    }
});

// --- FIN REFACTORIZACIÓN Firestore para Reglas, Starters, Flujos ---

// === Rutas para Gestión de Agentes (Firestore) ===

// GET /users/:userId/agents - Listar todos los agentes de un usuario
app.get('/users/:userId/agents', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[API v2] GET /users/${userId}/agents`);
    try {
        const agentsSnapshot = await firestoreDb.collection('users').doc(userId).collection('agents').get();
        const agents = [];
        agentsSnapshot.forEach(doc => {
            agents.push(doc.data()); 
        });
        res.json({ success: true, data: agents });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error listando agentes para ${userId}:`, err);
        if (err.code === 5 || (err.message && err.message.includes("NOT_FOUND"))) {
            console.warn(`[API v2] Usuario ${userId} no encontrado o sin colección de agentes.`);
            return res.json({ success: true, data: [] }); // Devolver vacío si no existe user o colección
        }
        res.status(500).json({ success: false, message: 'Error interno al listar agentes.' });
    }
});

// POST /users/:userId/agents - Crear un nuevo agente para un usuario
app.post('/users/:userId/agents', async (req, res) => {
    const userId = req.params.userId;
    const agentData = req.body;
    console.log(`[API v2] POST /users/${userId}/agents`);

    // Validación básica de la estructura del agente
    if (!agentData || typeof agentData !== 'object' || !agentData.persona || !agentData.persona.name || !agentData.knowledge) {
        return res.status(400).json({ success: false, message: 'Datos del agente inválidos. Se requiere al menos persona.name y knowledge.' });
    }
    
    const agentsCollectionRef = firestoreDb.collection('users').doc(userId).collection('agents');
    
    try {
        // Verificar si el usuario existe
        const userDoc = await firestoreDb.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        const agentId = uuidv4();
        const newAgent = {
            id: agentId, // Asegurar que el ID esté en el documento
            ...agentData,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await agentsCollectionRef.doc(agentId).set(newAgent);
        console.log(`[API v2] Agente creado para ${userId}: ${agentId} - ${newAgent.persona.name}`);

        // Notificar al worker activo si coincide el userId (podría no estar activo)
        notifyWorker(userId, { type: 'COMMAND', command: 'RELOAD_AGENT_CONFIG' });

        res.status(201).json({ success: true, message: 'Agente creado.', data: { ...newAgent, id: agentId } }); // Devolver con ID

    } catch (err) {
        console.error(`[API v2][Firestore Error] Error creando agente para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al guardar el agente.' });
    }
});

// GET /users/:userId/agents/:agentId - Obtener un agente específico
app.get('/users/:userId/agents/:agentId', async (req, res) => {
    const { userId, agentId } = req.params;
    console.log(`[API v2] GET /users/${userId}/agents/${agentId}`);
    try {
        const agentDocRef = firestoreDb.collection('users').doc(userId).collection('agents').doc(agentId);
        const docSnap = await agentDocRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'Agente no encontrado.' });
        }
        res.json({ success: true, data: docSnap.data() });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error obteniendo agente ${agentId} para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al obtener el agente.' });
    }
});

// PUT /users/:userId/agents/:agentId - Actualizar un agente existente
app.put('/users/:userId/agents/:agentId', async (req, res) => {
    const { userId, agentId } = req.params;
    const updatedAgentData = req.body;
    console.log(`[API v2] PUT /users/${userId}/agents/${agentId}`);

    if (!updatedAgentData || typeof updatedAgentData !== 'object' || !updatedAgentData.persona || !updatedAgentData.persona.name || !updatedAgentData.knowledge) {
        return res.status(400).json({ success: false, message: 'Datos del agente inválidos para actualizar.' });
    }
    
    const agentDocRef = firestoreDb.collection('users').doc(userId).collection('agents').doc(agentId);

    try {
        // Usar update para no fallar si el documento no existe, pero verificar luego o manejar el error.
        // Opcionalmente, hacer un get() primero para asegurar que existe y devolver 404.
        // Por simplicidad, intentamos update directamente.

        const dataToUpdate = {
            ...updatedAgentData,
            id: agentId, // Reasegurar ID
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        delete dataToUpdate.createdAt; // No sobreescribir createdAt

        await agentDocRef.update(dataToUpdate); // update fallará si el doc no existe
        console.log(`[API v2] Agente actualizado para ${userId}: ${agentId} - ${dataToUpdate.persona.name}`);
        
        // Notificar al worker si este agente era el activo
        const userDoc = await firestoreDb.collection('users').doc(userId).get();
        if (userDoc.exists && userDoc.data().active_agent_id === agentId) {
             console.log(` -> Notificando worker ${userId} por cambio en agente activo.`);
             // <<< UPDATED: Enviar config actualizada en payload >>>
             const updatedAgentConfigData = (await agentDocRef.get()).data(); // Re-fetch latest data
             notifyWorker(userId, { 
                type: 'COMMAND', 
                command: 'RELOAD_AGENT_CONFIG', 
                payload: { agentConfig: updatedAgentConfigData } 
             }); 
        } else {
             console.log(` -> Agente actualizado no era el activo para ${userId}, no se notifica cambio inmediato.`);
        }

        res.json({ success: true, message: 'Agente actualizado.', data: { ...dataToUpdate, id: agentId } });

    } catch (err) {
        console.error(`[API v2][Firestore Error] Error actualizando agente ${agentId} para ${userId}:`, err);
        if (err.code === 5) { // Firestore NOT_FOUND
            return res.status(404).json({ success: false, message: 'Agente no encontrado para actualizar.' });
        }
        res.status(500).json({ success: false, message: 'Error interno al guardar el agente actualizado.' });
    }
});

// DELETE /users/:userId/agents/:agentId - Eliminar un agente
app.delete('/users/:userId/agents/:agentId', async (req, res) => {
    const { userId, agentId } = req.params;
    console.log(`[API v2] DELETE /users/${userId}/agents/${agentId}`);
    const agentDocRef = firestoreDb.collection('users').doc(userId).collection('agents').doc(agentId);
    const userDocRef = firestoreDb.collection('users').doc(userId);

    try {
        // Verificar si existe antes de borrar
        const docSnap = await agentDocRef.get();
        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'Agente no encontrado para eliminar.' });
        }
        
        // Verificar si es el agente activo y desasignarlo si lo es
        const userDocSnap = await userDocRef.get();
        let activeAgentWasDeleted = false;
        if (userDocSnap.exists && userDocSnap.data().active_agent_id === agentId) {
             console.log(` -> Desasignando agente activo ${agentId} de usuario ${userId} antes de eliminar.`);
             await userDocRef.update({ active_agent_id: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
             activeAgentWasDeleted = true;
        }

        await agentDocRef.delete();
        console.log(`[API v2] Agente eliminado de Firestore: ${agentId} para usuario ${userId}`);
        
        // Notificar al worker si se eliminó el agente activo
        if (activeAgentWasDeleted) {
             console.log(` -> Notificando worker ${userId} que su agente activo fue eliminado.`);
              // Enviar comando para que cambie a default
             notifyWorker(userId, { type: 'SWITCH_AGENT', payload: { agentId: null } }); 
        } else {
             // Notificar por si acaso necesita recargar lista? Depende de la lógica del worker
             // notifyWorker(userId, { type: 'COMMAND', command: 'RELOAD_AGENT_CONFIG' }); 
        }

        res.json({ success: true, message: 'Agente eliminado.' });
    } catch (err) {
        console.error(`[API v2][Firestore Error] Error eliminando agente ${agentId} para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al eliminar el agente.' });
    }
});

// PUT /users/:userId/active-agent - Establecer el agente activo para un usuario
app.put('/users/:userId/active-agent', async (req, res) => {
    const userId = req.params.userId;
    const { agentId } = req.body; // Espera { "agentId": "some-agent-id" } o { "agentId": null }
    console.log(`[API v2] PUT /users/${userId}/active-agent - Estableciendo a: ${agentId}`);

    const userDocRef = firestoreDb.collection('users').doc(userId);

    try {
        const userDocSnap = await userDocRef.get();
        if (!userDocSnap.exists) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        // Verificar si el agentId proporcionado existe (si no es null)
        if (agentId) {
            const agentDocRef = userDocRef.collection('agents').doc(agentId);
            const agentDocSnap = await agentDocRef.get();
            if (!agentDocSnap.exists) {
                return res.status(404).json({ success: false, message: `Agente con ID ${agentId} no encontrado para este usuario.` });
            }
        }

        // Actualizar el usuario
        await userDocRef.update({
            active_agent_id: agentId, // Establece null si agentId es null/undefined
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`[API v2] Agente activo para ${userId} actualizado a ${agentId || 'ninguno'}.`);

        // Notificar al worker activo para que cambie su configuración
        let agentConfigPayload = null;
        if (agentId) {
            const agentDocRef = userDocRef.collection('agents').doc(agentId);
            const agentDocSnap = await agentDocRef.get();
            if (agentDocSnap.exists) {
                agentConfigPayload = agentDocSnap.data();
            }
        }
        console.log(` -> Notificando worker ${userId} para cambiar al agente ${agentId || 'default'} (config ${agentConfigPayload ? 'incluida' : 'no incluida'}).`);
        notifyWorker(userId, { 
            type: 'SWITCH_AGENT', 
            payload: { agentId: agentId, agentConfig: agentConfigPayload } // Enviar ID y la config si existe
        });

        res.json({ success: true, message: `Agente activo establecido a ${agentId || 'ninguno'}.`, activeAgentId: agentId || null });

    } catch (err) {
        console.error(`[API v2][Firestore Error] Error estableciendo agente activo para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al actualizar el agente activo.' });
    }
});

// === FIN Rutas para Gestión de Agentes ===


// === INICIALIZACIÓN DEL SERVIDOR Y CIERRE LIMPIO === 

try {
    console.log("==== INICIALIZANDO SERVIDOR API PRINCIPAL (v2) ====");
    
    const server = app.listen(port, () => {
        console.log(`¡API Principal (v2) escuchando en http://localhost:${port}!`);
    });
    
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`[ERROR] El puerto ${port} ya está en uso.`);
        } else {
            console.error('[ERROR] Iniciando servidor API (v2): ', error);
        }
    });
    
} catch (err) {
    console.error("[ERROR CRÍTICO] Al iniciar servidor API (v2):", err);
}

// Manejo de cierre limpio (sin DB)
process.on('SIGINT', () => {
  console.log('\n[Master] Recibido SIGINT. Cerrando API Principal (v2)...');
  
  // Intentar detener todos los workers activos
  const activeWorkerPIDs = Object.values(workers).map(w => w?.pid).filter(Boolean); 
  console.log(`[Master] Intentando detener ${Object.keys(workers).length} workers activos...`);
  Object.keys(workers).forEach(userId => stopWorker(userId)); // stopWorker ahora es async, pero aquí no esperamos
  
  // Dar un tiempo para que los workers intenten cerrarse
  setTimeout(() => {
      console.log('[Master] Verificando workers restantes...');
      Object.values(workers).forEach(worker => {
          if (worker && !worker.killed) { 
              console.warn(`[Master] Forzando terminación del worker PID: ${worker.pid}`);
              worker.kill('SIGTERM');
          }
      });
        
      console.log('[Master] Saliendo.');
      process.exit(0); 
  }, 3000); // Esperar 3 segundos
});