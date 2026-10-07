import { z } from 'zod';

/** Body of POST /devmailcatcher/messages.json: a message pushed by another application. */
export const caughtMailSchema = z
  .object({
    to: z.string().trim().min(1, 'required').max(320, 'at most 320 characters'),
    from: z.string().trim().max(320, 'at most 320 characters').default(''),
    subject: z.string().trim().max(998, 'at most 998 characters').default(''),
    text: z.string().max(100_000, 'at most 100000 characters').default(''),
    html: z.string().max(100_000, 'at most 100000 characters').default(''),
  })
  .refine((m) => m.text !== '' || m.html !== '', {
    message: 'text or html is required',
    path: ['text'],
  });

export type CaughtMailBody = z.infer<typeof caughtMailSchema>;
