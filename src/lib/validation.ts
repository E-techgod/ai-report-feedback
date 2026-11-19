import { z } from 'zod';
import { questionIds } from './questions';
export const submissionSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  privacyAccepted: z.literal(true),
  answers: z
    .record(z.string(), z.boolean())
    .refine(
      (a) => Object.keys(a).length === 20 && questionIds.every((id) => typeof a[id] === 'boolean'),
      'Se requieren las 20 respuestas Sí/No.',
    ),
});
export type Submission = z.infer<typeof submissionSchema>;
