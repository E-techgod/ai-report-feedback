import type { ReportContent } from './report-content';

/** Table-based email; all report values come from the persisted report. */
export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const EMAIL_BUTTON_LABEL = 'Agendar asesoría personalizada';
export const EMAIL_ATTACHMENT_TITLE = 'Informe completo adjunto';

const C = {
  page: '#ffffff',
  ink: '#171717',
  muted: '#777777',
  line: '#e6e6e6',
  orange: '#d95d1e',
  track: '#ededed',
  logo: '#000000',
};
/** Display size of the 604x264 logo PNG, in CSS pixels, at its natural aspect ratio. */
export const LOGO_WIDTH = 120;
export const LOGO_HEIGHT = Math.round((LOGO_WIDTH * 264) / 604);
const FONT = "Inter,'Helvetica Neue',Helvetica,Arial,sans-serif";
const WRAP = 'word-break:break-word;overflow-wrap:anywhere';

export type EmailHtmlInput = {
  content: ReportContent;
  name: string;
  percent: number;
  highlights: Array<{ label: string; value: string }>;
  attachmentName: string;
  logoUrl: string | null;
};

function progressBar(percent: number): string {
  const fill = Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0;
  const cell = (width: number, color: string) =>
    `<td width="${width}%" bgcolor="${color}" style="width:${width}%;background-color:${color};height:6px;line-height:6px;font-size:0">&nbsp;</td>`;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 8px;border-collapse:collapse"><tr>${fill > 0 ? cell(fill, C.orange) : ''}${fill < 100 ? cell(100 - fill, C.track) : ''}</tr></table>`;
}

export function renderEmailHtml(input: EmailHtmlInput): string {
  const { content: c, name, percent, highlights, attachmentName, logoUrl } = input;
  const { score, weak } = c.hero;
  // The supplied PNG (604x264) has white lettering, so it needs a small black field on the white
  // email. width/height attributes keep its 2.288 aspect ratio in Outlook; CSS height:auto keeps it
  // elsewhere. Without a public HTTPS logo URL (see site-url.ts) a text wordmark is used instead.
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="Quirón" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" style="display:block;border:0;outline:none;width:${LOGO_WIDTH}px;max-width:100%;height:auto">`
    : `<span style="font-size:19px;font-weight:700;letter-spacing:2px;color:#ffffff">QUIRÓN<span style="color:${C.orange}">.</span></span>`;
  const findings = highlights
    .map(
      (h, i) => `<tr><td style="padding:${i ? '18px' : '0'} 0 0">
<div style="font-size:11px;line-height:1.4;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.muted}">${esc(h.label)}</div>
<div style="margin-top:5px;font-size:16px;line-height:1.5;color:${C.ink};${WRAP}">${esc(h.value)}</div>
</td></tr>`,
    )
    .join('\n');
  const button = c.cta.url
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${C.orange}" style="background-color:${C.orange};border-radius:6px"><a href="${esc(c.cta.url)}" target="_blank" style="display:block;padding:14px 24px;font-family:${FONT};font-size:15px;font-weight:700;line-height:1.3;color:#ffffff;text-decoration:none">${EMAIL_BUTTON_LABEL}</a></td></tr></table>`
    : `<p style="margin:0;font-size:14px;line-height:1.5;color:${C.muted}">${esc(c.cta.unavailableNote)}</p>`;
  return `<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>Tu diagnóstico patrimonial está listo</title>
<style>@media only screen and (max-width:620px){.container{width:100%!important}.px{padding-left:22px!important;padding-right:22px!important}.h1{font-size:28px!important}.score{font-size:40px!important}}</style>
</head><body bgcolor="${C.page}" style="margin:0;padding:0;background-color:${C.page};font-family:${FONT};color:${C.ink};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.page}">${esc(`${score.label}: ${score.value} · ${score.levelLabel}`)}&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.page}" style="background-color:${C.page}"><tr><td align="center">
<table role="presentation" class="container" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;border-collapse:collapse;text-align:left">
<tr><td class="px" style="padding:40px 40px 0"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${C.logo}" style="background-color:${C.logo};padding:7px 12px">${logo}</td></tr></table></td></tr>
<tr><td class="px" style="padding:30px 40px 0"><div style="width:36px;height:3px;background-color:${C.orange};font-size:0;line-height:3px">&nbsp;</div>
<h1 class="h1" style="margin:24px 0 16px;font-size:32px;line-height:1.2;font-weight:700;color:${C.ink};${WRAP}">Tu diagnóstico patrimonial está listo</h1>
<p style="margin:0;font-size:16px;line-height:1.65;color:${C.muted};${WRAP}">Hola, ${esc(name)}. Gracias por completar el cuestionario de Blindaje Patrimonial. Aquí tienes lo más importante de tus resultados.</p></td></tr>
<tr><td class="px" style="padding:38px 40px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
<td valign="bottom" width="60%" style="width:60%"><div style="font-size:15px;line-height:1.4;color:${C.muted}">${esc(score.label)}</div><div class="score" style="margin-top:7px;font-size:48px;line-height:1.1;font-weight:700;color:${C.ink}">${esc(score.value)}</div></td>
<td valign="bottom" align="right" style="text-align:right"><div style="font-size:28px;line-height:1.2;font-weight:700;color:${C.ink}">${esc(weak.value)} <span style="font-size:17px;font-weight:400;color:${C.muted}">${esc(weak.of)}</span></div><div style="margin-top:6px;font-size:13px;line-height:1.4;color:${C.muted}">${esc(weak.label)}</div></td>
</tr></table><div style="margin-top:8px;font-size:14px;line-height:1.4;font-weight:700;color:${C.orange}">${esc(score.levelLabel)}</div>
${progressBar(percent)}<div style="font-size:12px;line-height:1.5;color:${C.muted}">${esc(weak.sub)}</div></td></tr>
${highlights.length ? `<tr><td class="px" style="padding:30px 40px 0"><div style="border-top:1px solid ${C.line};padding-top:30px;font-size:20px;line-height:1.3;font-weight:700;color:${C.ink}">Lo más relevante</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:22px">${findings}</table></td></tr>` : ''}
<tr><td class="px" style="padding:34px 40px 0"><div style="border-top:1px solid ${C.line};padding-top:30px;font-size:16px;line-height:1.4;font-weight:700;color:${C.ink}">${EMAIL_ATTACHMENT_TITLE}</div><div style="margin-top:6px;font-size:13px;line-height:1.5;color:${C.muted};${WRAP}">${esc(attachmentName)}</div></td></tr>
<tr><td class="px" style="padding:30px 40px 0"><p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:${C.muted}">Un asesor de Quirón puede ayudarte a convertir estos hallazgos en un plan personalizado.</p>${button}</td></tr>
<tr><td class="px" style="padding:34px 40px 42px"><div style="border-top:1px solid ${C.line};padding-top:24px;font-size:12px;line-height:1.55;color:${C.muted};${WRAP}"><strong style="color:${C.ink}">QUIRÓN · Arquitectos Financieros</strong><br><span style="display:block;margin-top:10px">${esc(c.legal)}</span></div></td></tr>
</table></td></tr></table></body></html>`;
}
