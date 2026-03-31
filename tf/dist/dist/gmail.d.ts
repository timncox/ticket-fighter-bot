/**
 * Set up Gmail authentication.
 * - If Gmail API is configured (GOOGLE_CLIENT_ID + SECRET), returns an OAuth URL.
 * - Otherwise, launches a visible browser for manual login (local-only).
 */
export declare function setupGmailAuth(): Promise<string>;
export interface GmailSearchResult {
    emails: {
        subject: string;
        from: string;
        date: string;
        snippet: string;
    }[];
    downloadedPdfs: string[];
}
/**
 * Search Gmail for decision emails.
 * Uses Gmail API if configured, otherwise falls back to Playwright scraping.
 */
export declare function searchGmailForDecisions(query: string): Promise<GmailSearchResult>;
