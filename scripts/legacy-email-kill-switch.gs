/*
 * Add this file to the EXISTING Apps Script project, then paste the guard line
 * below immediately after the opening brace of enviarCorreosPendientes().
 * Do not install a new trigger for this helper.
 * Default is OFF until the Script Property is explicitly "true".
 *
 * if (!legacyEmailEnabled_()) return;
 */
function legacyEmailEnabled_() {
  return PropertiesService.getScriptProperties().getProperty('LEGACY_EMAIL_ENABLED') === 'true';
}
