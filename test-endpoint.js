// Endpoint de prueba para verificar conexión directa
app.get('/api/test-savings-connection', async (req, res) => {
  try {
    console.log('[TEST] Iniciando prueba de conexión de ahorros...');
    
    // Usar directamente la conexión de Google Sheets del servidor
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Savings!A:G'
    });
    
    const rows = response.data.values || [];
    console.log(`[TEST] Obtenidas ${rows.length} filas de Savings`);
    
    if (rows.length > 1) {
      console.log(`[TEST] Headers: ${rows[0].join(', ')}`);
      console.log(`[TEST] Muestra: ${rows[1].join(' | ')}`);
    }
    
    res.json({
      success: true,
      totalRows: rows.length,
      headers: rows[0],
      sampleData: rows.slice(1, 3),
      message: 'Conexión directa exitosa'
    });
    
  } catch (error) {
    console.error('[TEST] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});