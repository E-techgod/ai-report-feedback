/*
 * Prepared only. Add this helper to the existing Apps Script project after reviewing
 * the REAL enviarCorreosPendientes() source. Replace its positional E:X answer read with:
 *
 * var respuestas = leerRespuestasLegacyPorCabecera_(resp, fila, correo);
 *
 * Adapt the variable names to the installed function. Do not activate this patch
 * until the existing trigger, row matching, and email path have been audited.
 */
function leerRespuestasLegacyPorCabecera_(hoja, fila, correoEsperado) {
  var ancho = hoja.getLastColumn();
  var cabeceras = hoja.getRange(1, 1, 1, ancho).getValues()[0];
  var indices = {};
  var correoIndice = -1;
  cabeceras.forEach(function (valor, indice) {
    var texto = String(valor).trim();
    if (/^Correo\s*\*?$/i.test(texto)) {
      if (correoIndice !== -1) throw new Error('Cabecera Correo duplicada');
      correoIndice = indice;
    }
    var match = texto.match(/^([AB])\)\s*(\d{1,2})\s*[.:-]/i);
    if (match) {
      var id = match[1].toUpperCase() + Number(match[2]);
      if (indices[id] !== undefined) throw new Error('Cabecera duplicada: ' + id);
      indices[id] = indice;
    }
  });
  if (correoIndice < 0) throw new Error('Falta cabecera Correo');
  var valores = hoja.getRange(fila, 1, 1, ancho).getValues()[0];
  if (String(valores[correoIndice]).trim().toLowerCase() !== String(correoEsperado).trim().toLowerCase())
    throw new Error('Correo de respuestas no coincide con Dashboard');
  var respuestas = [];
  ['A', 'B'].forEach(function (grupo) {
    for (var n = 1; n <= 10; n++) {
      var id = grupo + n;
      if (indices[id] === undefined) throw new Error('Falta cabecera ' + id);
      respuestas.push(valores[indices[id]]);
    }
  });
  if (respuestas.some(function (valor) { return String(valor).trim() === ''; }))
    throw new Error('Respuestas incompletas');
  return respuestas;
}
