/**
 * TEST-ONLY — DRAFT, NOT INSTALLED. Paste into the spreadsheet's Apps Script project as a NEW file.
 *
 * Processes EXACTLY ONE explicitly selected Dashboard row and sends the diagnostic email ONLY to a
 * test address you control. It never iterates over rows, never reads the recipient from historical
 * data, and installs no triggers. It does not call or modify enviarCorreosPendientes().
 *
 * IMPORTANT: this is a RECONSTRUCTION from a written description of enviarCorreosPendientes()
 * (Dashboard A:I from row 2; questionnaire answers by header; recommendations from answer indices 0,7,3,2,16 when
 * the answer is "no", max 3; pie chart from the Dashboard percentages; GmailApp; H="Enviado",
 * I=timestamp). The original source was NOT available. Replace RECOMENDACIONES and buildHtml_
 * with the production texts/markup so the test renders what customers will really receive.
 *
 * Safety guards (ALL must pass or nothing is sent):
 *   1. PRUEBA.FILA is an integer >= 2 and PRUEBA.CORREO_PRUEBA is a valid address.
 *   2. The selected Dashboard row's email (col B) EQUALS PRUEBA.CORREO_PRUEBA.
 *   3. The selected row's name (col A) starts with "PRUEBA".
 *   4. Dashboard col H of that row is empty (not "Enviado"/"Enviando").
 *   5. One-shot arming: enviarCorreoPrueba() only runs after armarEnvioPrueba() was run for the same
 *      row, and the arming flag is deleted BEFORE sending (one flag = at most one email).
 *   6. LockService, and the recipient is always PRUEBA.CORREO_PRUEBA, subject prefixed "[PRUEBA]".
 *
 * Workflow:  previsualizarCorreoPrueba()  -> logs the email, sends nothing (safe to run anytime)
 *            armarEnvioPrueba()           -> sets the one-shot flag (still sends nothing)
 *            enviarCorreoPrueba()         -> sends ONE email, then marks H/I on that row
 */
var PRUEBA = {
  FILA: null, // e.g. 14 — Dashboard row number of the test row. Required.
  CORREO_PRUEBA: '', // e.g. 'tu.correo@quirongroup.com' — an address you control. Required.
  HOJA_DASHBOARD: 'Dashboard',
  HOJA_RESPUESTAS: 'Respuestas de formulario 1',
  PREFIJO_NOMBRE: 'PRUEBA',
  MARCAR_ENVIADO: true, // after a real send, write H="Enviado", I=now on THIS row only
};
var PRUEBA_FLAG = 'PRUEBA_ENVIO_FILA';
// Answer indices (0 = A1 … 19 = B10) in priority order; first three answered "no" are used.
var INDICES_RECOMENDACION = [0, 7, 3, 2, 16];
// TODO: replace with the production recommendation texts.
var RECOMENDACIONES = {
  0: 'Actualiza tu testamento (no más de 5 años).',
  7: 'Revisa que la suma asegurada de tu seguro de vida sea suficiente para tu familia.',
  3: 'Define con tu familia un plan de acción en caso de fallecimiento.',
  2: 'Asegura que tu familia tenga acceso al detalle de todo tu patrimonio.',
  16: 'Establece un plan de sucesión dentro de tu empresa.',
};

function leerRespuestasPorCabecera_(resp, fila, correoEsperado) {
  var ancho = resp.getLastColumn();
  var cabeceras = resp.getRange(1, 1, 1, ancho).getValues()[0];
  var indices = {};
  var correoIndice = -1;
  cabeceras.forEach(function (valor, indice) {
    var texto = String(valor).trim();
    if (/^Correo\s*\*?$/i.test(texto)) {
      if (correoIndice !== -1) throw new Error('Cabecera de correo duplicada. Abortado.');
      correoIndice = indice;
    }
    var match = texto.match(/^([AB])\)\s*(\d{1,2})\s*[.:-]/i);
    if (match) {
      var id = match[1].toUpperCase() + Number(match[2]);
      if (indices[id] !== undefined) throw new Error('Cabecera duplicada: ' + id);
      indices[id] = indice;
    }
  });
  if (correoIndice < 0) throw new Error('Falta cabecera Correo*. Abortado.');
  var valores = resp.getRange(fila, 1, 1, ancho).getValues()[0];
  if (String(valores[correoIndice]).trim().toLowerCase() !== correoEsperado.toLowerCase()) {
    throw new Error('Correo de respuestas no coincide con Dashboard. Abortado.');
  }
  var respuestas = [];
  ['A', 'B'].forEach(function (grupo) {
    for (var n = 1; n <= 10; n++) {
      var id = grupo + n;
      if (indices[id] === undefined) throw new Error('Falta cabecera ' + id + '. Abortado.');
      respuestas.push(valores[indices[id]]);
    }
  });
  return respuestas;
}

