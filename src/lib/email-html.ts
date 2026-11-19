import type { ReportContent } from './report-content';

/**
 * HTML presentation of the report email. Pure layout: every value arrives already resolved from
 * buildReportContent() / the stored report, nothing is computed or written here except fixed email
 * chrome (the button and attachment-notice wording). Table-based with inline CSS so Gmail and
 * Outlook render it; the <style> block only adds the mobile stacking, the page works without it.
 *
 * Palette = the web report's (ReportView.module.css): black page, #16171a / #1d1e22 surfaces,
 * #34363c lines, #a1a4ad muted text, #d95d1e orange.
 */
export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const EMAIL_BUTTON_LABEL = 'Agendar asesoría personalizada';
export const EMAIL_ATTACHMENT_TITLE = 'Tu informe completo está adjunto';
export const EMAIL_ATTACHMENT_NOTE =
  'Ábrelo para ver tu diagnóstico completo, tus prioridades y tu plan de acción.';

const C = {
  page: '#000000',
  card: '#16171a',
  hero: '#1a1a1c',
  surface: '#1d1e22',
  line: '#34363c',
  ink: '#ffffff',
  muted: '#a1a4ad',
  orange: '#d95d1e',
  orangeBg: '#3b241b',
};
const FONT = "Inter,'Helvetica Neue',Helvetica,Arial,sans-serif";
// Long unbroken text (names, URLs, file names) must wrap instead of widening the layout.
const WRAP = 'word-break:break-word;overflow-wrap:anywhere';

export type EmailHtmlInput = {
  content: ReportContent;
  name: string;
  /** The stored protection percentage (0-100), used only to size the progress bar. */
  percent: number;
  highlights: Array<{ label: string; value: string }>;
  attachmentName: string;
  logoUrl: string | null;
};

function progressBar(percent: number): string {
  const fill = Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0;
  const cell = (width: number, color: string, radius: string) =>
    `<td width="${width}%" bgcolor="${color}" style="width:${width}%;background-color:${color};height:8px;line-height:8px;font-size:0;${radius}">&nbsp;</td>`;
  const cells = [
    fill > 0 ? cell(fill, C.orange, `border-radius:8px${fill < 100 ? ' 0 0 8px' : ''}`) : '',
    fill < 100 ? cell(100 - fill, C.line, `border-radius:${fill > 0 ? '0 8px 8px 0' : '8px'}`) : '',
  ].join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0 0;border-collapse:separate"><tr>${cells}</tr></table>`;
}

const card = (inner: string, attrs: string) =>
  `<td ${attrs} valign="top" bgcolor="${C.surface}" style="background-color:${C.surface};border:1px solid ${C.line};border-radius:12px;padding:20px">${inner}</td>`;

const label = (text: string) =>
  `<div style="font-size:11px;line-height:1.4;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${C.muted}">${esc(text)}</div>`;

