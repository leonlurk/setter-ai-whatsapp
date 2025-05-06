require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const admin = require('firebase-admin'); // <<< Importar Firebase Admin
const { fork } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws'); // <<< ADDED: Import WebSocket library

// === CONFIGURACIÓN INICIAL ===
const app = express();
const port = process.env.PORT || 3457;
const server = require('http').createServer(app); // <<< CHANGED: Use http server to attach WebSocket server
const wss = new WebSocket.Server({ server }); // <<< ADDED: Create WebSocket server instance

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
const wsClients = new Map(); // <<< ADDED: Map to store WebSocket clients { userId: WebSocket }
const connectingUsers = new Set(); // <<< ADDED: Set to track users currently being connected

// --- WebSocket Server Logic ---
wss.on('connection', (ws, req) => {
    console.log(`[Server][WebSocket][DEBUG] Incoming connection request. URL: ${req.url}`); // Log raw URL

    // Extract userId from the connection request if possible (e.g., using query params or headers)
    // For simplicity, let's assume userId is passed via query param like ws://localhost:3457?userId=someUser
    let userId = null;
    try {
        const urlParts = req.url.split('?');
        if (urlParts.length > 1) {
            const queryParams = new URLSearchParams(urlParts[1]);
            userId = queryParams.get('userId');
            console.log(`[Server][WebSocket][DEBUG] Extracted userId: ${userId} from query params.`);
        } else {
            console.log(`[Server][WebSocket][DEBUG] No query parameters found in URL: ${req.url}`);
        }
    } catch (e) {
        console.error(`[Server][WebSocket][ERROR] Failed to parse URL or extract userId from ${req.url}:`, e);
    }

    if (!userId) {
        console.log('[Server][WebSocket] Connection attempt without valid userId. Closing.');
        ws.close(1008, "User ID missing or invalid"); // Send a specific close code
        return;
    }

    // Log before attempting to add
    console.log(`[Server][WebSocket][DEBUG] Attempting to register client for userId: ${userId}`);
    console.log(`[Server][WebSocket] Client connected for user: ${userId}`);
    // Check if a client already exists for this user
    if (wsClients.has(userId)) {
        console.warn(`[Server][WebSocket][WARN] Overwriting existing WebSocket connection for user: ${userId}. Possible stale connection.`);
        // Optionally close the old connection
        // wsClients.get(userId)?.close(1001, "New connection established");
    }
    wsClients.set(userId, ws);
    console.log(`[Server][WebSocket][DEBUG] Client registered in wsClients map for userId: ${userId}. Map size: ${wsClients.size}`);

    ws.on('message', (message) => {
        // Handle messages from client if needed (e.g., ping/pong, specific commands)
        console.log(`[Server][WebSocket] Received message from ${userId}: ${message}`);
        // Simple echo for testing
        // ws.send(`Server received: ${message}`);
        // Handle PING message from client
        try {
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.type === 'PING') {
                if (DEBUG) console.log(`[Server][WebSocket] Received PING from ${userId}. Sending PONG.`);
                ws.send(JSON.stringify({ type: 'PONG' }));
            }
        } catch (e) {
            // Ignore non-JSON messages or messages without type='PING'
        }
    });

    ws.on('close', (code, reason) => {
        const reasonString = reason instanceof Buffer ? reason.toString() : reason;
        console.log(`[Server][WebSocket] Client disconnected for user: ${userId}. Code: ${code}, Reason: ${reasonString}`);
        // Ensure the correct client is deleted if overwritten
        if (wsClients.get(userId) === ws) {
            wsClients.delete(userId);
            console.log(`[Server][WebSocket][DEBUG] Client removed from wsClients map for userId: ${userId}. Map size: ${wsClients.size}`);
        } else {
            console.warn(`[Server][WebSocket][WARN] Close event for user ${userId}, but the stored client was different. Not deleting from map.`);
        }
    });

    ws.on('error', (error) => {
        console.error(`[Server][WebSocket] Error for user ${userId}:`, error);
        // Ensure the correct client is deleted if overwritten
        if (wsClients.get(userId) === ws) {
            wsClients.delete(userId); // Clean up on error
            console.log(`[Server][WebSocket][DEBUG] Client removed from wsClients map due to error for userId: ${userId}. Map size: ${wsClients.size}`);
        } else {
            console.warn(`[Server][WebSocket][WARN] Error event for user ${userId}, but the stored client was different. Not deleting from map.`);
        }
    });

    // Send a welcome message or initial status
    ws.send(JSON.stringify({ type: 'status', message: 'Connected to server' }));
});

console.log('[Server] WebSocket server attached to HTTP server.');
// --- End WebSocket Server Logic ---

// --- Middleware para loggear todas las peticiones ---
app.use((req, res, next) => {
    console.log(`[API v2] ${req.method} ${req.url} - ${new Date().toLocaleTimeString()}`);
    next();
});

// Helper para notificar a un worker específico via IPC
function notifyWorker(userId, message) {
    console.log(`[Server] notifyWorker a ${userId}. Mensaje tipo: ${message?.type || 'DESCONOCIDO'}`);

    // Buscar worker en workerProcesses
    const workerProcess = workers[userId];
    if (!workerProcess) {
        console.error(`[Server][ERROR] No se puede enviar mensaje a worker ${userId}: no existe en workerProcesses`);
        return false;
    }

    try {
        console.log(`[Server] ENVIANDO mensaje a worker ${userId}:`, JSON.stringify(message));
        const result = workerProcess.send(message);
        console.log(`[Server] Resultado de workerProcess.send para ${userId}: ${result}`);
        return result;
    } catch (error) {
        console.error(`[Server][ERROR CRÍTICO] Error enviando mensaje a worker ${userId}:`, error);
        return false;
    }
}

