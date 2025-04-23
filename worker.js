const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); // Usar LocalAuth para sesiones persistentes
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config(); // Cargar variables de entorno (ej. GEMINI_API_KEY)
const { loadData, saveData } = require('./utils'); // Importar desde utils.js
const admin = require('firebase-admin'); 

// --- Obtener User ID --- 
const userId = process.argv[2]; 
if (!userId) {
    console.error('[Worker] ERROR: No se proporcionó userId al iniciar el worker.');
    process.exit(1); // Salir si no hay ID de usuario
}
console.log(`[Worker ${userId}] Iniciando worker...`);

// --- Obtener Active Agent ID (pasado como 3er argumento) ---
let currentAgentId = process.argv[3] || null;
console.log(`[Worker ${userId}] Active Agent ID inicial: ${currentAgentId || 'Ninguno (usará default)'}`);

// --- Definición de Rutas y Archivos --- 
const USER_DATA_PATH = path.join(__dirname, 'data_v2', userId);
const SESSION_PATH = path.join(USER_DATA_PATH, '.wwebjs_auth'); // Directorio para la sesión de WhatsApp
const AGENT_CONFIG_FILE = path.join(USER_DATA_PATH, 'agent_config.json');
const RULES_FILE = path.join(USER_DATA_PATH, 'rules.json');
const GEMINI_STARTERS_FILE = path.join(USER_DATA_PATH, 'gemini-starters.json');
const UPLOADS_DIR = path.join(USER_DATA_PATH, 'uploads'); // Directorio de uploads por usuario
const ACTION_FLOWS_FILE = path.join(__dirname, 'action_flows.json'); // Ruta al archivo global de flujos

// Crear directorios específicos del usuario si no existen
if (!fs.existsSync(USER_DATA_PATH)) fs.mkdirSync(USER_DATA_PATH, { recursive: true });
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- Carga Inicial de Configuración --- 
console.log(`[Worker ${userId}] Preparando configuración inicial (esperando datos via IPC)...`);

// Configuración por defecto para el agente
const DEFAULT_AGENT_CONFIG = {
    persona: { name: "Agente IA (Default)", role: "Asistente", language: "es", tone: "Neutral", style: "Directo", guidelines: [] }, 
    knowledge: { files: [], urls: [], qandas: [] } 
};

// Variable para almacenar la configuración del agente ACTIVO
let agentConfig = { ...DEFAULT_AGENT_CONFIG }; // Iniciar con el default

// <<< ADDED: Firestore Initialization for Worker >>>
let firestoreDbWorker;
try {
    // Re-initialize using the same credentials as the master process expects
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!serviceAccountPath || !fs.existsSync(serviceAccountPath)) {
        throw new Error(`Service account key not found at: ${serviceAccountPath}`);
    }
    // Check if Firebase app is already initialized (less likely in separate process, but good practice)
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccountPath)
        });
         console.log(`[Worker ${userId}] Firebase Admin SDK initialized in worker.`);
    } else {
         console.log(`[Worker ${userId}] Firebase Admin SDK already initialized.`);
    }
    firestoreDbWorker = admin.firestore();
} catch (error) {
    console.error(`[Worker ${userId}][ERROR CRÍTICO] Initializing Firebase Admin SDK in worker:`, error);
    // Notify master?
    sendErrorInfo(`Critical Firebase Init Error: ${error.message}`);
    // Exit? If Firestore is essential for state, the worker might be useless without it.
    process.exit(1);
}
// <<< END: Firestore Initialization for Worker >>>

// <<< ADDED: Presence Detection Logic >>>
let lastUserSentMessageTimestamp = 0; // Timestamp of the last message sent by the user (fromMe=true)
const PRESENCE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes threshold

function isUserConsideredPresent() {
    if (!lastUserSentMessageTimestamp) return false; // Never sent a message since worker started
    const isPresent = (Date.now() - lastUserSentMessageTimestamp) < PRESENCE_THRESHOLD_MS;
    // Optional: Add more logging for debugging presence
    // if (isPresent) console.log(`[Worker ${userId}][Presence Debug] User considered PRESENT (Last activity: ${new Date(lastUserSentMessageTimestamp).toLocaleTimeString()})`);
    // else console.log(`[Worker ${userId}][Presence Debug] User considered ABSENT (Last activity: ${new Date(lastUserSentMessageTimestamp).toLocaleTimeString()})`);
    return isPresent;
}
// <<< END: Presence Detection Logic >>>

// <<< ADDED: Gemini Initialization with try...catch >>>
try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not defined.");
    }
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});
    console.log(`[Worker ${userId}] Gemini Model initialized successfully. Type: ${typeof geminiModel}`); // Log success and type
} catch(geminiInitError) {
    console.error(`[Worker ${userId}][ERROR CRÍTICO] Initializing GoogleGenerativeAI:`, geminiInitError);
    sendErrorInfo(`Critical Gemini Init Error: ${geminiInitError.message}`);
    // Exit? If Gemini is essential, the worker might be useless without it.
    process.exit(1);
}
// <<< END: Gemini Initialization >>>

// Función para enviar estado/error al proceso Master
function sendStatusUpdate(status, error = null) {
    if (process.send) {
        process.send({ type: 'STATUS_UPDATE', status, error });
    } else {
        console.warn(`[Worker ${userId}] Imposible enviar STATUS_UPDATE (process.send no disponible)`);
    }
}

