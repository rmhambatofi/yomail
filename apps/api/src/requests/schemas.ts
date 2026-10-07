import { z } from 'zod';
import { NOTE_MAX_LENGTH } from '@yomail/shared';

/** Body schemas of the owner routes on requests (phase 8.3). */

export const updateNoteSchema = z.object({
  note: z
    .string()
    .trim()
    .max(NOTE_MAX_LENGTH, `at most ${NOTE_MAX_LENGTH} characters`)
    .nullable()
    // An empty note means "no note".
    .transform((value) => (value === '' ? null : value)),
});

export const replaySchema = z.object({
  target_url: z.string().trim().min(1, 'required').max(2048, 'at most 2048 characters'),
});

export type UpdateNoteBody = z.infer<typeof updateNoteSchema>;
export type ReplayBody = z.infer<typeof replaySchema>;
