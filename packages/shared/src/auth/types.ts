/**
 * Auth Types (Browser-safe)
 *
 * Pure type definitions for authentication state.
 * No runtime dependencies - safe for browser bundling.
 */

/**
 * Session context for OAuth flows.
 * Used to build deeplinks that return users to their active chat session
 * after completing OAuth authentication.
 */
export interface OAuthSessionContext {
  /** The session ID to return to after OAuth completes */
  sessionId?: string;
  /** The app's deeplink scheme (e.g., 'craftagents') */
  deeplinkScheme?: string;
}

/**
 * Build a deeplink URL to return to a chat session after OAuth.
 * Returns undefined if session context is incomplete.
 */
export function buildOAuthDeeplinkUrl(ctx?: OAuthSessionContext): string | undefined {
  if (!ctx?.sessionId || !ctx?.deeplinkScheme) return undefined;
  return `${ctx.deeplinkScheme}://allChats/chat/${ctx.sessionId}`;
}
