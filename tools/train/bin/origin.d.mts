/** Types for `origin.mjs`, which is plain JavaScript because the dashboard imports it directly. */

/** `origin` when the dashboard answers it -- a loopback page or the desktop studio -- else null. */
export function allowedOrigin(origin: string | null | undefined): string | null;
/** Whether a Host header is a loopback name on the dashboard's own port. */
export function allowedHost(host: string | undefined, port: number): boolean;
/** Why a request is refused, from its Host and Origin headers, or null to serve it. */
export function refusal(
  request: { readonly host?: string | undefined; readonly origin?: string | undefined },
  port: number,
): { status: number; error: string; hint: string } | null;
/** The CORS headers for an answer to `origin`: the origin echoed when allowed, `vary` always. */
export function corsHeaders(origin: string | undefined): Record<string, string>;
