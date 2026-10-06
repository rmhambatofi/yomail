export const API_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '');
/** Public base of capture URLs: the SPA and the capture routes share one origin. */
export const PUBLIC_BASE_URL = window.location.origin;
