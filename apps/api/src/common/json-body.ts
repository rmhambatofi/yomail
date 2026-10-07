/**
 * The app boots with `bodyParser: false` (the capture route streams its own body), so
 * every controller that reads JSON mounts `express.json` itself with one of these limits.
 */
export const JSON_BODY_LIMIT = '16kb';
/** Owner routes carrying a response config (body up to 64 KB plus headers). */
export const JSON_BODY_LIMIT_LARGE = '96kb';
