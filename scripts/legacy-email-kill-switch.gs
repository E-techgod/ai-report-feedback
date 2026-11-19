/*
 * PASTE THESE THREE LINES immediately after the opening brace of the existing
 * enviarCorreosPendientes() function in the live Apps Script project.
 * Do not replace the function, run it here, or install a new trigger.
 * Default is OFF until the Script Property is explicitly "true".
 */
if (PropertiesService.getScriptProperties().getProperty('LEGACY_EMAIL_ENABLED') !== 'true') {
  console.log('Legacy report email is disabled');
  return;
}
