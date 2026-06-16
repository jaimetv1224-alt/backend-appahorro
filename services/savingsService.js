const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Parser de dinero tolerante a locale es-EC: "137,37" -> 137.37, "1.234,56" -> 1234.56
function toMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = (value == null ? '' : value).toString().trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

class SavingsService {
  constructor() {
    this.auth = null;
    this.sheets = null;
    this.isAvailable = false;
    // No inicializar automáticamente, hacerlo solo cuando se necesite
  }

  async initializeAuth() {
    try {
      let credentials = null;
      
      // Intentar obtener credenciales desde variable de entorno (para Render)
      if (process.env.GOOGLE_CREDENTIALS) {
        console.log('[SAVINGS SERVICE] Cargando credenciales desde variable de entorno...');
        try {
          credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
          console.log('[SAVINGS SERVICE] Credenciales cargadas desde variable de entorno, client_email:', credentials.client_email);
        } catch (e) {
          console.error('[SAVINGS SERVICE] Error al parsear GOOGLE_CREDENTIALS:', e.message);
        }
      }
      
      // Si no hay credenciales en la variable de entorno, intentar leer el archivo (para desarrollo local)
      if (!credentials) {
        const credentialsPath = path.join(__dirname, '..', 'credentials.json');
        console.log('[SAVINGS SERVICE] Intentando cargar credenciales desde archivo:', credentialsPath);
        
        if (!fs.existsSync(credentialsPath)) {
          console.warn('[SAVINGS SERVICE] credentials.json no encontrado y no hay variable GOOGLE_CREDENTIALS. Funcionando en modo de prueba.');
          this.isAvailable = false;
          return false;
        }
        
        console.log('[SAVINGS SERVICE] Archivo de credenciales encontrado, leyendo...');
        credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        console.log('[SAVINGS SERVICE] Credenciales cargadas del archivo, client_email:', credentials.client_email);
      }
      
      // Usar GoogleAuth en lugar de JWT directamente (como en server.js)
      this.auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      
      console.log('[SAVINGS SERVICE] GoogleAuth creado, obteniendo cliente...');
      const authClient = await this.auth.getClient();
      console.log('[SAVINGS SERVICE] Cliente de autenticación obtenido, creando cliente sheets...');
      this.sheets = google.sheets({ version: 'v4', auth: authClient });
      this.isAvailable = true;
      console.log('[SAVINGS SERVICE] Google Sheets API autenticado correctamente.');
      return true;
    } catch (error) {
      console.warn('[SAVINGS SERVICE] Error al inicializar Google Sheets. Funcionando en modo de prueba:', error.message);
      console.error('[SAVINGS SERVICE] Stack trace:', error.stack);
      this.isAvailable = false;
      return false;
    }
  }

  async ensureAuthenticated() {
    if (!this.isAvailable && (!this.auth || !this.sheets)) {
      await this.initializeAuth();
    }
    return this.isAvailable;
  }

