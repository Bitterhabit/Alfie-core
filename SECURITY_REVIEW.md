# Alfie Core — Interface Security Review

**Review date:** 14 November 2026  
**Scope:** source-level review of the standalone web interface, authentication store, service worker and browser security headers. This is not a penetration test or a review of the host, reverse proxy, Docker runtime, Core API or Petrio deployment.

## Changes made in this pass

- Removed the visible default username/password hint and stopped pre-filling the username field.
- New administrator bootstrap passwords and password changes now require 16–256 characters. Existing 6–15 character passwords remain sign-in compatible to avoid locking out an already-deployed administrator; rotate these through Settings.
- Changed framing policy to deny embedding by default. If embedding is deliberately enabled, only same-origin framing is allowed.
- Removed `unsafe-inline` from the script CSP, retained inline styles because the theme/Soul controller applies CSS custom properties at runtime, and added `object-src 'none'`, `frame-src 'none'`, and same-origin isolation headers.
- When `ALFIE_UI_PUBLIC_ORIGIN` is configured, origin checks now require an exact match rather than falling through to host-based development allowances.
- Replaced service-worker API fallbacks with a static-shell-only cache. It no longer invents an authenticated session, returns a synthetic linked identity, caches Garden memories or reports offline writes as successful. The cache version is bumped so the previous cache is retired on activation.
- Refined the login doorway and Soul motion for smaller screens, shorter viewports and reduced-motion preferences. API errors and connection loss now have distinct Soul states.

## Existing controls confirmed in source

- Passwords are derived with asynchronous scrypt and per-user random salts.
- Session tokens are random opaque values; only their SHA-256 digests are stored.
- Session cookies are HttpOnly; CSRF tokens and request-origin checks protect state-changing routes.
- Sessions have a 30-minute idle expiry and a 12-hour absolute expiry.
- Password changes revoke all active sessions.
- Login attempts are throttled at five failures per IP per ten-minute window, with a bounded in-memory map.
- JSON request bodies are size-limited; account data is written with restrictive directory/file permissions and atomic replacement.

## Remaining risks and deployment requirements

1. **Rate limiting is process-local.** The current login throttle resets on restart and is not shared across multiple interface replicas. For a single-container personal deployment this is a known limitation; before multi-instance or public multi-user use, move rate limiting to a shared store and consider a reverse-proxy/WAF limit.
2. **No MFA or recovery workflow.** The interface remains a single-administrator system. Protect the account with a unique passphrase and keep the account volume backup private and encrypted.
3. **Secure cookie depends on deployment configuration.** Set `ALFIE_UI_COOKIE_SECURE=true`, set `ALFIE_UI_PUBLIC_ORIGIN` to the exact public HTTPS origin, and only trust forwarded client-IP headers when the interface is reachable exclusively through a proxy that overwrites them.
4. **Keep Core private.** Do not publish port 8780. Keep service tokens and identity secrets in server-side environment configuration, never in browser assets or endpoint URLs.
5. **Inline styles remain allowed by CSP.** The current theme and Soul system writes CSS variables through element styles. Inline scripts are no longer allowed. A nonce/hash-based style policy would require refactoring those runtime style writes first.
6. **Legacy passwords.** Existing passwords shorter than 16 characters are still accepted at login for compatibility. Change them in Settings; the next password is checked against the stronger policy.
7. **Service-worker rollout.** The old cache is cleared when the updated worker activates. Existing tabs may continue running an already-loaded document until refreshed; verify the updated worker has activated on each device after deployment.

## Verification status

GitHub Actions run #187 passed the Node test suite, standalone browser-script syntax check, Compose validation, Core image build and standalone interface image build. The container smoke-test step was still running at the time of this review. No live homelab deployment check or browser-based visual/accessibility review has been performed. Treat this as a targeted hardening pass, not a security certification.
