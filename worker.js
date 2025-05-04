const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); // Usar LocalAuth para sesiones persistentes
const qrcodeTerminal = require('qrcode-terminal'); // La que ya tenías, renombrada
const qrcodeDataUrl = require('qrcode');
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

// Variables para almacenar reglas y flujos
let autoReplyRules = []; // Reglas simples de respuesta automática
let geminiConversationStarters = []; // Starters de conversación con Gemini
let actionFlows = []; // Flujos de acción

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

// <<< ADDED: Function to update status in Firestore >>>
async function updateFirestoreStatus(statusData) {
    if (!firestoreDbWorker) {
        console.error(`[Worker ${userId}][Firestore Status] Firestore DB instance not available. Cannot update status.`);
        return;
    }
    if (!userId) {
        console.error(`[Worker ${userId}][Firestore Status] User ID not available. Cannot update status.`);
        return;
    }

    const statusDocRef = firestoreDbWorker.collection('users').doc(userId).collection('status').doc('whatsapp');
    const dataToSet = {
        ...statusData, // status, qrCodeUrl, error, message
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    // Remove undefined/null fields to avoid Firestore issues if needed
    Object.keys(dataToSet).forEach(key => (dataToSet[key] === undefined || dataToSet[key] === null) && delete dataToSet[key]);

    console.log(`[Worker ${userId}][Firestore Status] Updating status document with:`, dataToSet);
    try {
        await statusDocRef.set(dataToSet, { merge: true });
        console.log(`[Worker ${userId}][Firestore Status] Document updated successfully.`);
    } catch (error) {
        console.error(`[Worker ${userId}][Firestore Status] Error updating document:`, error);
        // Optionally send error to master process
        sendErrorInfo(`Firestore status update failed: ${error.message}`);
    }
}
// <<< END: Function to update status in Firestore >>>

// <<< ADDED: Gemini Initialization with try...catch >>>
try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not defined.");
    }
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    console.log(`[Worker ${userId}] Gemini Model initialized successfully. Type: ${typeof geminiModel}`); // Log success and type
} catch(geminiInitError) {
    console.error(`[Worker ${userId}][ERROR CRÍTICO] Initializing GoogleGenerativeAI:`, geminiInitError);
    sendErrorInfo(`Critical Gemini Init Error: ${geminiInitError.message}`);
    // Exit? If Gemini is essential, the worker might be useless without it.
    process.exit(1);
}
// <<< END: Gemini Initialization >>>

// <<< ADDED: Sistema de rate limiting para Gemini >>>
// Variables para el rate limiting
let geminiRequestsInLastMinute = 0;
let geminiRequestsTimestamps = [];
const MAX_GEMINI_REQUESTS_PER_MINUTE = 30; // Ajustar según límites de tu API
const REQUEST_TRACKING_WINDOW_MS = 60000; // 1 minuto en milisegundos

// Función para verificar y gestionar rate limiting
function checkGeminiRateLimit() {
    const now = Date.now();

    // Eliminar timestamps antiguos (mayores a 1 minuto)
    geminiRequestsTimestamps = geminiRequestsTimestamps.filter(timestamp =>
        now - timestamp < REQUEST_TRACKING_WINDOW_MS
    );

    // Verificar cuántas solicitudes hemos hecho en el último minuto
    geminiRequestsInLastMinute = geminiRequestsTimestamps.length;

    // Si estamos cerca del límite, esperar
    if (geminiRequestsInLastMinute >= MAX_GEMINI_REQUESTS_PER_MINUTE) {
        const oldestRequest = geminiRequestsTimestamps[0];
        const timeToWaitMs = REQUEST_TRACKING_WINDOW_MS - (now - oldestRequest) + 100; // +100ms de margen
        console.warn(`[Worker ${userId}][RATE LIMIT] Límite de solicitudes Gemini alcanzado (${geminiRequestsInLastMinute}/${MAX_GEMINI_REQUESTS_PER_MINUTE}). Esperando ${timeToWaitMs}ms...`);
        return timeToWaitMs;
    }

    // Si no hay problema, registrar la nueva solicitud
    geminiRequestsTimestamps.push(now);
    return 0; // No es necesario esperar
}

// <<< ADDED: Respuestas de fallback para cuando Gemini no está disponible >>>
const FALLBACK_RESPONSES = [
    "Lo siento, en este momento estoy experimentando una alta demanda. ¿Podrías intentar de nuevo en unos minutos?",
    "Disculpa la interrupción. Estoy procesando muchas consultas en este momento. Por favor, inténtalo de nuevo más tarde.",
    "Parece que hay mucho tráfico en el sistema. Intentaré responder tu mensaje más tarde cuando haya menos carga.",
    "Estoy teniendo dificultades para procesar tu solicitud en este momento debido a limitaciones temporales de recursos. Te atenderé en cuanto pueda."
];

// Función para obtener una respuesta de fallback aleatoria
function getFallbackResponse() {
    const randomIndex = Math.floor(Math.random() * FALLBACK_RESPONSES.length);
    return FALLBACK_RESPONSES[randomIndex];
}

