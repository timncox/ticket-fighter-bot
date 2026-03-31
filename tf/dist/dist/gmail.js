import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";
import { getAuthDir, getDecisionsDir } from "./config.js";
import { isGmailApiEnabled, getAuthUrl, searchGmailApi, } from "./gmail-api.js";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
/**
 * Set up Gmail authentication.
 * - If Gmail API is configured (GOOGLE_CLIENT_ID + SECRET), returns an OAuth URL.
 * - Otherwise, launches a visible browser for manual login (local-only).
 */
export async function setupGmailAuth() {
    if (isGmailApiEnabled()) {
        const url = getAuthUrl();
        return (`Gmail API mode enabled. Visit this URL to authorize:\n\n${url}\n\n` +
            `After authorizing, you'll receive a code. ` +
            `If using the MMP bot, the callback handles it automatically.`);
    }
    // Fallback: Playwright browser login (requires display)
    const stateFile = path.join(getAuthDir(), "state.json");
    const browser = await chromium.launch({ headless: false });
    try {
        const context = await browser.newContext({ userAgent: USER_AGENT });
        const page = await context.newPage();
        await page.goto("https://mail.google.com/");
        await page.waitForURL(/mail\.google\.com\/mail\/u\/\d+\/#inbox/, {
            timeout: 120_000,
        });
        await context.storageState({ path: stateFile });
        return `Gmail auth saved to ${stateFile}. You are now logged in.`;
    }
    finally {
        await browser.close();
    }
}
/**
 * Search Gmail for decision emails.
 * Uses Gmail API if configured, otherwise falls back to Playwright scraping.
 */
export async function searchGmailForDecisions(query) {
    // Prefer Gmail API if configured
    if (isGmailApiEnabled()) {
        return searchGmailApi(query);
    }
    // Fallback: Playwright scraping (requires prior setupGmailAuth via browser)
    const stateFile = path.join(getAuthDir(), "state.json");
    if (!fs.existsSync(stateFile)) {
        throw new Error("Gmail session expired — run setup_gmail to re-authenticate");
    }
    const decisionsDir = getDecisionsDir();
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({
            userAgent: USER_AGENT,
            storageState: stateFile,
            acceptDownloads: true,
        });
        const page = await context.newPage();
        const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: "networkidle" });
        if (page.url().includes("accounts.google.com")) {
            throw new Error("Gmail session expired — run setup_gmail to re-authenticate");
        }
        await page.waitForSelector("table.F.cf.zt, div[role='main']", {
            timeout: 15_000,
        });
        const emails = await page.evaluate(() => {
            const results = [];
            const rows = document.querySelectorAll("tr.zA");
            rows.forEach((row) => {
                const fromEl = row.querySelector(".yW span[email], .yW span[name]");
                const subjectEl = row.querySelector(".bog span, .y6 span");
                const snippetEl = row.querySelector(".y2");
                const dateEl = row.querySelector(".xW span, .xY span");
                const from = fromEl?.getAttribute("email") ||
                    fromEl?.getAttribute("name") ||
                    fromEl?.textContent?.trim() ||
                    "";
                const subject = subjectEl?.textContent?.trim() || "";
                const snippet = snippetEl?.textContent?.trim() || "";
                const date = dateEl?.getAttribute("title") || dateEl?.textContent?.trim() || "";
                if (subject || from) {
                    results.push({ subject, from, date, snippet });
                }
            });
            return results;
        });
        const downloadedPdfs = [];
        const rowHandles = await page.$$("tr.zA");
        const topRows = rowHandles.slice(0, 5);
        for (const row of topRows) {
            try {
                await row.click();
                await page.waitForLoadState("networkidle");
                if (page.url().includes("accounts.google.com")) {
                    throw new Error("Gmail session expired — run setup_gmail to re-authenticate");
                }
                const attachmentLinks = await page.$$("[data-tooltip*='.pdf'], [aria-label*='.pdf'], [download*='.pdf']");
                const attachmentChips = await page.$$("span.aZo, div.aQH");
                const allAttachmentEls = [...attachmentLinks, ...attachmentChips];
                for (const attachEl of allAttachmentEls) {
                    try {
                        const ariaLabel = await attachEl.getAttribute("aria-label") || "";
                        const tooltip = await attachEl.getAttribute("data-tooltip") || "";
                        const text = await attachEl.textContent() || "";
                        const isPdf = ariaLabel.toLowerCase().includes(".pdf") ||
                            tooltip.toLowerCase().includes(".pdf") ||
                            text.toLowerCase().includes(".pdf");
                        if (!isPdf)
                            continue;
                        const downloadBtn = await attachEl.$("a[href*='attachment'], a[download]");
                        const clickTarget = downloadBtn || attachEl;
                        const downloadPromise = page.waitForEvent("download", {
                            timeout: 15_000,
                        });
                        await clickTarget.click();
                        const download = await downloadPromise;
                        const suggestedName = download.suggestedFilename() || `decision_${Date.now()}.pdf`;
                        const savePath = path.join(decisionsDir, suggestedName);
                        await download.saveAs(savePath);
                        downloadedPdfs.push(savePath);
                    }
                    catch {
                        // Skip failed individual attachment downloads
                    }
                }
                await page.goBack({ waitUntil: "networkidle" });
                if (page.url().includes("accounts.google.com")) {
                    throw new Error("Gmail session expired — run setup_gmail to re-authenticate");
                }
            }
            catch (err) {
                if (err.message?.includes("Gmail session expired"))
                    throw err;
            }
        }
        return { emails, downloadedPdfs };
    }
    finally {
        await browser.close();
    }
}
//# sourceMappingURL=gmail.js.map