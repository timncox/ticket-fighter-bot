import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
const codesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../codes/chicago-codes.json");
const CHICAGO_CODES = JSON.parse(fs.readFileSync(codesPath, "utf-8"));
function getCodeInfo(code) {
    return CHICAGO_CODES[code] ?? { description: "Unknown violation", fine: 0, defenses: [] };
}
// ---------------------------------------------------------------------------
// CHIPAY JSON API (undocumented, no CAPTCHA)
// ---------------------------------------------------------------------------
const CHIPAY_API = "https://webapps1.chicago.gov/payments-web";
async function getChipayToken() {
    const resp = await fetch(`${CHIPAY_API}/security/tokens`, {
        headers: { "chipay-security": "open" },
    });
    if (!resp.ok)
        throw new Error(`CHIPAY token error: ${resp.status}`);
    const data = await resp.json();
    return data.token;
}
async function chipaySearch(token, searchCategoryId, fields) {
    const resp = await fetch(`${CHIPAY_API}/api/searches`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "chipay-token": token,
        },
        body: JSON.stringify({
            searchCategoryId,
            flowSession: crypto.randomUUID(),
            cityServiceId: 1,
            skeletal: false,
            searchInputFields: fields,
        }),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`CHIPAY search error: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    // The API returns results in various shapes — normalize
    if (Array.isArray(data))
        return data;
    if (data?.receivables)
        return data.receivables;
    if (data?.tickets)
        return data.tickets;
    if (data?.results)
        return data.results;
    return [];
}
async function chipayTicketLookup(ticketNumber) {
    const token = await getChipayToken();
    return chipaySearch(token, 5, [
        { fieldKey: "ticketNumber", fieldValue: ticketNumber },
    ]);
}
async function chipayPlateLookup(plate, state, lastName) {
    const token = await getChipayToken();
    return chipaySearch(token, 3, [
        { fieldKey: "licPlateNumber", fieldValue: plate },
        { fieldKey: "state", fieldValue: state },
        { fieldKey: "lastName", fieldValue: lastName },
    ]);
}
function chipayToTicket(r, plate) {
    const code = r.violationCode ?? "";
    const codeInfo = getCodeInfo(code);
    return {
        violationNumber: r.ticketNumber ?? "",
        dateIssued: r.issueDate ?? "",
        violationCode: code,
        description: r.violationDescription ?? codeInfo.description,
        amount: r.currentAmountDue ?? r.originalAmount ?? codeInfo.fine,
        status: r.currentAmountDue && r.currentAmountDue > 0 ? "open" : "paid",
        location: r.location ?? "",
        city: "chicago",
        plate: r.licensePlate ?? plate,
    };
}
// ---------------------------------------------------------------------------
// Playwright scraper fallback (non-headless, user solves hCaptcha)
// ---------------------------------------------------------------------------
const LOOKUP_URL = "https://webapps1.chicago.gov/payments-web/#/validatedFlow?cityServiceId=1";
const EHEARING_URL = "https://parkingtickets.chicago.gov/EHearingWeb/home";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
async function scrapeLookup(plate, state) {
    const browser = await chromium.launch({ headless: false });
    try {
        const context = await browser.newContext({ userAgent: USER_AGENT });
        const page = await context.newPage();
        await page.goto(LOOKUP_URL, { waitUntil: "networkidle" });
        await page.waitForSelector('input[type="text"]', { timeout: 15000 });
        const inputs = page.locator('input[type="text"]');
        await inputs.nth(0).fill(plate);
        const stateSelect = page.locator("select").first();
        await stateSelect.selectOption(state.toUpperCase());
        console.error("[ticket-fighter] CHICAGO: hCaptcha detected. Please solve the CAPTCHA in the browser window, then press Submit. Waiting up to 120 seconds...");
        await page.waitForSelector('.ticket-result, .violation-result, [class*="result"], [class*="ticket"]', {
            timeout: 120000,
        });
        const tickets = [];
        const rows = await page.locator('[class*="ticket"], [class*="violation"], tr').all();
        for (const row of rows) {
            const text = await row.innerText().catch(() => "");
            if (!text.trim())
                continue;
            const violationMatch = text.match(/(\d{8,})/);
            const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
            const amountMatch = text.match(/\$?([\d,]+\.?\d{0,2})/);
            const codeMatch = text.match(/096\d{4}|097\d{4}/);
            if (violationMatch) {
                const code = codeMatch ? codeMatch[0] : "";
                const codeInfo = getCodeInfo(code);
                tickets.push({
                    violationNumber: violationMatch[1],
                    dateIssued: dateMatch ? dateMatch[1] : "",
                    violationCode: code,
                    description: codeInfo.description || text.split("\n")[0].trim(),
                    amount: amountMatch ? parseFloat(amountMatch[1].replace(",", "")) : codeInfo.fine,
                    status: "open",
                    location: "",
                    city: "chicago",
                    plate,
                });
            }
        }
        return tickets;
    }
    finally {
        await browser.close();
    }
}
// ---------------------------------------------------------------------------
// Chicago Adapter — CHIPAY API + Playwright scraper fallback
// ---------------------------------------------------------------------------
export const chicagoAdapter = {
    cityId: "chicago",
    displayName: "Chicago",
    async lookupTickets(plate, state, _type) {
        // CHIPAY API requires lastName for plate search, which we don't have.
        // Fall back to browser scraper (user solves hCaptcha).
        try {
            return await scrapeLookup(plate, state);
        }
        catch (err) {
            throw new Error(`Chicago plate lookup failed: ${err.message}. The portal requires solving an hCaptcha.`);
        }
    },
    async getTicketDetails(violationNumber) {
        // Use CHIPAY API — no CAPTCHA needed for ticket number lookup
        try {
            const results = await chipayTicketLookup(violationNumber);
            if (results.length === 0) {
                throw new Error(`No ticket found with number ${violationNumber}`);
            }
            const r = results[0];
            const code = r.violationCode ?? "";
            const codeInfo = getCodeInfo(code);
            const rawData = {};
            for (const [k, v] of Object.entries(r)) {
                if (v !== null && v !== undefined)
                    rawData[k] = String(v);
            }
            return {
                violationNumber: r.ticketNumber ?? violationNumber,
                dateIssued: r.issueDate ?? "",
                violationCode: code,
                description: r.violationDescription ?? codeInfo.description,
                amount: r.currentAmountDue ?? r.originalAmount ?? codeInfo.fine,
                status: r.currentAmountDue && r.currentAmountDue > 0 ? "open" : "paid",
                location: r.location ?? "",
                city: "chicago",
                plate: r.licensePlate ?? "",
                vehicleMake: r.vehicleMake ?? undefined,
                vehicleColor: r.vehicleColor ?? undefined,
                rawData,
            };
        }
        catch (err) {
            // If CHIPAY fails, fall back to scraper
            if (err.message.includes("No ticket found"))
                throw err;
            throw new Error(`Chicago ticket lookup failed: ${err.message}`);
        }
    },
    getDisputeFormStructure() {
        return {
            city: "chicago",
            requiredFields: ["violationNumber", "arguments"],
            maxArgumentLength: 5000,
            maxEvidenceFiles: 5,
            acceptedFileTypes: ["image/jpeg", "image/png", "application/pdf"],
            notes: "Chicago processes parking disputes through the Department of Administrative Hearings eHearing portal " +
                "(https://parkingtickets.chicago.gov/EHearingWeb/home). Submit within 25 days of the citation date " +
                "to avoid late penalties. Correspondence hearings have a roughly 54% dismissal rate for first-time " +
                "disputes with supporting evidence.",
        };
    },
    async submitDispute(violationNumber, args, evidencePaths) {
        const browser = await chromium.launch({ headless: false });
        try {
            const context = await browser.newContext({ userAgent: USER_AGENT });
            const page = await context.newPage();
            await page.goto(EHEARING_URL, { waitUntil: "networkidle" });
            console.error(`[ticket-fighter] CHICAGO DISPUTE SUBMISSION\n` +
                `=============================================\n` +
                `Violation Number: ${violationNumber}\n` +
                `Evidence files to attach: ${evidencePaths.length > 0 ? evidencePaths.join(", ") : "none"}\n\n` +
                `--- DISPUTE ARGUMENT TEXT (paste into the eHearing portal) ---\n\n` +
                `${args}\n\n` +
                `--- END OF ARGUMENT TEXT ---\n\n` +
                `The Chicago eHearing portal is now open. Please:\n` +
                `  1. Log in or create an account\n` +
                `  2. Select "File a Dispute" and enter violation number: ${violationNumber}\n` +
                `  3. Paste the argument text above into the statement field\n` +
                `  4. Upload any evidence files listed above\n` +
                `  5. Submit the form and note your confirmation number\n\n` +
                `Waiting — close the browser window when finished to continue...`);
            await page.waitForEvent("close", { timeout: 600000 }).catch(() => { });
            return {
                success: true,
                timestamp: new Date().toISOString(),
                message: `Chicago eHearing portal opened for violation ${violationNumber}. ` +
                    `Dispute text was printed to the console for manual entry. ` +
                    `Record the confirmation number shown after submission.`,
            };
        }
        finally {
            await browser.close();
        }
    },
    async checkDisposition(violationNumber) {
        // Use CHIPAY API — no CAPTCHA needed for ticket number lookup
        try {
            const results = await chipayTicketLookup(violationNumber);
            if (results.length === 0) {
                return {
                    violationNumber,
                    city: "chicago",
                    status: "unknown",
                    disposition: null,
                    details: "Ticket not found in CHIPAY. It may be fully paid or too old.",
                };
            }
            const r = results[0];
            const amountDue = r.currentAmountDue ?? 0;
            const statusStr = (r.status ?? "").toLowerCase();
            let status = "unknown";
            let disposition = null;
            let details = "";
            if (statusStr.includes("dismiss") || statusStr.includes("not liable")) {
                status = "decided";
                disposition = "dismissed";
                details = "Violation dismissed — no amount owed.";
            }
            else if (statusStr.includes("liable") || statusStr.includes("guilty")) {
                status = "decided";
                disposition = "guilty";
                details = "Found liable. Payment required.";
            }
            else if (statusStr.includes("reduced")) {
                status = "decided";
                disposition = "reduced";
                details = "Fine reduced.";
            }
            else if (statusStr.includes("hearing") || statusStr.includes("pending")) {
                status = "scheduled";
                details = "Hearing scheduled or dispute pending.";
            }
            else if (amountDue > 0) {
                status = "pending";
                details = `Open — $${amountDue.toFixed(2)} due.`;
            }
            else if (amountDue === 0) {
                status = "decided";
                disposition = "dismissed";
                details = "No amount due — likely paid or dismissed.";
            }
            return {
                violationNumber,
                city: "chicago",
                status,
                disposition,
                amount: amountDue,
                details,
            };
        }
        catch {
            return {
                violationNumber,
                city: "chicago",
                status: "unknown",
                disposition: null,
                details: "CHIPAY API lookup failed.",
            };
        }
    },
};
//# sourceMappingURL=chicago.js.map