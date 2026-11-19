import { questions } from './questions';
export type Answers = Record<string, boolean>;
export type Score = {
  yes: number;
  no: number;
  protection: number;
  gap: number;
  personalYes: number;
  businessYes: number;
  personalPercent: number;
  businessPercent: number;
  category: string;
  missing: string[];
};
/**
 * "Nivel de Blindaje" — must stay identical to the Dashboard!G formula in the spreadsheet,
 * which also drives the email sent to the user:
 *   =IF(C=100,"Excelente",IF(C>=80,"Alto",IF(C>=60,"Medio",IF(C>=40,"Bajo","Muy bajo"))))
 * where C is the % of "Sí" answers (yes * 5).
 */
export function blindajeLevel(protection: number): string {
  if (protection === 100) return 'Excelente';
  if (protection >= 80) return 'Alto';
  if (protection >= 60) return 'Medio';
  if (protection >= 40) return 'Bajo';
  return 'Muy bajo';
}

export function scoreAnswers(answers: Answers): Score {
  const yes = questions.filter((q) => answers[q.id] === true).length;
  const no = 20 - yes;
  const personalYes = questions.filter(
    (q) => q.section === 'personal' && answers[q.id] === true,
  ).length;
  const businessYes = questions.filter(
    (q) => q.section === 'empresarial' && answers[q.id] === true,
  ).length;
  const protection = yes * 5;
  return {
    yes,
    no,
    protection,
    gap: no * 5,
    personalYes,
    businessYes,
    personalPercent: personalYes * 10,
    businessPercent: businessYes * 10,
    category: blindajeLevel(protection),
    missing: questions.filter((q) => answers[q.id] === false).map((q) => q.id),
  };
}