// Función para enviar QR al proceso Master
function sendQrCode(qr) {
    if (process.send) {
        process.send({ type: 'QR_CODE', qr });
    } else {
         console.warn(`[Worker ${userId}] Imposible enviar QR_CODE (process.send no disponible)`);
    }
}

// Función para enviar un error específico al Master
function sendErrorInfo(errorMsg) {
     if (process.send) {
        process.send({ type: 'ERROR_INFO', error: errorMsg });
    } else {
        console.error(`[Worker ${userId}] ERROR: ${errorMsg} (process.send no disponible)`);
    }
}

// --- Función auxiliar para resolver variables en strings ---
function resolveVariables(templateString, context) {
    if (!templateString || typeof templateString !== 'string') {
        return templateString; // Devuelve el original si no es un string válido
    }
    // Regex para encontrar {{path.to.variable}}
    return templateString.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
        try {
            const keys = path.trim().split('.');
            let value = context;
            for (const key of keys) {
                if (value === undefined || value === null) {
                    // console.warn(`[resolveVariables] Path intermedio ${key} no encontrado en contexto para ${path}`);
                    return match; // No reemplazar si el path es inválido
                }
                value = value[key];
            }
            return typeof value === 'object' ? JSON.stringify(value) : (value ?? match);
        } catch (error) {
            console.error(`[resolveVariables] Error resolviendo path "${path}":`, error);
            return match;
        }
    });
}

// --- Función auxiliar para evaluar condiciones ---
function evaluateCondition(conditionObj, context) {
    if (!conditionObj || typeof conditionObj !== 'object' || !conditionObj.variable || !conditionObj.operator) {
        console.warn('[evaluateCondition] Condición inválida: falta variable u operador.');
        return false;
    }

    const { variable, operator, value: compareValue } = conditionObj;
    let actualValue = null;

    try {
        const keys = variable.trim().split('.');
        let current = context;
        for (const key of keys) {
            if (current === undefined || current === null) throw new Error(`Path intermedio ${key} no encontrado.`);
            current = current[key];
        }
        actualValue = current;
    } catch (error) {
        // console.warn(`[evaluateCondition] No se pudo obtener valor para variable "${variable}": ${error.message}`);
        actualValue = null;
    }

    const actualValueStr = actualValue === null || actualValue === undefined ? '' : String(actualValue);
    const compareValueStr = compareValue === null || compareValue === undefined ? '' : String(compareValue);

    // console.log(`[evaluateCondition] Evaluando: "${actualValueStr}" ${operator} "${compareValueStr}"`);

    switch (operator.toLowerCase()) {
        case 'equals':
            return actualValueStr === compareValueStr;
        case 'contains':
            return actualValueStr.includes(compareValueStr);
        case 'starts_with':
            return actualValueStr.startsWith(compareValueStr);
        case 'is_empty':
            return actualValue === null || actualValue === undefined || actualValueStr === '';
        default:
            console.warn(`[evaluateCondition] Operador desconocido: ${operator}`);
            return false;
    }
}

// --- Función auxiliar para añadir un retraso aleatorio ---
function randomDelay(minMs = 2500, maxMs = 3500) {
  const delayTime = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  console.log(`   -> [Delay] Esperando ${delayTime}ms antes de enviar...`);
  return new Promise(resolve => setTimeout(resolve, delayTime));
}

// --- Función REFACTORIZADA para ejecutar una lista de pasos ---
async function executeSteps(stepsToExecute, context) {
    const userId = context.message.from; // Usar sender para logs

    for (const step of stepsToExecute) {
        // console.log(`[Worker ${userId}][Flow Engine] Procesando paso tipo: ${step.type}`); // Log detallado
        switch (step.type) {
            case 'send_message':
                if (step.content) {
                    const resolvedContent = resolveVariables(step.content, context);
                    try {
                         // --- Mover el log ANTES de enviar --- 
                         console.log(`   -> INTENTANDO enviar mensaje: "${resolvedContent}"`); 
                         await randomDelay(); // <<< AÑADIDO DELAY
                         await client.sendMessage(context.message.from, resolvedContent);
                         // Log original (después) lo dejamos comentado o lo quitamos si preferimos
                         // console.log(`   -> Mensaje enviado: "${resolvedContent}"`);
                    } catch (sendError) {
                         console.error(`[Worker ${userId}][Flow Engine] Error enviando mensaje en paso:`, sendError);
                         sendErrorInfo(`Error enviando mensaje de flujo: ${sendError.message}`);
                    }
                } else {
                    console.warn(`   -> Paso send_message sin 'content'. Saltando.`);
                }
                break;
            
            case 'run_gemini':
                if (step.prompt && typeof step.prompt === 'string') {
                    const resolvedPrompt = resolveVariables(step.prompt, context);
                    // console.log(`   -> Ejecutando Gemini con prompt resuelto: "${resolvedPrompt.substring(0, 50)}..."`);
                    try {
                        const result = await geminiModel.generateContent(resolvedPrompt);
                        const geminiResponseText = await result.response.text();
                        
                        if (geminiResponseText) {
                            // console.log(`   -> Respuesta Gemini generada.`);
                            if (step.outputVariable && typeof step.outputVariable === 'string' && step.outputVariable.trim()) {
                                const varName = step.outputVariable.trim();
                                context.variables[varName] = geminiResponseText;
                                // console.log(`      -> Respuesta guardada en context.variables.${varName}`);
                            } else {
                                // console.log(`      -> No se especificó outputVariable. Enviando respuesta directamente.`);
                                try {
                                    await randomDelay(); // <<< AÑADIDO DELAY
                                    await client.sendMessage(context.message.from, geminiResponseText);
                                    // console.log(`         -> Respuesta Gemini enviada a ${context.message.from}.`);
                                } catch (sendError) {
                                      console.error(`[Worker ${userId}][Flow Engine] Error enviando respuesta Gemini:`, sendError);
                                      sendErrorInfo(`Error enviando resp Gemini: ${sendError.message}`);
                                }
                            }
                            // await new Promise(resolve => setTimeout(resolve, 300)); // Delay menor eliminado
                        } else {
                            console.warn(`   -> Gemini no generó respuesta para el prompt.`);
                            if (step.outputVariable && typeof step.outputVariable === 'string' && step.outputVariable.trim()) {
                                context.variables[step.outputVariable.trim()] = null;
                            }
                        }
                    } catch (geminiError) {
                       console.error(`   -> [Error Gemini] Error ejecutando el paso run_gemini:`, geminiError);
                       sendErrorInfo(`Error en paso run_gemini: ${geminiError.message}`);
                       if (step.outputVariable && typeof step.outputVariable === 'string' && step.outputVariable.trim()) {
                            context.variables[step.outputVariable.trim()] = null;
                       }
                    }
                } else {
                    console.warn(`   -> Paso run_gemini sin 'prompt' válido. Saltando.`);
                }
                break;
            
            case 'condition':
                if (step.if && step.then && Array.isArray(step.then)) {
                    // console.log(`   -> Evaluando condición...`);
                    const conditionResult = evaluateCondition(step.if, context);
                    // console.log(`      -> Resultado de la condición: ${conditionResult}`);

                    if (conditionResult) {
                        // console.log(`   -> Ejecutando bloque 'then'...`);
                        await executeSteps(step.then, context); // Llamada recursiva
                    } else if (step.else && Array.isArray(step.else)) {
                        // console.log(`   -> Ejecutando bloque 'else'...`);
                        await executeSteps(step.else, context); // Llamada recursiva
                    } // else: no hacer nada si es falso y no hay bloque else
                } else {
                    console.warn(`   -> Paso condition mal formado (falta 'if' o 'then'). Saltando.`);
                }
                break;

            default:
                console.warn(`   -> Tipo de paso desconocido: ${step.type}. Saltando.`);
                break;
        }
    }
}