// --- Reemplazo Firestore y Async ---
async function startWorker(userId) {
    console.log(`[Server][CRITICAL] INICIANDO worker para usuario ${userId}...`);

    // <<< ADDED: Check and set connection lock >>>
    if (connectingUsers.has(userId)) {
        console.warn(`[Server][CRITICAL] Intento de inicio concurrente para ${userId} bloqueado (ya está en proceso).`);
        // Return a specific value or throw an error to indicate concurrent attempt
        // For now, returning null mimics a failure to start, preventing multiple starts.
        return null; // Indicate connection is already in progress
    }
    connectingUsers.add(userId);
    console.log(`[Server][DEBUG] Locking connection attempt for ${userId}. connectingUsers:`, connectingUsers);
    // <<< END ADDED >>>

    try {
        // Verificar si ya existe un worker *activo* para este usuario
        if (workers[userId] && workers[userId].connected) { // <<< Check .connected explicitly >>>
            console.warn(`[Server][CRITICAL] Ya existe un worker CONECTADO para ${userId}. No se iniciará uno nuevo.`);
            // <<< MODIFIED: Release lock and return existing worker >>>
            connectingUsers.delete(userId);
            console.log(`[Server][DEBUG] Releasing lock (worker already exists) for ${userId}. connectingUsers:`, connectingUsers);
            return workers[userId]; // Return the existing *connected* worker
        }

        // Limpiar worker zombie si existe (no conectado)
        if (workers[userId] && !workers[userId].connected) {
            console.warn(`[Server][CRITICAL] Worker para ${userId} existe pero no está conectado. Intentando limpiar y reiniciar.`);
            try { workers[userId].kill(); } catch (e) { console.error("Error matando worker zombie:", e); }
            delete workers[userId];
        }

        // Crear directorio de datos para sesión de WhatsApp (aún necesario para LocalAuth)
        const userDataDir = path.join(__dirname, 'data_v2', userId); // Mantener data_v2 para sesiones wwebjs
        const sessionPath = path.join(userDataDir, '.wwebjs_auth');
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
            console.log(`[Server] Creado directorio para sesión WhatsApp: ${sessionPath}`);
        }

        console.log(`[Server] Iniciando worker para usuario: ${userId}`);
        const workerScript = path.join(__dirname, 'worker.js');

        if (!fs.existsSync(workerScript)) {
            console.error(`[Server][CRITICAL] No se encuentra el script del worker: ${workerScript}. No se puede iniciar el worker para ${userId}.`);
            try {
                await firestoreDb.collection('users').doc(userId).update({
                    status: 'error',
                    last_error: 'Worker script not found',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (dbErr) {
                console.error("[Server][Firestore Error] Error actualizando estado a error (worker script missing):", dbErr);
            }
            return null;
        }

        // Obtener agente activo desde Firestore
        const userDocSnap = await firestoreDb.collection('users').doc(userId).get();
        let activeAgentId = null;
        if (userDocSnap.exists) {
            activeAgentId = userDocSnap.data()?.active_agent_id || null;
        } else {
            console.warn(`[Server] Documento de usuario ${userId} no encontrado en Firestore al iniciar worker.`);
            // Considerar si crear el documento aquí o dejar que falle?
            // Por ahora, continuaremos, el worker usará default.
        }
        console.log(`[Server] Agente activo inicial para ${userId}: ${activeAgentId || 'Ninguno (usará default)'}`);

        // Lanzar el proceso hijo
        const workerArgs = [userId];
        if (activeAgentId) {
            workerArgs.push(activeAgentId);
        }
        const worker = fork(workerScript, workerArgs, { stdio: 'inherit' });
        workers[userId] = worker;
        console.log(`[Server][DEBUG] Worker PID ${worker.pid} added to workers map for ${userId}.`); // Log adding to map

        // <<< MODIFIED: Actualizar Firestore - Documento principal y subcolección de estado >>>
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const userDocRef = firestoreDb.collection('users').doc(userId);
        const statusDocRef = userDocRef.collection('status').doc('whatsapp');

        // Actualizar documento principal del usuario
        await userDocRef.update({
            worker_pid: worker.pid,
            last_error: null, // Limpiar errores previos al iniciar
            updatedAt: timestamp // Actualizar timestamp principal también
        });

        // Establecer estado inicial en la subcolección
        await statusDocRef.set({
            status: 'connecting',
            last_error: null,
            last_qr_code: null,
            updatedAt: timestamp
        }, { merge: true });
        console.log(`[Server][DB Firestore] Usuario ${userId} worker_pid -> ${worker.pid}, status -> connecting`);
        // <<< END MODIFICATION >>>

        // ----- Manejadores de eventos para el worker -----
        worker.on('message', (message) => {
            // handleWorkerMessage ya es async y usa Firestore
            handleWorkerMessage(userId, message);
        });

        worker.on('exit', async (code, signal) => {
            console.log(`[Server] Worker para ${userId} (PID: ${worker.pid || 'N/A'}) terminó inesperadamente con código ${code}, señal ${signal}`);
            const workerExisted = !!workers[userId];
            delete workers[userId];
            try {
                const userDocRef = firestoreDb.collection('users').doc(userId);
                const statusDocRef = userDocRef.collection('status').doc('whatsapp');
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // <<< MODIFIED: Actualizar Firestore - Documento principal (PID) y subcolección (estado error) >>>
                // Limpiar PID en el documento principal
                await userDocRef.update({ worker_pid: null, updatedAt: timestamp });

                // Solo actualizar estado a 'error' si el worker existía y el estado actual NO era 'disconnected'
                // (evita sobrescribir una desconexión manual con un error de salida tardío)
                const statusDocSnap = await statusDocRef.get();
                if (workerExisted && (!statusDocSnap.exists || statusDocSnap.data().status !== 'disconnected')) {
                    const exitErrorMsg = `Worker exited code ${code}${signal ? ` (signal ${signal})` : ``} unexpectedly`;
                    await statusDocRef.set({
                        status: 'error',
                        last_error: exitErrorMsg,
                        updatedAt: timestamp
                    }, { merge: true });
                    console.log(`[Server][DB Firestore] Usuario ${userId} worker_pid -> null, status -> error (Worker exit)`);
                } else {
                    console.log(`[Server] No se actualiza subcolección status en exit para ${userId}, estado ya era disconnected o worker no registrado.`);
                }
                 // <<< ADDED: Release lock on exit >>>
                 connectingUsers.delete(userId);
                 console.log(`[Server][DEBUG] Releasing lock (worker exit) for ${userId}. connectingUsers:`, connectingUsers);
                // <<< END ADDED >>>
                // <<< END MODIFICATION >>>
            } catch (dbErr) {
                console.error("[Server][Firestore Error] Error obteniendo/actualizando status en exit:", dbErr);
            }
        });

        worker.on('error', async (error) => {
            console.error(`[Server] Error en worker ${userId} (PID: ${worker.pid || 'N/A'}):`, error);
            delete workers[userId]; // Eliminar referencia del worker localmente
             // <<< ADDED: Release lock on error >>>
             connectingUsers.delete(userId);
             console.log(`[Server][DEBUG] Releasing lock (worker error event) for ${userId}. connectingUsers:`, connectingUsers);
             // <<< END ADDED >>>
            try {
                // <<< MODIFIED: Actualizar Firestore - Documento principal (PID) y subcolección (estado error) >>>
                const userDocRef = firestoreDb.collection('users').doc(userId);
                const statusDocRef = userDocRef.collection('status').doc('whatsapp');
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Limpiar PID en el documento principal
                await userDocRef.update({ worker_pid: null, updatedAt: timestamp });

                // Establecer estado de error en la subcolección
                await statusDocRef.set({
                    status: 'error',
                    last_error: error.message || 'Unknown worker error',
                    updatedAt: timestamp
                }, { merge: true });
                console.log(`[Server][DB Firestore] Usuario ${userId} worker_pid -> null, status -> error (Worker error event)`);
                // <<< END MODIFICATION >>>
            } catch (dbErr) {
                console.error("[Server][Firestore Error] Error actualizando DB en error de worker:", dbErr);
            }
        });

        // <<< ADDED: Enviar configuración inicial al worker >>>
        fetchInitialConfigsAndNotifyWorker(userId, activeAgentId);

        // <<< ADDED: Release lock after successful start sequence (before return) >>>
        // Note: We release slightly early, assuming the critical part is avoiding the fork() race.
        // If IPC/DB updates fail later, the worker might still exit and release again.
        connectingUsers.delete(userId);
        console.log(`[Server][DEBUG] Releasing lock (after successful start sequence) for ${userId}. connectingUsers:`, connectingUsers);
        // <<< END ADDED >>>

        return worker; // Devuelve la instancia del worker
    } catch (error) {
        console.error(`[Server][CRITICAL] Error CRÍTICO iniciando worker para ${userId}:`, error);
         // <<< ADDED: Ensure lock is released on critical error >>>
         connectingUsers.delete(userId);
         console.log(`[Server][DEBUG] Releasing lock (critical start error) for ${userId}. connectingUsers:`, connectingUsers);
         // <<< END ADDED >>>

        // Asegurar que el estado en DB sea error si falló la inicialización
        try {
            // <<< MODIFIED: Actualizar Firestore - Documento principal y subcolección de estado en caso de error CRÍTICO al inicio >>>
            const userDocRefOnError = firestoreDb.collection('users').doc(userId);
            const statusDocRefOnError = userDocRefOnError.collection('status').doc('whatsapp');
            const errorTimestamp = admin.firestore.FieldValue.serverTimestamp();

            // Actualizar documento principal (quitar PID)
            await userDocRefOnError.update({
                 worker_pid: null,
                 last_error: `Error crítico al iniciar worker: ${error.message}`, // Guardar error crítico en doc principal
                 updatedAt: errorTimestamp
             });

            // Establecer estado de error en la subcolección
            await statusDocRefOnError.set({
                 status: 'error',
                 last_error: `Error crítico al iniciar worker: ${error.message}`,
                 updatedAt: errorTimestamp
             }, { merge: true });
            // <<< END MODIFICATION >>>
        } catch (dbErr) { console.error(`[Server][Firestore Error] Error secundario actualizando estado a error crítico para ${userId}:`, dbErr); }
        return null;
    }
}
// --- Fin Reemplazo Firestore y Async ---
/* function startWorker(userId) {
    // ... (código sqlite eliminado)
} */

// <<< ADDED: Función para obtener y enviar configuración inicial al worker >>>
async function fetchInitialConfigsAndNotifyWorker(userId, activeAgentId) {
    console.log(`[Server] Preparando configuración inicial para worker ${userId} (Agente: ${activeAgentId || 'default'})`);
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

        // 4. Obtener Flujos (ESPECÍFICOS DEL USUARIO)
        const flowsSnapshot = await userDocRef.collection('action_flows').get(); // <-- CAMBIO DE RUTA
        const flowsData = flowsSnapshot.docs.map(doc => doc.data());
        console.log(`   -> Flujos del usuario cargados: ${flowsData.length}`); // <-- LOG ACTUALIZADO

        // 5. Enviar configuración al worker
        const initialConfigPayload = {
            agentConfig: agentConfigData, // Puede ser null si no hay o no se encuentra
            rules: rulesData,
            starters: startersData,
            flows: flowsData // <-- AHORA SON LOS FLUJOS DEL USUARIO
            // No necesitamos enviar writingSampleTxt aquí, ya está dentro de agentConfigData si existe
        };

        notifyWorker(userId, { type: 'INITIAL_CONFIG', payload: initialConfigPayload });
        console.log(`[Server] Configuración inicial enviada a worker ${userId} via IPC.`);
    } catch (error) {
        console.error(`[Server][Firestore Error] Error crítico obteniendo configuración inicial para ${userId}:`, error);
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
    const userDocRef = firestoreDb.collection('users').doc(userId);
    const statusDocRef = userDocRef.collection('status').doc('whatsapp');
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    if (workers[userId] && workers[userId].connected) {
        console.log(`[Server] Iniciando parada para worker ${userId} (PID: ${workers[userId].pid})`);
        try {
            // <<< MODIFIED: Actualizar Firestore - Documento principal (PID) y subcolección (estado disconnected) >>>
            // Limpiar PID en el documento principal
            await userDocRef.update({ worker_pid: null, updatedAt: timestamp });

            // Establecer estado disconnected en la subcolección
            await statusDocRef.set({
                status: 'disconnected',
                last_qr_code: null,
                last_error: null,
                updatedAt: timestamp
            }, { merge: true });
            console.log(`[Server][DB Firestore] Usuario ${userId} worker_pid -> null, status -> disconnected (manual stop)`);
            // <<< END MODIFICATION >>>

            // Enviar comando IPC DESPUÉS
            if (workers[userId] && workers[userId].connected) {
                console.log(`[Server] Enviando comando SHUTDOWN a worker ${userId}`);
                workers[userId].send({ type: 'COMMAND', command: 'SHUTDOWN' });
            } else {
                console.warn(`[Server] Worker ${userId} ya no está conectado al intentar enviar SHUTDOWN.`);
                delete workers[userId]; // Limpiar referencia local si ya no está conectado
            }
            return true; // Indica que se inició el proceso de parada
        } catch (dbErr) {
            console.error("[Server][Firestore Error] Error actualizando DB antes de parar worker:", dbErr);
            // Si falla la DB, ¿deberíamos intentar parar el worker igualmente?
            // Por ahora sí, pero logueamos el error
            try {
                if (workers[userId] && workers[userId].connected) {
                    console.log(`[Server] Enviando comando SHUTDOWN a worker ${userId} (a pesar de error DB)`);
                    workers[userId].send({ type: 'COMMAND', command: 'SHUTDOWN' });
                }
            } catch (ipcErr) { console.error(`[Server] Error enviando SHUTDOWN (tras error DB) a worker ${userId}:`, ipcErr); }
            return true; // Se intentó parar
        }
    } else {
        console.log(`[Server] Worker para ${userId} no encontrado o no conectado. Asegurando estado Firestore.`);
        try {
            // <<< MODIFIED: Asegurar estado disconnected en Firestore (subcolección) si el worker no está >>>
            await userDocRef.update({ worker_pid: null, updatedAt: timestamp }); // Asegurar PID nulo en principal
            await statusDocRef.set(
                { status: 'disconnected', last_error: null, last_qr_code: null, updatedAt: timestamp },
                { merge: true }
             );
            console.log(`[Server][DB Firestore] Asegurado ${userId} worker_pid -> null, status -> disconnected (worker not found)`);
            // <<< END MODIFICATION >>>
        } catch (dbErr) {
            console.error("[Server][Firestore Error] Error asegurando desconexión en Firestore (worker no encontrado):", dbErr);
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
    console.log(`[Server][CRITICAL] handleWorkerMessage de ${userId}, tipo: ${message?.type || 'DESCONOCIDO'}, mensaje completo:`, JSON.stringify(message));

    if (!message || !message.type) {
        console.error(`[Server][ERROR] Mensaje IPC inválido recibido de worker ${userId}`);
        return;
    }

    // <<< MODIFIED: Preparar datos para la subcolección status/whatsapp >>>
    let statusUpdateData = {};
    let logMsg = '';
    let newStatus = message.status || null;
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    // <<< ADDED: Handle new message notification for WebSocket broadcast >>>
    if (message.type === 'NEW_MESSAGE_RECEIVED') {
        console.log(`[Server][IPC] Received NEW_MESSAGE_RECEIVED from worker ${userId}`);
        const clientWs = wsClients.get(userId);
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            try {
                // Directly forward the message payload received from the worker
                // <<< MODIFIED: Send object with explicit type 'newMessage' >>>
                clientWs.send(JSON.stringify({ type: 'newMessage', data: message.payload }));
                console.log(`[Server][WebSocket] Sent newMessage notification to user ${userId}`);
            } catch (wsError) {
                console.error(`[Server][WebSocket] Error sending message to user ${userId}:`, wsError);
            }
        } else {
            // Log more specific reason for not sending
            if (!clientWs) {
                console.log(`[Server][WebSocket] No active client found in wsClients map for user ${userId}. Cannot send newMessage notification.`);
            } else {
                console.log(`[Server][WebSocket] Client found for user ${userId} but not open (readyState: ${clientWs.readyState}). Cannot send newMessage notification.`);
            }
        }
        // This message type doesn't update Firestore status, so return early
        return;
    }
    // <<< END: Handle new message notification >>>

    switch (message.type) {
        case 'STATUS_UPDATE':
            newStatus = newStatus || 'error'; // Asumir error si no se especifica estado
            statusUpdateData = {
                status: newStatus,
                last_error: message.error || null,
                updatedAt: timestamp
            };
            if (newStatus === 'connected' || newStatus === 'disconnected') {
                statusUpdateData.last_qr_code = null; // Limpiar QR al conectar/desconectar
            }
            logMsg = `status -> ${newStatus}`;
            break;
        case 'QR_CODE':
            statusUpdateData = {
                status: 'generating_qr',
                last_qr_code: message.qr || null,
                updatedAt: timestamp
            };
            logMsg = `status -> generating_qr`;
            break;
        case 'ERROR_INFO':
            newStatus = 'error';
            statusUpdateData = {
                status: newStatus,
                last_error: message.error || 'Unknown worker error',
                updatedAt: timestamp
            };
            logMsg = `status -> error (ERROR_INFO)`;
            break;
        default:
            console.log(`[Server] Mensaje tipo ${message.type} no manejado para worker ${userId}.`);
            return;
    }

    try {
        // <<< MODIFIED: Escribir en la subcolección status/whatsapp usando set con merge >>>
        const statusDocRef = firestoreDb.collection('users').doc(userId).collection('status').doc('whatsapp');
        await statusDocRef.set(statusUpdateData, { merge: true });
        console.log(`[Server][DB Firestore] Usuario ${userId} ${logMsg}`);
        // <<< END MODIFICATION >>>
    } catch (err) {
        console.error(`[Server][IPC Master] Error actualizando Firestore (status/whatsapp) para worker ${userId} por mensaje ${message.type}:`, err);
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
    console.log(`[Server] POST /users - Intentando registrar usuario: ${trimmedUserId}`);

    const userDocRef = firestoreDb.collection('users').doc(trimmedUserId);

    try {
        const docSnap = await userDocRef.get();
        if (docSnap.exists) {
            console.warn(`[Server] Conflicto: Usuario ${trimmedUserId} ya existe.`);
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
            console.log(`[Server] Usuario ${trimmedUserId} registrado en Firestore.`);
            res.status(201).json({ success: true, message: 'Usuario registrado con éxito.', userId: trimmedUserId });
        }
    } catch (err) {
        console.error("[Server][Firestore Error] Error creando/verificando usuario:", err);
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
    console.log(`[Server] GET /users`);
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
        console.error("[Server][Firestore Error] Error obteniendo usuarios:", err);
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
    console.log(`[Server] POST /users/${userId}/connect`);

    try {
        const userDoc = await firestoreDb.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        const userData = userDoc.data();
        // Verificar si ya está conectado o conectando
        if (userData.status === 'connected' || userData.status === 'connecting' || userData.status === 'generating_qr') {
            if (workers[userId] && workers[userId].connected) {
                console.log(`[Server] Petición connect para ${userId} pero worker ya está activo.`);
                return res.status(200).json({ success: true, message: 'La conexión ya está activa o en proceso.', currentStatus: userData.status });
            }
            console.warn(`[Server] Inconsistencia detectada: Firestore dice ${userData.status} para ${userId} pero no hay worker activo. Intentando iniciar.`);
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
        console.error("[Server][Firestore Error] Error verificando usuario para conectar:", err);
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
    console.log(`[Server] POST /users/${userId}/disconnect`);

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
        console.error("[Server][Firestore Error] Error verificando usuario para desconectar:", err);
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
    console.log(`[Server] GET /users/${userId}/status`);

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
        console.error("[Server][Firestore Error] Error obteniendo estado de usuario:", err);
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
    console.log(`[Server] GET /users/${userId}/active-agent`);
    try {
        const docSnap = await firestoreDb.collection('users').doc(userId).get();
        if (!docSnap.exists) {
             return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }
        res.json({ success: true, activeAgentId: docSnap.data().active_agent_id || null });
    } catch (err) {
         console.error("[Server][Firestore Error] Error obteniendo agente activo:", err);
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
    console.log(`[Server] POST /users/${userId}/send-message`);

    if (!number || !message || !number.trim() || !message.trim()) {
        return res.status(400).json({ success: false, message: 'Número y mensaje son requeridos.' });
    }

    // Verificar si el worker está activo y conectado
    if (!workers[userId] || !workers[userId].connected) {
        console.warn(`[Server] Intento de enviar mensaje para ${userId} pero worker no está activo/conectado.`);
        try {
            const docSnap = await firestoreDb.collection('users').doc(userId).get();
            const currentStatus = docSnap.exists ? docSnap.data().status : 'unknown';
            return res.status(400).json({ success: false, message: `Worker para usuario ${userId} no está activo (estado: ${currentStatus}). Conéctese primero.` });
        } catch (err) {
            console.error("[Server][Firestore Error] Error verificando estado antes de enviar mensaje:", err);
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
        console.error(`[Server] Error enviando comando SEND_MESSAGE a worker ${userId}:`, ipcError);
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
    console.log(`[Server] GET /users/${userId}/rules`);
    try {
        const rulesSnapshot = await firestoreDb.collection('users').doc(userId).collection('rules').get();
        const rules = [];
        rulesSnapshot.forEach(doc => {
            rules.push(doc.data());
        });
        res.json({ success: true, data: rules });
    } catch (err) {
        console.error(`[Server][Firestore Error] Error listando reglas para ${userId}:`, err);
        if (err.code === 5 || (err.message && err.message.includes("NOT_FOUND"))) { // 5 = gRPC NOT_FOUND
            console.warn(`[Server] Usuario ${userId} no encontrado o sin colección de reglas.`);
            return res.json({ success: true, data: [] });
        }
        res.status(500).json({ success: false, message: 'Error interno al listar reglas.' });
    }
});

// POST /users/:userId/add-rule - Añadir una nueva regla simple
app.post('/users/:userId/add-rule', async (req, res) => {
    const userId = req.params.userId;
    const { trigger, response } = req.body;
    console.log(`[Server] POST /users/${userId}/add-rule`);

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
        console.error(`[Server][Firestore Error] Error añadiendo regla para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al guardar la regla.' });
    }
});

// DELETE /users/:userId/rules/:ruleId - Eliminar una regla simple por su ID
app.delete('/users/:userId/rules/:ruleId', async (req, res) => {
    const { userId, ruleId } = req.params;
    console.log(`[Server] DELETE /users/${userId}/rules/${ruleId}`);
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
        console.error(`[Server][Firestore Error] Error eliminando regla ${ruleId} para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al eliminar la regla.' });
    }
});


// === Rutas para Gemini Starters (Firestore) ===

// GET /users/:userId/gemini-starters - Listar todos los starters
app.get('/users/:userId/gemini-starters', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[Server] GET /users/${userId}/gemini-starters`);
    try {
        const startersSnapshot = await firestoreDb.collection('users').doc(userId).collection('gemini_starters').get();
        const starters = [];
        startersSnapshot.forEach(doc => {
            starters.push(doc.data());
        });
        res.json({ success: true, data: starters });
    } catch (err) {
        console.error(`[Server][Firestore Error] Error listando starters para ${userId}:`, err);
        if (err.code === 5 || (err.message && err.message.includes("NOT_FOUND"))) { // 5 = gRPC NOT_FOUND
             console.warn(`[Server] Usuario ${userId} no encontrado o sin colección de gemini_starters.`);
             return res.json({ success: true, data: [] });
        }
        res.status(500).json({ success: false, message: 'Error interno al listar disparadores.' });
    }
});

// POST /users/:userId/add-gemini-starter - Añadir un nuevo starter
app.post('/users/:userId/add-gemini-starter', async (req, res) => {
    const userId = req.params.userId;
    const { trigger, prompt } = req.body;
    console.log(`[Server] POST /users/${userId}/add-gemini-starter`);

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
        console.error(`[Server][Firestore Error] Error añadiendo starter para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al guardar el disparador.' });
    }
});

// DELETE /users/:userId/gemini-starters/:starterId - Eliminar un starter por ID
app.delete('/users/:userId/gemini-starters/:starterId', async (req, res) => {
    const { userId, starterId } = req.params;
    console.log(`[Server] DELETE /users/${userId}/gemini-starters/${starterId}`);
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
        console.error(`[Server][Firestore Error] Error eliminando starter ${starterId} para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al eliminar el disparador.' });
    }
});


// === Rutas para Flujos de Acción (Firestore) === // <-- CAMBIO DE NOMBRE DE SECCIÓN

// GET /users/:userId/action-flows - Listar todos los flujos de un usuario
app.get('/users/:userId/action-flows', async (req, res) => { // <-- CAMBIO DE RUTA
    const userId = req.params.userId; // <-- OBTENER userId
    console.log(`[Server] GET /users/${userId}/action-flows`);
    try {
        // Verificar si el usuario existe (opcional pero bueno)
        const userDoc = await firestoreDb.collection('users').doc(userId).get();
        if (!userDoc.exists) {
             return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        // Consultar subcolección específica del usuario
        const flowsSnapshot = await firestoreDb.collection('users').doc(userId).collection('action_flows').orderBy('createdAt', 'desc').get(); // <-- CAMBIO DE RUTA FIRESTORE
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
        console.error(`[Server][Firestore Error] Error listando flujos de acción para ${userId}:`, err); // <-- ACTUALIZAR LOG
        if (err.code === 5 || (err.message && err.message.includes("NOT_FOUND"))) { // Puede ser error al encontrar user o collection
            console.warn(`[Server] Usuario ${userId} no encontrado o sin colección de action_flows.`);
            return res.json({ success: true, data: [] }); // Devolver vacío si no existe user o colección
        }
        res.status(500).json({ success: false, message: 'Error interno al listar flujos.' });
    }
});

// POST /users/:userId/action-flows - Crear un nuevo flujo para un usuario
app.post('/users/:userId/action-flows', async (req, res) => { // <-- CAMBIO DE RUTA
    const userId = req.params.userId; // <-- OBTENER userId
    console.log(`[Server] POST /users/${userId}/action-flows`);
    const flowData = req.body;

    if (!flowData || typeof flowData !== 'object' || !flowData.name || !flowData.trigger || !Array.isArray(flowData.steps)) {
        return res.status(400).json({ success: false, message: 'Datos del flujo inválidos. Se requiere name, trigger y steps (array).' });
    }

    const flowsCollectionRef = firestoreDb.collection('users').doc(userId).collection('action_flows'); // <-- RUTA FIRESTORE USER-SPECIFIC
    const userDocRef = firestoreDb.collection('users').doc(userId);

    try {
        // Verificar si el usuario existe
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) {
             return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        const flowId = uuidv4();
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const newFlow = {
            ...flowData,
            id: flowId,
            createdAt: timestamp,
            updatedAt: timestamp
        };

        await flowsCollectionRef.doc(flowId).set(newFlow); // <-- GUARDAR EN SUBCOLECCIÓN
        console.log(`[Server] Flujo de acción creado para ${userId} en Firestore: ${flowId} - ${newFlow.name}`);

        // Notificar al worker específico de este usuario
        console.log(`[Server] Recargando y notificando flujos al worker ${userId}...`);
        const userFlowsSnapshot = await flowsCollectionRef.get(); // <-- OBTENER SOLO FLUJOS DEL USUARIO
        const userFlowsData = userFlowsSnapshot.docs.map(doc => doc.data());

        // Nuevo comando IPC específico para flujos de usuario
        notifyWorker(userId, { type: 'RELOAD_USER_FLOWS', payload: { flows: userFlowsData } }); // <-- NUEVO COMANDO Y PAYLOAD

        // Devolver el flujo con timestamps resueltos (aproximados)
        const createdFlow = { ...newFlow, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        res.status(201).json({ success: true, message: 'Flujo de acción creado.', data: createdFlow });
    } catch (err) {
        console.error(`[Server][Firestore Error] Error creando flujo de acción para ${userId}:`, err); // <-- ACTUALIZAR LOG
        res.status(500).json({ success: false, message: 'Error interno al guardar el flujo.' });
    }
});

// GET /users/:userId/action-flows/:flowId - Obtener un flujo específico de un usuario
app.get('/users/:userId/action-flows/:flowId', async (req, res) => { // <-- CAMBIO DE RUTA
    const { userId, flowId } = req.params; // <-- OBTENER userId Y flowId
    console.log(`[Server] GET /users/${userId}/action-flows/${flowId}`);
    try {
        const flowDoc = await firestoreDb.collection('users').doc(userId).collection('action_flows').doc(flowId).get(); // <-- CAMBIO DE RUTA FIRESTORE
        if (!flowDoc.exists) {
             return res.status(404).json({ success: false, message: 'Flujo de acción no encontrado.' });
        }
        // Convertir Timestamps si es necesario para el cliente
        let data = flowDoc.data();
        if (data.createdAt?.toDate) data.createdAt = data.createdAt.toDate().toISOString();
        if (data.updatedAt?.toDate) data.updatedAt = data.updatedAt.toDate().toISOString();
        res.json({ success: true, data: data });
    } catch (err) {
        console.error(`[Server][Firestore Error] Error obteniendo flujo ${flowId} para ${userId}:`, err); // <-- ACTUALIZAR LOG
        res.status(500).json({ success: false, message: 'Error interno al obtener el flujo.' });
    }
});

// PUT /users/:userId/action-flows/:flowId - Actualizar un flujo existente de un usuario
app.put('/users/:userId/action-flows/:flowId', async (req, res) => { // <-- CAMBIO DE RUTA
    const { userId, flowId } = req.params; // <-- OBTENER userId Y flowId
    const updatedFlowData = req.body;
    console.log(`[Server] PUT /users/${userId}/action-flows/${flowId}`);

    if (!updatedFlowData || typeof updatedFlowData !== 'object' || !updatedFlowData.name || !updatedFlowData.trigger || !Array.isArray(updatedFlowData.steps)) {
         return res.status(400).json({ success: false, message: 'Datos del flujo inválidos. Se requiere name, trigger y steps (array).' });
    }

    const flowDocRef = firestoreDb.collection('users').doc(userId).collection('action_flows').doc(flowId); // <-- CAMBIO DE RUTA FIRESTORE
    const flowsCollectionRef = firestoreDb.collection('users').doc(userId).collection('action_flows'); // Para recargar

    try {
        const dataToUpdate = {
            ...updatedFlowData,
            id: flowId, // Asegurar ID
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        delete dataToUpdate.createdAt; // No sobreescribir createdAt

        await flowDocRef.update(dataToUpdate); // update fallará si el doc no existe
        console.log(`[Server] Flujo de acción actualizado para ${userId} en Firestore: ${flowId} - ${dataToUpdate.name}`);

        // Notificar al worker específico de este usuario
        console.log(`[Server] Recargando y notificando flujos al worker ${userId}...`);
        const userFlowsSnapshotUpdate = await flowsCollectionRef.get(); // <-- OBTENER SOLO FLUJOS DEL USUARIO
        const userFlowsDataUpdate = userFlowsSnapshotUpdate.docs.map(doc => doc.data());

        // Nuevo comando IPC específico
        notifyWorker(userId, { type: 'RELOAD_USER_FLOWS', payload: { flows: userFlowsDataUpdate } }); // <-- NUEVO COMANDO Y PAYLOAD

        // Merge local aproximado para respuesta
        const approxUpdatedData = { ...updatedFlowData, id: flowId, updatedAt: new Date().toISOString() };
        res.json({ success: true, message: 'Flujo de acción actualizado.', data: approxUpdatedData });

    } catch (err) {
        console.error(`[Server][Firestore Error] Error actualizando flujo ${flowId} para ${userId}:`, err); // <-- ACTUALIZAR LOG
        if (err.code === 5) { // Firestore NOT_FOUND
             return res.status(404).json({ success: false, message: 'Flujo de acción no encontrado para actualizar.' });
        }
        res.status(500).json({ success: false, message: 'Error interno al guardar el flujo actualizado.' });
    }
});

// DELETE /users/:userId/action-flows/:flowId - Eliminar un flujo de un usuario
app.delete('/users/:userId/action-flows/:flowId', async (req, res) => { // <-- CAMBIO DE RUTA
    const { userId, flowId } = req.params; // <-- OBTENER userId Y flowId
    console.log(`[Server] DELETE /users/${userId}/action-flows/${flowId}`);
    const flowDocRef = firestoreDb.collection('users').doc(userId).collection('action_flows').doc(flowId); // <-- CAMBIO DE RUTA FIRESTORE
    const flowsCollectionRef = firestoreDb.collection('users').doc(userId).collection('action_flows'); // Para recargar

    try {
        // Verificar si existe antes de borrar
         const docSnap = await flowDocRef.get();
         if (!docSnap.exists) {
             return res.status(404).json({ success: false, message: 'Flujo de acción no encontrado para eliminar.' });
        }

        await flowDocRef.delete();
        console.log(`[Server] Flujo de acción eliminado de Firestore: ${flowId} para usuario ${userId}`);

        // Notificar al worker específico de este usuario
        console.log(`[Server] Recargando y notificando flujos al worker ${userId}...`);
        const userFlowsSnapshotDelete = await flowsCollectionRef.get(); // <-- OBTENER SOLO FLUJOS DEL USUARIO
        const userFlowsDataDelete = userFlowsSnapshotDelete.docs.map(doc => doc.data());

        // Nuevo comando IPC específico
        notifyWorker(userId, { type: 'RELOAD_USER_FLOWS', payload: { flows: userFlowsDataDelete } }); // <-- NUEVO COMANDO Y PAYLOAD

        res.json({ success: true, message: 'Flujo de acción eliminado.' });
    } catch (err) {
        console.error(`[Server][Firestore Error] Error eliminando flujo ${flowId} para ${userId}:`, err); // <-- ACTUALIZAR LOG
        res.status(500).json({ success: false, message: 'Error interno al eliminar el flujo.' });
    }
});

// Eliminar rutas globales antiguas si aún existen
// app.get('/action-flows', ...); // ELIMINADO
// app.post('/action-flows', ...); // ELIMINADO
// app.get('/action-flows/:flowId', ...); // ELIMINADO
// app.put('/action-flows/:flowId', ...); // ELIMINADO
// app.delete('/action-flows/:flowId', ...); // ELIMINADO


// --- FIN REFACTORIZACIÓN Firestore para Reglas, Starters, Flujos ---

// === Rutas para Gestión de Agentes (Firestore) ===

// GET /users/:userId/agents - Listar todos los agentes de un usuario
app.get('/users/:userId/agents', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[Server] GET /users/${userId}/agents`);
    try {
        const agentsSnapshot = await firestoreDb.collection('users').doc(userId).collection('agents').get();
        const agents = [];
        agentsSnapshot.forEach(doc => {
            agents.push(doc.data());
        });
        res.json({ success: true, data: agents });
    } catch (err) {
        console.error(`[Server][Firestore Error] Error listando agentes para ${userId}:`, err);
        if (err.code === 5 || (err.message && err.message.includes("NOT_FOUND"))) {
            console.warn(`[Server] Usuario ${userId} no encontrado o sin colección de agentes.`);
            return res.json({ success: true, data: [] }); // Devolver vacío si no existe user o colección
        }
        res.status(500).json({ success: false, message: 'Error interno al listar agentes.' });
    }
});

// POST /users/:userId/agents - Crear un nuevo agente para un usuario
app.post('/users/:userId/agents', async (req, res) => {
    const userId = req.params.userId;
    const agentData = req.body;
    console.log(`[Server] POST /users/${userId}/agents`);

    // Validación básica de la estructura del agente
    if (!agentData || typeof agentData !== 'object' || !agentData.persona || !agentData.persona.name || !agentData.knowledge) {
        return res.status(400).json({ success: false, message: 'Datos del agente inválidos. Se requiere al menos persona.name y knowledge.' });
    }
    // Validar que knowledge sea un objeto (puede venir vacío)
    if (typeof agentData.knowledge !== 'object' || agentData.knowledge === null) {
        agentData.knowledge = {}; // Asegurar que sea un objeto si no lo es
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
        console.log(`[Server] Agente creado para ${userId}: ${agentId} - ${newAgent.persona.name}`);

        // Notificar al worker activo si coincide el userId (podría no estar activo)
        notifyWorker(userId, { type: 'COMMAND', command: 'RELOAD_AGENT_CONFIG' });


        res.status(201).json({ success: true, message: 'Agente creado.', data: { ...newAgent, id: agentId } }); // Devolver con ID

    } catch (err) {
        console.error(`[Server][Firestore Error] Error creando agente para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al guardar el agente.' });
    }
});

// GET /users/:userId/agents/:agentId - Obtener un agente específico
app.get('/users/:userId/agents/:agentId', async (req, res) => {
    const { userId, agentId } = req.params;
    console.log(`[Server] GET /users/${userId}/agents/${agentId}`);
    try {
        const agentDocRef = firestoreDb.collection('users').doc(userId).collection('agents').doc(agentId);
        const docSnap = await agentDocRef.get();

        if (!docSnap.exists) {
             return res.status(404).json({ success: false, message: 'Agente no encontrado.' });
        }
        res.json({ success: true, data: docSnap.data() });
    } catch (err) {
        console.error(`[Server][Firestore Error] Error obteniendo agente ${agentId} para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al obtener el agente.' });
    }
});

// PUT /users/:userId/agents/:agentId - Actualizar un agente existente
app.put('/users/:userId/agents/:agentId', async (req, res) => {
    const { userId, agentId } = req.params;
    const updatedAgentData = req.body;
    console.log(`[Server] PUT /users/${userId}/agents/${agentId}`);

    if (!updatedAgentData || typeof updatedAgentData !== 'object' || !updatedAgentData.persona || !updatedAgentData.persona.name || !updatedAgentData.knowledge) {
        return res.status(400).json({ success: false, message: 'Datos del agente inválidos para actualizar.' });
    }
    // Validar que knowledge sea un objeto (puede venir vacío)
    if (typeof updatedAgentData.knowledge !== 'object' || updatedAgentData.knowledge === null) {
        updatedAgentData.knowledge = {}; // Asegurar que sea un objeto si no lo es
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
        console.log(`[Server] Agente actualizado para ${userId}: ${agentId} - ${dataToUpdate.persona.name}`);

        // Notificar al worker si este agente era el activo
        const userDoc = await firestoreDb.collection('users').doc(userId).get();
        if (userDoc.exists && userDoc.data().active_agent_id === agentId) {
            console.log(` -> Notificando worker ${userId} por cambio en agente activo.`);
            // <<< UPDATED: Enviar config actualizada en payload >>>
            const updatedAgentConfigData = (await agentDocRef.get()).data(); // Re-fetch latest data
            notifyWorker(userId, {
                type: 'COMMAND',
                command: 'RELOAD_AGENT_CONFIG',
                // El payload ya contiene la config completa, incluyendo writingSampleTxt si existe
                payload: { agentConfig: updatedAgentConfigData }
            });
        } else {
             console.log(` -> Agente actualizado no era el activo para ${userId}, no se notifica cambio inmediato.`);
        }

        res.json({ success: true, message: 'Agente actualizado.', data: { ...dataToUpdate, id: agentId } });

    } catch (err) {
        console.error(`[Server][Firestore Error] Error actualizando agente ${agentId} para ${userId}:`, err);
        if (err.code === 5) { // Firestore NOT_FOUND
             return res.status(404).json({ success: false, message: 'Agente no encontrado para actualizar.' });
        }
        res.status(500).json({ success: false, message: 'Error interno al guardar el agente actualizado.' });
    }
});

// DELETE /users/:userId/agents/:agentId - Eliminar un agente
app.delete('/users/:userId/agents/:agentId', async (req, res) => {
    const { userId, agentId } = req.params;
    console.log(`[Server] DELETE /users/${userId}/agents/${agentId}`);
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
        console.log(`[Server] Agente eliminado de Firestore: ${agentId} para usuario ${userId}`);

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
        console.error(`[Server][Firestore Error] Error eliminando agente ${agentId} para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al eliminar el agente.' });
    }
});

// PUT /users/:userId/active-agent - Establecer el agente activo para un usuario
app.put('/users/:userId/active-agent', async (req, res) => {
    const userId = req.params.userId;
    const { agentId } = req.body; // Espera { "agentId": "some-agent-id" } o { "agentId": null }
    // <<< ADDED LOG >>>
    console.log(`[Server][SwitchAgent] PUT /users/${userId}/active-agent - Intentando establecer a: ${agentId}`);

    const userDocRef = firestoreDb.collection('users').doc(userId);

    try {
        const userDocSnap = await userDocRef.get();
        if (!userDocSnap.exists) {
             return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        // Verificar si el agentId proporcionado existe (si no es null)
        let agentConfigPayload = null; // <<< MOVED DECLARATION EARLIER
        if (agentId) {
            const agentDocRef = userDocRef.collection('agents').doc(agentId);
            const agentDocSnap = await agentDocRef.get();
            if (!agentDocSnap.exists) {
                return res.status(404).json({ success: false, message: `Agente con ID ${agentId} no encontrado para este usuario.` });
            }
            // <<< OBTENER CONFIG PARA PAYLOAD >>>
            agentConfigPayload = agentDocSnap.data();
        }

        // Actualizar el usuario
        await userDocRef.update({
            active_agent_id: agentId, // Establece null si agentId es null/undefined
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`[Server][SwitchAgent] Agente activo para ${userId} actualizado en Firestore a ${agentId || 'ninguno'}.`);

        // Notificar al worker activo para que cambie su configuración
        // <<< ADDED LOG >>>
        console.log(`[Server][SwitchAgent] Notificando worker ${userId} para cambiar al agente ${agentId || 'default'}. Payload config: ${agentConfigPayload ? JSON.stringify(agentConfigPayload).substring(0, 200)+'...' : 'null'}`); // Log truncado
        notifyWorker(userId, {
            type: 'SWITCH_AGENT',
            // El payload ya contiene la config completa, incluyendo writingSampleTxt si existe
            payload: { agentId: agentId, agentConfig: agentConfigPayload } // Enviar ID y la config si existe
        });

        res.json({ success: true, message: `Agente activo establecido a ${agentId || 'ninguno'}.`, activeAgentId: agentId || null });

    } catch (err) {
        console.error(`[Server][Firestore Error] Error estableciendo agente activo para ${userId}:`, err);
        res.status(500).json({ success: false, message: 'Error interno al actualizar el agente activo.' });
    }
});

// === FIN Rutas para Gestión de Agentes ===

// <<< ADDED: API Endpoint to List Chats >>>
app.get('/users/:userId/chats', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[Server] GET /users/${userId}/chats`);

    try {
        const userDoc = await firestoreDb.collection('users').doc(userId).get();
        if (!userDoc.exists) {
             return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        const chatsSnapshot = await firestoreDb.collection('users').doc(userId).collection('chats')
            .orderBy('lastMessageTimestamp', 'desc') // Order by most recent activity
            .get();

        const chats = [];
        chatsSnapshot.forEach(doc => {
            const data = doc.data();
            const chatId = doc.id; // The document ID is the chatId (e.g., 1234567890@c.us)

            // Extract relevant info, ensure fields exist
            const lastMessageTimestamp = data.lastMessageTimestamp?.toDate ? data.lastMessageTimestamp.toDate().toISOString() : null;

            // Basic contact info (can be expanded later)
            let contactName = data.contactName || chatId; // Use chatId as default name

            chats.push({
                chatId: chatId,
                contactName: contactName, // Placeholder for actual contact name logic
                lastMessageContent: data.lastMessageContent || '',
                lastMessageTimestamp: lastMessageTimestamp,
                // Add other fields like unread count if tracked later
            });
        });

        res.json({ success: true, data: chats });

    } catch (err) {
        console.error(`[Server][Firestore Error] Error fetching chats for user ${userId}:`, err);
        // Handle specific errors like missing indices if needed
        res.status(500).json({ success: false, message: 'Error interno al obtener la lista de chats.' });
    }
});
// <<< END: API Endpoint to List Chats >>>

// <<< ADDED: API Endpoint to Get Messages for a Chat >>>
app.get('/users/:userId/chats/:chatId/messages', async (req, res) => {
    const { userId, chatId } = req.params;
    // Pagination parameters (example)
    const limit = parseInt(req.query.limit) || 50; // Default limit 50 messages
    const beforeTimestampStr = req.query.before; // ISO string timestamp

    console.log(`[Server] GET /users/${userId}/chats/${chatId}/messages (limit: ${limit}, before: ${beforeTimestampStr})`);

    try {
        const chatDocRef = firestoreDb.collection('users').doc(userId).collection('chats').doc(chatId);
        const messagesRef = chatDocRef.collection('messages_all'); // Query the unified collection

        let query = messagesRef.orderBy('timestamp', 'desc'); // Get newest first for typical chat view

        // Apply cursor for pagination if 'before' timestamp is provided
        if (beforeTimestampStr) {
            try {
                const beforeTimestamp = admin.firestore.Timestamp.fromDate(new Date(beforeTimestampStr));
                query = query.startAfter(beforeTimestamp); // Fetch messages *before* this timestamp (older)
                console.log(`   -> Paginating: starting after ${beforeTimestampStr}`);
            } catch (dateErr) {
                console.warn(`[Server] Invalid 'before' timestamp format: ${beforeTimestampStr}. Ignoring pagination.`);
                 return res.status(400).json({ success: false, message: 'Formato de timestamp inválido para paginación (use ISO 8601).' });
            }
        }

        query = query.limit(limit);

        const messagesSnapshot = await query.get();

        const messages = [];
        messagesSnapshot.forEach(doc => {
            const data = doc.data();
            const messageTimestamp = data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : null;

            messages.push({
                id: doc.id, // Firestore document ID
                messageId: data.messageId || null, // WhatsApp message ID if available
                body: data.body || '',
                timestamp: messageTimestamp,
                from: data.from || 'unknown',
                to: data.to || 'unknown',
                isFromMe: data.isFromMe || false,
                origin: data.origin || 'unknown', // 'human', 'bot', 'contact', 'unknown'
                // Add other fields like 'ack' status if needed
            });
        });

        // Note: Messages are currently newest first due to orderBy('desc').
        // Frontend might need to reverse this array for display (oldest at top).
        res.json({ success: true, data: messages });

    } catch (err) {
        console.error(`[Server][Firestore Error] Error fetching messages for chat ${chatId}, user ${userId}:`, err);
        // Handle specific errors like missing indices
        if (err.code === 5) { // NOT_FOUND (likely chat doesn't exist)
             return res.status(404).json({ success: false, message: 'Chat no encontrado.' });
        }
         if (err.message && (err.message.includes('INVALID_ARGUMENT') || err.message.includes('requires an index'))) {
            console.error(`[Server][Firestore Error] Missing index for chat message query: ${err.message}`);
            return res.status(500).json({ success: false, message: 'Error interno: Falta un índice de base de datos. Contacte al administrador.', code: 'INDEX_REQUIRED' });
         }
        res.status(500).json({ success: false, message: 'Error interno al obtener los mensajes del chat.' });
    }
});
// <<< END: API Endpoint to Get Messages for a Chat >>>

// === INICIALIZACIÓN DEL SERVIDOR Y CIERRE LIMPIO ===
try {
    console.log("==== INICIALIZANDO SERVIDOR API PRINCIPAL (v2) ====");
    // <<< CHANGED: Use the http server (with WebSocket attached) for listening >>>
    server.listen(port, () => {
        console.log(`¡Server API Principal (v2) escuchando en http://localhost:${port}! (WebSocket ready)`);
    });

    // server.on('error', (error) => { // This listener should be on 'server', not 'app'
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`[Server][ERROR] El puerto ${port} ya está en uso.`);
        } else {
            console.error('[Server][ERROR] Iniciando servidor API (v2): ', error);
        }
    });

} catch (err) {
    console.error("[Server][ERROR CRÍTICO] Al iniciar servidor API (v2):", err);
}


// Manejo de cierre limpio (sin DB)
process.on('SIGINT', () => {
    console.log('\n[Server] Recibido SIGINT. Cerrando API Principal (v2)...');

    // <<< ADDED: Close WebSocket connections gracefully >>>
    console.log('[Server] Cerrando conexiones WebSocket...');
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1001, 'Server shutting down'); // 1001: Going Away
        }
    });
    // Wait a very short moment for close frames to be sent
    setTimeout(() => {
        console.log('[Server] Cerrando servidor HTTP...');
        server.close(() => { // <<< CHANGED: Close the http server instance
            console.log('[Server] Servidor HTTP cerrado.');

            // Intentar detener todos los workers activos
            const activeWorkerPIDs = Object.values(workers).map(w => w?.pid).filter(Boolean);
            console.log(`[Server] Intentando detener ${Object.keys(workers).length} workers activos...`);
            const stopPromises = Object.keys(workers).map(userId => stopWorker(userId)); // stopWorker now returns a promise implicitly

            Promise.allSettled(stopPromises).then(() => {
                 console.log('[Server] Resultados de parada de workers procesados.');
                 // Dar un tiempo para que los workers intenten cerrarse (puede ser redundante con el timeout de stopWorker)
                 setTimeout(() => {
                    console.log('[Server] Verificando workers restantes...');
                    Object.values(workers).forEach(worker => {
                        if (worker && !worker.killed) {
                            console.warn(`[Server] Forzando terminación del worker PID: ${worker.pid}`);
                            worker.kill('SIGTERM');
                        }
                    });

                    console.log('[Server] Saliendo.');
                    process.exit(0);
                 }, 3000); // Esperar 3 segundos adicionales para los workers
            });
        });
    }, 500); // Give 0.5s for WebSockets to close
});
