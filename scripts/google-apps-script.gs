/**
 * Deploy as Web App: Execute as owner; access anyone (endpoint is protected by
 * SCRIPT_SHARED_SECRET, a random 32+ byte secret stored in Script Properties).
 * Bind this script to the EXISTING questionnaire spreadsheet, and create a
 * new tab named WEB_SHIELD_2026 to preserve the original Form response sheet.
 * IMPORTANT: Google Apps Script endpoints do not support custom auth headers
 * reliably in web app doPost; token is in request body over HTTPS.
 * This is a starter: add rate-limiting / abuse protection before a mass mailing.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var data = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SCRIPT_SHARED_SECRET');
    if (!secret || !data.secret || data.secret !== secret) return reply({ ok:false, error:'Unauthorized' });
    if (!data.id || !/^[0-9a-f-]{36}$/i.test(data.id)) return reply({ok:false,error:'Invalid ID'});
    if (!data.privacyAccepted || !data.firstName || !data.lastName || !data.email) return reply({ok:false,error:'Invalid contact'});
    var ids = [];
    for(var i=1;i<=10;i++) ids.push('A'+i);
    for(var j=1;j<=10;j++) ids.push('B'+j);
    if (!data.answers || ids.some(function(id){return typeof data.answers[id] !== 'boolean';})) return reply({ok:false,error:'Invalid answers'});
    var yes = ids.filter(function(id){return data.answers[id] === true;}).length;
    if (data.score.protection !== yes*5 || data.score.yes !== yes) return reply({ok:false,error:'Invalid score'});
    lock.waitLock(15000);
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName('WEB_SHIELD_2026') || ss.insertSheet('WEB_SHIELD_2026');
      if (sheet.getLastRow() === 0) sheet.appendRow(['ID','Fecha','Nombre','Apellido','Correo','Si','No','Proteccion','Brechas','Personal %','Empresarial %'].concat(ids));
      // ID-based deduplication for network retries, using only column A.
      var existing = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues() : [];
      if (existing.some(function(row){return row[0] === data.id;})) return reply({ok:true,duplicate:true});
      // Apostrophe prefixes prevent leading spreadsheet formula injection.
      function safeText(s){return "'"+String(s).slice(0,254).replace(/[\r\n]/g,' ');}
      var row = [data.id, new Date(), safeText(data.firstName), safeText(data.lastName), safeText(data.email),yes,20-yes,yes*5,(20-yes)*5,ids.slice(0,10).filter(function(id){return data.answers[id]}).length*10,ids.slice(10).filter(function(id){return data.answers[id]}).length*10];
      ids.forEach(function(id){row.push(data.answers[id] ? 'Sí' : 'No');});
      sheet.appendRow(row);
      return reply({ok:true});
    } finally { lock.releaseLock(); }
  } catch(err) { return reply({ok:false,error:'Server error'}); }
}
function reply(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
