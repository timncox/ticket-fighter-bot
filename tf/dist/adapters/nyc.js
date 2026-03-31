import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { isCaptchaSolverEnabled, solveRecaptchaV2, extractRecaptchaSiteKey, injectRecaptchaToken, } from "../captcha-solver.js";
const codesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../codes/nyc-codes.json");
const NYC_CODES = JSON.parse(fs.readFileSync(codesPath, "utf-8"));
// ---------------------------------------------------------------------------
// NYC Open Data API (SODA 2.0)
// ---------------------------------------------------------------------------
const API_BASE = "https://data.cityofnewyork.us/resource/nc67-uf89.json";
async function queryApi(params) {
    const url = `${API_BASE}?${params}`;
    const resp = await fetch(url, {
        headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
        throw new Error(`NYC Open Data API error: ${resp.status} ${resp.statusText}`);
    }
    return resp.json();
}
function parseAmount(s) {
    return parseFloat((s ?? "0").replace(/[^0-9.]/g, "")) || 0;
}
function formatDate(isoOrSlash) {
    // API returns "MM/DD/YYYY" or ISO — normalize
    if (!isoOrSlash)
        return "";
    if (isoOrSlash.includes("T")) {
        return new Date(isoOrSlash).toLocaleDateString("en-US");
    }
    return isoOrSlash;
}
function mapStatus(v) {
    if (!v.violation_status) {
        return parseAmount(v.amount_due) > 0 ? "open" : "paid";
    }
    const s = v.violation_status.toLowerCase();
    if (s.includes("not guilty"))
        return "dismissed";
    if (s.includes("guilty") && s.includes("reduction"))
        return "reduced";
    if (s.includes("guilty"))
        return "guilty";
    if (s.includes("pending") || s.includes("adjournment"))
        return "pending";
    if (s.includes("appeal"))
        return "appeal";
    return v.violation_status;
}
function violationToTicket(v) {
    const code = v.violation?.replace(/[^0-9]/g, "") ?? "";
    return {
        violationNumber: v.summons_number,
        dateIssued: formatDate(v.issue_date),
        violationCode: code,
        description: v.violation ?? NYC_CODES[code]?.description ?? "Unknown violation",
        amount: parseAmount(v.amount_due),
        status: mapStatus(v),
        location: v.county ? `Precinct ${v.precinct}, ${v.county}` : v.precinct ?? "",
        city: "nyc",
        plate: v.plate,
    };
}
// ---------------------------------------------------------------------------
// CityPay scraper fallback (non-headless — user solves reCAPTCHA)
// ---------------------------------------------------------------------------
const LOOKUP_URL = "https://a836-citypay.nyc.gov/citypay/Parking?stage=procurement";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function chosenSelect(page, selectId, value) {
    const chosenContainer = page.locator(`${selectId}_chosen`);
    if (await chosenContainer.count() > 0) {
        await chosenContainer.click();
        await sleep(300);
        const searchInput = chosenContainer.locator("input[type='text']");
        if (await searchInput.count() > 0) {
            await searchInput.fill(value);
            await sleep(300);
        }
        const result = chosenContainer.locator("li.active-result:has-text('" + value + "')");
        if (await result.count() > 0) {
            await result.first().click();
        }
        else {
            const anyResult = chosenContainer.locator("li.active-result").first();
            if (await anyResult.count() > 0)
                await anyResult.click();
        }
    }
    else {
        const sel = page.locator(selectId);
        await sel.selectOption({ label: value });
    }
}
async function scrapeCityPay(plate, state, type) {
    const headless = isCaptchaSolverEnabled();
    const browser = await chromium.launch({ headless });
    try {
        const context = await browser.newContext({
            userAgent: USER_AGENT,
            locale: "en-US",
        });
        const page = await context.newPage();
        await page.goto(LOOKUP_URL, { waitUntil: "networkidle" });
        await sleep(3000);
        // Click the License Plate tab
        const plateTab = page.locator("button:has-text('License Plate'), a:has-text('License Plate'), [role='tab']:has-text('License Plate')");
        if (await plateTab.count() > 0) {
            await plateTab.first().click();
            await sleep(1000);
        }
        // Fill plate number
        const plateInput = page.locator("input[name*='plate'], input[id*='plate'], input[placeholder*='plate' i], input[placeholder*='Plate' i]");
        await plateInput.first().fill(plate);
        // Select state and type via Chosen dropdowns
        await chosenSelect(page, "#PLATE_STATE", state);
        await chosenSelect(page, "#PLATE_TYPE", type);
        // Solve CAPTCHA automatically if solver is available
        if (headless) {
            const siteKey = await extractRecaptchaSiteKey(page);
            if (siteKey) {
                const token = await solveRecaptchaV2(LOOKUP_URL, siteKey);
                await injectRecaptchaToken(page, token);
                await sleep(500);
            }
        }
        // Submit
        await page.locator("button[type='submit']").first().evaluate((btn) => btn.click());
        // Wait for results — if headless, CAPTCHA is already solved; if headed, user solves manually
        await page.waitForSelector("table tbody tr, .no-results, .error-message", {
            timeout: 120_000,
        }).catch(() => { });
        await sleep(3000);
        // Parse tickets from the results table
        const tickets = [];
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
            const violationNumber = cellTexts[0] ?? "";
            const dateIssued = cellTexts[1] ?? "";
            const violationCode = cellTexts[2] ?? "";
            const description = cellTexts[3] ??
                NYC_CODES[violationCode]?.description ??
                "Unknown violation";
            const amountStr = cellTexts[4] ?? "0";
            const amount = parseFloat(amountStr.replace(/[^0-9.]/g, "")) || 0;
            const status = cellTexts[5] ?? "unknown";
            if (!violationNumber)
                continue;
            tickets.push({
                violationNumber,
                dateIssued,
                violationCode,
                description,
                amount,
                status,
                location: cellTexts[6] ?? "",
                city: "nyc",
                plate,
            });
        }
        return tickets;
    }
    finally {
        await browser.close();
    }
}
// ---------------------------------------------------------------------------
// NYC DOF Adapter — Open Data API + CityPay scraper fallback
// ---------------------------------------------------------------------------
export const nycAdapter = {
    cityId: "nyc",
    displayName: "New York City",
    async lookupTickets(plate, state, type) {
        // Primary: Open Data API (fast, no CAPTCHA, but can lag weeks behind)
        const where = encodeURIComponent(`plate='${plate.toUpperCase()}' AND state='${state.toUpperCase()}'`);
        const apiResults = await queryApi(`$where=${where}&$order=issue_date DESC&$limit=50`);
        const apiTickets = apiResults.map(violationToTicket);
        // Check if API data is stale — if newest ticket is >30 days old,
        // fall back to CityPay scraper for real-time results
        const now = Date.now();
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
        const newestDate = apiResults.length > 0
            ? new Date(apiResults[0].issue_date).getTime()
            : 0;
        if (newestDate < thirtyDaysAgo) {
            // API may be stale — try CityPay scraper (opens browser for reCAPTCHA)
            try {
                const scraperTickets = await scrapeCityPay(plate, state, type);
                if (scraperTickets.length > 0) {
                    // Merge: scraper results + API results not already in scraper set
                    const scraperNums = new Set(scraperTickets.map((t) => t.violationNumber));
                    const merged = [
                        ...scraperTickets,
                        ...apiTickets.filter((t) => !scraperNums.has(t.violationNumber)),
                    ];
                    return merged;
                }
            }
            catch {
                // Scraper failed (CAPTCHA not solved, etc.) — return API results
            }
        }
        return apiTickets;
    },
    async getTicketDetails(violationNumber) {
        const results = await queryApi(`summons_number=${encodeURIComponent(violationNumber)}`);
        if (results.length === 0) {
            throw new Error(`No violation found with number ${violationNumber}`);
        }
        const v = results[0];
        const code = v.violation?.replace(/[^0-9]/g, "") ?? "";
        const codeInfo = NYC_CODES[code];
        return {
            violationNumber: v.summons_number,
            dateIssued: formatDate(v.issue_date),
            violationCode: code,
            description: v.violation ?? codeInfo?.description ?? "",
            amount: parseAmount(v.amount_due),
            status: mapStatus(v),
            location: v.county ? `Precinct ${v.precinct}, ${v.county}` : v.precinct ?? "",
            city: "nyc",
            plate: v.plate,
            rawData: {
                fine_amount: v.fine_amount ?? "",
                penalty_amount: v.penalty_amount ?? "",
                interest_amount: v.interest_amount ?? "",
                reduction_amount: v.reduction_amount ?? "",
                payment_amount: v.payment_amount ?? "",
                amount_due: v.amount_due ?? "",
                violation_time: v.violation_time ?? "",
                issuing_agency: v.issuing_agency ?? "",
                precinct: v.precinct ?? "",
                county: v.county ?? "",
                violation_status: v.violation_status ?? "",
                judgment_entry_date: v.judgment_entry_date ?? "",
                summons_image_url: v.summons_image?.url ?? "",
            },
            photoUrls: v.summons_image?.url ? [v.summons_image.url] : [],
        };
    },
    getDisputeFormStructure() {
        return {
            city: "nyc",
            requiredFields: [
                "violationNumber",
                "plate",
                "state",
                "argument",
                "name",
                "address",
                "email",
            ],
            maxArgumentLength: 5000,
            maxEvidenceFiles: 5,
            acceptedFileTypes: ["pdf", "jpg", "jpeg", "png"],
            notes: "NYC parking disputes are submitted to the NYC Department of Finance (DOF) " +
                "via the Online Dispute Portal. You have 30 days from the violation date to " +
                "dispute by mail or in person, or 30 days from the first notice to dispute " +
                "online. Disputes for dismissed tickets are not necessary. Supporting " +
                "evidence (photos, receipts, permits) significantly improves outcomes.",
        };
    },
    async submitDispute(_violationNumber, _args, _evidencePaths) {
        throw new Error("Automated dispute submission is not supported for NYC. " +
            "To dispute this ticket, visit the NYC DOF Online Dispute Portal at " +
            "https://a836-citypay.nyc.gov/citypay/Parking and submit your dispute " +
            "manually using the argument and evidence files prepared by this tool.");
    },
    async checkDisposition(violationNumber) {
        const results = await queryApi(`summons_number=${encodeURIComponent(violationNumber)}`);
        if (results.length === 0) {
            return {
                violationNumber,
                city: "nyc",
                status: "unknown",
                disposition: null,
                details: "Violation not found in NYC Open Data.",
            };
        }
        const v = results[0];
        const statusStr = mapStatus(v);
        let status = "unknown";
        let disposition = null;
        if (statusStr === "dismissed") {
            status = "decided";
            disposition = "dismissed";
        }
        else if (statusStr === "guilty") {
            status = "decided";
            disposition = "guilty";
        }
        else if (statusStr === "reduced") {
            status = "decided";
            disposition = "reduced";
        }
        else if (statusStr === "pending" || statusStr === "appeal") {
            status = "pending";
        }
        else if (statusStr === "open" || statusStr === "paid") {
            status = "pending";
        }
        return {
            violationNumber,
            city: "nyc",
            status,
            disposition,
            amount: parseAmount(v.amount_due),
            decisionDate: v.judgment_entry_date ? formatDate(v.judgment_entry_date) : undefined,
            details: v.violation_status
                ? `Status: ${v.violation_status}`
                : `Amount due: $${parseAmount(v.amount_due).toFixed(2)}`,
        };
    },
};
//# sourceMappingURL=nyc.js.map