function validarFilaPrueba_() {
  var fila = PRUEBA.FILA;
  if (!Number.isInteger(fila) || fila < 2) throw new Error('PRUEBA.FILA debe ser un entero >= 2.');
  var destino = String(PRUEBA.CORREO_PRUEBA || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(destino)) throw new Error('PRUEBA.CORREO_PRUEBA inválido.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dash = ss.getSheetByName(PRUEBA.HOJA_DASHBOARD);
  var resp = ss.getSheetByName(PRUEBA.HOJA_RESPUESTAS);
  if (!dash || !resp) throw new Error('No se encontraron las hojas esperadas.');

  var d = dash.getRange(fila, 1, 1, 9).getValues()[0]; // A:I of exactly one row
  var nombre = String(d[0]).trim();
  var correo = String(d[1]).trim().toLowerCase();
  var estado = String(d[7]).trim();
  if (correo !== destino.toLowerCase()) {
    throw new Error('El correo de la fila ' + fila + ' no coincide con CORREO_PRUEBA. Abortado.');
  }
  if (nombre.toUpperCase().indexOf(PRUEBA.PREFIJO_NOMBRE.toUpperCase()) !== 0) {
    throw new Error('El nombre de la fila ' + fila + ' no empieza con "' + PRUEBA.PREFIJO_NOMBRE + '". Abortado.');
  }
  if (estado !== '') throw new Error('La columna H de la fila ' + fila + ' ya tiene valor ("' + estado + '"). Abortado.');

  var respuestas = leerRespuestasPorCabecera_(resp, fila, correo);
  if (respuestas.some(function (v) { return String(v).trim() === ''; })) {
    throw new Error('La fila ' + fila + ' de respuestas está incompleta. Abortado.');
  }
  return { dash: dash, fila: fila, destino: destino, d: d, respuestas: respuestas };
}

function construirCorreoPrueba_(ctx) {
  var d = ctx.d;
  var pctSi = Number(d[2]);
  var pctNo = Number(d[3]);
  var nivel = String(d[6]);
  var recs = INDICES_RECOMENDACION.filter(function (i) {
    return String(ctx.respuestas[i]).trim().toLowerCase() === 'no';
  })
    .slice(0, 3)
    .map(function (i) {
      return RECOMENDACIONES[i];
    });

  var chart = Charts.newPieChart()
    .setDataTable(
      Charts.newDataTable()
        .addColumn(Charts.ColumnType.STRING, 'Respuesta')
        .addColumn(Charts.ColumnType.NUMBER, 'Porcentaje')
        .addRow(['Sí', pctSi])
        .addRow(['No', pctNo])
        .build(),
    )
    .setDimensions(400, 260)
    .build()
    .getAs('image/png')
    .setName('grafica');

  var texto = String(d[5]); // Dashboard "Mensaje"
  var html =
    '<p>' + texto.replace(/\n/g, '<br>') + '</p>' +
    '<p><img src="cid:grafica" alt="Resultado"></p>' +
    (recs.length ? '<p><b>Recomendaciones:</b></p><ul><li>' + recs.join('</li><li>') + '</li></ul>' : '');
  return {
    subject: '[PRUEBA] ' + String(d[4]),
    text: texto + (recs.length ? '\n\nRecomendaciones:\n- ' + recs.join('\n- ') : ''),
    html: html,
    chart: chart,
    nivel: nivel,
    recs: recs,
  };
}

/** Safe anytime: validates the row and logs the email. Sends nothing, writes nothing. */
function previsualizarCorreoPrueba() {
  var ctx = validarFilaPrueba_();
  var mail = construirCorreoPrueba_(ctx);
  console.log('PREVIEW — no se envió nada.');
  console.log('Fila: ' + ctx.fila + ' | Para: ' + ctx.destino + ' | Nivel: ' + mail.nivel);
  console.log('Asunto: ' + mail.subject);
  console.log('Recomendaciones (' + mail.recs.length + '): ' + JSON.stringify(mail.recs));
  console.log('Cuerpo:\n' + mail.text);
}

/** Arms ONE send for PRUEBA.FILA. Does not send. */
function armarEnvioPrueba() {
  var ctx = validarFilaPrueba_(); // fails early if the row is not a safe test row
  PropertiesService.getScriptProperties().setProperty(PRUEBA_FLAG, String(ctx.fila));
  console.log('Armado para la fila ' + ctx.fila + '. Ahora ejecuta enviarCorreoPrueba() UNA vez.');
}

/** Sends ONE email to CORREO_PRUEBA for PRUEBA.FILA. Requires armarEnvioPrueba() first. */
function enviarCorreoPrueba() {
  if (!legacyEmailEnabled_()) throw new Error('Legacy report email is disabled. No test sent.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Otra ejecución está activa.');
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty(PRUEBA_FLAG) !== String(PRUEBA.FILA)) {
      throw new Error('No está armado para la fila ' + PRUEBA.FILA + '. Ejecuta armarEnvioPrueba().');
    }
    var ctx = validarFilaPrueba_();
    var mail = construirCorreoPrueba_(ctx); // build first: if it throws, nothing was sent
    props.deleteProperty(PRUEBA_FLAG); // one-shot: consume the flag BEFORE sending
    GmailApp.sendEmail(ctx.destino, mail.subject, mail.text, {
      htmlBody: mail.html,
      inlineImages: { grafica: mail.chart },
      name: 'Quirón (PRUEBA)',
    });
    if (PRUEBA.MARCAR_ENVIADO) {
      ctx.dash.getRange(ctx.fila, 8, 1, 2).setValues([['Enviado', new Date()]]);
      SpreadsheetApp.flush();
    }
    console.log('Enviado UNA prueba a ' + ctx.destino + ' (fila ' + ctx.fila + ').');
  } finally {
    lock.releaseLock();
  }
}
