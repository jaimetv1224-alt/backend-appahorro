const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

async function testSheetsData() {
    try {
        console.log('🔍 Iniciando prueba de conexión a Google Sheets...');
        
        // Cargar credenciales
        const credentialsPath = path.join(__dirname, 'credentials.json');
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        console.log('✅ Credenciales cargadas');
        
        // Configurar autenticación
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        const authClient = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        console.log('✅ Cliente de Google Sheets creado');
        
        // ID de la hoja de cálculo
        const SPREADSHEET_ID = '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';
        
        // Obtener información básica de la hoja
        console.log('📊 Obteniendo información del spreadsheet...');
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID
        });
        
        console.log(`📋 Nombre: ${spreadsheet.data.properties.title}`);
        console.log('📄 Hojas disponibles:');
        spreadsheet.data.sheets.forEach(sheet => {
            console.log(`  - ${sheet.properties.title} (${sheet.properties.gridProperties.rowCount} filas, ${sheet.properties.gridProperties.columnCount} columnas)`);
        });
        
        // Probar datos de usuarios
        console.log('\n👥 Verificando datos de usuarios...');
        try {
            const usersResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Users!A:F'
            });
            console.log(`  ✅ Hoja 'Users' encontrada con ${usersResponse.data.values?.length || 0} filas`);
            if (usersResponse.data.values && usersResponse.data.values.length > 1) {
                console.log(`  📋 Headers: ${usersResponse.data.values[0].join(', ')}`);
                console.log(`  👤 Usuarios encontrados: ${usersResponse.data.values.length - 1}`);
            }
        } catch (error) {
            console.log(`  ❌ Error al leer hoja 'Users': ${error.message}`);
        }
        
        // Probar datos de ahorros
        console.log('\n💰 Verificando datos de ahorros...');
        try {
            const savingsResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Ahorros!A:J'
            });
            console.log(`  ✅ Hoja 'Ahorros' encontrada con ${savingsResponse.data.values?.length || 0} filas`);
            if (savingsResponse.data.values && savingsResponse.data.values.length > 0) {
                console.log(`  📋 Headers: ${savingsResponse.data.values[0].join(', ')}`);
                console.log(`  💵 Registros de ahorros: ${(savingsResponse.data.values.length - 1) || 0}`);
                if (savingsResponse.data.values.length === 1) {
                    console.log('  ⚠️ Solo hay cabeceras, no hay datos de ahorros');
                }
            }
        } catch (error) {
            console.log(`  ❌ Error al leer hoja 'Ahorros': ${error.message}`);
        }
        
        // También probar la hoja 'Savings'
        console.log('\n💰 Verificando datos de Savings (hoja alternativa)...');
        try {
            const savingsResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Savings!A:J'
            });
            console.log(`  ✅ Hoja 'Savings' encontrada con ${savingsResponse.data.values?.length || 0} filas`);
            if (savingsResponse.data.values && savingsResponse.data.values.length > 0) {
                console.log(`  📋 Headers: ${savingsResponse.data.values[0].join(', ')}`);
                console.log(`  💵 Registros de savings: ${(savingsResponse.data.values.length - 1) || 0}`);
                if (savingsResponse.data.values.length > 1) {
                    console.log('  📊 Muestra de datos:');
                    savingsResponse.data.values.slice(1, 3).forEach((row, index) => {
                        console.log(`    Registro ${index + 1}: ${row.join(' | ')}`);
                    });
                }
            }
        } catch (error) {
            console.log(`  ❌ Error al leer hoja 'Savings': ${error.message}`);
        }
        
        // Probar datos de acciones
        console.log('\n📈 Verificando datos de acciones...');
        try {
            const sharesResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Acciones!A:G'
            });
            console.log(`  ✅ Hoja 'Acciones' encontrada con ${sharesResponse.data.values?.length || 0} filas`);
            if (sharesResponse.data.values && sharesResponse.data.values.length > 1) {
                console.log(`  📋 Headers: ${sharesResponse.data.values[0].join(', ')}`);
                console.log(`  📊 Registros de acciones: ${sharesResponse.data.values.length - 1}`);
            }
        } catch (error) {
            console.log(`  ❌ Error al leer hoja 'Acciones': ${error.message}`);
        }
        
        // Buscar usuario específico
        console.log('\n🔍 Buscando usuario específico (svillonp@upse.edu.ec)...');
        try {
            const usersResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Users!A:F'
            });
            
            if (usersResponse.data.values) {
                const headers = usersResponse.data.values[0];
                const users = usersResponse.data.values.slice(1);
                const emailIndex = headers.findIndex(h => h.toLowerCase().includes('email'));
                
                if (emailIndex >= 0) {
                    const targetUser = users.find(user => user[emailIndex] === 'svillonp@upse.edu.ec');
                    if (targetUser) {
                        console.log('  ✅ Usuario encontrado:');
                        headers.forEach((header, index) => {
                            console.log(`    ${header}: ${targetUser[index] || 'N/A'}`);
                        });
                    } else {
                        console.log('  ❌ Usuario no encontrado');
                        console.log('  📋 Usuarios disponibles:');
                        users.slice(0, 5).forEach(user => {
                            console.log(`    - ${user[emailIndex] || 'Sin email'}`);
                        });
                    }
                } else {
                    console.log('  ❌ No se encontró columna de email');
                }
            }
        } catch (error) {
            console.log(`  ❌ Error buscando usuario: ${error.message}`);
        }
        
    } catch (error) {
        console.error('❌ Error en la prueba:', error.message);
        console.error('Stack:', error.stack);
    }
}

testSheetsData();