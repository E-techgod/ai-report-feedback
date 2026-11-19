/**
 * DRAFT — NOT INSTALLED. Review before pasting into the spreadsheet's Apps Script project.
 *
 * Wraps the EXISTING enviarCorreosPendientes() (left untouched) in a time-driven trigger that is
 * safe against overlapping runs and reports failures instead of dying silently.
 *
 * Why a time-driven trigger: rows appended through the Sheets API (POST /api/questionnaire)
 * do NOT fire onFormSubmit, so pending rows must be picked up by polling.
 *
 * BEFORE enabling, enviarCorreosPendientes() must be idempotent:
 *   - it must select only rows not yet marked as sent, and
 *   - it must mark each row as sent right after (ideally in the same loop iteration as) sending,
 *     otherwise an error between send and mark causes a duplicate email on the next run.
 * It must also tolerate a half-written row never happening: API appends are atomic per row.
 *
 * Mail quotas: ~100 recipients/day (consumer Gmail) or ~1,500/day (Workspace).
 */
var CORREOS_TRIGGER_HANDLER = 'procesarCorreosPendientesSeguro';
var CORREOS_INTERVAL_MINUTES = 5;
// Set to an address to be notified of failures by email. Leave '' to log only (no emails).
var CORREOS_ALERT_EMAIL = '';

function procesarCorreosPendientesSeguro() {
  var lock = LockService.getScriptLock();
  // Skip (do not queue) if the previous run is still going, so triggers never overlap.
  if (!lock.tryLock(30000)) {
    console.warn('procesarCorreosPendientesSeguro: otra ejecución sigue activa; se omite.');
    return;
  }
  try {
    enviarCorreosPendientes();
  } catch (err) {
    var message = (err && err.stack) || String(err);
    console.error('enviarCorreosPendientes falló: ' + message);
    if (CORREOS_ALERT_EMAIL) {
      try {
        MailApp.sendEmail(
          CORREOS_ALERT_EMAIL,
          'Quirón: falló el envío de correos pendientes',
          message.slice(0, 1500),
        );
      } catch (mailErr) {
        console.error('No se pudo enviar la alerta: ' + mailErr);
      }
    }
    throw err; // keep the failure visible in the Apps Script Executions list
  } finally {
    lock.releaseLock();
  }
}

/** Run once manually from the editor to install the trigger (idempotent). */
function instalarTriggerCorreos() {
  desinstalarTriggerCorreos();
  ScriptApp.newTrigger(CORREOS_TRIGGER_HANDLER)
    .timeBased()
    .everyMinutes(CORREOS_INTERVAL_MINUTES)
    .create();
}

/** Run to pause the workflow (e.g. before a test submission). */
function desinstalarTriggerCorreos() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === CORREOS_TRIGGER_HANDLER) ScriptApp.deleteTrigger(t);
  });
}
