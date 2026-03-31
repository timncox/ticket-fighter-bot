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
import * as fs from "node:fs";
import * as path from "node:path";
import { getAuthDir, getDecisionsDir } from "./config.js";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_FILE = "gmail-oauth-tokens.json";
export function isGmailApiEnabled() {
    return CLIENT_ID.length > 0 && CLIENT_SECRET.length > 0;
}
function getTokenPath() {
    return path.join(getAuthDir(), TOKEN_FILE);
}
function loadTokens() {
    const p = getTokenPath();
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    catch {
        return null;
    }
}
function saveTokens(tokens) {
    fs.writeFileSync(getTokenPath(), JSON.stringify(tokens, null, 2));
}
/**
 * Generate the OAuth2 authorization URL for the user to visit.
 */
export function getAuthUrl() {
    if (!isGmailApiEnabled()) {
        throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set for Gmail API");
    }
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(code) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: "authorization_code",
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
    }
    const data = (await res.json());
    const tokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || "",
        expires_at: Date.now() + data.expires_in * 1000,
    };
    saveTokens(tokens);
    return tokens;
}
async function refreshAccessToken(refreshToken) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "refresh_token",
        }),
    });
    if (!res.ok) {
        throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json());
    const tokens = {
        access_token: data.access_token,
        refresh_token: refreshToken,
        expires_at: Date.now() + data.expires_in * 1000,
    };
    saveTokens(tokens);
    return tokens;
}
async function getAccessToken() {
    let tokens = loadTokens();
    if (!tokens || !tokens.refresh_token) {
        throw new Error("Gmail not authenticated. Run setup_gmail first.");
    }
    if (Date.now() > tokens.expires_at - 60_000) {
        tokens = await refreshAccessToken(tokens.refresh_token);
    }
    return tokens.access_token;
}
async function gmailGet(endpoint) {
    const token = await getAccessToken();
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        throw new Error(`Gmail API error: ${res.status} ${await res.text()}`);
    }
    return res.json();
}
function getHeader(msg, name) {
    return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}
function findPdfParts(parts) {
    const pdfs = [];
    if (!parts)
        return pdfs;
    for (const part of parts) {
        if (part.filename &&
            part.filename.toLowerCase().endsWith(".pdf") &&
            part.body?.attachmentId) {
            pdfs.push({ filename: part.filename, attachmentId: part.body.attachmentId });
        }
        if (part.parts) {
            pdfs.push(...findPdfParts(part.parts));
        }
    }
    return pdfs;
}
/**
 * Search Gmail for decision emails and download PDF attachments.
 * Drop-in replacement for the Playwright-based searchGmailForDecisions.
 */
export async function searchGmailApi(query) {
    const list = (await gmailGet(`messages?q=${encodeURIComponent(query)}&maxResults=10`));
    if (!list.messages || list.messages.length === 0) {
        return { emails: [], downloadedPdfs: [] };
    }
    const emails = [];
    const downloadedPdfs = [];
    const decisionsDir = getDecisionsDir();
    // Process top 5 messages
    for (const msgRef of list.messages.slice(0, 5)) {
        const msg = (await gmailGet(`messages/${msgRef.id}?format=full`));
        emails.push({
            subject: getHeader(msg, "Subject"),
            from: getHeader(msg, "From"),
            date: getHeader(msg, "Date"),
            snippet: msg.snippet,
        });
        // Download PDF attachments
        const pdfParts = findPdfParts(msg.payload.parts);
        for (const pdf of pdfParts) {
            try {
                const attachment = (await gmailGet(`messages/${msgRef.id}/attachments/${pdf.attachmentId}`));
                // Gmail returns base64url-encoded data
                const buffer = Buffer.from(attachment.data, "base64url");
                const savePath = path.join(decisionsDir, pdf.filename);
                fs.writeFileSync(savePath, buffer);
                downloadedPdfs.push(savePath);
            }
            catch (err) {
                console.error(`Failed to download PDF ${pdf.filename}:`, err);
            }
        }
    }
    return { emails, downloadedPdfs };
}
//# sourceMappingURL=gmail-api.js.map