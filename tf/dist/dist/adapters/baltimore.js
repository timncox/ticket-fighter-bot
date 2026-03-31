import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
const codesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../codes/baltimore-codes.json");
const BALTIMORE_CODES = JSON.parse(fs.readFileSync(codesPath, "utf-8"));
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PORTAL_URL = "https://pay.baltimorecity.gov/parkingfines";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const LOCALE = "en-US";
// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getCodeInfo(code) {
    return (BALTIMORE_CODES[code] ?? {
        description: "Unknown violation",
        fine: 0,
        defenses: [],
    });
}
// ---------------------------------------------------------------------------
// Baltimore City Parking Fines Adapter
// ---------------------------------------------------------------------------
export const baltimoreAdapter = {
    cityId: "baltimore",
    displayName: "Baltimore",
    // -------------------------------------------------------------------------
    // lookupTickets — search by License Plate #
    // -------------------------------------------------------------------------
    async lookupTickets(plate, _state, _type) {
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({
                userAgent: USER_AGENT,
                locale: LOCALE,
            });
            const page = await context.newPage();
            await page.goto(PORTAL_URL, { waitUntil: "networkidle" });
            await sleep(2000);
            // Fill the License Plate # field
            const plateInput = page.locator("input[name*='plate' i], input[id*='plate' i], input[placeholder*='plate' i], input[placeholder*='license' i]");
            await plateInput.first().fill(plate.toUpperCase());
            // Click Search
            const submitBtn = page.locator("button[type='submit'], input[type='submit'], button:has-text('Search'), button:has-text('Find')");
            await submitBtn.first().click();
            await page.waitForLoadState("networkidle");
            await sleep(2000);
            const tickets = [];
            // Parse result rows from table
            const rows = page.locator("table tbody tr, [role='row']:not(:first-child)");
            const rowCount = await rows.count();
            for (let i = 0; i < rowCount; i++) {
                const row = rows.nth(i);
                const cells = row.locator("td, [role='cell']");
                const cellCount = await cells.count();
                if (cellCount < 3)
                    continue;
                const cellTexts = [];
                for (let j = 0; j < cellCount; j++) {
                    cellTexts.push((await cells.nth(j).innerText()).trim());
                }
                // Baltimore portal typically shows: citation#, date, violation code/description, amount, status
                const violationNumber = cellTexts[0] ?? "";
                if (!violationNumber)
                    continue;
                const dateIssued = cellTexts[1] ?? "";
                const violationCode = cellTexts[2] ?? "";
                const codeInfo = getCodeInfo(violationCode);
                const description = cellTexts[3] ?? codeInfo.description ?? "Unknown violation";
                const amountStr = cellTexts[4] ?? "0";
                const amount = parseFloat(amountStr.replace(/[^0-9.]/g, "")) || codeInfo.fine;
                const status = cellTexts[5] ?? "unknown";
                const location = cellTexts[6] ?? "";
                tickets.push({
                    violationNumber,
                    dateIssued,
                    violationCode,
                    description,
                    amount,
                    status,
                    location,
                    city: "baltimore",
                    plate,
                });
            }
            return tickets;
        }
        finally {
            await browser.close();
        }
    },
    // -------------------------------------------------------------------------
    // getTicketDetails — search by Citation/Issue #
    // -------------------------------------------------------------------------
    async getTicketDetails(violationNumber) {
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({
                userAgent: USER_AGENT,
                locale: LOCALE,
            });
            const page = await context.newPage();
            await page.goto(PORTAL_URL, { waitUntil: "networkidle" });
            await sleep(2000);
            // Fill the Citation/Issue # field
            const citationInput = page.locator("input[name*='citation' i], input[id*='citation' i], input[placeholder*='citation' i], input[name*='issue' i], input[id*='issue' i], input[placeholder*='issue' i]");
            await citationInput.first().fill(violationNumber);
            const submitBtn = page.locator("button[type='submit'], input[type='submit'], button:has-text('Search'), button:has-text('Find')");
            await submitBtn.first().click();
            await page.waitForLoadState("networkidle");
            await sleep(2000);
            // Collect raw label/value pairs
            const rawData = {};
            const labelledFields = await page.$$eval("[class*='label'], [class*='field'], dt, th", (els) => els.map((el) => ({
                label: el.textContent?.trim() ?? "",
                value: el.nextElementSibling?.textContent?.trim() ??
                    el.dataset["value"] ??
                    "",
            })));
            for (const { label, value } of labelledFields) {
                if (label)
                    rawData[label] = value;
            }
            // Also try to parse key:value pairs from page text
            const pageText = await page.innerText("body");
            const kvMatches = pageText.matchAll(/([A-Za-z ]{3,40}):\s*([^\n]{1,120})/g);
            for (const m of kvMatches) {
                const k = m[1].trim();
                if (k && !rawData[k])
                    rawData[k] = m[2].trim();
            }
            const violationCode = rawData["Violation Code"] ??
                rawData["Code"] ??
                rawData["Violation"] ??
                "";
            const codeInfo = getCodeInfo(violationCode);
            return {
                violationNumber,
                dateIssued: rawData["Issue Date"] ??
                    rawData["Date Issued"] ??
                    rawData["Citation Date"] ??
                    "",
                violationCode,
                description: rawData["Violation Description"] ??
                    rawData["Description"] ??
                    codeInfo.description ??
                    "",
                amount: parseFloat((rawData["Fine Amount"] ??
                    rawData["Amount Due"] ??
                    rawData["Amount"] ??
                    "0").replace(/[^0-9.]/g, "")) || codeInfo.fine,
                status: rawData["Status"] ?? "unknown",
                location: rawData["Location"] ??
                    rawData["Street"] ??
                    rawData["Address"] ??
                    "",
                city: "baltimore",
                plate: rawData["License Plate"] ??
                    rawData["Plate"] ??
                    rawData["Tag Number"] ??
                    "",
                vehicleMake: rawData["Make"] ?? rawData["Vehicle Make"],
                vehicleModel: rawData["Model"] ?? rawData["Vehicle Model"],
                vehicleColor: rawData["Color"] ?? rawData["Vehicle Color"],
                officerNotes: rawData["Officer Notes"] ?? rawData["Notes"],
                meterNumber: rawData["Meter Number"] ?? rawData["Meter"],
                photoUrls: [],
                rawData,
            };
        }
        finally {
            await browser.close();
        }
    },
    // -------------------------------------------------------------------------
    // getDisputeFormStructure
    // -------------------------------------------------------------------------
    getDisputeFormStructure() {
        return {
            city: "baltimore",
            requiredFields: [
                "violationNumber",
                "plate",
                "argument",
                "name",
                "address",
                "email",
                "phone",
            ],
            maxArgumentLength: 3000,
            maxEvidenceFiles: 3,
            acceptedFileTypes: ["pdf", "jpg", "jpeg", "png"],
            notes: "Baltimore City parking ticket disputes are handled by phone or in person — " +
                "there is no online dispute submission portal. To dispute a citation, contact " +
                "the Baltimore City Parking Authority by phone at 410-396-3000 or visit in " +
                "person at the Abel Wolman Municipal Building, 200 N. Holliday St., Baltimore, " +
                "MD 21202. Bring your citation number, vehicle registration, and any supporting " +
                "evidence (photos, receipts, permits). Disputes should be initiated within 25 " +
                "days of the citation date to avoid late penalties.",
        };
    },
    // -------------------------------------------------------------------------
    // submitDispute — not supported; Baltimore is phone/in-person only
    // -------------------------------------------------------------------------
    async submitDispute(violationNumber, _args, _evidencePaths) {
        throw new Error(`Automated dispute submission is not supported for Baltimore City. ` +
            `Baltimore parking ticket disputes must be handled by phone or in person. ` +
            `To dispute citation ${violationNumber}, please use one of the following options:\n` +
            `\n` +
            `  Phone: 410-396-3000 (Baltimore City Parking Authority)\n` +
            `  In Person: Abel Wolman Municipal Building\n` +
            `              200 N. Holliday St., Baltimore, MD 21202\n` +
            `\n` +
            `Bring your citation number, vehicle registration, and any supporting evidence ` +
            `(photos, receipts, permits) when contacting the Parking Authority. ` +
            `Disputes should be initiated within 25 days of the citation date.`);
    },
    // -------------------------------------------------------------------------
    // checkDisposition — search by citation number, parse status
    // -------------------------------------------------------------------------
    async checkDisposition(violationNumber) {
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({
                userAgent: USER_AGENT,
                locale: LOCALE,
            });
            const page = await context.newPage();
            await page.goto(PORTAL_URL, { waitUntil: "networkidle" });
            await sleep(2000);
            // Search by Citation/Issue #
            const citationInput = page.locator("input[name*='citation' i], input[id*='citation' i], input[placeholder*='citation' i], input[name*='issue' i], input[id*='issue' i], input[placeholder*='issue' i]");
            await citationInput.first().fill(violationNumber);
            const submitBtn = page.locator("button[type='submit'], input[type='submit'], button:has-text('Search'), button:has-text('Find')");
            await submitBtn.first().click();
            await page.waitForLoadState("networkidle");
            await sleep(2000);
            const pageText = await page.innerText("body");
            const lower = pageText.toLowerCase();
            let status = "unknown";
            let disposition = null;
            let details;
            let amount;
            let decisionDate;
            if (lower.includes("dismissed") || lower.includes("not guilty")) {
                status = "decided";
                disposition = "dismissed";
                details = "Citation dismissed — no amount owed.";
            }
            else if (lower.includes("guilty") && !lower.includes("not guilty")) {
                status = "decided";
                disposition = "guilty";
                details = "Found guilty. Payment required.";
            }
            else if (lower.includes("reduced")) {
                status = "decided";
                disposition = "reduced";
                details = "Fine reduced.";
            }
            else if (lower.includes("scheduled") || lower.includes("hearing")) {
                status = "scheduled";
                details = "Hearing scheduled or dispute pending.";
            }
            else if (lower.includes("pending") || lower.includes("open")) {
                status = "pending";
                details = "Citation open and unpaid.";
            }
            else if (lower.includes("paid")) {
                status = "decided";
                disposition = "guilty";
                details = "Citation paid.";
            }
            const amountMatch = pageText.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
            if (amountMatch) {
                amount = parseFloat(amountMatch[1].replace(/,/g, ""));
            }
            const dateMatch = pageText.match(/(?:decision|decided|hearing)\s*(?:date)?[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
            if (dateMatch) {
                decisionDate = dateMatch[1];
            }
            if (!details) {
                details = `Scraped status from Baltimore City parking fines portal for citation ${violationNumber}.`;
            }
            return {
                violationNumber,
                city: "baltimore",
                status,
                disposition,
                amount,
                decisionDate,
                details,
            };
        }
        finally {
            await browser.close();
        }
    },
};
//# sourceMappingURL=baltimore.js.map