  // Crear hoja de Ahorros si no existe
  async createSavingsSheetIfNotExists(spreadsheetId) {
    try {
      const isAuthenticated = await this.ensureAuthenticated();
      if (!isAuthenticated) {
        console.log('[SAVINGS SERVICE] Modo demo - No se puede crear hoja de Ahorros');
        return false;
      }
      
      // Verificar si la hoja ya existe
      const spreadsheet = await this.sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
      
      const existingSheet = spreadsheet.data.sheets.find(
        sheet => sheet.properties.title === 'Savings'
      );
      
      if (existingSheet) {
        console.log('La hoja "Ahorros" ya existe');
        return existingSheet.properties.sheetId;
      }
      
      // Crear la hoja si no existe
      const addSheetRequest = {
        spreadsheetId: spreadsheetId,
        resource: {
          requests: [{
            addSheet: {
              properties: {
                title: 'Savings',
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 10
                }
              }
            }
          }]
        }
      };
      
      const response = await this.sheets.spreadsheets.batchUpdate(addSheetRequest);
      const sheetId = response.data.replies[0].addSheet.properties.sheetId;
      
      // Agregar encabezados
      const headers = [
        'ID', 'Email', 'GroupID', 'Tipo', 'Monto', 'Descripcion', 
        'Fecha', 'Meta', 'Estado', 'FechaCreacion'
      ];
      
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: 'Ahorros!A1:J1',
        valueInputOption: 'RAW',
        resource: {
          values: [headers]
        }
      });
      
      console.log('Hoja "Ahorros" creada exitosamente');
      return sheetId;
    } catch (error) {
      console.error('Error creando hoja de Ahorros:', error);
      throw error;
    }
  }

  // Crear hoja de Metas de Ahorro si no existe
  async createSavingsGoalsSheetIfNotExists(spreadsheetId) {
    try {
      const isAuthenticated = await this.ensureAuthenticated();
      if (!isAuthenticated) {
        console.log('[SAVINGS SERVICE] Modo demo - No se puede crear hoja de MetasAhorro');
        return false;
      }
      
      // Verificar si la hoja ya existe
      const spreadsheet = await this.sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
      
      const existingSheet = spreadsheet.data.sheets.find(
        sheet => sheet.properties.title === 'MetasAhorro'
      );
      
      if (existingSheet) {
        console.log('La hoja "MetasAhorro" ya existe');
        return existingSheet.properties.sheetId;
      }
      
      // Crear la hoja si no existe
      const addSheetRequest = {
        spreadsheetId: spreadsheetId,
        resource: {
          requests: [{
            addSheet: {
              properties: {
                title: 'MetasAhorro',
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 12
                }
              }
            }
          }]
        }
      };
      
      const response = await this.sheets.spreadsheets.batchUpdate(addSheetRequest);
      const sheetId = response.data.replies[0].addSheet.properties.sheetId;
      
      // Agregar encabezados
      const headers = [
        'ID', 'Email', 'GroupID', 'Nombre', 'MontoObjetivo', 'MontoActual',
        'FechaObjetivo', 'Descripcion', 'Prioridad', 'Categoria', 'Estado', 'FechaCreacion'
      ];
      
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: 'MetasAhorro!A1:L1',
        valueInputOption: 'RAW',
        resource: {
          values: [headers]
        }
      });
      
      console.log('Hoja "MetasAhorro" creada exitosamente');
      return sheetId;
    } catch (error) {
      console.error('Error creando hoja de MetasAhorro:', error);
      throw error;
    }
  }

  // Agregar nuevo ahorro
  async addSaving(spreadsheetId, savingData) {
    try {
      await this.ensureAuthenticated();
      await this.createSavingsSheetIfNotExists(spreadsheetId);
      
      const { email, groupId, tipo, monto, descripcion, meta } = savingData;
      
      const savingId = `SAV_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const fecha = new Date().toISOString();

      // Hoja canonica: Savings con convencion posicional A=email,B=group,C=amount,D=date,E=type,F=descripcion
      // (coincide con savings/complete y los datos existentes). Asi el ahorro SI se refleja en el patrimonio.
      const values = [
        email,
        groupId,
        toMoney(monto),
        fecha.split('T')[0], // Solo la fecha (D=Date)
        tipo || 'mensual',   // E=Type
        descripcion || ''    // F=Description
      ];

      await this.sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: 'Savings!A:F',
        valueInputOption: 'RAW',
        resource: {
          values: [values]
        }
      });

      return {
        success: true,
        savingId: savingId,
        data: values
      };
    } catch (error) {
      console.error('Error agregando ahorro:', error);
      throw error;
    }
  }

  // Obtener ahorros por usuario
  async getSavingsByUser(spreadsheetId, email, groupId = null) {
    try {
      const isAuthenticated = await this.ensureAuthenticated();
      if (!isAuthenticated) {
        return this.getMockSavings();
      }
      await this.createSavingsSheetIfNotExists(spreadsheetId);
      
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'Savings!A:F'
      });

      const rows = response.data.values || [];
      console.log(`[SAVINGS SERVICE] Obtenidos ${rows.length} filas de Savings para ${email}`);

      if (rows.length <= 1) {
        console.log('[SAVINGS SERVICE] No hay datos de ahorros (solo headers o vacío)');
        return [];
      }

      // Lectura POSICIONAL: A=email, B=group, C=amount, D=date, E=type, F=descripcion
      const norm = (v) => (v || '').toString().trim().toLowerCase();
      const targetEmail = norm(email);
      const targetGroup = (groupId || '').toString().trim();

      return rows.slice(1)
        .filter((row) => norm(row[0]) === targetEmail && (!targetGroup || (row[1] || '').toString().trim() === targetGroup))
        .map((row) => ({
          tipo: row[4] || 'mensual',
          monto: toMoney(row[2]),
          descripcion: row[5] || '',
          fecha: row[3] || '',
          estado: 'Activo'
        }));
    } catch (error) {
      console.error('Error obteniendo ahorros:', error);
      throw error;
    }
  }

  // Calcular estadísticas de ahorros incluyendo acciones
  async getSavingsStats(spreadsheetId, email, groupId = null) {
    try {
      // Verificar si Google Sheets está disponible
      const isAuthenticated = await this.ensureAuthenticated();
      if (!isAuthenticated) {
        // Retornar datos de prueba
        return this.getMockSavingsStats();
      }
      
      const savings = await this.getSavingsByUser(spreadsheetId, email, groupId);
      
      // Obtener también las acciones del usuario
      const shares = await this.getUserShares(spreadsheetId, email, groupId);
      
      const totalSavingsAmount = savings.reduce((sum, saving) => sum + saving.monto, 0);
      const totalSharesAmount = shares.reduce((sum, share) => sum + (share.cantidad * share.valorAccion), 0);
      const totalAmount = totalSavingsAmount + totalSharesAmount;
      
      const monthlyAmount = savings
        .filter(saving => saving.tipo === 'mensual')
        .reduce((sum, saving) => sum + saving.monto, 0);
      const extraAmount = savings
        .filter(saving => saving.tipo === 'extra')
        .reduce((sum, saving) => sum + saving.monto, 0);
      const goalAmount = savings
        .filter(saving => saving.tipo === 'meta')
        .reduce((sum, saving) => sum + saving.monto, 0);
      
      // Calcular tendencia (últimos 6 meses)
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const monthlyTrend = [];
      for (let i = 5; i >= 0; i--) {
        const monthDate = new Date();
        monthDate.setMonth(monthDate.getMonth() - i);
        const monthStr = monthDate.toISOString().slice(0, 7); // YYYY-MM
        
        const monthSavings = savings.filter(saving => 
          saving.fecha.startsWith(monthStr)
        );
        
        monthlyTrend.push({
          month: monthDate.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' }),
          amount: monthSavings.reduce((sum, saving) => sum + saving.monto, 0)
        });
      }
      
      return {
        totalAmount,
        totalSavingsAmount,
        totalSharesAmount,
        monthlyAmount,
        extraAmount,
        goalAmount,
        totalTransactions: savings.length,
        totalShares: shares.length,
        averageAmount: savings.length > 0 ? totalSavingsAmount / savings.length : 0,
        monthlyTrend,
        shares: shares
      };
    } catch (error) {
      console.error('Error calculando estadísticas:', error);
      throw error;
    }
  }

  // Agregar nueva meta de ahorro
  async addSavingGoal(spreadsheetId, goalData) {
    try {
      await this.ensureAuthenticated();
      await this.createSavingsGoalsSheetIfNotExists(spreadsheetId);
      
      const { 
        email, 
        groupId, 
        nombre, 
        montoObjetivo, 
        fechaObjetivo, 
        descripcion, 
        prioridad, 
        categoria 
      } = goalData;
      
      const goalId = `GOAL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const fechaCreacion = new Date().toISOString();
      
      const values = [
        goalId,
        email,
        groupId,
        nombre,
        Number(montoObjetivo),
        0, // MontoActual inicial
        fechaObjetivo,
        descripcion || '',
        prioridad || 'medium',
        categoria || 'personal',
        'Activa',
        fechaCreacion
      ];
      
      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: 'MetasAhorro!A:L',
        valueInputOption: 'RAW',
        resource: {
          values: [values]
        }
      });
      
      return {
        success: true,
        goalId: goalId,
        data: values
      };
    } catch (error) {
      console.error('Error agregando meta de ahorro:', error);
      throw error;
    }
  }

  // Obtener metas de ahorro por usuario
  async getSavingsGoalsByUser(spreadsheetId, email, groupId = null) {
    try {
      const isAuthenticated = await this.ensureAuthenticated();
      if (!isAuthenticated) {
        return this.getMockGoals();
      }
      await this.createSavingsGoalsSheetIfNotExists(spreadsheetId);
      
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'MetasAhorro!A:L'
      });
      
      const rows = response.data.values || [];
      if (rows.length <= 1) return [];
      
      const headers = rows[0];
      const goals = rows.slice(1).map(row => {
        const goal = {};
        headers.forEach((header, index) => {
          goal[header] = row[index] || '';
        });
        return goal;
      });
      
      // Filtrar por usuario y grupo si se especifica
      let filteredGoals = goals.filter(goal => goal.Email === email);
      
      if (groupId) {
        filteredGoals = filteredGoals.filter(goal => goal.GroupID === groupId);
      }
      
      return filteredGoals.map(goal => ({
        id: goal.ID,
        nombre: goal.Nombre,
        montoObjetivo: Number(goal.MontoObjetivo) || 0,
        montoActual: Number(goal.MontoActual) || 0,
        fechaObjetivo: goal.FechaObjetivo,
        descripcion: goal.Descripcion,
        prioridad: goal.Prioridad,
        categoria: goal.Categoria,
        estado: goal.Estado,
        fechaCreacion: goal.FechaCreacion
      }));
    } catch (error) {
      console.error('Error obteniendo metas de ahorro:', error);
      throw error;
    }
  }

  // Actualizar progreso de meta de ahorro
  async updateGoalProgress(spreadsheetId, goalId, nuevoMonto) {
    try {
      await this.ensureAuthenticated();
      
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'MetasAhorro!A:L'
      });
      
      const rows = response.data.values || [];
      if (rows.length <= 1) return { success: false, message: 'No se encontraron metas' };
      
      const headers = rows[0];
      const goalIndex = rows.findIndex(row => row[0] === goalId);
      
      if (goalIndex === -1) {
        return { success: false, message: 'Meta no encontrada' };
      }
      
      // Actualizar monto actual
      const rowNumber = goalIndex + 1;
      const currentAmountColumnIndex = headers.indexOf('MontoActual');
      const targetAmountColumnIndex = headers.indexOf('MontoObjetivo');
      const statusColumnIndex = headers.indexOf('Estado');
      
      if (currentAmountColumnIndex === -1) {
        return { success: false, message: 'Columna MontoActual no encontrada' };
      }
      
      const targetAmount = Number(rows[goalIndex][targetAmountColumnIndex]) || 0;
      const newStatus = nuevoMonto >= targetAmount ? 'Completada' : 'Activa';
      
      // Actualizar las celdas
      const updates = [
        {
          range: `MetasAhorro!${String.fromCharCode(65 + currentAmountColumnIndex)}${rowNumber}`,
          values: [[nuevoMonto]]
        }
      ];
      
      if (statusColumnIndex !== -1) {
        updates.push({
          range: `MetasAhorro!${String.fromCharCode(65 + statusColumnIndex)}${rowNumber}`,
          values: [[newStatus]]
        });
      }
      
      for (const update of updates) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId,
          range: update.range,
          valueInputOption: 'RAW',
          resource: {
            values: update.values
          }
        });
      }
      
      return {
        success: true,
        nuevoMonto: nuevoMonto,
        estado: newStatus,
        progreso: targetAmount > 0 ? (nuevoMonto / targetAmount) * 100 : 0
      };
    } catch (error) {
      console.error('Error actualizando progreso de meta:', error);
      throw error;
    }
  }

  // Eliminar meta de ahorro
  async deleteGoal(spreadsheetId, goalId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'MetasAhorro!A:L'
      });
      
      const rows = response.data.values || [];
      if (rows.length <= 1) return { success: false, message: 'No se encontraron metas' };
      
      const goalIndex = rows.findIndex(row => row[0] === goalId);
      
      if (goalIndex === -1) {
        return { success: false, message: 'Meta no encontrada' };
      }
      
      // Eliminar la fila
      const deleteRequest = {
        spreadsheetId: spreadsheetId,
        resource: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: await this.getSheetId(spreadsheetId, 'MetasAhorro'),
                dimension: 'ROWS',
                startIndex: goalIndex,
                endIndex: goalIndex + 1
              }
            }
          }]
        }
      };
      
      await this.sheets.spreadsheets.batchUpdate(deleteRequest);
      
      return { success: true, message: 'Meta eliminada exitosamente' };
    } catch (error) {
      console.error('Error eliminando meta:', error);
      throw error;
    }
  }

  // Obtener acciones del usuario
  async getUserShares(spreadsheetId, email, groupId = null) {
    try {
      const isAuthenticated = await this.ensureAuthenticated();
      if (!isAuthenticated) {
        return this.getMockShares();
      }
      
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'Acciones!A:G'
      });
      
      const rows = response.data.values || [];
      if (rows.length <= 1) return [];
      
      const headers = rows[0];
      const shares = rows.slice(1).map(row => {
        const share = {};
        headers.forEach((header, index) => {
          share[header] = row[index] || '';
        });
        return share;
      });
      
      // Filtrar por usuario y grupo (sin distinguir mayúsculas/espacios)
      const norm = (v) => (v || '').toString().trim().toLowerCase();
      const targetEmail = norm(email);
      const targetGroup = (groupId || '').toString().trim();
      let filteredShares = shares.filter(share => norm(share.UserEmail || share.Email) === targetEmail);

      if (targetGroup) {
        filteredShares = filteredShares.filter(share => (share.GroupID || share.Group || '').toString().trim() === targetGroup);
      }

      return filteredShares.map(share => {
        const cantidad = toMoney(share.Shares || share.CantidadAcciones);
        const valorAccion = toMoney(share.ShareValue || share.ValorAccion);
        return {
          fecha: share.Date || share.Fecha,
          cantidad,
          valorAccion,
          tasaInteres: toMoney(share.InterestRate || share.TasaInteres),
          total: cantidad * valorAccion
        };
      });
    } catch (error) {
      console.error('Error obteniendo acciones del usuario:', error);
      return [];
    }
  }

  // Obtener ID de hoja por nombre
  async getSheetId(spreadsheetId, sheetName) {
    try {
      const spreadsheet = await this.sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
      
      const sheet = spreadsheet.data.sheets.find(
        sheet => sheet.properties.title === sheetName
      );
      
      return sheet ? sheet.properties.sheetId : null;
    } catch (error) {
      console.error('Error obteniendo ID de hoja:', error);
      throw error;
    }
  }

  // Métodos para datos de prueba cuando Google Sheets no está disponible

  getMockSavingsStats() {
    return {
      totalAmount: 15000,
      totalSavingsAmount: 8000,
      totalSharesAmount: 5000,
      monthlyAmount: 300,
      extraAmount: 200,
      goalAmount: 100,
      totalTransactions: 12,
      totalShares: 8,
      averageAmount: 666.67,
      monthlyTrend: [
        { month: 'may. 2025', amount: 12000 },
        { month: 'jun. 2025', amount: 13000 },
        { month: 'jul. 2025', amount: 13500 },
        { month: 'ago. 2025', amount: 14000 },
        { month: 'sep. 2025', amount: 14500 },
        { month: 'oct. 2025', amount: 15000 }
      ],
      shares: this.getMockShares()
    };
  }

  getMockSavings() {
    return [
      { fecha: '2025-10-01', monto: 300, tipo: 'mensual', descripcion: 'Ahorro mensual octubre' },
      { fecha: '2025-09-15', monto: 200, tipo: 'extra', descripcion: 'Ahorro extra septiembre' },
      { fecha: '2025-09-01', monto: 300, tipo: 'mensual', descripcion: 'Ahorro mensual septiembre' },
      { fecha: '2025-08-20', monto: 150, tipo: 'meta', descripcion: 'Para vacaciones' },
      { fecha: '2025-08-01', monto: 300, tipo: 'mensual', descripcion: 'Ahorro mensual agosto' }
    ];
  }

  getMockShares() {
    return [
      { fecha: '2025-09-15', cantidad: 10, valorAccion: 150, tasaInteres: 5.5, total: 1500 },
      { fecha: '2025-08-10', cantidad: 5, valorAccion: 200, tasaInteres: 6.0, total: 1000 },
      { fecha: '2025-07-20', cantidad: 8, valorAccion: 125, tasaInteres: 4.8, total: 1000 },
      { fecha: '2025-06-25', cantidad: 12, valorAccion: 175, tasaInteres: 5.2, total: 2100 }
    ];
  }

  getMockGoals() {
    return [
      {
        id: 1,
        nombre: 'Vacaciones 2026',
        montoObjetivo: 5000,
        montoActual: 2000,
        fechaInicio: '2025-01-01',
        fechaObjetivo: '2026-06-01'
      },
      {
        id: 2,
        nombre: 'Fondo de Emergencia',
        montoObjetivo: 10000,
        montoActual: 5000,
        fechaInicio: '2025-03-01',
        fechaObjetivo: '2025-12-31'
      }
    ];
  }
}

module.exports = new SavingsService();
