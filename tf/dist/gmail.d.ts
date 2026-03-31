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
export declare function searchGmailForDecisions(query: string): Promise<GmailSearchResult>;