// Actualizar callGeminiWithRetry para usar respuestas de fallback cuando sea necesario
async function callGeminiWithRetry(prompt, chatId = null, maxRetries = 3, initialBackoffMs = 1000) {
    let retryCount = 0;
    let backoffMs = initialBackoffMs;

    // Verificar rate limiting antes de hacer la solicitud
    const waitTimeMs = checkGeminiRateLimit();
    if (waitTimeMs > 0) {
        console.log(`[Worker ${userId}][Gemini] Esperando ${waitTimeMs}ms por rate limiting...`);
        await new Promise(resolve => setTimeout(resolve, waitTimeMs));
    }

    // Si se proporcionó chatId, rastreamos tokens de esta conversación
    if (chatId) {
        // Registrar el prompt del usuario en el tracking
        trackMessageTokens(chatId, 'user', prompt);
    }

    while (retryCount <= maxRetries) {
        try {
            console.log(`[Worker ${userId}][Gemini] Intento ${retryCount + 1}/${maxRetries + 1} para generar contenido`);
            const result = await geminiModel.generateContent(prompt);
            const responseText = await result.response.text();

            // Si se proporcionó chatId, rastreamos la respuesta en el tracking
            if (chatId && responseText) {
                trackMessageTokens(chatId, 'assistant', responseText);
            }

            return responseText;
        } catch (error) {
            console.error(`[Worker ${userId}][Gemini] Error en intento ${retryCount + 1}:`, error);
            // Verificar si es un error de cuota (429)
            if (error.status === 429) {
                const retryDelay = error.errorDetails?.find(detail =>
                    detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
                )?.retryDelay;

                // Extraer segundos del retryDelay si está presente ('24s' -> 24000)
                let waitTime = backoffMs;
                if (retryDelay) {
                    const seconds = parseInt(retryDelay.replace('s', ''));
                    if (!isNaN(seconds)) {
                        waitTime = seconds * 1000;
                        console.log(`[Worker ${userId}][Gemini] Google recomienda esperar ${seconds}s antes de reintentar`);
                    }
                }

                // Aumentar backoff para el próximo intento
                backoffMs = backoffMs * 2;

                if (retryCount < maxRetries) {
                    console.log(`[Worker ${userId}][Gemini] Error de cuota (429). Esperando ${waitTime/1000}s antes de reintentar...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    retryCount++;
                    continue;
                }
            }

            // Si no es un error de cuota o se acabaron los intentos, propagar el error
            if (retryCount >= maxRetries) {
                console.error(`[Worker ${userId}][Gemini] Se agotaron los reintentos (${maxRetries + 1}). Error: ${error.message}`);
                // En lugar de propagar el error, devolver una respuesta de fallback
                console.log(`[Worker ${userId}][Gemini] Utilizando respuesta de fallback`);
                const fallbackResponse = getFallbackResponse();

                // Registrar la respuesta de fallback en el tracking
                if (chatId) {
                    trackMessageTokens(chatId, 'assistant', fallbackResponse);
                }

                return fallbackResponse;
            }

            // Para otros errores, implementar backoff exponencial
            if (retryCount < maxRetries) {
                console.log(`[Worker ${userId}][Gemini] Reintentando en ${backoffMs/1000}s...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                backoffMs = backoffMs * 2; // Backoff exponencial
                retryCount++;
            } else {
                // En lugar de propagar el error, devolver una respuesta de fallback
                console.log(`[Worker ${userId}][Gemini] Utilizando respuesta de fallback por error general`);
                const fallbackResponse = getFallbackResponse();

                // Registrar la respuesta de fallback en el tracking
                if (chatId) {
                    trackMessageTokens(chatId, 'assistant', fallbackResponse);
                }

                return fallbackResponse;
            }
        }
    }
}
// <<< END: Sistema de rate limiting para Gemini >>>

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
    return templateString.replace(/{{([^}]+)}}/g, (match, path) => {
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
                    console.log(`   -> Ejecutando send_message: "${resolvedContent.substring(0, 30)}..."`);
                    try {
                        await randomDelay();
                        // Usar la nueva función unificada para enviar mensajes del bot
                        await sendBotMessage(context.message.from, resolvedContent, "Flow");
                        console.log(`   -> Mensaje de flujo enviado y guardado correctamente.`);
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
                        let promptToUse = resolvedPrompt;

                        // Si se solicita usar historial de conversación
                        if (step.useConversationHistory === true) {
                            try {
                                // Construir prompt con historial
                                promptToUse = await buildPromptWithHistory(
                                    context.message.from,
                                    resolvedPrompt, // Usamos el prompt resuelto como el "mensaje actual"
                                    agentConfig.persona
                                );
                                console.log(`   -> [Flow Gemini] Usando prompt con historial de conversación`);
                            } catch (historyError) {
                                console.error(`   -> [Flow Gemini] Error construyendo historial:`, historyError);
                                // Si falla, usar el prompt resuelto original
                            }
                        }

                        const result = await callGeminiWithRetry(promptToUse, context.message.from);
                        const geminiResponseText = await result;

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
    try {
        console.log(`
[Worker ${userId}][Flow Engine] ====== EJECUTANDO FLUJO: ${flow.name} (ID: ${flow.id}) ======`);
        console.log(`[Worker ${userId}][Flow Engine] Trigger: "${flow.trigger}", Pasos: ${flow.steps?.length || 0}`);

        // Configuración inicial del contexto
        const context = {
            message: message,
            flow: flow,
            variables: {},
            // Adicionar variables "mágicas" útiles
            userId: userId,
            sender: message.from,
            messageBody: message.body,
            timestamp: new Date().toISOString(),
            // Valores recuperados de la sesión
            user: { name: agentConfig.persona?.name || 'Asistente' }
        };

        // Verificar si el flujo tiene pasos
        if (!flow.steps || !Array.isArray(flow.steps) || flow.steps.length === 0) {
            console.log(`[Worker ${userId}][Flow Engine] Flujo sin pasos definidos. Respondiendo con mensaje predeterminado.`);
            await randomDelay();
            await sendBotMessage(message.from, "Flujo activado pero sin acciones definidas.", "Flow");
            return;
        }

        // Ejecutar los pasos
        await executeSteps(flow.steps, context);
        console.log(`[Worker ${userId}][Flow Engine] ====== FLUJO COMPLETADO ======`);
    } catch (error) {
        console.error(`[Worker ${userId}][Flow Engine] Error ejecutando flujo:`, error);
        try {
            // Enviar mensaje de error (en producción esto debería ser más amigable)
            await randomDelay();
            await sendBotMessage(message.from, "Lo siento, ocurrió un error al procesar tu solicitud.", "Flow");
        } catch (sendError) {
            console.error(`[Worker ${userId}][Flow Engine] Error enviando mensaje de error:`, sendError);
        }
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

// AÑADIR FUNCIÓN DE DIAGNÓSTICO DE PUPPETEER
async function diagnosePuppeteerEnvironment() {
    console.log(`[Worker ${userId}][DIAGNÓSTICO] Verificando entorno para Puppeteer...`);
    try {
        // Verificar requisitos del sistema
        const chromiumPath = require('puppeteer').executablePath();
        console.log(`[Worker ${userId}][DIAGNÓSTICO] Ruta ejecutable Chromium: ${chromiumPath}`);

        // Verificar si la ruta existe
        if (fs.existsSync(chromiumPath)) {
            console.log(`[Worker ${userId}][DIAGNÓSTICO] ✅ Ejecutable Chromium encontrado`);
        } else {
            console.error(`[Worker ${userId}][DIAGNÓSTICO] ❌ Ejecutable Chromium NO ENCONTRADO en la ruta`);
        }

        // Verificar permisos y espacio en disco
        try {
            const stats = fs.statSync(chromiumPath);
            console.log(`[Worker ${userId}][DIAGNÓSTICO] Permisos Chromium: ${stats.mode}, Tamaño: ${stats.size} bytes`);
        } catch (statErr) {
            console.error(`[Worker ${userId}][DIAGNÓSTICO] ❌ Error verificando permisos: ${statErr.message}`);
        }

        // Verificar dependencias
        try {
            const { execSync } = require('child_process');
            const libsCheck = execSync('ldd $(which chromium-browser) | grep "not found" || echo "All dependencies OK"').toString();
            console.log(`[Worker ${userId}][DIAGNÓSTICO] Verificación dependencias:
${libsCheck}`);
        } catch (libErr) {
            console.error(`[Worker ${userId}][DIAGNÓSTICO] ❌ Error verificando dependencias: ${libErr.message}`);
        }

        // Verificar memoria disponible
        try {
            const { execSync } = require('child_process');
            const memInfo = execSync('free -m').toString();
            console.log(`[Worker ${userId}][DIAGNÓSTICO] Información de memoria:
${memInfo}`);
        } catch (memErr) {
            console.error(`[Worker ${userId}][DIAGNÓSTICO] ❌ Error verificando memoria: ${memErr.message}`);
        }

        console.log(`[Worker ${userId}][DIAGNÓSTICO] Verificación de entorno completada`);
    } catch (error) {
        console.error(`[Worker ${userId}][DIAGNÓSTICO] ❌ Error general: ${error.message}`);
    }
}

// Ejecutar diagnóstico antes de inicializar
diagnosePuppeteerEnvironment()
    .then(() => {
        console.log(`[Worker ${userId}][CRITICAL] ANTES de client.initialize(). Client tipo: ${typeof client}, isValid: ${!!client}`);
        try {
            client.initialize()
                .then(() => {
                    console.log(`[Worker ${userId}][CRITICAL] client.initialize() completado con éxito en el .then()`);
                })
                .catch(initError => {
                    console.error(`[Worker ${userId}][CRITICAL] ERROR en client.initialize().catch():`, initError);
                    sendErrorInfo(`Error en initialize(): ${initError.message}`);
                    // Notificar al servidor sobre el error crítico
                    sendStatusUpdate('error', `Error de inicialización: ${initError.message}`);
                });
            console.log(`[Worker ${userId}][CRITICAL] Llamada a client.initialize() realizada. Esperando eventos...`);
        } catch (outerError) {
            console.error(`[Worker ${userId}][CRITICAL] ERROR EXTERNO al llamar client.initialize():`, outerError);
            sendErrorInfo(`Error externo initialize(): ${outerError.message}`);
            sendStatusUpdate('error', `Error crítico: ${outerError.message}`);
        }
    })
    .catch(diagErr => {
        console.error(`[Worker ${userId}][CRITICAL] Error en diagnóstico previo: ${diagErr.message}`);
        sendErrorInfo(`Error en diagnóstico previo: ${diagErr.message}`);
        sendStatusUpdate('error', `Error en diagnóstico previo: ${diagErr.message}`);
});

client.on('qr', async (qr) => { // Ya era async
    console.log(`[Worker ${userId}] QR Recibido. Processing...`);
    sendStatusUpdate('generating_qr');
    let qrDataURL = null; // Declarar fuera para usarla en updateFirestoreStatus
    try {
        // 1. Generar ASCII para consola (Opcional) - Usa qrcodeTerminal
        try {
            await qrcodeTerminal.generate(qr, { small: true });
        } catch (asciiErr) {
            console.error(`[Worker ${userId}] Error generando QR ASCII para consola:`, asciiErr);
        }

        // 2. Generar la Base64 Data URL - Usa qrcodeDataUrl
        qrDataURL = await qrcodeDataUrl.toDataURL(qr); // <-- Guarda la URL generada
        console.log(`[Worker ${userId}] QR Data URL generado (longitud: ${qrDataURL.length})`);

        // 3. Enviar la DATA URL (utilizable en <img>) al servidor
        sendQrCode(qrDataURL); // <-- Envía la Data URL correcta

        // <<< ADDED: Update Firestore Status with the generated Data URL >>>
        await updateFirestoreStatus({ status: 'generating_qr', qrCodeUrl: qrDataURL, error: null, message: 'Scan QR code' });

    } catch (err) {
        // Este catch ahora cubre errores de toDataURL o generate
        console.error(`[Worker ${userId}] ERROR procesando QR:`, err);
        sendStatusUpdate('error', 'Error procesando QR');
        // <<< ADDED: Update Firestore Status on Error >>>
        await updateFirestoreStatus({ status: 'error', qrCodeUrl: null, error: 'Error processing QR', message: err.message });
    }
});

// Eventos de depuración adicionales de Puppeteer para WhatsApp Web
client.pupBrowser?.on('disconnected', () => {
    console.error(`[Worker ${userId}][CRITICAL] Navegador Puppeteer desconectado inesperadamente`);
    sendStatusUpdate('error', 'Navegador Puppeteer desconectado');
});

client.on('ready', async () => { // <<< ADDED async >>>
    console.log(`[Worker ${userId}] Cliente WhatsApp LISTO!`);
    sendStatusUpdate('connected'); // Informar al master
    // <<< ADDED: Update Firestore Status >>>
    await updateFirestoreStatus({ status: 'connected', qrCodeUrl: null, error: null, message: 'Client is ready' });
});

client.on('authenticated', async () => { // <<< ADDED async >>>
    console.log(`[Worker ${userId}] Cliente AUTENTICADO`);
    // Podríamos enviar un estado intermedio si quisiéramos
    // sendStatusUpdate('authenticated');
    // <<< ADDED: Update Firestore Status (optional intermediate state) >>>
    await updateFirestoreStatus({ status: 'authenticated', qrCodeUrl: null, error: null, message: 'Client authenticated' });
});

client.on('auth_failure', async (msg) => { // <<< ADDED async >>>
    console.error(`[Worker ${userId}] FALLO DE AUTENTICACIÓN: ${msg}`);
    sendStatusUpdate('error', `Fallo de autenticación: ${msg}`);
    // <<< ADDED: Update Firestore Status >>>
    await updateFirestoreStatus({ status: 'error', qrCodeUrl: null, error: 'Authentication Failure', message: msg });
    // Production Consideration: Decide if auth failure is fatal. Often it is.
    // Consider exiting: process.exit(1);
});

client.on('disconnected', async (reason) => { // <<< ADDED async >>>
  console.log(`[Worker ${userId}] Cliente DESCONECTADO:`, reason);
  // No in-memory state to clear anymore.
  sendStatusUpdate('disconnected', `Desconectado: ${reason}`);
  // <<< ADDED: Update Firestore Status >>>
  // Ensure reason is a string or provide a default
  const disconnectMessage = typeof reason === 'string' ? reason : JSON.stringify(reason);
  await updateFirestoreStatus({ status: 'disconnected', qrCodeUrl: null, error: null, message: `Disconnected: ${disconnectMessage}` });
  // ¿Intentar reiniciar automáticamente? Por ahora no.
});

client.on('loading_screen', (percent, message) => {
    console.log(`[Worker ${userId}] Cargando: ${percent}% - ${message}`);
    // Podríamos enviar este progreso al Master si quisiéramos
});

// Eventos adicionales para diagnosticar problemas de conectividad
client.on('change_state', state => {
    console.log(`[Worker ${userId}][STATE] Estado del cliente cambiado a: ${state}`);
});

client.on('change_battery', batteryInfo => {
    console.log(`[Worker ${userId}][BATTERY] Info batería actualizada:`, batteryInfo);
});

// Monitorear TODOS los tipos de mensajes
client.on('message', async (message) => {
  // <<< AÑADIR ESTOS LOGS EXTENSIVOS AL INICIO DEL EVENTO >>>
  console.log(`
[Worker ${userId}][MESSAGE EVENT v2] ====== NUEVO MENSAJE DETECTADO ======`);
  console.log(`[Worker ${userId}][MESSAGE EVENT v2] Timestamp: ${new Date().toISOString()}`);
  console.log(`[Worker ${userId}][MESSAGE EVENT v2] Message ID: ${message.id?.id || 'unknown'}`);
  console.log(`[Worker ${userId}][MESSAGE EVENT v2] From: ${message.from || 'unknown'}`);
  console.log(`[Worker ${userId}][MESSAGE EVENT v2] To: ${message.to || 'unknown'}`);
  console.log(`[Worker ${userId}][MESSAGE EVENT v2] FromMe: ${message.fromMe}`);
  console.log(`[Worker ${userId}][MESSAGE EVENT v2] Body: "${message.body?.substring(0, 100)}..."`);
  console.log(`[Worker ${userId}][MESSAGE EVENT v2] HasMedia: ${!!message.hasMedia}`);
  console.log(`[Worker ${userId}][MESSAGE EVENT v2] IsGroup: ${message.id?.remote?.endsWith('@g.us') || false}`);

  // <<< VERIFICAR SI PUPPETEER SIGUE FUNCIONANDO >>>
  try {
    if (!client.pupBrowser || !client.pupPage) {
      console.error(`[Worker ${userId}][ERROR CRÍTICO] Puppeteer browser/page no disponible en evento message. Browser: ${!!client.pupBrowser}, Page: ${!!client.pupPage}`);
      sendErrorInfo(`Puppeteer no disponible al procesar mensaje. Es posible que se haya desconectado.`);
    } else {
      console.log(`[Worker ${userId}][PUPPETEER STATUS] Browser: OK, Page: OK`);
    }
  } catch (puppeteerCheckError) {
    console.error(`[Worker ${userId}][ERROR CRÍTICO] Error verificando estado Puppeteer:`, puppeteerCheckError);
  }

  const sender = message.from;
  const isFromMe = message.fromMe;

  // Ignorar procesar mensajes de grupos si el tipo de mensaje no es soportado
  if (sender.endsWith('@g.us')) {
    console.log(`[Worker ${userId}][MESSAGE EVENT v2] Mensaje de grupo detectado. No procesando por ahora.`);
    return;
  }

  // Manejar mensajes multimedia: por ahora solo loguear
  if (message.hasMedia) {
    console.log(`[Worker ${userId}][MESSAGE EVENT v2] Mensaje con multimedia detectado:`, message.type);
    // En una versión futura, podrías descargar y procesar media
    // Por ahora, continuamos procesando como mensaje normal y solo usamos el body
  }

  const chatPartnerId = message.to;
  // Asegurar que existen las colecciones necesarias para este chat
  await ensureChatCollections(chatPartnerId);

  // Obtener timestamp único para todas las operaciones
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

  // Referencias Firestore
  const chatDocRef = firestoreDbWorker.collection('users').doc(userId).collection('chats').doc(chatPartnerId);
  const allMessagesColRef = chatDocRef.collection('messages_all');
  const humanMessagesColRef = chatDocRef.collection('messages_human');
  const botMessagesColRef = chatDocRef.collection('messages_bot');
  const contactMessagesColRef = chatDocRef.collection('messages_contact');

  // === PROCESAMIENTO SEGÚN EL ORIGEN ===
  try {
    if (isFromMe) {
      // CASO 1: Mensaje saliente (de mí)
      // Estos deberían manejarse principalmente en message_create
      // Aquí solo los guardamos como respaldo
      console.log(`[Worker ${userId}][MESSAGE EVENT v2] Procesando mensaje saliente (isFromMe=true)...`);
      // Nota: Este mensaje PUEDE ser del bot, message_create debería haber manejado
      // los mensajes genuinos del usuario. Por precaución, solo lo guardamos en messages_all
      await allMessagesColRef.add({
        body: message.body,
        timestamp: serverTimestamp,
        isFromMe: true,
        messageId: message.id.id,
        from: `me (${userId}) - via message event`,
        to: chatPartnerId,
        // Sin especificar origin para evitar confusión
      });

      console.log(`[Worker ${userId}][MESSAGE EVENT v2] Mensaje saliente guardado en messages_all (como respaldo).`);

      // No actualizamos estado de actividad aquí para evitar conflictos con message_create
      return; // IMPORTANTE: Salir aquí para no procesar auto-respuestas a mensajes propios
    } else {
      // CASO 2: Mensaje entrante (de otra persona)
      console.log(`[Worker ${userId}][MESSAGE EVENT v2] Procesando mensaje entrante (isFromMe=false)...`);

      // Guardar en messages_contact
      await contactMessagesColRef.add({
        body: message.body,
        timestamp: serverTimestamp,
        isFromMe: false,
        messageId: message.id.id,
        from: chatPartnerId,
        to: `me (${userId})`,
        origin: 'contact'
      });

      // Guardar en messages_all
      await allMessagesColRef.add({
        body: message.body,
        timestamp: serverTimestamp,
        isFromMe: false,
        messageId: message.id.id,
        from: chatPartnerId,
        to: `me (${userId})`,
        origin: 'contact'
      });

      // Actualizar documento del chat
      await chatDocRef.set({
        lastContactMessageTimestamp: serverTimestamp,
        lastMessageTimestamp: serverTimestamp,
        lastMessageContent: message.body
      }, { merge: true });

      console.log(`[Worker ${userId}][MESSAGE EVENT v2] Mensaje entrante guardado en messages_contact y messages_all.`);


      // --- Verificar si el usuario está activo para decidir si responder automáticamente ---
      console.log(`[Worker ${userId}][PRESENCE CHECK v2] Verificando actividad...`);
      const userIsActive = await isUserActiveInChat(userId, sender);
      console.log(`[Worker ${userId}][PRESENCE CHECK v2] Resultado: ${userIsActive ? 'ACTIVO' : 'INACTIVO'} (${userIsActive ? 'no responder automáticamente' : 'responder automáticamente'})`);

      // Si el usuario está inactivo, procesar respuestas automáticas
      if (!userIsActive) {
        console.log(`[Worker ${userId}][AUTO-REPLY v2] Usuario INACTIVO. Procesando posibles respuestas automáticas para: ${sender}`);


        // 1. Verificar si hay un flujo activado por el mensaje
        const matchedFlow = actionFlows.find(flow => {
          const messageTextLower = message.body.trim().toLowerCase();
          const triggerTextLower = flow.trigger?.trim().toLowerCase();
          return messageTextLower === triggerTextLower;
        });

        if (matchedFlow) {
          console.log(`[Worker ${userId}][AUTO-REPLY v2] Encontrado flujo coincidente: ${matchedFlow.name} (ID: ${matchedFlow.id}). Ejecutando...`);
          await executeActionFlow(message, matchedFlow);
          return; // Terminar aquí si se ejecutó un flujo
        }

        // 2. Verificar si hay una regla simple que coincida
        const matchingSimpleRule = autoReplyRules.find(rule => {
          const messageTextInternal = message.body.trim().toLowerCase();
          const triggerText = rule.trigger.trim().toLowerCase();
          return messageTextInternal.includes(triggerText) || messageTextInternal === triggerText;
        });

        if (matchingSimpleRule) {
          console.log(`[Worker ${userId}][AUTO-REPLY v2] Encontrada regla simple coincidente. Respondiendo: "${matchingSimpleRule.response}"`);
          await randomDelay();
          // Usar la nueva función unificada para enviar mensajes del bot
          await sendBotMessage(sender, matchingSimpleRule.response, "Auto");
          return; // Terminar aquí si se ejecutó una regla simple
        }

        // 3. Verificar si hay un starter de conversación Gemini
        const matchedStarter = geminiConversationStarters.find(starter => {
          const messageTextInternal = message.body.trim().toLowerCase();
          const triggerText = starter.trigger.trim().toLowerCase();
          return messageTextInternal.includes(triggerText) || messageTextInternal === triggerText;
        });

        if (matchedStarter) {
          console.log(`[Worker ${userId}][AUTO-REPLY v2] Encontrado starter Gemini: "${matchedStarter.trigger}". Generando respuesta...`);

          try {
            // Usar prompts específicos de starters
            const result = await callGeminiWithRetry(matchedStarter.prompt);
            if (result) {
              console.log(`[Worker ${userId}][AUTO-REPLY v2] Respuesta Gemini Starter generada: "${result.substring(0, 50)}..."`);
              await randomDelay();
              // Usar la nueva función unificada para enviar mensajes del bot
              await sendBotMessage(sender, result, "IA");
            } else {
              console.warn(`[Worker ${userId}][AUTO-REPLY v2] Gemini no generó respuesta para starter.`);
              // Si falla, caer al gemini default más abajo
            }
          } catch (geminiError) {
            console.error(`[Worker ${userId}][AUTO-REPLY v2] Error generando respuesta Gemini para starter:`, geminiError);
            // Si falla, caer al gemini default más abajo
          }
          return; // Terminar aquí aunque haya fallado (no tratar de procesar más)
        }

        // 4. Respuesta default de Gemini (si todo lo anterior falló)
        // En una implementación futura, buscar historial de mensajes para contexto.
        console.log(`[Worker ${userId}][AUTO-REPLY v2] Sin coincidencias específicas, usando respuesta default con Gemini...`);
        // Usar la función de historial de conversación en lugar del contexto default
        try {
            // Construir prompt con historial de conversación
            const promptWithHistory = await buildPromptWithHistory(message.from, message.body, agentConfig.persona);
            console.log(`[Worker ${userId}][AUTO-REPLY v2] Prompt con historial generado. Enviando a Gemini...`);

            const result = await callGeminiWithRetry(promptWithHistory, message.from); // Pasar el chatId
            if (result) {
                console.log(`[Worker ${userId}][AUTO-REPLY v2] Respuesta Gemini con contexto generada: "${result.substring(0, 50)}..."`);
                await randomDelay();
                // Usar la nueva función unificada para enviar mensajes del bot
                await sendBotMessage(sender, result, "IA");
            } else {
                console.warn(`[Worker ${userId}][AUTO-REPLY v2] Gemini no generó respuesta con contexto.`);
            }
        } catch (geminiError) {
            console.error(`[Worker ${userId}][AUTO-REPLY v2] Error generando respuesta Gemini con contexto:`, geminiError);
        }
      } else {
        console.log(`[Worker ${userId}][AUTO-REPLY v2] Usuario ACTIVO. No se enviarán respuestas automáticas.`);
      }
    }
  } catch (dbError) {
    console.error(`[Worker ${userId}][MESSAGE EVENT v2] Error procesando mensaje:`, dbError);
    sendErrorInfo(`Error procesando mensaje: ${dbError.message}`);
  }
});

client.on('message_revoke_everyone', async (after, before) => {
    console.log(`[Worker ${userId}][MESSAGE_REVOKE] Mensaje eliminado. FromMe: ${after.fromMe}, From: ${after.from}`);
});

client.on('message_ack', async (message, ack) => {
    // ACK: 1 = enviado, 2 = recibido, 3 = leído, 4 = reproducido
    console.log(`[Worker ${userId}][MESSAGE_ACK] Confirmación para mensaje. ACK: ${ack}, ID: ${message.id?.id}`);
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
            if (message.payload && Array.isArray(message.payload.flows)) {
                actionFlows = message.payload.flows;
                console.log(`   -> Flujos de acción actualizados desde payload. Total: ${actionFlows.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_FLOWS recibido sin payload de flujos válido. No se puede actualizar.`);
            }
            break;
        case 'RELOAD_RULES': // <<< ADDED
            console.log(`[Worker ${userId}] Recibido comando RELOAD_RULES.`);
            if (message.payload && Array.isArray(message.payload.rules)) {
                autoReplyRules = message.payload.rules;
                console.log(`   -> Reglas actualizadas desde payload. Total: ${autoReplyRules.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_RULES recibido sin payload de reglas válido. No se puede actualizar.`);
            }
            break;
        case 'RELOAD_STARTERS': // <<< ADDED
            console.log(`[Worker ${userId}] Recibido comando RELOAD_STARTERS.`);
            if (message.payload && Array.isArray(message.payload.starters)) {
                geminiConversationStarters = message.payload.starters;
                console.log(`   -> Starters actualizados desde payload. Total: ${geminiConversationStarters.length}`);
            } else {
                console.warn(`   -> Comando RELOAD_STARTERS recibido sin payload de starters válido. No se puede actualizar.`);
            }
            break;
        case 'RELOAD_AGENT_CONFIG': // <<< ADDED
             console.log(`[Worker ${userId}] Recibido comando RELOAD_AGENT_CONFIG.`);
            if (message.payload && message.payload.agentConfig && message.payload.agentConfig.id === currentAgentId) {
                agentConfig = message.payload.agentConfig;
                console.log(`   -> Configuración para agente activo (${currentAgentId}) actualizada desde payload.`);
            } else if (message.payload && message.payload.agentConfig && message.payload.agentConfig.id !== currentAgentId) {
                 console.warn(`   -> Recibido RELOAD_AGENT_CONFIG para agente ${message.payload.agentConfig.id}, pero el agente activo es ${currentAgentId}. Configuración no aplicada.`);
             } else if (!message.payload || !message.payload.agentConfig) {
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
            } else if (payload && payload.agentConfig && payload.agentConfig.id !== currentAgentId) {
                 console.warn(`   -> Recibido RELOAD_AGENT_CONFIG para agente ${payload.agentConfig.id}, pero el agente activo es ${currentAgentId}. Configuración no aplicada.`);
             } else if (!payload || !payload.agentConfig) {
                console.warn(`   -> Comando RELOAD_AGENT_CONFIG recibido sin payload de config válido. No se puede actualizar.`);
            }
            break;
         // TODO: Añadir case para 'RELOAD_CONFIG' (para otras configs)
         // ...
        default:
            console.warn(`[IPC Worker ${userId}] Tipo de mensaje no reconocido: ${command}`);
    }
}

// Añadir manejadores de excepciones no capturadas al final del archivo
process.on('uncaughtException', (error) => {
    console.error(`[Worker ${userId}][CRITICAL] UNCAUGHT EXCEPTION:`, error);
    sendErrorInfo(`Excepción no capturada: ${error.message}
${error.stack}`);
    sendStatusUpdate('error', `Error crítico no capturado: ${error.message}`);
    // No cerramos el proceso aquí para permitir debugging
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[Worker ${userId}][CRITICAL] UNHANDLED REJECTION:`, reason);
    sendErrorInfo(`Promesa rechazada no manejada: ${reason}`);
    sendStatusUpdate('error', `Promesa rechazada no manejada: ${reason}`);
    // No cerramos el proceso aquí para permitir debugging
});

// <<< REEMPLAZADO: Lógica de Presencia Basada en Firestore >>>
async function isUserActiveInChat(userId, senderId) {
    console.log(`
[Worker ${userId}][PRESENCE v3] ====== VERIFICANDO PRESENCIA (Basado en nueva arquitectura) ======`);
    console.log(`[Worker ${userId}][PRESENCE v3] Parámetros: userId=${userId}, senderId=${senderId}`);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    console.log(`[Worker ${userId}][PRESENCE v3] Timestamp actual: ${new Date().toISOString()}`);
    console.log(`[Worker ${userId}][PRESENCE v3] Timestamp límite para inactividad (10min): ${tenMinutesAgo.toISOString()}`);


    const chatDocRef = firestoreDbWorker.collection('users').doc(userId).collection('chats').doc(senderId);
    try {
        // 1. Verificar flag explícito de actividad en el documento de chat
        const chatDoc = await chatDocRef.get();
        if (chatDoc.exists && chatDoc.data().userIsActive === true) {
            // Verificar si la actividad es reciente usando diferencia relativa
            const lastHumanTimestamp = chatDoc.data().lastHumanMessageTimestamp?.toDate();
            if (lastHumanTimestamp) {
                const nowMs = Date.now();
                const lastActivityMs = lastHumanTimestamp.getTime();
                const diffMinutes = (nowMs - lastActivityMs) / (1000 * 60);

                console.log(`[Worker ${userId}][PRESENCE v3] Último mensaje humano: ${lastHumanTimestamp.toISOString()}`);
                console.log(`[Worker ${userId}][PRESENCE v3] Tiempo transcurrido: ${diffMinutes.toFixed(2)} minutos`);
                if (diffMinutes < 10) {
                    console.log(`[Worker ${userId}][PRESENCE v3] ✅ Usuario ACTIVO (< 10 minutos)`);
                    return true;
                }
                console.log(`[Worker ${userId}][PRESENCE v3] ⚠️ Mensaje humano encontrado pero demasiado antiguo (${diffMinutes.toFixed(2)} min > 10 min)`);
            } else {
                console.log(`[Worker ${userId}][PRESENCE v3] ⚠️ Flag userIsActive=true pero sin timestamp de actividad`);
            }
        }

        // 2. Buscar mensajes humanos recientes en la colección messages_human
        console.log(`[Worker ${userId}][PRESENCE v3] Buscando mensajes humanos recientes en messages_human...`);
        const humanMessagesRef = chatDocRef.collection('messages_human');
        const recentHumanMessages = await humanMessagesRef
            .where('timestamp', '>', tenMinutesAgo)
            .limit(1)
            .get();

        if (!recentHumanMessages.empty) {
            const lastMsg = recentHumanMessages.docs[0].data();
            const msgTimestamp = lastMsg.timestamp?.toDate();

            if (msgTimestamp) {
                const nowMs = Date.now();
                const msgMs = msgTimestamp.getTime();
                const diffMinutes = (nowMs - msgMs) / (1000 * 60);

                console.log(`[Worker ${userId}][PRESENCE v3] Mensaje encontrado en messages_human: ${msgTimestamp.toISOString()}`);
                console.log(`[Worker ${userId}][PRESENCE v3] Tiempo transcurrido: ${diffMinutes.toFixed(2)} minutos`);
                if (diffMinutes < 10) {
                    console.log(`[Worker ${userId}][PRESENCE v3] ✅ Usuario ACTIVO (mensaje < 10 minutos)`);
                    // Actualizar estado de actividad
                    await chatDocRef.set({
                        userIsActive: true,
                        lastHumanMessageTimestamp: lastMsg.timestamp,
                        lastActivityCheck: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                    return true;
                }
                console.log(`[Worker ${userId}][PRESENCE v3] ⚠️ Mensaje humano encontrado pero demasiado antiguo (${diffMinutes.toFixed(2)} min > 10 min)`);
            }
        } else {
            console.log(`[Worker ${userId}][PRESENCE v3] No se encontraron mensajes humanos recientes en messages_human`);
        }

        // 3. Verificar mensajes recientes del contacto/tercero como último criterio
        console.log(`[Worker ${userId}][PRESENCE v3] Verificando mensajes recientes del contacto...`);
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000); // Ventana más corta para mensajes del contacto
        const contactMessagesRef = chatDocRef.collection('messages_contact');
        const recentContactMessages = await contactMessagesRef
            .where('timestamp', '>', fiveMinutesAgo)
            .limit(1)
            .get();

        if (!recentContactMessages.empty) {
            const lastMsg = recentContactMessages.docs[0].data();
            const msgTimestamp = lastMsg.timestamp?.toDate();

            if (msgTimestamp) {
                const nowMs = Date.now();
                const msgMs = msgTimestamp.getTime();
                const diffMinutes = (nowMs - msgMs) / (1000 * 60);

                console.log(`[Worker ${userId}][PRESENCE v3] Mensaje reciente del contacto: ${msgTimestamp.toISOString()}`);
                console.log(`[Worker ${userId}][PRESENCE v3] Tiempo transcurrido: ${diffMinutes.toFixed(2)} minutos`);
                if (diffMinutes < 5) {
                    console.log(`[Worker ${userId}][PRESENCE v3] ✅ Usuario considerado ACTIVO porque el contacto envió mensaje hace menos de 5 minutos`);
                    // No actualizar userIsActive basado en actividad del contacto, solo considerarlo activo para esta evaluación
                    return true;
                }
            }
        }

        // No se encontró actividad humana reciente
        console.log(`[Worker ${userId}][PRESENCE v3] ⚠️ Usuario INACTIVO (sin actividad reciente)`);
        // Actualizar estado de inactividad
        await chatDocRef.set({
            userIsActive: false,
            lastActivityCheck: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return false;

    } catch (error) {
        console.error(`[Worker ${userId}][PRESENCE v3] Error crítico: ${error.message}`);
        // Si es un error de índice, asumimos que el usuario está inactivo (comportamiento más seguro)
        if (error.message && (error.message.includes('FAILED_PRECONDITION') || error.message.includes('requires an index'))) {
            console.log(`[Worker ${userId}][PRESENCE v3] ⚠️ Error de índice detectado. Asumiendo usuario INACTIVO por seguridad.`);
            // Configurar como inactivo para permitir respuestas automáticas
            await chatDocRef.set({
                userIsActive: false,
                lastActivityCheck: admin.firestore.FieldValue.serverTimestamp(),
                lastError: 'Índice faltante: ' + error.message.substring(0, 100)
            }, { merge: true });
            return false;
        }

        console.log(`[Worker ${userId}][PRESENCE v3] Por precaución ante error desconocido, considerando al usuario ACTIVO (para evitar respuestas automáticas).`);
        return true; // Para otros errores, seguimos siendo conservadores
    }
}
// <<< FIN: Lógica de Presencia Basada en Firestore >>>

// --- Función para enviar y guardar mensajes del bot en collection separada ---
async function sendBotMessage(chatId, content, type = "Auto") {
    try {
        // 1. Enviar el mensaje a través de WhatsApp
        await client.sendMessage(chatId, content);

        // 2. Guardar ÚNICAMENTE en la colección messages_bot
        const chatDocRef = firestoreDbWorker.collection('users').doc(userId).collection('chats').doc(chatId);
        // Asegurar que la colección messages_bot existe
        await chatDocRef.collection('messages_bot').add({
            from: `me (${type} - ${userId})`,
            to: chatId,
            body: content,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            isFromMe: true,
            isAutoReply: true,
            origin: 'bot'
        });

        // 3. También guardar en la colección messages_all para vista unificada
        await chatDocRef.collection('messages_all').add({
            from: `me (${type} - ${userId})`,
            to: chatId,
            body: content,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            isFromMe: true,
            isAutoReply: true,
            origin: 'bot'
        });

        // 4. Actualizar metadata del chat
        await chatDocRef.set({
            lastBotMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            lastMessageContent: content,
            lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`[Worker ${userId}] Mensaje automático (${type}) enviado y guardado en messages_bot.`);
        return true;
    } catch (error) {
        console.error(`[Worker ${userId}] Error enviando mensaje automático:`, error);
        return false;
    }
}

// Función para asegurar que existe la estructura de colecciones para un chat
async function ensureChatCollections(chatId) {
    try {
        console.log(`[Worker ${userId}][DB MIGRATION] Verificando/creando colecciones para chat ${chatId}...`);
        const chatDocRef = firestoreDbWorker.collection('users').doc(userId).collection('chats').doc(chatId);
        // Asegurar que el documento del chat existe
        const chatDoc = await chatDocRef.get();
        if (!chatDoc.exists) {
            console.log(`[Worker ${userId}][DB MIGRATION] Creando documento de chat para ${chatId}`);
            await chatDocRef.set({
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                userIsActive: false
            });
        }

        // Verificar si existen las colecciones separadas
        // No podemos verificar directamente si una colección existe,
        // pero podemos crear un documento dummy y luego borrarlo
        const collectionsToCheck = ['messages_all', 'messages_human', 'messages_bot', 'messages_contact'];
        for (const collection of collectionsToCheck) {
            try {
                const dummyDocRef = chatDocRef.collection(collection).doc('dummy_check');
                await dummyDocRef.set({ dummyCheck: true });
                await dummyDocRef.delete();
                console.log(`[Worker ${userId}][DB MIGRATION] Colección ${collection} verificada`);
            } catch (collError) {
                console.error(`[Worker ${userId}][DB MIGRATION] Error verificando colección ${collection}:`, collError);
                // La colección se creará cuando se agregue el primer documento
            }
        }

        // Verificar si hay mensajes antiguos que necesiten migración
        console.log(`[Worker ${userId}][DB MIGRATION] Verificando mensajes existentes para posible migración...`);
        const oldMessagesRef = chatDocRef.collection('messages');
        const oldMessagesSnapshot = await oldMessagesRef.limit(1).get();

        if (!oldMessagesSnapshot.empty) {
            // Hay mensajes en la colección antigua, verificar si ya se ha iniciado o completado la migración
            const migrationDoc = await chatDocRef.collection('_migrations').doc('messages_split').get();
            if (!migrationDoc.exists || migrationDoc.data().status !== 'completed') {
                console.log(`[Worker ${userId}][DB MIGRATION] Mensajes antiguos encontrados. Iniciar migración en segundo plano...`);
                // Marcar migración como iniciada
                await chatDocRef.collection('_migrations').doc('messages_split').set({
                    status: 'in_progress',
                    startedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                // No bloqueamos el procesamiento actual, programamos la migración para después
                setTimeout(() => migrateOldMessages(chatId), 5000);
            } else {
                console.log(`[Worker ${userId}][DB MIGRATION] Migración ya fue ${migrationDoc.data().status}`);
            }
        } else {
            console.log(`[Worker ${userId}][DB MIGRATION] No hay mensajes antiguos para migrar`);
        }

        return true;
    } catch (error) {
        console.error(`[Worker ${userId}][DB MIGRATION] Error asegurando colecciones:`, error);
        return false;
    }
}

// Función para migrar mensajes antiguos a la nueva estructura
async function migrateOldMessages(chatId) {
    const chatDocRef = firestoreDbWorker.collection('users').doc(userId).collection('chats').doc(chatId);
    const oldMessagesRef = chatDocRef.collection('messages');
    try {
        console.log(`[Worker ${userId}][DB MIGRATION] Iniciando migración de mensajes antiguos para ${chatId}...`);
        // Obtener mensajes antiguos en lotes para evitar problemas de memoria
        let processedCount = 0;
        let batchSize = 100;
        let lastDoc = null;
        let hasMore = true;

        while (hasMore) {
            let query = oldMessagesRef.orderBy('timestamp', 'asc').limit(batchSize);
            if (lastDoc) {
                query = query.startAfter(lastDoc);
            }

            const snapshot = await query.get();

            if (snapshot.empty) {
                hasMore = false;
                continue;
            }

            // Procesamos este lote
            const batch = firestoreDbWorker.batch();
            let humanBatch = [];
            let botBatch = [];
            let contactBatch = [];
            let allBatch = [];

            snapshot.forEach(doc => {
                const data = doc.data();
                const messageData = {
                    ...data,
                    migratedAt: admin.firestore.FieldValue.serverTimestamp(),
                    migratedFrom: 'messages'
                };

                // Determinar en qué colección va
                if (data.isFromMe === false) {
                    // Mensaje del contacto
                    messageData.origin = 'contact';
                    contactBatch.push(messageData);
                    allBatch.push(messageData);
                } else if (data.isAutoReply === true) {
                    // Mensaje automático del bot
                    messageData.origin = 'bot';
                    botBatch.push(messageData);
                    allBatch.push(messageData);
                } else if (data.IS_GENUINE_USER === true ||
                           (data.from && data.from.includes('User REAL'))) {
                    // Mensaje genuino del usuario
                    messageData.origin = 'human';
                    humanBatch.push(messageData);
                    allBatch.push(messageData);
                } else {
                    // Caso ambiguo, solo a messages_all
                    messageData.origin = 'unknown';
                    allBatch.push(messageData);
                }

                lastDoc = doc;
                processedCount++;
            });

            // Guardar en las nuevas colecciones
            console.log(`[Worker ${userId}][DB MIGRATION] Migrando ${humanBatch.length} mensajes humanos, ${botBatch.length} bot, ${contactBatch.length} contacto`);
            // Promise.all para operaciones en paralelo
            const promises = [];

            // Guardar mensajes humanos
            humanBatch.forEach(msg => {
                promises.push(chatDocRef.collection('messages_human').add(msg));
            });

            // Guardar mensajes del bot
            botBatch.forEach(msg => {
                promises.push(chatDocRef.collection('messages_bot').add(msg));
            });

            // Guardar mensajes del contacto
            contactBatch.forEach(msg => {
                promises.push(chatDocRef.collection('messages_contact').add(msg));
            });

            // Guardar todos en la vista unificada
            allBatch.forEach(msg => {
                promises.push(chatDocRef.collection('messages_all').add(msg));
            });

            await Promise.all(promises);

            console.log(`[Worker ${userId}][DB MIGRATION] Procesados ${processedCount} mensajes hasta ahora...`);
        }

        // Marcar migración como completada
        await chatDocRef.collection('_migrations').doc('messages_split').set({
            status: 'completed',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            messagesProcessed: processedCount
        });

        console.log(`[Worker ${userId}][DB MIGRATION] Migración completa. Total: ${processedCount} mensajes procesados.`);


    } catch (error) {
        console.error(`[Worker ${userId}][DB MIGRATION] Error durante la migración:`, error);
        // Marcar migración como fallida
        await chatDocRef.collection('_migrations').doc('messages_split').set({
            status: 'failed',
            error: error.message,
            failedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }
}

client.on('message_create', async (message) => {
    // Log inicial para saber que se detectó la creación
    console.log(`
[Worker ${userId}][MESSAGE_CREATE v2] ====== MENSAJE SALIENTE DETECTADO ======`);
    console.log(`[Worker ${userId}][MESSAGE_CREATE v2] ID: ${message.id?.id || 'unknown'}`);
    console.log(`[Worker ${userId}][MESSAGE_CREATE v2] To: ${message.to || 'unknown'}`);
    console.log(`[Worker ${userId}][MESSAGE_CREATE v2] Body: "${message.body?.substring(0, 50)}${message.body?.length > 50 ? '...' : ''}"`);


    // ELIMINAMOS ESTE CHECK - SABEMOS QUE message_create SIEMPRE ES PARA MENSAJES SALIENTES
    // INDEPENDIENTEMENTE DEL VALOR DE message.fromMe
    // if (!message.fromMe) {
    //     console.log(`[Worker ${userId}][MESSAGE_CREATE v2] ⚠️ Mensaje message_create con fromMe=false. Ignorando.`);
    //     return;
    // }


    try {
        const chatPartnerId = message.to;

        // Asegurar que existen las colecciones necesarias para este chat
        await ensureChatCollections(chatPartnerId);

        const chatDocRef = firestoreDbWorker.collection('users').doc(userId).collection('chats').doc(chatPartnerId);
        // 1. Verificar si es un mensaje del bot (buscar en messages_bot)
        console.log(`[Worker ${userId}][MESSAGE_CREATE v2] Verificando si es un mensaje automático...`);
        const recentBotTime = new Date(Date.now() - 2000); // 2 segundos atrás
        const recentBotMessages = await chatDocRef.collection('messages_bot')
            .where('timestamp', '>', recentBotTime)
            .where('body', '==', message.body)
            .limit(1)
            .get();

        // Si encontramos coincidencia, es un mensaje del bot que ya guardamos, salir
        if (!recentBotMessages.empty) {
            console.log(`[Worker ${userId}][MESSAGE_CREATE v2] ✅ Mensaje identificado como del bot, ya guardado en messages_bot.`);
            return;
        }

        // 2. Si llegamos aquí, es un mensaje genuino del usuario
        console.log(`[Worker ${userId}][MESSAGE_CREATE v2] ✅ Mensaje GENUINO del usuario detectado.`);
        // Timestamp para todo
        const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
        // 3. Guardar en messages_human
        await chatDocRef.collection('messages_human').add({
            from: `me (${userId})`,
            to: chatPartnerId,
            body: message.body || '',
            timestamp: serverTimestamp,
            isFromMe: true,
            isAutoReply: false,
            origin: 'human',
            messageId: message.id?.id || 'unknown'
        });

        // 4. Guardar en messages_all para vista unificada
        await chatDocRef.collection('messages_all').add({
            from: `me (${userId})`,
            to: chatPartnerId,
            body: message.body || '',
            timestamp: serverTimestamp,
            isFromMe: true,
            isAutoReply: false,
            origin: 'human',
            messageId: message.id?.id || 'unknown'
        });

        // 5. Actualizar estado de actividad del usuario
        await chatDocRef.set({
            userIsActive: true,
            lastHumanMessageTimestamp: serverTimestamp,
            lastMessageTimestamp: serverTimestamp,
            lastMessageContent: message.body || '',
            userActivitySource: 'message_create_event'
        }, { merge: true });

        console.log(`[Worker ${userId}][MESSAGE_CREATE v2] Mensaje genuino guardado y usuario marcado como activo.`);

        // <<< ADDED: Notify server about the new incoming message for potential WebSocket broadcast >>>
        if (process.send) {
            const messagePayload = {
                chatId: chatPartnerId,
                messageId: message.id?.id || 'unknown',
                body: message.body || '',
                timestamp: new Date().toISOString(), // Use current time as Firestore timestamp isn't available yet
                from: chatPartnerId, // The sender is the contact
                isFromMe: false,
                origin: 'contact'
                // Add other relevant fields if needed by the frontend
            };
            process.send({ type: 'NEW_MESSAGE_RECEIVED', payload: messagePayload });
            console.log(`[Worker ${userId}][IPC] Sent NEW_MESSAGE_RECEIVED notification to server for chat ${chatPartnerId}`);
        } else {
            console.warn(`[Worker ${userId}][IPC] process.send not available. Cannot notify server about new message.`);
        }
        // <<< END: Notify server >>>

        // Actualizar documento del chat
        await chatDocRef.set({
            lastContactMessageTimestamp: serverTimestamp,
            lastMessageTimestamp: serverTimestamp,
            lastMessageContent: message.body
        }, { merge: true });
    } catch (error) {
        console.error(`[Worker ${userId}][MESSAGE_CREATE v2] Error procesando mensaje saliente:`, error);
        sendErrorInfo(`Error en message_create: ${error.message}`);
    }
});

// Función para obtener historial de conversación para contexto de Gemini
async function getConversationHistory(chatId, maxMessages = 6) {
    try {
        console.log(`[Worker ${userId}][CONTEXT] Obteniendo historial de conversación para ${chatId} (max: ${maxMessages} mensajes)`);
        const chatDocRef = firestoreDbWorker.collection('users').doc(userId).collection('chats').doc(chatId);
        // Obtener los últimos mensajes ordenados por timestamp
        const messagesSnapshot = await chatDocRef.collection('messages_all')
            .orderBy('timestamp', 'desc')
            .limit(maxMessages * 2) // Obtenemos el doble para tener margen de selección
            .get();

        if (messagesSnapshot.empty) {
            console.log(`[Worker ${userId}][CONTEXT] No se encontraron mensajes previos.`);
            return [];
        }

        // Convertir a array y ordenar cronológicamente (el más antiguo primero)
        const messages = [];
        messagesSnapshot.forEach(doc => {
            const msgData = doc.data();
            // Solo incluir mensajes con body (texto)
            if (msgData.body) {
                messages.push({
                    role: msgData.origin === 'bot' ? 'assistant' : 'user',
                    content: msgData.body,
                    timestamp: msgData.timestamp?.toDate?.() || new Date(),
                    // Estimación aproximada de tokens (1 token ≈ 4 caracteres en promedio)
                    estimatedTokens: Math.ceil(msgData.body.length / 4)
                });
            }
        });

        // Ordenar cronológicamente
        messages.sort((a, b) => a.timestamp - b.timestamp);

        // Control de tokens: limitar a ~2000 tokens para el historial
        const MAX_HISTORY_TOKENS = 2000;
        let totalTokens = 0;
        let selectedMessages = [];

        // Primero incluir los mensajes más recientes (desde el final)
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (totalTokens + msg.estimatedTokens <= MAX_HISTORY_TOKENS &&
                selectedMessages.length < maxMessages) {
                selectedMessages.unshift(msg); // Añadir al principio para mantener orden cronológico
                totalTokens += msg.estimatedTokens;
            } else if (totalTokens >= MAX_HISTORY_TOKENS || selectedMessages.length >= maxMessages) {
                // Ya tenemos suficientes mensajes o tokens
                break;
            }
        }

        console.log(`[Worker ${userId}][CONTEXT] Recuperados ${selectedMessages.length} mensajes para contexto. Tokens estimados: ${totalTokens}`);
        return selectedMessages;
    } catch (error) {
        console.error(`[Worker ${userId}][CONTEXT] Error obteniendo historial:`, error);
        return []; // En caso de error, devolver array vacío
    }
}

// Función para construir un prompt con historial de conversación
async function buildPromptWithHistory(chatId, currentMessage, persona) {
    try {
        // Obtener historial de mensajes
        const history = await getConversationHistory(chatId);

        // Construir la sección de historial del prompt
        let historyText = '';
        if (history.length > 0) {
            historyText = history.map(msg => {
                const speaker = msg.role === 'assistant' ? 'Asistente' : 'Usuario';
                return `${speaker}: ${msg.content}`;
            }).join('\n\n'); // Use escaped newlines
        }

        // Detectar si el historial es muy largo y generar resumen si es necesario
        if (historyText.length > 6000) {
            console.log(`[Worker ${userId}][CONTEXT] Historial muy extenso (${historyText.length} caracteres). Considerando resumen.`);
            // Si se implementa un resumen, se podría usar Gemini para generarlo
            // Por ahora, simplemente truncamos y añadimos una nota
            historyText = `[Conversación previa resumida]\n\n${history.slice(-3).map(msg => {
                const speaker = msg.role === 'assistant' ? 'Asistente' : 'Usuario';
                return `${speaker}: ${msg.content}`;
            }).join('\n\n')}`; // Use escaped newlines
        }

        // Construir prompt base con la persona del agente - ensure template literal uses standard newlines
        const basePrompt = `Eres ${persona?.name || 'un asistente virtual'}.\nRol: ${persona?.role || 'Ayudar a los usuarios.'}\nTono: ${persona?.tone || 'amable'}.\nEstilo: ${persona?.style || 'claro'}.\nIdioma: ${persona?.language || 'es'}.\n\nInstrucciones Principales:\n${persona?.instructions || 'No se proporcionaron instrucciones específicas.'} // <-- AÑADIDO\n\nDirectrices Adicionales:\n${(persona?.guidelines || []).map(g => `- ${g}`).join('\n') || '- Responde de forma concisa.'}\n\nIMPORTANTE: Mantén la continuidad de la conversación. Recuerda lo que se ha dicho previamente y responde de manera coherente con el historial.`;


        // Prompt completo con historial y mensaje actual - ensure template literal uses standard newlines
        const fullPrompt = `${basePrompt}\n\n---\n${history.length > 0 ? 'Historial de la Conversación:' : 'No hay historial previo de esta conversación.'}\n${historyText}\n\n---\nMensaje Actual del Usuario:\nUsuario: ${currentMessage}\n\n---\nTu Respuesta (siguiendo el contexto de la conversación):`;

        console.log(`[Worker ${userId}][CONTEXT] Prompt con historial generado. Longitud aproximada: ${fullPrompt.length} caracteres.`);
        return fullPrompt;
    } catch (error) {
        console.error(`[Worker ${userId}][CONTEXT] Error construyendo prompt con historial:`, error);
        // En caso de error, devolver un prompt básico
        return `Eres un asistente. Responde al mensaje: ${currentMessage}`;
    }
}

// <<< ADDED: Sistema de tracking de tokens para conversaciones Gemini >>>
// Mapa para seguir tokens por conversación: chatId -> { messages: [], totalTokens: number }
const conversationTokenMap = new Map();

// Constantes para gestión de tokens
const MAX_CONVERSATION_TOKENS = 15000; // Máximo para toda la conversación (ajustar según modelo)
const MAX_HISTORY_TOKENS = 2000; // Máximo para el historial en cada prompt
const TOKEN_ESTIMATE_RATIO = 4; // Caracteres por token (estimación)

// Función para registrar un mensaje en el tracking de tokens
function trackMessageTokens(chatId, role, content) {
    // Estimar tokens en el contenido
    const estimatedTokens = Math.ceil((content?.length || 0) / TOKEN_ESTIMATE_RATIO);

    // Obtener o crear el registro de la conversación
    if (!conversationTokenMap.has(chatId)) {
        conversationTokenMap.set(chatId, {
            messages: [],
            totalTokens: 0,
            lastUpdated: Date.now()
        });
    }

    const conversation = conversationTokenMap.get(chatId);

    // Añadir nuevo mensaje
    conversation.messages.push({
        role,
        content,
        timestamp: Date.now(),
        estimatedTokens
    });

    // Actualizar total de tokens
    conversation.totalTokens += estimatedTokens;
    conversation.lastUpdated = Date.now();

    // Si excedemos el límite, eliminar mensajes antiguos
    while (conversation.totalTokens > MAX_CONVERSATION_TOKENS && conversation.messages.length > 1) {
        const oldestMessage = conversation.messages.shift();
        conversation.totalTokens -= oldestMessage.estimatedTokens;
    }

    // Log de depuración
    console.log(`[Worker ${userId}][TOKEN TRACKING] Chat ${chatId}: ${conversation.messages.length} mensajes, ~${conversation.totalTokens} tokens`);


    return conversation;
}

// Función para limpiar conversaciones antiguas (llamar periódicamente)
function cleanupOldConversations(maxAgeMs = 24 * 60 * 60 * 1000) { // 24 horas por defecto
    const now = Date.now();
    let cleanedCount = 0;

    for (const [chatId, conversation] of conversationTokenMap.entries()) {
        if (now - conversation.lastUpdated > maxAgeMs) {
            conversationTokenMap.delete(chatId);
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        console.log(`[Worker ${userId}][TOKEN TRACKING] Limpiadas ${cleanedCount} conversaciones antiguas`);
    }
}

// Configurar limpieza periódica cada 6 horas
setInterval(cleanupOldConversations, 6 * 60 * 60 * 1000);
// <<< END: Sistema de tracking de tokens >>>