// --- Función PRINCIPAL para ejecutar flujos de acción (refactorizada) ---
async function executeActionFlow(message, flow) {
    const sender = message.from;
    const userId = sender; // Identificador para logs
    console.log(`[Worker ${userId}][Flow Engine] Iniciando flujo: ${flow.name} (ID: ${flow.id})`);

    if (!flow.steps || !Array.isArray(flow.steps) || flow.steps.length === 0) {
        console.error(`[Worker ${userId}][Flow Engine] Error: Flujo ${flow.id} sin pasos válidos.`);
        return;
    }

    const flowContext = {
        message: { from: sender, body: message.body, id: message.id.id },
        variables: {}
    };

    try {
        await executeSteps(flow.steps, flowContext);
        console.log(`[Worker ${userId}][Flow Engine] Flujo ${flow.name} completado.`);

    } catch (error) {
        console.error(`[Worker ${userId}][Flow Engine] Error GRAL ejecutando flujo ${flow.name}:`, error);
        sendErrorInfo(`Error ejecutando flujo ${flow.id}: ${error.message}`);
    }
}

// --- Listeners de Eventos del Cliente WhatsApp ---
const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId, dataPath: SESSION_PATH }), // Usa LocalAuth con ruta específica
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], // Añadir disable-gpu
        headless: true
    }
});

client.on('qr', async (qr) => {
    console.log(`[Worker ${userId}] QR Recibido. Generando Data URL...`);
    sendStatusUpdate('generating_qr'); // Informar al master
    try {
        const qrCodeUrl = await qrcode.generate(qr, { small: true });
        console.log(`[Worker ${userId}] QR Data URL generado.`);
        sendQrCode(qrCodeUrl); // Enviar QR al master
    } catch (err) {
        console.error(`[Worker ${userId}] ERROR generando QR Data URL:`, err);
        sendStatusUpdate('error', 'Error generando QR');
    }
});

client.on('ready', () => {
    console.log(`[Worker ${userId}] Cliente WhatsApp LISTO!`);
    sendStatusUpdate('connected'); // Informar al master
});

client.on('authenticated', () => {
    console.log(`[Worker ${userId}] Cliente AUTENTICADO`);
    // Podríamos enviar un estado intermedio si quisiéramos
    // sendStatusUpdate('authenticated'); 
});

client.on('auth_failure', (msg) => {
    console.error(`[Worker ${userId}] FALLO DE AUTENTICACIÓN: ${msg}`);
    sendStatusUpdate('error', `Fallo de autenticación: ${msg}`);
    // Production Consideration: Decide if auth failure is fatal. Often it is.
    // Consider exiting: process.exit(1);
});

client.on('disconnected', (reason) => {
  console.log(`[Worker ${userId}] Cliente DESCONECTADO:`, reason);
  // No in-memory state to clear anymore.
  sendStatusUpdate('disconnected', `Desconectado: ${reason}`);
  // ¿Intentar reiniciar automáticamente? Por ahora no.
});

client.on('loading_screen', (percent, message) => {
    console.log(`[Worker ${userId}] Cargando: ${percent}% - ${message}`);
    // Podríamos enviar este progreso al Master si quisiéramos
});

