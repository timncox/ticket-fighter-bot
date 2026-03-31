import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
const DS_PAYMENTS_URL = "https://www.dspayments.com/Atlanta";
const DUNCAN_APPEAL_URL = "https://duncan.imageenforcement.com/adminreviewsites/atlantareview";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const codesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../codes/atlanta-codes.json");
const ATLANTA_CODES = JSON.parse(fs.readFileSync(codesPath, "utf-8"));
function getCodeInfo(code) {
    return (ATLANTA_CODES[code] ?? { description: "Unknown violation", fine: 0, defenses: [] });
}
export const atlantaAdapter = {
    cityId: "atlanta",
    displayName: "Atlanta",
    async lookupTickets(plate, state, _type) {
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({ userAgent: USER_AGENT });
            const page = await context.newPage();
            await page.goto(DS_PAYMENTS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            // Leave ticket number blank — search by plate only
            // Fill license plate field
            const plateInput = page.locator('input[name*="plate" i], input[id*="plate" i], input[placeholder*="plate" i]').first();
            await plateInput.fill(plate.toUpperCase());
            // Select state from dropdown
            const stateSelect = page.locator('select[name*="state" i], select[id*="state" i]').first();
            await stateSelect.selectOption(state.toUpperCase());
            // Submit the search
            await Promise.all([
                page.waitForLoadState("networkidle", { timeout: 30000 }),
                page.locator('input[type="submit"], button[type="submit"]').first().click(),
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
                const dateIssued = cellTexts[1]?.trim() ?? "";
                const violationCode = cellTexts[2]?.trim() ?? "";
                const status = cellTexts[3]?.trim() ?? "open";
                const amount = parseFloat((cellTexts[4]?.trim() ?? "0").replace(/[^0-9.]/g, "")) || 0;
                const location = cellTexts[5]?.trim() ?? "";
                if (!violationNumber)
                    continue;
                const codeInfo = getCodeInfo(violationCode);
                const description = codeInfo.description !== "Unknown violation"
                    ? codeInfo.description
                    : violationCode;
                tickets.push({
                    violationNumber,
                    dateIssued,
                    violationCode,
                    description,
                    amount,
                    status,
                    location,
                    city: "atlanta",
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
            await page.goto(DS_PAYMENTS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            // Fill ticket number field
            const ticketInput = page.locator('input[name*="ticket" i], input[id*="ticket" i], input[name*="citation" i], input[id*="citation" i], input[placeholder*="ticket" i], input[placeholder*="citation" i]').first();
            await ticketInput.fill(violationNumber);
            // Submit
            await Promise.all([
                page.waitForLoadState("networkidle", { timeout: 30000 }),
                page.locator('input[type="submit"], button[type="submit"]').first().click(),
            ]);
            // Collect raw key:value pairs from the page
            const rawData = {};
            const pageText = await page.innerText("body");
            const kvMatches = pageText.matchAll(/([A-Za-z ]{3,30}):\s*([^\n]{1,150})/g);
            for (const m of kvMatches) {
                rawData[m[1].trim()] = m[2].trim();
            }
            // Extract structured fields from result table cells
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
            const parsedAmount = parseFloat((cellData[4] ?? "0").replace(/[^0-9.]/g, ""));
            const amount = parsedAmount || codeInfo.fine;
            const makeMatch = pageText.match(/make[:\s]+([^\n]+)/i);
            const modelMatch = pageText.match(/model[:\s]+([^\n]+)/i);
            const colorMatch = pageText.match(/color[:\s]+([^\n]+)/i);
            const plateMatch = pageText.match(/plate[:\s]+([A-Z0-9]+)/i);
            return {
                violationNumber,
                dateIssued: cellData[1] ?? "",
                violationCode,
                description: codeInfo.description !== "Unknown violation"
                    ? codeInfo.description
                    : violationCode,
                amount,
                status: cellData[3] ?? "unknown",
                location: cellData[5] ?? "",
                city: "atlanta",
                plate: plateMatch ? plateMatch[1] : (cellData[6] ?? ""),
                vehicleMake: makeMatch ? makeMatch[1].trim() : undefined,
                vehicleModel: modelMatch ? modelMatch[1].trim() : undefined,
                vehicleColor: colorMatch ? colorMatch[1].trim() : undefined,
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
            city: "atlanta",
            requiredFields: ["violationNumber", "licensePlate", "arguments"],
            maxArgumentLength: 5000,
            maxEvidenceFiles: 3,
            acceptedFileTypes: ["image/jpeg", "image/png", "application/pdf"],
            notes: [
                "Atlanta appeals are processed through the Duncan Solutions portal (ATLPlus system): " +
                    DUNCAN_APPEAL_URL,
                "Appeals must be filed within 14 days of the citation issue date.",
                "Atlanta uses a 3-tier appeal process: (1) ATLPlus online administrative review, " +
                    "(2) Review Board hearing, (3) Municipal Court.",
                "Up to 3 evidence attachments (JPEG, PNG, or PDF) may be submitted with the online appeal.",
                "Citation number AND license plate or VIN are required to file the appeal.",
                "For assistance, contact the Atlanta Department of Public Works at 404-201-5396.",
            ].join(" | "),
        };
    },
    async submitDispute(violationNumber, args, evidencePaths) {
        const browser = await chromium.launch({ headless: false });
        try {
            const context = await browser.newContext({ userAgent: USER_AGENT });
            const page = await context.newPage();
            await page.goto(DUNCAN_APPEAL_URL, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
            });
            // Attempt to pre-fill citation number if the field is present
            const citationInput = page.locator('input[name*="citation" i], input[id*="citation" i], input[name*="ticket" i], input[id*="ticket" i]').first();
            const citationInputVisible = await citationInput.isVisible().catch(() => false);
            if (citationInputVisible) {
                await citationInput.fill(violationNumber);
            }
            const disputeText = [
                `Citation Number: ${violationNumber}`,
                "",
                "DISPUTE ARGUMENTS:",
                args,
                "",
                evidencePaths.length > 0
                    ? `Evidence files to attach: ${evidencePaths.join(", ")}`
                    : "No evidence files specified.",
            ].join("\n");
            console.error([
                "=== ATLANTA APPEAL SUBMISSION ===",
                `Portal: ${DUNCAN_APPEAL_URL}`,
                `Citation Number: ${violationNumber}`,
                "",
                "Steps to complete your Atlanta parking appeal:",
                "1. The Duncan Solutions appeal portal is now open in the browser.",
                `2. Enter citation number: ${violationNumber}`,
                "3. Enter your license plate number or VIN.",
                "4. Paste the dispute argument text below into the statement/reason field.",
                "5. Upload up to 3 evidence files (JPEG, PNG, or PDF).",
                "6. Submit the form and save your confirmation number.",
                "   NOTE: Appeals must be filed within 14 DAYS of the citation date.",
                "   For help, call 404-201-5396.",
                "",
                "=== DISPUTE TEXT ===",
                disputeText,
                "====================================",
            ].join("\n"));
            // Wait for the user to complete and close the browser
            await page.waitForEvent("close", { timeout: 600000 }).catch(() => {
                // User closed browser — treat as completed
            });
            return {
                success: true,
                timestamp: new Date().toISOString(),
                message: [
                    `Atlanta Duncan appeal portal opened for citation ${violationNumber}.`,
                    "Dispute text and instructions were printed to the console for manual entry.",
                    "Appeals must be submitted within 14 days of the citation date.",
                    "For assistance, call 404-201-5396.",
                ].join(" "),
            };
        }
        finally {
            await browser.close();
        }
    },
    async checkDisposition(violationNumber) {
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({ userAgent: USER_AGENT });
            const page = await context.newPage();
            await page.goto(DS_PAYMENTS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            // Search by ticket number
            const ticketInput = page.locator('input[name*="ticket" i], input[id*="ticket" i], input[name*="citation" i], input[id*="citation" i], input[placeholder*="ticket" i], input[placeholder*="citation" i]').first();
            await ticketInput.fill(violationNumber);
            await Promise.all([
                page.waitForLoadState("networkidle", { timeout: 30000 }),
                page.locator('input[type="submit"], button[type="submit"]').first().click(),
            ]);
            const pageText = await page.innerText("body");
            const textLower = pageText.toLowerCase();
            let status = "unknown";
            let disposition = null;
            let details;
            if (textLower.includes("dismissed") || textLower.includes("not liable")) {
                status = "decided";
                disposition = "dismissed";
                details = "Citation dismissed — no amount owed.";
            }
            else if (textLower.includes("reduced")) {
                status = "decided";
                disposition = "reduced";
                details = "Fine amount reduced.";
            }
            else if (textLower.includes("liable") || textLower.includes("guilty")) {
                status = "decided";
                disposition = "guilty";
                details = "Found liable. Payment is required.";
            }
            else if (textLower.includes("scheduled") || textLower.includes("hearing")) {
                status = "scheduled";
                details = "Hearing scheduled or pending.";
            }
            else if (textLower.includes("pending") || textLower.includes("appeal") || textLower.includes("review")) {
                status = "pending";
                details = "Appeal pending review.";
            }
            else if (textLower.includes("open") || textLower.includes("unpaid")) {
                status = "pending";
                details = "Citation open and unpaid.";
            }
            const amountMatch = pageText.match(/\$?([\d,]+\.?\d{0,2})/);
            const amount = amountMatch
                ? parseFloat(amountMatch[1].replace(",", ""))
                : undefined;
            return {
                violationNumber,
                city: "atlanta",
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
//# sourceMappingURL=atlanta.js.map