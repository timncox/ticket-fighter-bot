import { chromium } from "playwright";
import orlandoCodes from "../codes/orlando-codes.json" with { type: "json" };
const LOOKUP_URL = "https://www.citationprocessingcenter.com/citizen-search-citation.aspx";
const APPEAL_FORM_PDF = "https://www.citationprocessingcenter.com/appealpdfs/APPEAL_FORM.pdf";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
function getCodeInfo(code) {
    if (code in orlandoCodes) {
        return orlandoCodes[code];
    }
    return null;
}
export const orlandoAdapter = {
    cityId: "orlando",
    displayName: "Orlando",
    async lookupTickets(plate, state, _type) {
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({ userAgent: USER_AGENT });
            const page = await context.newPage();
            await page.goto(LOOKUP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            // Select "License Plate" search type
            const searchTypeSelect = page.locator('select').first();
            await searchTypeSelect.selectOption({ label: "License Plate" });
            // Fill in plate number
            const plateInput = page.locator('input[type="text"]').first();
            await plateInput.fill(plate.toUpperCase());
            // Select state
            const stateSelect = page.locator('select').nth(1);
            await stateSelect.selectOption({ value: state.toUpperCase() });
            // Submit the search
            await Promise.all([
                page.waitForLoadState("networkidle", { timeout: 30000 }),
                page.locator('input[type="submit"], button[type="submit"]').first().click(),
            ]);
            // Parse results table
            const tickets = [];
            const rows = await page.locator("table tr").all();
            for (let i = 1; i < rows.length; i++) {
                const cells = await rows[i].locator("td").all();
                if (cells.length < 4)
                    continue;
                const cellTexts = await Promise.all(cells.map((c) => c.innerText()));
                const violationNumber = cellTexts[0]?.trim() ?? "";
                const dateIssued = cellTexts[1]?.trim() ?? "";
                const violationCode = cellTexts[2]?.trim() ?? "";
                const status = cellTexts[3]?.trim() ?? "";
                const amount = parseFloat((cellTexts[4]?.trim() ?? "0").replace(/[^0-9.]/g, "")) || 0;
                const location = cellTexts[5]?.trim() ?? "";
                if (!violationNumber)
                    continue;
                const codeInfo = getCodeInfo(violationCode);
                const description = codeInfo?.description ?? violationCode;
                tickets.push({
                    violationNumber,
                    dateIssued,
                    violationCode,
                    description,
                    amount,
                    status,
                    location,
                    city: "orlando",
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
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({ userAgent: USER_AGENT });
            const page = await context.newPage();
            await page.goto(LOOKUP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            // Select citation number search type
            const searchTypeSelect = page.locator('select').first();
            await searchTypeSelect.selectOption({ label: "Citation Number" });
            // Fill in violation/citation number
            const citationInput = page.locator('input[type="text"]').first();
            await citationInput.fill(violationNumber);
            // Submit
            await Promise.all([
                page.waitForLoadState("networkidle", { timeout: 30000 }),
                page.locator('input[type="submit"], button[type="submit"]').first().click(),
            ]);
            // Extract all visible text fields as rawData
            const rawData = {};
            const labeledFields = await page.locator("td, th, label, span").all();
            for (const field of labeledFields) {
                const text = (await field.innerText()).trim();
                if (text) {
                    rawData[text] = text;
                }
            }
            // Try to extract structured fields from result rows
            const rows = await page.locator("table tr").all();
            const cellData = [];
            for (const row of rows) {
                const cells = await row.locator("td").all();
                for (const cell of cells) {
                    cellData.push((await cell.innerText()).trim());
                }
            }
            const violationCode = cellData[2] ?? "";
            const codeInfo = getCodeInfo(violationCode);
            const description = codeInfo?.description ?? violationCode;
            const parsedAmount = parseFloat((cellData[4] ?? "0").replace(/[^0-9.]/g, ""));
            const amount = parsedAmount || (codeInfo?.fine ?? 0);
            return {
                violationNumber,
                dateIssued: cellData[1] ?? "",
                violationCode,
                description,
                amount,
                status: cellData[3] ?? "unknown",
                location: cellData[5] ?? "",
                city: "orlando",
                plate: cellData[6] ?? "",
                vehicleMake: cellData[7] ?? undefined,
                vehicleModel: cellData[8] ?? undefined,
                vehicleColor: cellData[9] ?? undefined,
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
        return {
            city: "orlando",
            requiredFields: ["violationNumber", "arguments", "contactName", "contactEmail", "contactPhone"],
            maxArgumentLength: 3000,
            maxEvidenceFiles: 3,
            acceptedFileTypes: ["image/jpeg", "image/png", "application/pdf"],
            notes: [
                "Orlando appeals require a NOTARIZED appeal form — the form must be signed in front of a notary public before submission.",
                "Appeals must be filed within 14 days of the citation issue date.",
                "Submit the completed notarized form by mail or in person to the Citation Processing Center.",
                "Administrative review may be requested by phone after filing the written appeal.",
                `Download the official appeal form here: ${APPEAL_FORM_PDF}`,
                "Codes 39.14(1) and 39.41 may be reduced to $5 with supporting proof (registration documents or meter payment receipt).",
            ].join(" | "),
        };
    },
    async submitDispute(violationNumber, args, evidencePaths) {
        // Orlando does not support online dispute submission.
        // The user must print, notarize, and mail/deliver the appeal form.
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
        console.error([
            "=== ORLANDO APPEAL INSTRUCTIONS ===",
            `Appeal Form PDF: ${APPEAL_FORM_PDF}`,
            "",
            "Steps to submit your Orlando parking dispute:",
            "1. Download the appeal form from the URL above.",
            "2. Complete the form with the dispute text below.",
            "3. Have the form NOTARIZED by a licensed notary public.",
            "4. Submit the notarized form within 14 DAYS of the citation date,",
            "   either by mail or in person to the Citation Processing Center.",
            "5. Attach copies of any supporting evidence.",
            "6. For administrative review, contact the Citation Processing Center by phone.",
            "",
            "=== DISPUTE TEXT ===",
            disputeText,
            "====================================",
        ].join("\n"));
        return {
            success: false,
            timestamp: new Date().toISOString(),
            message: [
                "Orlando does not support online dispute submission.",
                "You must download, complete, and NOTARIZE the official appeal form, then submit it within 14 days.",
                `Appeal form: ${APPEAL_FORM_PDF}`,
                "Full instructions and dispute text have been printed to the console.",
            ].join(" "),
        };
    },
    async checkDisposition(violationNumber) {
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({ userAgent: USER_AGENT });
            const page = await context.newPage();
            await page.goto(LOOKUP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            // Select citation number search
            const searchTypeSelect = page.locator('select').first();
            await searchTypeSelect.selectOption({ label: "Citation Number" });
            const citationInput = page.locator('input[type="text"]').first();
            await citationInput.fill(violationNumber);
            await Promise.all([
                page.waitForLoadState("networkidle", { timeout: 30000 }),
                page.locator('input[type="submit"], button[type="submit"]').first().click(),
            ]);
            const pageText = (await page.innerText("body")).toLowerCase();
            // Infer status from page content
            let status = "unknown";
            let disposition = null;
            let details;
            if (pageText.includes("dismissed")) {
                status = "decided";
                disposition = "dismissed";
                details = "Citation dismissed.";
            }
            else if (pageText.includes("reduced")) {
                status = "decided";
                disposition = "reduced";
                details = "Citation amount reduced.";
            }
            else if (pageText.includes("guilty") || pageText.includes("liable")) {
                status = "decided";
                disposition = "guilty";
                details = "Found guilty/liable. Fine is due.";
            }
            else if (pageText.includes("scheduled") || pageText.includes("hearing")) {
                status = "scheduled";
                details = "Hearing scheduled.";
            }
            else if (pageText.includes("pending") || pageText.includes("appeal")) {
                status = "pending";
                details = "Appeal pending review.";
            }
            return {
                violationNumber,
                city: "orlando",
                status,
                disposition,
                details,
            };
        }
        finally {
            await browser.close();
        }
    },
};
//# sourceMappingURL=orlando.js.map