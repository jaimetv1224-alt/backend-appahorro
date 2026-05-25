const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

async function createSampleSavingsData() {
    try {
        console.log('🏦 Creando datos de muestra para ahorros...');
        
        // Cargar credenciales
        const credentialsPath = path.join(__dirname, 'credentials.json');
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        
        // Configurar autenticación
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        const authClient = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        const SPREADSHEET_ID = '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';
        
        // Datos de muestra para ahorros
        const sampleSavingsData = [
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '300', '2025-10-01', 'mensual', 'Ahorro mensual octubre'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '200', '2025-09-15', 'extra', 'Ahorro extra septiembre'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '300', '2025-09-01', 'mensual', 'Ahorro mensual septiembre'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '150', '2025-08-20', 'meta', 'Para vacaciones'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '300', '2025-08-01', 'mensual', 'Ahorro mensual agosto'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '400', '2025-07-15', 'extra', 'Bonificación julio'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '300', '2025-07-01', 'mensual', 'Ahorro mensual julio'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '250', '2025-06-10', 'meta', 'Meta emergencia'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '300', '2025-06-01', 'mensual', 'Ahorro mensual junio'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', '300', '2025-05-01', 'mensual', 'Ahorro mensual mayo']
        ];
        
        console.log('📊 Agregando datos a la hoja Savings...');
        
        // Agregar los datos
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Savings!A:F',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: sampleSavingsData
            }
        });
        
        console.log('✅ Datos de ahorros agregados exitosamente');
        console.log(`📈 Se agregaron ${sampleSavingsData.length} registros de ahorros`);
        
        // Crear datos para MetasAhorro también
        const sampleGoalsData = [
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', 'Vacaciones 2026', '5000', '2000', '2025-01-01', '2026-06-01', 'activa', 'Para viaje familiar'],
            ['svillonp@upse.edu.ec', 'grupo_av74u1zj', 'Fondo de Emergencia', '10000', '950', '2025-03-01', '2025-12-31', 'activa', 'Seguridad financiera']
        ];
        
        console.log('🎯 Agregando metas de ahorro...');
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'MetasAhorro!A:I',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: sampleGoalsData
            }
        });
        
        console.log('✅ Metas de ahorro agregadas exitosamente');
        console.log(`🎯 Se agregaron ${sampleGoalsData.length} metas de ahorro`);
        
    } catch (error) {
        console.error('❌ Error creando datos de muestra:', error.message);
        console.error('Stack:', error.stack);
    }
}

createSampleSavingsData();