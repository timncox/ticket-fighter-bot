import { chromium } from "playwright";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const LOCALE = "en-US";
// ---------------------------------------------------------------------------
// Helper: sleep
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ---------------------------------------------------------------------------
// Helper: wait for CAPTCHA solve
// Prompts the user via console.error, then waits up to 120 seconds for the
// results page to appear after the human submits the form.
// ---------------------------------------------------------------------------
async function promptAndWaitForResults(page, displayName, context) {
    console.error(`[ticket-fighter] ${displayName} eTIMS CAPTCHA: A custom image CAPTCHA is displayed in the browser window.\n` +
        `  1. Look at the distorted text image in the browser.\n` +
        `  2. Type the characters shown into the CAPTCHA text field.\n` +
        `  3. Use the refresh button if the image is unclear, or the audio option if available.\n` +
        `  4. Fill in any remaining fields if not already filled, then click Submit.\n` +
        `  Context: ${context}\n` +
        `  Waiting up to 120 seconds for you to solve the CAPTCHA and submit...`);
    // Wait for navigation away from the input page (form submission triggers reload/redirect)
    await page.waitForFunction(() => {
        const url = window.location.href;
        return (!url.includes("input.jsp") ||
            document.querySelector("table") !== null);
    }, { timeout: 120000 });
    await sleep(2000);
}
// ---------------------------------------------------------------------------
// Helper: parse tickets from the eTIMS results table
// ---------------------------------------------------------------------------
async function parseTicketTable(page, plate, cityId) {
    const tickets = [];
    const rows = page.locator("table tbody tr, table tr:not(:first-child)");
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
        // eTIMS typically shows: citation#, issue date, violation code, description, fine, status, location
        const violationNumber = cellTexts[0] ?? "";
        if (!violationNumber || !/\d/.test(violationNumber))
            continue;
        const dateIssued = cellTexts[1] ?? "";
        const violationCode = cellTexts[2] ?? "";
        const description = cellTexts[3] ?? violationCode ?? "Unknown violation";
        const amountStr = cellTexts[4] ?? "0";
        const amount = parseFloat(amountStr.replace(/[^0-9.]/g, "")) || 0;
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
            city: cityId,
            plate,
        });
    }
    return tickets;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createEtimsAdapter(config) {
    const cityId = config.cityId;
    const subdomain = config.subdomain ?? "prodpci";
    const portalUrl = `https://${subdomain}.etimspayments.com/pbw/include/${config.cityPath}/input.jsp`;
    return {
        cityId,
        displayName: config.displayName,
        // -----------------------------------------------------------------------
        // lookupTickets — searches by license plate + state
        // -----------------------------------------------------------------------
        async lookupTickets(plate, state, _type) {
            const browser = await chromium.launch({ headless: false });
            try {
                const ctx = await browser.newContext({
                    userAgent: USER_AGENT,
                    locale: LOCALE,
                });
                const page = await ctx.newPage();
                await page.goto(portalUrl, { waitUntil: "networkidle" });
                await sleep(2000);
                // Click the plate/state lookup tab if present
                const plateTab = page.locator("a:has-text('License Plate'), button:has-text('License Plate'), " +
                    "[role='tab']:has-text('Plate'), a:has-text('Plate'), input[value*='Plate' i]");
                if (await plateTab.count() > 0) {
                    await plateTab.first().click();
                    await sleep(1000);
                }
                // Fill the plate number field
                const plateInput = page.locator("input[name*='plate' i], input[id*='plate' i], input[placeholder*='plate' i], " +
                    "input[name='plateNumber'], input[name='plate_number']");
                if (await plateInput.count() > 0) {
                    await plateInput.first().fill(plate);
                }
                // Select state from dropdown
                const stateSelect = page.locator("select[name*='state' i], select[id*='state' i]");
                if (await stateSelect.count() > 0) {
                    try {
                        await stateSelect.first().selectOption({ value: state.toUpperCase() });
                    }
                    catch {
                        await stateSelect.first().selectOption({ label: state });
                    }
                }
                await sleep(500);
                // Prompt user to solve the custom image CAPTCHA and submit
                await promptAndWaitForResults(page, config.displayName, `plate lookup: ${plate} (${state.toUpperCase()})`);
                return parseTicketTable(page, plate, cityId);
            }
            finally {
                await browser.close();
            }
        },
        // -----------------------------------------------------------------------
        // getTicketDetails — searches by citation number
        // -----------------------------------------------------------------------
        async getTicketDetails(violationNumber) {
            const browser = await chromium.launch({ headless: false });
            try {
                const ctx = await browser.newContext({
                    userAgent: USER_AGENT,
                    locale: LOCALE,
                });
                const page = await ctx.newPage();
                await page.goto(portalUrl, { waitUntil: "networkidle" });
                await sleep(2000);
                // Click citation number lookup tab if available
                const citationTab = page.locator("a:has-text('Citation'), button:has-text('Citation'), " +
                    "[role='tab']:has-text('Citation'), input[value*='Citation' i]");
                if (await citationTab.count() > 0) {
                    await citationTab.first().click();
                    await sleep(1000);
                }
                // Fill citation number field
                const citationInput = page.locator("input[name*='citation' i], input[id*='citation' i], input[name*='ticket' i], " +
                    "input[placeholder*='citation' i], input[name='citationNumber']");
                if (await citationInput.count() > 0) {
                    await citationInput.first().fill(violationNumber);
                }
                await sleep(500);
                // Prompt user to solve CAPTCHA and submit
                await promptAndWaitForResults(page, config.displayName, `citation lookup: ${violationNumber}`);
                // Collect raw key/value pairs from the page
                const rawData = {};
                const pageText = await page.innerText("body");
                const kvMatches = pageText.matchAll(/([A-Za-z ]{3,40}):\s*([^\n]{1,120})/g);
                for (const m of kvMatches) {
                    rawData[m[1].trim()] = m[2].trim();
                }
                // Scrape table cells as label/value pairs
                const tableRows = page.locator("table tr");
                const rowCount = await tableRows.count();
                for (let i = 0; i < rowCount; i++) {
                    const cells = tableRows.nth(i).locator("td, th");
                    const count = await cells.count();
                    if (count >= 2) {
                        const label = (await cells.nth(0).innerText()).trim();
                        const value = (await cells.nth(1).innerText()).trim();
                        if (label)
                            rawData[label] = value;
                    }
                }
                const violationCode = rawData["Violation Code"] ??
                    rawData["Code"] ??
                    rawData["Viol Code"] ??
                    "";
                const amountRaw = rawData["Fine Amount"] ??
                    rawData["Amount"] ??
                    rawData["Total Due"] ??
                    rawData["Balance Due"] ??
                    "0";
                return {
                    violationNumber,
                    dateIssued: rawData["Issue Date"] ??
                        rawData["Date Issued"] ??
                        rawData["Ticket Date"] ??
                        "",
                    violationCode,
                    description: rawData["Violation"] ??
                        rawData["Description"] ??
                        rawData["Violation Description"] ??
                        violationCode,
                    amount: parseFloat(amountRaw.replace(/[^0-9.]/g, "")) || 0,
                    status: rawData["Status"] ??
                        rawData["Ticket Status"] ??
                        "unknown",
                    location: rawData["Location"] ??
                        rawData["Street"] ??
                        rawData["Address"] ??
                        rawData["Block"] ??
                        "",
                    city: cityId,
                    plate: rawData["Plate"] ??
                        rawData["License Plate"] ??
                        rawData["Tag Number"] ??
                        "",
                    vehicleMake: rawData["Make"] ?? rawData["Vehicle Make"],
                    vehicleModel: rawData["Model"] ?? rawData["Vehicle Model"],
                    vehicleColor: rawData["Color"] ?? rawData["Vehicle Color"],
                    officerNotes: rawData["Officer Notes"] ?? rawData["Notes"],
                    meterNumber: rawData["Meter"] ?? rawData["Meter Number"],
                    photoUrls: [],
                    rawData,
                };
            }
            finally {
                await browser.close();
            }
        },
        // -----------------------------------------------------------------------
        // getDisputeFormStructure
        // -----------------------------------------------------------------------
        getDisputeFormStructure() {
            const disputeNote = config.disputeUrl
                ? `To dispute a citation, visit ${config.disputeUrl}.`
                : `Contact the ${config.displayName} parking authority directly for dispute instructions.`;
            return {
                city: cityId,
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
                notes: `${config.displayName} parking citations are processed through the eTIMS portal ` +
                    `(etimspayments.com) operated by Conduent/Trellint. ` +
                    `Automated dispute submission is not supported due to the eTIMS custom image CAPTCHA ` +
                    `which requires human interaction to complete. ` +
                    disputeNote +
                    ` Supporting evidence such as photos, meter receipts, permits, or medical documentation ` +
                    `significantly improves your chances of dismissal. ` +
                    `Disputes typically must be filed within 30 days of the ticket issue date — ` +
                    `check your citation for the specific deadline.`,
            };
        },
        // -----------------------------------------------------------------------
        // submitDispute — manual only (custom CAPTCHA prevents automation)
        // -----------------------------------------------------------------------
        async submitDispute(violationNumber, _args, _evidencePaths) {
            const disputeInstruction = config.disputeUrl
                ? `Please visit ${config.disputeUrl} to submit your dispute online.`
                : `Please contact the ${config.displayName} parking authority directly to submit your dispute.`;
            throw new Error(`Automated dispute submission is not supported for ${config.displayName} because the eTIMS portal ` +
                `uses a custom image CAPTCHA that requires human interaction to complete. ` +
                `To dispute ticket ${violationNumber}, ${disputeInstruction} ` +
                `You must file within 30 days of the ticket issue date.`);
        },
        // -----------------------------------------------------------------------
        // checkDisposition — searches by citation number, parses status
        // -----------------------------------------------------------------------
        async checkDisposition(violationNumber) {
            const browser = await chromium.launch({ headless: false });
            try {
                const ctx = await browser.newContext({
                    userAgent: USER_AGENT,
                    locale: LOCALE,
                });
                const page = await ctx.newPage();
                await page.goto(portalUrl, { waitUntil: "networkidle" });
                await sleep(2000);
                // Click citation number lookup tab if available
                const citationTab = page.locator("a:has-text('Citation'), button:has-text('Citation'), " +
                    "[role='tab']:has-text('Citation'), input[value*='Citation' i]");
                if (await citationTab.count() > 0) {
                    await citationTab.first().click();
                    await sleep(1000);
                }
                // Fill citation number
                const citationInput = page.locator("input[name*='citation' i], input[id*='citation' i], input[name*='ticket' i], " +
                    "input[placeholder*='citation' i], input[name='citationNumber']");
                if (await citationInput.count() > 0) {
                    await citationInput.first().fill(violationNumber);
                }
                await sleep(500);
                // Prompt user to solve CAPTCHA and submit
                await promptAndWaitForResults(page, config.displayName, `disposition check: ${violationNumber}`);
                const pageText = await page.innerText("body");
                const lower = pageText.toLowerCase();
                let status = "unknown";
                let disposition = null;
                let details;
                let amount;
                let decisionDate;
                // Parse status from page text
                if (lower.includes("dismissed") || lower.includes("not guilty") || lower.includes("not liable")) {
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
                else if (lower.includes("scheduled") || lower.includes("hearing date")) {
                    status = "scheduled";
                    details = "Hearing scheduled.";
                }
                else if (lower.includes("pending") || lower.includes("open") || lower.includes("unpaid")) {
                    status = "pending";
                    details = "Citation open and unpaid.";
                }
                else if (lower.includes("paid") || lower.includes("closed")) {
                    status = "decided";
                    disposition = "guilty";
                    details = "Citation paid/closed.";
                }
                // Extract fine amount
                const amountMatch = pageText.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
                if (amountMatch) {
                    amount = parseFloat(amountMatch[1].replace(/,/g, ""));
                }
                // Extract decision/hearing date
                const dateMatch = pageText.match(/(?:decision|decided|hearing|adjudication)\s*(?:date)?[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
                if (dateMatch) {
                    decisionDate = dateMatch[1];
                }
                if (!details) {
                    details = `Status scraped from ${config.displayName} eTIMS portal for citation ${violationNumber}.`;
                }
                return {
                    violationNumber,
                    city: cityId,
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
}
//# sourceMappingURL=etims.js.map