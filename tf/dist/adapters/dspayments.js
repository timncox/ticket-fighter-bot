import { chromium } from "playwright";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export function createDsPaymentsAdapter(config) {
    const portalDomain = config.portalDomain ?? "dspayments.com";
    const baseUrl = `https://${portalDomain}/${config.citySlug}`;
    const cityId = config.cityId;
    return {
        cityId,
        displayName: config.displayName,
        async lookupTickets(plate, state, _type) {
            const browser = await chromium.launch({
                headless: true,
                args: ["--lang=en-US"],
            });
            try {
                const context = await browser.newContext({
                    userAgent: USER_AGENT,
                    locale: "en-US",
                });
                const page = await context.newPage();
                await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                // DS Payments form: ticket number AND/OR license plate + state dropdown.
                // For plate lookup, leave ticket number blank, fill plate and select state.
                const plateInput = page
                    .locator('input[name*="plate" i], input[id*="plate" i], input[placeholder*="plate" i], input[name*="license" i], input[id*="license" i]')
                    .first();
                await plateInput.fill(plate.toUpperCase());
                // Select state from dropdown
                const stateSelect = page.locator("select").first();
                await stateSelect.selectOption({ value: state.toUpperCase() });
                // Submit the form
                await Promise.all([
                    page.waitForLoadState("networkidle", { timeout: 30000 }),
                    page
                        .locator('input[type="submit"], button[type="submit"], button')
                        .first()
                        .click(),
                ]);
                // Scrape results table
                const tickets = [];
                const rows = await page.locator("table tr").all();
                for (let i = 1; i < rows.length; i++) {
                    const cells = await rows[i].locator("td").all();
                    if (cells.length < 3)
                        continue;
                    const cellTexts = await Promise.all(cells.map((c) => c.innerText()));
                    const violationNumber = cellTexts[0]?.trim() ?? "";
                    if (!violationNumber)
                        continue;
                    const dateIssued = cellTexts[1]?.trim() ?? "";
                    const violationCode = cellTexts[2]?.trim() ?? "";
                    const description = cellTexts[3]?.trim() ?? violationCode;
                    const status = cellTexts[4]?.trim() ?? "unknown";
                    const amount = parseFloat((cellTexts[5]?.trim() ?? "0").replace(/[^0-9.]/g, "")) || 0;
                    const location = cellTexts[6]?.trim() ?? "";
                    tickets.push({
                        violationNumber,
                        dateIssued,
                        violationCode,
                        description,
                        amount,
                        status,
                        location,
                        city: cityId,
                        plate: plate.toUpperCase(),
                    });
                }
                return tickets;
            }
            finally {
                await browser.close();
            }
        },
        async getTicketDetails(violationNumber) {
            const browser = await chromium.launch({
                headless: true,
                args: ["--lang=en-US"],
            });
            try {
                const context = await browser.newContext({
                    userAgent: USER_AGENT,
                    locale: "en-US",
                });
                const page = await context.newPage();
                await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                // Fill ticket/citation number input
                const ticketInput = page
                    .locator('input[name*="ticket" i], input[id*="ticket" i], input[name*="citation" i], input[id*="citation" i], input[name*="violation" i], input[id*="violation" i], input[type="text"]')
                    .first();
                await ticketInput.fill(violationNumber);
                await Promise.all([
                    page.waitForLoadState("networkidle", { timeout: 30000 }),
                    page
                        .locator('input[type="submit"], button[type="submit"], button')
                        .first()
                        .click(),
                ]);
                // Collect all visible detail fields into rawData
                const rawData = {};
                // Extract key:value patterns from page text
                const pageText = await page.innerText("body");
                const kvMatches = pageText.matchAll(/([A-Za-z][A-Za-z\s]{2,40}):\s*([^\n]{1,150})/g);
                for (const m of kvMatches) {
                    rawData[m[1].trim()] = m[2].trim();
                }
                // Extract structured elements
                const labelValuePairs = await page.locator("td, th, label, dt, span").all();
                for (const el of labelValuePairs) {
                    const text = (await el.innerText()).trim();
                    if (text && text.length < 200) {
                        rawData[text] = text;
                    }
                }
                // Parse table rows for structured data
                const rows = await page.locator("table tr").all();
                const cellData = [];
                for (const row of rows) {
                    const cells = await row.locator("td").all();
                    for (const cell of cells) {
                        cellData.push((await cell.innerText()).trim());
                    }
                }
                const dateIssued = cellData[1] ?? rawData["Date"] ?? rawData["Issue Date"] ?? rawData["Date Issued"] ?? "";
                const violationCode = cellData[2] ?? rawData["Code"] ?? rawData["Violation Code"] ?? "";
                const description = cellData[3] ?? rawData["Description"] ?? rawData["Violation"] ?? violationCode;
                const status = cellData[4] ?? rawData["Status"] ?? "unknown";
                const amount = parseFloat((cellData[5] ?? rawData["Amount"] ?? rawData["Fine"] ?? rawData["Balance Due"] ?? "0").replace(/[^0-9.]/g, "")) || 0;
                const location = cellData[6] ?? rawData["Location"] ?? rawData["Address"] ?? rawData["Street"] ?? "";
                const plate = cellData[7] ??
                    rawData["Plate"] ??
                    rawData["License Plate"] ??
                    rawData["Plate Number"] ??
                    "";
                const makeKey = Object.keys(rawData).find((k) => /make/i.test(k));
                const modelKey = Object.keys(rawData).find((k) => /model/i.test(k));
                const colorKey = Object.keys(rawData).find((k) => /color/i.test(k));
                return {
                    violationNumber,
                    dateIssued,
                    violationCode,
                    description,
                    amount,
                    status,
                    location,
                    city: cityId,
                    plate,
                    vehicleMake: makeKey ? rawData[makeKey] : undefined,
                    vehicleModel: modelKey ? rawData[modelKey] : undefined,
                    vehicleColor: colorKey ? rawData[colorKey] : undefined,
                    officerNotes: undefined,
                    meterNumber: undefined,
                    photoUrls: [],
                    rawData,
                };
            }
            finally {
                await browser.close();
            }
        },
        getDisputeFormStructure() {
            const appealNotes = config.appealSlug
                ? [
                    `${config.displayName} uses the Duncan Solutions appeal portal at https://duncan.imageenforcement.com/adminreviewsites/${config.appealSlug}.`,
                    "Opening the appeal portal in a visible browser window is supported via submitDispute.",
                ]
                : [
                    `${config.displayName} does not have a configured Duncan appeal portal slug.`,
                    "Contact the city directly to dispute a citation.",
                ];
            return {
                city: cityId,
                requiredFields: ["violationNumber", "arguments", "contactName", "contactEmail"],
                maxArgumentLength: 5000,
                maxEvidenceFiles: 3,
                acceptedFileTypes: ["application/pdf", "image/jpg", "image/jpeg", "image/png"],
                notes: [
                    `${config.displayName} parking citations are managed through the DS Payments portal at ${baseUrl}.`,
                    ...appealNotes,
                    "Typical appeal deadlines are 30 days from the citation issue date — check your citation for the specific deadline.",
                    "Supporting evidence (photos, receipts, registration documents) can be uploaded as PDF, JPG, or PNG files (max 3 files).",
                    "You will receive a confirmation after submission. Keep the reference number for follow-up.",
                ].join(" | "),
            };
        },
        async submitDispute(violationNumber, args, evidencePaths) {
            if (!config.appealSlug) {
                throw new Error([
                    `No Duncan appeal portal slug is configured for ${config.displayName}.`,
                    `To dispute citation ${violationNumber}, visit the DS Payments portal at ${baseUrl} directly,`,
                    "look up your citation, and follow the appeal or dispute link on the citation detail page.",
                    "Alternatively, contact the city's parking enforcement office directly.",
                ].join(" "));
            }
            const appealUrl = `https://duncan.imageenforcement.com/adminreviewsites/${config.appealSlug}`;
            const disputeText = [
                `Violation Number: ${violationNumber}`,
                "",
                "DISPUTE ARGUMENTS:",
                args,
                "",
                evidencePaths.length > 0
                    ? `Evidence files to attach: ${evidencePaths.join(", ")}`
                    : "No evidence files specified.",
            ].join("\n");
            const browser = await chromium.launch({ headless: false });
            try {
                const context = await browser.newContext({
                    userAgent: USER_AGENT,
                    locale: "en-US",
                });
                const page = await context.newPage();
                await page.goto(appealUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                console.error([
                    `=== ${config.displayName.toUpperCase()} (DS PAYMENTS / DUNCAN) DISPUTE SUBMISSION ===`,
                    `Appeal Portal: ${appealUrl}`,
                    `Payment Portal: ${baseUrl}`,
                    "",
                    "Steps to submit your appeal:",
                    `1. The Duncan appeal portal for ${config.displayName} is now open in your browser.`,
                    `2. Enter your violation number: ${violationNumber}`,
                    "3. Complete the appeal form with your contact information.",
                    "4. Paste the dispute text below into the statement / argument field.",
                    "5. Upload any evidence files listed.",
                    "6. Submit and record your confirmation number.",
                    "",
                    "=== DISPUTE TEXT ===",
                    disputeText,
                    "===================",
                    "",
                    "Waiting — close the browser window when finished to continue...",
                ].join("\n"));
                await page.waitForEvent("close", { timeout: 600000 }).catch(() => {
                    // User closed browser — treat as done
                });
                return {
                    success: true,
                    timestamp: new Date().toISOString(),
                    message: [
                        `Duncan appeal portal for ${config.displayName} was opened at ${appealUrl} for violation ${violationNumber}.`,
                        "Dispute text was printed to the console for manual entry.",
                        "Record the confirmation number shown after submission.",
                    ].join(" "),
                };
            }
            finally {
                await browser.close();
            }
        },
        async checkDisposition(violationNumber) {
            const browser = await chromium.launch({
                headless: true,
                args: ["--lang=en-US"],
            });
            try {
                const context = await browser.newContext({
                    userAgent: USER_AGENT,
                    locale: "en-US",
                });
                const page = await context.newPage();
                await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                // Search by ticket/citation number
                const ticketInput = page
                    .locator('input[name*="ticket" i], input[id*="ticket" i], input[name*="citation" i], input[id*="citation" i], input[name*="violation" i], input[id*="violation" i], input[type="text"]')
                    .first();
                await ticketInput.fill(violationNumber);
                await Promise.all([
                    page.waitForLoadState("networkidle", { timeout: 30000 }),
                    page
                        .locator('input[type="submit"], button[type="submit"], button')
                        .first()
                        .click(),
                ]);
                const pageText = await page.innerText("body");
                const textLower = pageText.toLowerCase();
                let status = "unknown";
                let disposition = null;
                let details;
                if (textLower.includes("dismissed") ||
                    textLower.includes("not liable") ||
                    textLower.includes("cancelled") ||
                    textLower.includes("void")) {
                    status = "decided";
                    disposition = "dismissed";
                    details = "Citation dismissed.";
                }
                else if (textLower.includes("reduced")) {
                    status = "decided";
                    disposition = "reduced";
                    details = "Citation amount reduced.";
                }
                else if (textLower.includes("guilty") ||
                    textLower.includes("liable") ||
                    textLower.includes("upheld") ||
                    textLower.includes("denied")) {
                    status = "decided";
                    disposition = "guilty";
                    details = "Found guilty/liable. Fine is due.";
                }
                else if (textLower.includes("scheduled") || textLower.includes("hearing")) {
                    status = "scheduled";
                    details = "Hearing scheduled.";
                }
                else if (textLower.includes("pending") ||
                    textLower.includes("appeal") ||
                    textLower.includes("under review") ||
                    textLower.includes("in review")) {
                    status = "pending";
                    details = "Appeal pending review.";
                }
                const amountMatch = pageText.match(/\$?([\d,]+\.\d{2})/);
                const amount = amountMatch
                    ? parseFloat(amountMatch[1].replace(",", ""))
                    : undefined;
                return {
                    violationNumber,
                    city: cityId,
                    status,
                    disposition,
                    amount,
                    details,
                };
            }
            finally {
                await browser.close();
            }
        },
    };
}
//# sourceMappingURL=dspayments.js.map