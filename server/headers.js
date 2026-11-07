/** The security headers every response gets, from Selah and from the admin console alike. */
export function securityHeaders(app) {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()');
    // Strict-Transport-Security only with a public certificate (NOTEAPP_HSTS=1): with the private CA, a browser that
    // doesn't trust it yet refuses to let you click through the warning, which would lock new devices out.
    if (process.env.NOTEAPP_HSTS === '1') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data: blob:",
        // ipc: is how the Windows app (Tauri) passes notifications from the page.
        "connect-src 'self' blob: data: ipc: http://ipc.localhost",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "frame-src 'self'",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '));
    }
    return payload;
  });
}
