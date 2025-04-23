const fs = require('fs');

// Función para cargar datos desde archivo JSON
// defaultValue puede ser un objeto o un array
function loadData(filePath, defaultValue = {}) { 
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            if (!data) return defaultValue;
            return JSON.parse(data);
        } else {
            // Si no existe, intentar guardar el default
            console.log(`Archivo ${filePath} no encontrado, intentando crear con valor por defecto.`);
            if (saveData(filePath, defaultValue)) {
                return defaultValue;
            } else {
                // Si no se puede guardar, devolver el default en memoria
                console.error(`No se pudo crear el archivo ${filePath} con valor por defecto.`);
                return defaultValue; 
            }
        }
    } catch (error) {
        console.error(`Error cargando o parseando ${filePath}:`, error);
        // Intentar guardar el default si hubo error
        try {
            saveData(filePath, defaultValue);
        } catch (saveError) {
             console.error(`Error guardando valor por defecto para ${filePath} tras error de carga:`, saveError);
        }
        return defaultValue;
    }
}

// Función para guardar datos en archivo JSON
function saveData(filePath, data) {
    try {
        // Asegurarse de que el directorio padre exista
        const dir = require('path').dirname(filePath);
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`Datos guardados en ${filePath}`);
        return true;
    } catch (error) {
        console.error(`Error guardando ${filePath}:`, error);
        return false;
    }
}

module.exports = { loadData, saveData }; 