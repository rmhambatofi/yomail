import { z } from 'zod';
import {
  ENDPOINT_NAME_MAX_LENGTH,
  HEADER_NAME_REGEX,
  RESPONSE_BODY_MAX_LENGTH,
  RESPONSE_CONTENT_TYPE_MAX_LENGTH,
  RESPONSE_FORBIDDEN_HEADERS,
  RESPONSE_HEADER_NAME_MAX_LENGTH,
  RESPONSE_HEADER_VALUE_MAX_LENGTH,
  RESPONSE_MAX_DELAY_MS,
  RESPONSE_MAX_HEADERS,
} from '@yomail/shared';

/** Body schemas of the owner routes (phase 8); the bounds live in @yomail/shared. */

const nameSchema = z
  .string()
  .trim()
  .min(1, 'required')
  .max(ENDPOINT_NAME_MAX_LENGTH, `at most ${ENDPOINT_NAME_MAX_LENGTH} characters`);

const headerPairSchema = z.tuple([
  z
    .string()
    .trim()
    .min(1, 'header name required')
    .max(RESPONSE_HEADER_NAME_MAX_LENGTH, `at most ${RESPONSE_HEADER_NAME_MAX_LENGTH} characters`)
    .regex(HEADER_NAME_REGEX, 'invalid header name')
    .refine(
      (name) => !RESPONSE_FORBIDDEN_HEADERS.includes(name.toLowerCase()),
      (name) => ({ message: `${name} cannot be set here` }),
    ),
  z
    .string()
    .max(RESPONSE_HEADER_VALUE_MAX_LENGTH, `at most ${RESPONSE_HEADER_VALUE_MAX_LENGTH} characters`)
    .regex(/^[^\r\n]*$/, 'line breaks are not allowed'),
]);

export const responseConfigSchema = z.object({
  status: z.number().int().min(100, 'between 100 and 599').max(599, 'between 100 and 599'),
  content_type: z
    .string()
    .trim()
    .min(1, 'required')
    .max(RESPONSE_CONTENT_TYPE_MAX_LENGTH, `at most ${RESPONSE_CONTENT_TYPE_MAX_LENGTH} characters`)
    .regex(/^[^\r\n]*$/, 'line breaks are not allowed'),
  body: z.string().max(RESPONSE_BODY_MAX_LENGTH, `at most ${RESPONSE_BODY_MAX_LENGTH} characters`),
  headers: z.array(headerPairSchema).max(RESPONSE_MAX_HEADERS, `at most ${RESPONSE_MAX_HEADERS} headers`),
  delay_ms: z
    .number()
    .int()
    .min(0, `between 0 and ${RESPONSE_MAX_DELAY_MS}`)
    .max(RESPONSE_MAX_DELAY_MS, `between 0 and ${RESPONSE_MAX_DELAY_MS}`),
});

export const updateEndpointSchema = z
  .object({
    name: nameSchema.nullable().optional(),
    response: responseConfigSchema.nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.response !== undefined, {
    message: 'nothing to update',
    path: ['_'],
  });

export type UpdateEndpointBody = z.infer<typeof updateEndpointSchema>;
