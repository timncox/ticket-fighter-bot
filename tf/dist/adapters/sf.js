import { chromium } from "playwright";
// ---------------------------------------------------------------------------
// SF Open Data API (SODA 2.0) — SFMTA Parking Citations & Fines
// ---------------------------------------------------------------------------
const API_BASE = "https://data.sfgov.org/resource/ab4h-6ztd.json";
async function queryApi(params) {
    const url = `${API_BASE}?${params}`;
    const resp = await fetch(url, {
        headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
        throw new Error(`SF Open Data API error: ${resp.status} ${resp.statusText}`);
    }
    return resp.json();
}
function parseAmount(s) {
    return parseFloat((s ?? "0").replace(/[^0-9.]/g, "")) || 0;
}
function formatDate(iso) {
    if (!iso)
        return "";
    try {
        return new Date(iso).toLocaleDateString("en-US");
    }
    catch {
        return iso;
    }
}
function citationToTicket(c) {
    return {
        violationNumber: c.citation_number,
        dateIssued: formatDate(c.citation_issued_datetime),
        violationCode: c.violation ?? "",
        description: c.violation_desc ?? c.violation ?? "Unknown violation",
        amount: parseAmount(c.fine_amount),
        status: "open",
        location: c.citation_location ?? "",
        city: "sanfrancisco",
        plate: c.vehicle_plate,
    };
}
// ---------------------------------------------------------------------------
// eTIMS scraper fallback (non-headless)
// ---------------------------------------------------------------------------
const ETIMS_URL = "https://wmq.etimspayments.com/pbw/include/sanfrancisco/input.jsp";
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function scrapeEtims(plate, state) {
    const browser = await chromium.launch({ headless: false });
    try {
        const context = await browser.newContext({ locale: "en-US" });
        const page = await context.newPage();
        await page.goto(ETIMS_URL, { waitUntil: "networkidle" });
        await sleep(2000);
        const plateInput = page.locator("input[name*='plate' i], input[id*='plate' i], input[placeholder*='plate' i]");
        if (await plateInput.count() > 0) {
            await plateInput.first().fill(plate);
        }
        const stateSelect = page.locator("select[name*='state' i], select[id*='state' i]");
        if (await stateSelect.count() > 0) {
            await stateSelect.first().selectOption({ label: state });
        }
        const submitBtn = page.locator("input[type='submit'], button[type='submit'], input[value='Search' i], button:has-text('Search')");
        if (await submitBtn.count() > 0) {
            await submitBtn.first().click();
        }
        // Wait for results — user may need to solve CAPTCHA
        await page.waitForSelector("table, .results, .no-results, .error", {
            timeout: 120_000,
        }).catch(() => { });
        await sleep(3000);
        const tickets = [];
        const rows = page.locator("table tbody tr");
        const rowCount = await rows.count();
        for (let i = 0; i < rowCount; i++) {
            const row = rows.nth(i);
            const cells = row.locator("td");
            const cellCount = await cells.count();
            if (cellCount < 3)
                continue;
            const cellTexts = [];
            for (let j = 0; j < cellCount; j++) {
                cellTexts.push((await cells.nth(j).innerText()).trim());
            }
            const violationNumber = cellTexts[0] ?? "";
            if (!violationNumber)
                continue;
            tickets.push({
                violationNumber,
                dateIssued: cellTexts[1] ?? "",
                violationCode: cellTexts[2] ?? "",
                description: cellTexts[3] ?? "",
                amount: parseFloat((cellTexts[4] ?? "0").replace(/[^0-9.]/g, "")) || 0,
                status: cellTexts[5] ?? "open",
                location: cellTexts[6] ?? "",
                city: "sanfrancisco",
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
// SF Adapter — Open Data API + eTIMS scraper fallback
// ---------------------------------------------------------------------------
export const sfAdapter = {
    cityId: "sanfrancisco",
    displayName: "San Francisco",
    async lookupTickets(plate, state, _type) {
        // Primary: Open Data API
        const where = encodeURIComponent(`vehicle_plate='${plate.toUpperCase()}' AND vehicle_plate_state='${state.toUpperCase()}'`);
        const apiResults = await queryApi(`$where=${where}&$order=citation_issued_datetime DESC&$limit=50`);
        const apiTickets = apiResults.map(citationToTicket);
        // Check staleness — if newest is >30 days old, try eTIMS scraper
        const now = Date.now();
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
        const newestDate = apiResults.length > 0
            ? new Date(apiResults[0].citation_issued_datetime).getTime()
            : 0;
        if (newestDate < thirtyDaysAgo) {
            try {
                const scraperTickets = await scrapeEtims(plate, state);
                if (scraperTickets.length > 0) {
                    const scraperNums = new Set(scraperTickets.map((t) => t.violationNumber));
                    return [
                        ...scraperTickets,
                        ...apiTickets.filter((t) => !scraperNums.has(t.violationNumber)),
                    ];
                }
            }
            catch {
                // Scraper failed — return API results
            }
        }
        return apiTickets;
    },
    async getTicketDetails(violationNumber) {
        const results = await queryApi(`citation_number=${encodeURIComponent(violationNumber)}`);
        if (results.length === 0) {
            throw new Error(`No citation found with number ${violationNumber}`);
        }
        const c = results[0];
        return {
            violationNumber: c.citation_number,
            dateIssued: formatDate(c.citation_issued_datetime),
            violationCode: c.violation ?? "",
            description: c.violation_desc ?? c.violation ?? "",
            amount: parseAmount(c.fine_amount),
            status: "open",
            location: c.citation_location ?? "",
            city: "sanfrancisco",
            plate: c.vehicle_plate,
            rawData: {
                violation_code: c.violation ?? "",
                violation_desc: c.violation_desc ?? "",
                fine_amount: c.fine_amount ?? "",
                citation_location: c.citation_location ?? "",
                vehicle_plate_state: c.vehicle_plate_state ?? "",
                date_added: c.date_added ?? "",
            },
            photoUrls: [],
        };
    },
    getDisputeFormStructure() {
        return {
            city: "sanfrancisco",
            requiredFields: ["violationNumber", "argument"],
            maxArgumentLength: 5000,
            maxEvidenceFiles: 5,
            acceptedFileTypes: ["pdf", "jpg", "jpeg", "png"],
            notes: "SF parking citation contests are filed through SFMTA. You have 21 " +
                "calendar days from the citation date to contest. Visit " +
                "https://www.sfmta.com/getting-around/drive-park/citations for details.",
        };
    },
    async submitDispute(_violationNumber, _args, _evidencePaths) {
        throw new Error("Automated dispute submission is not supported for San Francisco. " +
            "Visit https://www.sfmta.com/getting-around/drive-park/citations " +
            "to contest your citation.");
    },
    async checkDisposition(violationNumber) {
        const results = await queryApi(`citation_number=${encodeURIComponent(violationNumber)}`);
        if (results.length === 0) {
            return {
                violationNumber,
                city: "sanfrancisco",
                status: "unknown",
                disposition: null,
                details: "Citation not found in SF Open Data.",
            };
        }
        const c = results[0];
        return {
            violationNumber,
            city: "sanfrancisco",
            status: "pending",
            disposition: null,
            amount: parseAmount(c.fine_amount),
            details: `${c.violation_desc ?? c.violation} — $${parseAmount(c.fine_amount).toFixed(2)}`,
        };
    },
};
//# sourceMappingURL=sf.js.map