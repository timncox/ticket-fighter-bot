/**
 * Gmail API client using OAuth2.
 * Replaces Playwright-based Gmail scraping for headless cloud operation.
 *
 * Setup flow:
 *   1. setup_gmail tool returns an OAuth authorization URL
 *   2. User visits URL, authorizes, gets redirect to callback
 *   3. Callback exchanges code for tokens, stores refresh token
 *   4. Subsequent calls use refresh token for access
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * Optional:
 *   GOOGLE_REDIRECT_URI (defaults to urn:ietf:wg:oauth:2.0:oob)
 */
import type { GmailSearchResult } from "./gmail.js";
interface OAuthTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number;
}
export declare function isGmailApiEnabled(): boolean;
/**
 * Generate the OAuth2 authorization URL for the user to visit.
 */
export declare function getAuthUrl(): string;
/**
 * Exchange an authorization code for tokens.
 */
export declare function exchangeCode(code: string): Promise<OAuthTokens>;
/**
 * Search Gmail for decision emails and download PDF attachments.
 * Drop-in replacement for the Playwright-based searchGmailForDecisions.
 */
export declare function searchGmailApi(query: string): Promise<GmailSearchResult>;
export {};