// --- Procesamiento de Mensajes (adaptado del server.js original) ---
client.on('message', async (message) => {
  const sender = message.from;
  const body = message.body;
  const isFromMe = message.fromMe;
  const isGroup = message.id.remote.endsWith('@g.us');

  // Ignorar mensajes propios y de grupos por ahora
  if (isFromMe) {
      // <<< ADDED: Update presence timestamp and ignore message >>>
      lastUserSentMessageTimestamp = Date.now();
      console.log(`[Worker ${userId}][Presence] User activity detected at ${new Date(lastUserSentMessageTimestamp).toLocaleTimeString()}. Ignoring own message.`);
      return; // Don't process own messages further
  }
  if (isGroup) return; // Still ignore group messages

  console.log(`[Worker ${userId}][MSG] Recibido de ${sender}: "${body}"`);
  const chatDocRef = firestoreDbWorker.collection('users').doc(userId).collection('chats').doc(sender);
  const messagesColRef = chatDocRef.collection('messages');
  try {
    await messagesColRef.add({
        from: sender,
        body: body,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        isFromMe: false
    });
    // Optional: Add chat metadata if it doesn't exist
    await chatDocRef.set({ 
        lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        lastUserMessageTimestamp: admin.firestore.FieldValue.serverTimestamp() 
    }, { merge: true });
  } catch (dbError) {
      console.error(`[Worker ${userId}][Firestore Error] Failed to save incoming message for ${sender}:`, dbError);
      // Continue processing even if save fails?
  }

  try {
    // Recargar configuración en cada mensaje? Podría ser ineficiente.
    // Mejor recargar solo si hay cambios (requeriría mecanismo de notificación o check)
    // Por ahora, usamos la config cargada al inicio.

    const basePrompt = `Eres ${agentConfig.persona?.name || 'un asistente virtual'}. \nRol: ${agentConfig.persona?.role || 'Ayudar a los usuarios.'}\nTono: ${agentConfig.persona?.tone || 'amable'}. \nEstilo: ${agentConfig.persona?.style || 'claro'}. \nIdioma: ${agentConfig.persona?.language || 'es'}.\nDirectrices importantes:\n${(agentConfig.persona?.guidelines || []).map(g => `- ${g}`).join('\n') || '- Responde de forma concisa.'}\n---\n`;

    // 1. ¿Conversación IA activa?
    let activeGeminiPrompt = null;
    let chatData = null; // Store chat data for reuse
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    try {
        const chatSnap = await chatDocRef.get();
        if (chatSnap.exists) {
            chatData = chatSnap.data();
            activeGeminiPrompt = chatData?.activeGeminiPrompt || null;

            // <<< ADDED: Inactivity Check >>>
            const lastUserTimestamp = chatData?.lastUserMessageTimestamp?.toDate();
            if (activeGeminiPrompt && lastUserTimestamp && lastUserTimestamp < fiveMinutesAgo) {
                console.log(`[Worker ${userId}][AI Timeout] Clearing active prompt for ${sender} due to inactivity (> 5 min).`);
                await chatDocRef.update({ activeGeminiPrompt: null }); // Clear in Firestore
                activeGeminiPrompt = null; // Clear for current execution
                // No need to update chatData locally unless reused heavily below
            }
            // <<< END: Inactivity Check >>>
        }
    } catch (dbError) {
        console.error(`[Worker ${userId}][Firestore Error] Failed to check active conversation for ${sender}:`, dbError);
    }
         
    if (activeGeminiPrompt) {
        // <<< ADDED: Presence Check before continuing conversation >>>
        if (isUserConsideredPresent()) {
            console.log(`[Worker ${userId}][Presence] User is present. Skipping AI continuation for ${sender}.`);
            return; // Don't continue AI conversation if user is active
        }
        // <<< END: Presence Check >>>

        console.log(`[Worker ${userId}][AI Conv] para ${sender}. Prompt activo: "${activeGeminiPrompt}"`);
        
        let conversationContext = '';
        try {
            const recentMessagesSnap = await messagesColRef.orderBy('timestamp', 'desc').limit(10).get();
            const recentMessages = recentMessagesSnap.docs.reverse().map(doc => {
                const msgData = doc.data();
                return msgData.isFromMe ? `IA: ${msgData.body}` : `Usuario: ${msgData.body}`;
            });
            conversationContext = recentMessages.join('\n');
        } catch (dbError) {
             console.error(`[Worker ${userId}][Firestore Error] Failed to fetch message context for ${sender}:`, dbError);
             conversationContext = ' (Error cargando historial) ';
        }
        
        const conversationPrompt = `${basePrompt}${activeGeminiPrompt}\n\n---\nHistorial Reciente:\n${conversationContext}\n\n---\nMensaje Actual:\nUsuario: ${body}\n\n---\nTu Respuesta (sigue la conversación y directrices):`;
        
        console.log(`[Worker ${userId}][AI Conv] Enviando a Gemini...`);
        const result = await geminiModel.generateContent(conversationPrompt);
        const geminiResponse = await result.response.text();
        
        if (geminiResponse) {
            console.log(`[Worker ${userId}][AI Conv] Respuesta Gemini: "${geminiResponse}"`);
            await randomDelay(); // <<< AÑADIDO DELAY
            await client.sendMessage(sender, geminiResponse);
            try {
                await messagesColRef.add({
                    from: `me (IA - ${userId})`,
                    to: sender,
                    body: geminiResponse,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    isFromMe: true
                });
                await chatDocRef.set({ lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            } catch (dbError) {
                console.error(`[Worker ${userId}][Firestore Error] Failed to save AI response for ${sender}:`, dbError);
            }
            // Keyword check should happen *after* potential response sending
            const lowerBody = body.toLowerCase().trim();
            const endKeywords = ['gracias', 'chau', 'nos vemos', 'adios', 'hasta luego'];
            if (activeGeminiPrompt && endKeywords.some(keyword => lowerBody.includes(keyword))) { // Check if prompt *was* active
                console.log(`[Worker ${userId}][AI End Keyword] Detected end keyword from ${sender}. Clearing active prompt.`);
                try {
                    await chatDocRef.update({ activeGeminiPrompt: null });
                    // No need to set local var here, return happens next
                } catch (dbError) {
                     console.error(`[Worker ${userId}][Firestore Error] Failed to clear active prompt after keyword for ${sender}:`, dbError);
                }
            }
            return; // End processing after handling active conversation
        } else {
            console.log(`[Worker ${userId}][AI Conv] Gemini no generó respuesta.`);
        }
        return; // End processing after handling active conversation
    }

    // 2. ¿Nuevo disparador de conversación IA?
    if (!activeGeminiPrompt) { 
        const matchedStarter = geminiConversationStarters.find(starter => {
            const messageText = body.trim().toLowerCase();
            const triggerText = starter.trigger.trim().toLowerCase();
            return messageText.includes(triggerText) || messageText === triggerText;
        });

        if (matchedStarter) {
            const newActivePrompt = matchedStarter.prompt;
            console.log(`[Worker ${userId}][AI Starter] Match para ${sender} con trigger "${matchedStarter.trigger}".`);
            try {
                await chatDocRef.set({ activeGeminiPrompt: newActivePrompt }, { merge: true });
                console.log(`   -> Prompt activo asignado en Firestore: "${newActivePrompt}"`);
            } catch (dbError) {
                 console.error(`[Worker ${userId}][Firestore Error] Failed to set active prompt for ${sender}:`, dbError);
                 // Proceed with AI response anyway?
            }
            
            let starterContext = '';
            try {
                const recentMessagesSnap = await messagesColRef.orderBy('timestamp', 'desc').limit(10).get();
                const recentMessages = recentMessagesSnap.docs.reverse().map(doc => {
                    const msgData = doc.data();
                    return msgData.isFromMe ? `IA: ${msgData.body}` : `Usuario: ${msgData.body}`;
                });
                starterContext = recentMessages.join('\n');
            } catch (dbError) {
                console.error(`[Worker ${userId}][Firestore Error] Failed to fetch message context for starter ${sender}:`, dbError);
                starterContext = ' (Error cargando historial) ';
            }
            
            const firstResponsePrompt = `${basePrompt}${newActivePrompt}\n\n---\nHistorial Reciente:\n${starterContext}\n\n---\nPrimer Mensaje Recibido (que activó esto):\nUsuario: ${body}\n\n---\nTu Primera Respuesta (inicia la conversación según rol y directrices):`;
            
            console.log(`[Worker ${userId}][AI Starter] Enviando a Gemini...`);
            const result = await geminiModel.generateContent(firstResponsePrompt);
            const geminiResponse = await result.response.text();
            
            if (geminiResponse) {
                console.log(`[Worker ${userId}][AI Starter] Primera respuesta Gemini: "${geminiResponse}"`);
                await randomDelay(); // <<< AÑADIDO DELAY
                await client.sendMessage(sender, geminiResponse);
                try {
                    await messagesColRef.add({
                        from: `me (IA - ${userId})`,
                        to: sender,
                        body: geminiResponse,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        isFromMe: true
                    });
                    await chatDocRef.set({ lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
                } catch (dbError) {
                    console.error(`[Worker ${userId}][Firestore Error] Failed to save AI starter response for ${sender}:`, dbError);
                }
                // Keyword check should happen *after* potential response sending
                const lowerBodyStarter = body.toLowerCase().trim();
                const endKeywordsStarter = ['gracias', 'chau', 'nos vemos', 'adios', 'hasta luego'];
                if (endKeywordsStarter.some(keyword => lowerBodyStarter.includes(keyword))) {
                    console.log(`[Worker ${userId}][AI End Keyword] Detected end keyword from ${sender} after starter. Clearing active prompt.`);
                    try {
                        await chatDocRef.update({ activeGeminiPrompt: null });
                    } catch (dbError) {
                         console.error(`[Worker ${userId}][Firestore Error] Failed to clear active prompt after keyword/starter for ${sender}:`, dbError);
                    }
                }
                return; // End processing after handling starter
            } else {
                console.log(`[Worker ${userId}][AI Starter] Gemini no generó primera respuesta.`);
            }
            return; // End processing after handling starter
        }
    }

    // 3. ¿Regla simple?
    const matchingSimpleRule = autoReplyRules.find(rule => {
        const messageText = body.trim().toLowerCase();
        const triggerText = rule.trigger.trim().toLowerCase();
        return messageText.includes(triggerText) || messageText === triggerText;
    });

    if (matchingSimpleRule) {
        console.log(`[Worker ${userId}][Simple Rule] Match para ${sender}. Respondiendo: "${matchingSimpleRule.response}"`);
        await randomDelay(); // <<< AÑADIDO DELAY
        await client.sendMessage(sender, matchingSimpleRule.response);
        try {
            await messagesColRef.add({
                from: `me (Auto - ${userId})`,
                to: sender,
                body: matchingSimpleRule.response,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                isFromMe: true,
                isAutoReply: true // Optional flag
            });
            await chatDocRef.set({ lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch (dbError) {
            console.error(`[Worker ${userId}][Firestore Error] Failed to save auto-reply for ${sender}:`, dbError);
        }
        return;
    }

    // --- Comprobación y Ejecución de Flujos de Acción ---
    // 4. Check for Action Flow triggers (exact match, case-insensitive)
    const matchedFlow = actionFlows.find(flow =>
        body.trim().toLowerCase() === flow.trigger?.toLowerCase()
    );

    if (matchedFlow) {
        // En lugar de solo loggear, llamamos a la función de ejecución
        await executeActionFlow(message, matchedFlow);
        return; // Flujo ejecutado, detener procesamiento adicional para este mensaje
    } else {
        // --- Lógica de Respuesta IA por Defecto (solo si nada más aplicó) ---
        if (!activeGeminiPrompt) {
            // <<< ADDED: Presence Check before default response >>>
            if (isUserConsideredPresent()) {
                console.log(`[Worker ${userId}][Presence] User is present. Skipping default AI response for ${sender}.`);
                return; // Don't generate default response if user is active
            }
            // <<< END: Presence Check >>>

            console.log(`[Worker ${userId}][AI Default] No match rule/starter/flow & no active conv. Generating default response...`);
            
            let defaultContext = '';
            try {
                const recentMessagesSnap = await messagesColRef.orderBy('timestamp', 'desc').limit(10).get();
                const recentMessages = recentMessagesSnap.docs.reverse().map(doc => {
                    const msgData = doc.data();
                    return msgData.isFromMe ? `IA: ${msgData.body}` : `Usuario: ${msgData.body}`;
                });
                defaultContext = recentMessages.join('\n');
            } catch (dbError) {
                console.error(`[Worker ${userId}][Firestore Error] Failed to fetch message context for default AI ${sender}:`, dbError);
                defaultContext = ' (Error cargando historial) ';
            }
            
            const defaultAiPrompt = `${basePrompt}
---
Historial Reciente:
${defaultContext}

---
Mensaje Actual del Usuario:
Usuario: ${body}

---
Tu Respuesta (siguiendo rol, tono, directrices y contexto):`;

            console.log(`[Worker ${userId}][AI Default] Enviando prompt a Gemini...`);
            
            try {
                console.log(`[Worker ${userId}][Debug] Type of geminiModel before generateContent: ${typeof geminiModel}`); // Debug line
                const result = await geminiModel.generateContent(defaultAiPrompt);
                const geminiResponse = await result.response.text();

                if (geminiResponse) {
                    console.log(`[Worker ${userId}][AI Default] Respuesta Gemini generada: "${geminiResponse.substring(0, 60)}..."`);
                    await randomDelay(); // <<< AÑADIDO DELAY
                    await client.sendMessage(sender, geminiResponse);
                    try {
                        await messagesColRef.add({
                            from: `me (IA - ${userId})`,
                            to: sender,
                            body: geminiResponse,
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                            isFromMe: true
                        });
                        await chatDocRef.set({ lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
                    } catch (dbError) {
                        console.error(`[Worker ${userId}][Firestore Error] Failed to save default AI response for ${sender}:`, dbError);
                    }
                } else {
                    console.warn(`[Worker ${userId}][AI Default] Gemini no generó respuesta.`);
                    // Podríamos enviar un mensaje genérico tipo "No sé qué decir" o nada
                }
            } catch (geminiError) {
                console.error(`[Worker ${userId}][AI Default] Error llamando a Gemini:`, geminiError);
                sendErrorInfo(`Error en respuesta IA default: ${geminiError.message}`);
                // Podríamos enviar un mensaje de error al usuario
                // await client.sendMessage(sender, "(Lo siento, tuve un problema interno al pensar la respuesta.)");
            }
        }
    }

} catch (error) {
    console.error(`[Worker ${userId}][MSG Error] Error procesando mensaje de ${sender}:`, error);
    sendErrorInfo(`Error procesando mensaje: ${error.message}`); 
}
});

// === MANEJO DE COMANDOS IPC DEL MASTER ===
let isShuttingDown = false;

process.on('message', (message) => {
    // --- Log AÑADIDO para depurar recepción --- 
    console.log(`[Worker ${userId}] ===> process.on('message') RECIBIDO:`, JSON.stringify(message)); 

    if (!message || !message.type) {
        console.warn(`[Worker ${userId}] Mensaje IPC inválido recibido o sin tipo.`);
        return;
    }

    console.log(`[IPC Worker ${userId}] Comando recibido del Master (Tipo: ${message.type}):`, message);

    switch (message.type) {
        case 'COMMAND':
            handleCommand(message.command, message.payload);
            break;
            case 'SWITCH_AGENT':
                console.log(`[Worker ${userId}] Recibido comando para cambiar agente activo...`, message.payload);
                const switchPayload = message.payload;
                currentAgentId = switchPayload?.agentId || null;
                console.log(`[Worker ${userId}] ID de agente activo establecido a: ${currentAgentId || 'Ninguno (default)'}.`);
            
                if (switchPayload?.agentConfig) {
                    agentConfig = switchPayload.agentConfig;
                    console.log(`   -> Configuración de agente actualizada desde payload SWITCH_AGENT para: ${agentConfig.persona?.name || currentAgentId}`);
                } else if (!currentAgentId) {
                    agentConfig = { ...DEFAULT_AGENT_CONFIG }; // Volver a default si ID es null y no vino config
                    console.log(`   -> Usando configuración de agente por defecto (ID es null).`);
                } else {
                    // No vino config en el payload, pero hay un agentId. Se usará la config que ya tenga cargada 
                    // (posiblemente de INITIAL_CONFIG o un RELOAD anterior). Loguear advertencia.
                    console.warn(`   -> SWITCH_AGENT recibido para ${currentAgentId} SIN payload de config. Se usará la config en memoria si existe.`);
                    // En este punto, agentConfig NO se modifica.
                }
                break;
        case 'INITIAL_CONFIG': // <<< ADDED: Manejar configuración inicial >>>
            console.log(`[Worker ${userId}] Recibida configuración inicial del Master.`);
            const configPayload = message.payload;
            if (configPayload) {
                agentConfig = configPayload.agentConfig || { ...DEFAULT_AGENT_CONFIG };
                currentAgentId = agentConfig.id || null;
                
                autoReplyRules = Array.isArray(configPayload.rules) ? configPayload.rules : [];
                geminiConversationStarters = Array.isArray(configPayload.starters) ? configPayload.starters : [];
                actionFlows = Array.isArray(configPayload.flows) ? configPayload.flows : [];
                
                console.log(`   -> Agent Config Loaded: ${agentConfig.persona?.name || (currentAgentId ? `ID ${currentAgentId}` : 'Default')}`);
                console.log(`   -> Rules Loaded: ${autoReplyRules.length}`);
                console.log(`   -> Starters Loaded: ${geminiConversationStarters.length}`);
                console.log(`   -> Flows Loaded: ${actionFlows.length}`);
            } else {
                console.warn(`[Worker ${userId}] Mensaje INITIAL_CONFIG recibido SIN payload. Usando defaults.`);
                agentConfig = { ...DEFAULT_AGENT_CONFIG };
                autoReplyRules = [];
                geminiConversationStarters = [];
                actionFlows = [];
                currentAgentId = null;
            }
            break;
        case 'RELOAD_FLOWS':
            console.log(`[Worker ${userId}] Recibido comando para recargar flujos de acción...`);
            if (payload && Array.isArray(payload.flows)) { 
                actionFlows = payload.flows;
                console.log(`   -> Flujos de acción actualizados desde payload. Total: ${actionFlows.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_FLOWS recibido sin payload de flujos válido. No se puede actualizar.`);
            }
            break;
        case 'RELOAD_RULES': // <<< ADDED
            console.log(`[Worker ${userId}] Recibido comando RELOAD_RULES.`);
            if (payload && Array.isArray(payload.rules)) {
                autoReplyRules = payload.rules;
                console.log(`   -> Reglas actualizadas desde payload. Total: ${autoReplyRules.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_RULES recibido sin payload de reglas válido. No se puede actualizar.`);
            }
            break;
        case 'RELOAD_STARTERS': // <<< ADDED
            console.log(`[Worker ${userId}] Recibido comando RELOAD_STARTERS.`);
            if (payload && Array.isArray(payload.starters)) {
                geminiConversationStarters = payload.starters;
                console.log(`   -> Starters actualizados desde payload. Total: ${geminiConversationStarters.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_STARTERS recibido sin payload de starters válido. No se puede actualizar.`);
            }
            break;
        case 'RELOAD_AGENT_CONFIG': // <<< ADDED
             console.log(`[Worker ${userId}] Recibido comando RELOAD_AGENT_CONFIG.`);
            if (payload && payload.agentConfig && payload.agentConfig.id === currentAgentId) {
                agentConfig = payload.agentConfig;
                console.log(`   -> Configuración para agente activo (${currentAgentId}) actualizada desde payload.`);
            } else if (payload && payload.agentConfig && payload.agentConfig.id !== currentAgentId){
                 console.warn(`   -> Recibido RELOAD_AGENT_CONFIG para agente ${payload.agentConfig.id}, pero el agente activo es ${currentAgentId}. Configuración no aplicada.`);
             } else if (!payload || !payload.agentConfig) {
                console.warn(`   -> Comando RELOAD_AGENT_CONFIG recibido sin payload de config válido. No se puede actualizar.`);
            }
            break;
         // TODO: Añadir case para 'RELOAD_CONFIG' (para otras configs)
         // ...
        default:
            console.warn(`[IPC Worker ${userId}] Tipo de mensaje no reconocido: ${message.type}`);
    }
});

function handleCommand(command, payload) {
    console.log(`[Worker ${userId}] Procesando comando: ${command}`);
    switch (command) {
        case 'SHUTDOWN':
            console.log(`[Worker ${userId}] ===> ENTRANDO al case SHUTDOWN`); // Log inicio case
            if (!isShuttingDown) {
                isShuttingDown = true;
                console.log(`[Worker ${userId}] Iniciando cierre ordenado... (isShuttingDown = true)`);
                if (client) {
                     console.log(`[Worker ${userId}] ===> INTENTANDO llamar a client.destroy()...`); // Log antes destroy
                     client.destroy() // Intenta cerrar la sesión de WhatsApp limpiamente
                        .then(() => {
                            console.log(`[Worker ${userId}] ===> client.destroy() COMPLETADO (then).`); // Log en then
                            console.log(`[Worker ${userId}] Cliente WhatsApp destruido. Saliendo con process.exit(0)...`);
                            process.exit(0); // Salir después de destruir
                        })
                        .catch(err => {
                            console.error(`[Worker ${userId}] ===> ERROR CAPTURADO en .catch() de client.destroy():`, err); // Log en catch
                            console.error(`[Worker ${userId}] Saliendo con process.exit(1) debido a error en destroy...`);
                            process.exit(1); // Salir con error si falla
                        });
                     console.log(`[Worker ${userId}] ===> Código DESPUÉS de la llamada a client.destroy() alcanzado.`); // Log después de llamada (no espera)
                } else {
                    console.log(`[Worker ${userId}] Cliente no inicializado, saliendo directamente con process.exit(0).`);
                    process.exit(0);
                }
                 // Poner un temporizador por si destroy() se cuelga
                 console.log(`[Worker ${userId}] ===> Estableciendo setTimeout de 10 segundos para forzar salida.`);
                 setTimeout(() => {
                    console.warn(`[Worker ${userId}] ===> TIMEOUT de cierre alcanzado! Forzando salida con process.exit(1).`); // Log en timeout
                    process.exit(1);
                 }, 10000); // 10 segundos de gracia
            } else {
                console.log(`[Worker ${userId}] ===> Comando SHUTDOWN recibido pero ya estaba en proceso de cierre (isShuttingDown=true).`);
            }
            break;
        case 'RELOAD_FLOWS':
            console.log(`[Worker ${userId}] Recibido comando para recargar flujos de acción...`);
            if (payload && Array.isArray(payload.flows)) { 
                actionFlows = payload.flows;
                console.log(`   -> Flujos de acción actualizados desde payload. Total: ${actionFlows.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_FLOWS recibido sin payload de flujos válido. No se puede actualizar.`);
            }
            break;
        case 'SWITCH_AGENT':
            console.log(`[Worker ${userId}] Procesando comando SWITCH_AGENT...`, payload);
            const newAgentId = payload?.agentId || null;
            currentAgentId = newAgentId;
            console.log(`[Worker ${userId}] ID de agente activo establecido a: ${currentAgentId || 'Ninguno (default)'}.`);
            if (!currentAgentId) {
                console.log(`   -> Usando configuración de agente por defecto (ID es null).`);
                agentConfig = { ...DEFAULT_AGENT_CONFIG };
            } else {
                 console.log(`   -> Se espera que la configuración para el agente ${currentAgentId} se reciba por separado si es necesario.`);
            }
            break;
        case 'RELOAD_RULES': // <<< ADDED
            console.log(`[Worker ${userId}] Recibido comando RELOAD_RULES.`);
            if (payload && Array.isArray(payload.rules)) {
                autoReplyRules = payload.rules;
                console.log(`   -> Reglas actualizadas desde payload. Total: ${autoReplyRules.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_RULES recibido sin payload de reglas válido. No se puede actualizar.`);
            }
            break;
        case 'RELOAD_STARTERS': // <<< ADDED
            console.log(`[Worker ${userId}] Recibido comando RELOAD_STARTERS.`);
            if (payload && Array.isArray(payload.starters)) {
                geminiConversationStarters = payload.starters;
                console.log(`   -> Starters actualizados desde payload. Total: ${geminiConversationStarters.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_STARTERS recibido sin payload de starters válido. No se puede actualizar.`);
            }
            break;
        case 'RELOAD_AGENT_CONFIG': // <<< ADDED
             console.log(`[Worker ${userId}] Recibido comando RELOAD_AGENT_CONFIG.`);
            if (payload && payload.agentConfig && payload.agentConfig.id === currentAgentId) {
                agentConfig = payload.agentConfig;
                console.log(`   -> Configuración para agente activo (${currentAgentId}) actualizada desde payload.`);
            } else if (payload && payload.agentConfig && payload.agentConfig.id !== currentAgentId){
                 console.warn(`   -> Recibido RELOAD_AGENT_CONFIG para agente ${payload.agentConfig.id}, pero el agente activo es ${currentAgentId}. Configuración no aplicada.`);
             } else if (!payload || !payload.agentConfig) {
                console.warn(`   -> Comando RELOAD_AGENT_CONFIG recibido sin payload de config válido. No se puede actualizar.`);
            }
            break;
         // TODO: Añadir case para 'RELOAD_CONFIG' (para otras configs)
         // ...
        default:
            console.warn(`[Worker ${userId}] Comando no reconocido: ${command}`);
    }
}

// --- Inicializar el Cliente WhatsApp ---
// <<< ADDED: Comment on whatsapp-web.js stability >>>
// Production Note: whatsapp-web.js relies on reverse engineering WhatsApp Web.
// Updates by WhatsApp can break functionality unexpectedly. Robust monitoring and
// a plan for quick updates/fixes are essential for production systems.
// <<< END: Comment >>>
try {
    console.log(`[Worker ${userId}] ===> INTENTANDO LLAMAR a client.initialize()...`); // Log ANTES
    client.initialize()
        .then(() => {
            console.log(`[Worker ${userId}] ===> LLAMADA a client.initialize() EJECUTADA (esperando eventos como QR/Ready)...`);
        })
        .catch(err => {
            console.error(`[Worker ${userId}] ===> ERROR CAPTURADO en .catch() de client.initialize():`, err);
            sendErrorInfo(`Error en client.initialize(): ${err.message}`);
            process.exit(1); // Salir si la inicialización falla catastróficamente
        });
    console.log(`[Worker ${userId}] ===> Código después de la llamada a client.initialize() alcanzado.`);

} catch (initError) {
     console.error(`[Worker ${userId}] ===> ERROR CRÍTICO CAPTURADO en try/catch general de inicialización:`, initError);
     sendErrorInfo(`Error crítico inicialización: ${initError.message}`);
     process.exit(1);
}

console.log(`[Worker ${userId}] Worker activo y escuchando.`);