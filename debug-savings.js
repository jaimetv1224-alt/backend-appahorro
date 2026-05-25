const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');

async function debugSavings() {
  try {
    console.log('🔍 Iniciando debug de ahorros...');
    
    // Configurar autenticación
    const auth = new GoogleAuth({
      keyFile: './credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    const SPREADSHEET_ID = '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';
    
    console.log('✅ Autenticación configurada');
    
    // Leer datos de la hoja Savings
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Savings!A:G'
    });
    
    const rows = response.data.values || [];
    console.log(`📊 Total de filas encontradas: ${rows.length}`);
    
    if (rows.length > 0) {
      console.log('📋 Headers:', rows[0]);
      
      // Buscar datos específicos para nuestro usuario
      const email = 'svillonp@upse.edu.ec';
      const groupId = 'grupo_av74u1zj';
      
      console.log(`🔍 Buscando datos para email: ${email}, grupo: ${groupId}`);
      
      // Los datos están directamente sin headers coincidentes
      // UserEmail, GroupID, Amount, Date, Type, Description
      const emailIndex = 0;
      const groupIndex = 1;
      const amountIndex = 2;
      const dateIndex = 3;
      const typeIndex = 4;
      
      console.log(`📍 Índices encontrados - Email: ${emailIndex}, Group: ${groupIndex}, Amount: ${amountIndex}, Date: ${dateIndex}, Type: ${typeIndex}`);
      
      // Mostrar todas las filas de datos
      console.log('\n📖 Datos completos:');
      rows.slice(1).forEach((row, index) => {
        console.log(`Fila ${index + 1}:`, row);
      });
      
      // Filtrar datos para nuestro usuario
      const userSavings = rows.slice(1).filter(row => {
        const emailMatch = row[emailIndex] === email;
        const groupMatch = !groupId || row[groupIndex] === groupId;
        console.log(`🔍 Fila ${row}: Email ${row[emailIndex]} === ${email} ? ${emailMatch}, Group ${row[groupIndex]} === ${groupId} ? ${groupMatch}`);
        return emailMatch && groupMatch;
      });
      
      console.log(`\n💰 Ahorros encontrados para el usuario: ${userSavings.length}`);
      userSavings.forEach((saving, index) => {
        console.log(`Ahorro ${index + 1}:`, {
          fecha: saving[dateIndex] || '',
          monto: Number(saving[amountIndex]) || 0,
          tipo: saving[typeIndex] || 'mensual',
          descripcion: saving[6] || ''
        });
      });
      
      const totalAhorros = userSavings.reduce((sum, saving) => sum + (Number(saving[amountIndex]) || 0), 0);
      console.log(`💵 Total de ahorros: $${totalAhorros}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

debugSavings();