export function renderEmailHtml(input: EmailHtmlInput): string {
  const { content: c, name, percent, highlights, attachmentName, logoUrl } = input;
  const { score, weak } = c.hero;

  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="Quirón Arquitectos Financieros" width="132" style="display:block;border:0;outline:none;width:132px;max-width:100%;height:auto">`
    : `<span style="font-size:20px;font-weight:bold;letter-spacing:3px;color:${C.ink}">QUIRÓN</span>`;

  const findings = highlights
    .map(
      (h, i) =>
        `<tr><td style="padding:${i === 0 ? '0' : '14px'} 0 ${i === highlights.length - 1 ? '0' : '14px'};${i === 0 ? '' : `border-top:1px solid ${C.line};`}">
${label(h.label)}
<div style="margin-top:4px;font-size:15px;line-height:1.55;color:${C.ink};${WRAP}">${esc(h.value)}</div>
</td></tr>`,
    )
    .join('\n');

  const findingsBlock = highlights.length
    ? `<tr><td class="px" style="padding:28px 32px 0">
<div style="font-size:11px;line-height:1.4;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${C.orange}">Lo más importante de tu diagnóstico</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:12px;border-collapse:separate"><tr>
<td bgcolor="${C.surface}" style="background-color:${C.surface};border:1px solid ${C.line};border-left:3px solid ${C.orange};border-radius:12px;padding:20px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
${findings}
</table></td></tr></table>
</td></tr>`
    : '';

  const button = c.cta.url
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto"><tr><td align="center" bgcolor="${C.orange}" style="background-color:${C.orange};border-radius:8px"><a href="${esc(c.cta.url)}" target="_blank" style="display:block;padding:15px 28px;font-family:${FONT};font-size:15px;font-weight:800;line-height:1.2;color:#000000;text-decoration:none;border-radius:8px">${EMAIL_BUTTON_LABEL}</a></td></tr></table>`
    : `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.muted}">${esc(c.cta.unavailableNote)}</p>`;

  return `<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(c.hero.title)}</title>
<style>
@media only screen and (max-width:620px){
.container{width:100%!important}
.px{padding-left:20px!important;padding-right:20px!important}
.stack{display:block!important;width:100%!important;box-sizing:border-box!important}
.gap{display:block!important;width:100%!important;height:12px!important;line-height:12px!important;font-size:12px!important}
.h1{font-size:26px!important}
.big{font-size:40px!important}
}
</style></head>
<body bgcolor="${C.page}" style="margin:0;padding:0;background-color:${C.page};font-family:${FONT};color:${C.ink};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.page}">${esc(`${score.label}: ${score.value} · ${score.levelLabel}`)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.page}" style="background-color:${C.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" class="container" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.card}" style="width:600px;max-width:600px;background-color:${C.card};border:1px solid ${C.line};border-radius:12px;border-collapse:separate">

<tr><td class="px" bgcolor="${C.page}" style="padding:28px 32px 22px;background-color:${C.page};border-radius:12px 12px 0 0;border-bottom:2px solid ${C.orange}">
${logo}
<div style="margin-top:14px;font-size:11px;line-height:1.4;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${C.orange};${WRAP}">${esc(c.brand)}</div>
</td></tr>

<tr><td class="px" bgcolor="${C.hero}" style="padding:32px 32px 28px;background-color:${C.hero};border-bottom:1px solid ${C.line}">
<h1 class="h1" style="margin:0 0 20px;font-size:30px;line-height:1.18;font-weight:700;color:${C.ink};${WRAP}">${esc(c.hero.title)}</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:${C.ink};${WRAP}">Hola, ${esc(name)}:</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:${C.ink}">Gracias por completar el cuestionario de Blindaje Patrimonial de Quirón.</p>
<p style="margin:0;font-size:15px;line-height:1.6;color:${C.muted}">Hemos preparado tu diagnóstico personalizado. Aquí tienes un resumen de los resultados más importantes.</p>
</td></tr>

<tr><td class="px" style="padding:28px 32px 0">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate"><tr>
${card(
  `${label(score.label)}
<div class="big" style="margin:8px 0 10px;font-size:46px;line-height:1.1;font-weight:700;color:${C.orange}">${esc(score.value)}</div>
<span style="display:inline-block;padding:5px 11px;border-radius:999px;background-color:${C.orange};font-size:11px;line-height:1.3;font-weight:800;color:#000000">${esc(score.levelLabel)}</span>
${progressBar(percent)}`,
  'class="stack" width="55%"',
)}
<td class="gap" width="12" style="width:12px;font-size:0;line-height:0">&nbsp;</td>
${card(
  `${label(weak.label)}
<div class="big" style="margin:8px 0 10px;font-size:46px;line-height:1.1;font-weight:700;color:${C.orange}">${esc(weak.value)} <span style="font-size:22px;font-weight:400;color:${C.muted}">${esc(weak.of)}</span></div>
<div style="font-size:12px;line-height:1.5;color:${C.muted}">${esc(weak.sub)}</div>`,
  'class="stack"',
)}
</tr></table>
</td></tr>

${findingsBlock}

<tr><td class="px" align="center" style="padding:32px 32px 8px">
<div style="margin:0 0 6px;font-size:20px;line-height:1.3;font-weight:700;color:${C.ink};${WRAP}">${esc(c.cta.title)}</div>
<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${C.muted}">${esc(c.cta.text)}</p>
${button}
</td></tr>

<tr><td class="px" style="padding:28px 32px 0">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate"><tr>
<td bgcolor="${C.orangeBg}" style="background-color:${C.orangeBg};border:1px solid ${C.orange};border-radius:12px;padding:16px 20px">
<div style="font-size:15px;line-height:1.4;font-weight:bold;color:${C.ink}">${EMAIL_ATTACHMENT_TITLE}</div>
<div style="margin-top:4px;font-size:13px;line-height:1.5;color:#f2aa83;${WRAP}">${esc(attachmentName)}</div>
<div style="margin-top:6px;font-size:12px;line-height:1.5;color:${C.muted}">${EMAIL_ATTACHMENT_NOTE}</div>
</td></tr></table>
</td></tr>

<tr><td class="px" style="padding:28px 32px 28px">
<div style="border-top:1px solid ${C.line};padding-top:18px;font-size:11px;line-height:1.6;color:${C.muted};${WRAP}"><strong style="color:${C.ink};letter-spacing:2px">QUIRÓN</strong> · Arquitectos Financieros<br><span style="display:block;margin-top:8px">${esc(c.legal)}</span></div>
</td></tr>

</table></td></tr></table></body></html>`;
}
