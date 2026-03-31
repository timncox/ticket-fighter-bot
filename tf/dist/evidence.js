import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { getDecisionsDir } from "./config.js";
const CITY_LOCATION_MAP = {
    nyc: "New York, NY",
    chicago: "Chicago, IL",
    orlando: "Orlando, FL",
};
const CODES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "codes");
function loadCityDefenses(city, violationCode) {
    const codesFile = path.join(CODES_DIR, `${city}-codes.json`);
    if (!fs.existsSync(codesFile))
        return [];
    try {
        const codes = JSON.parse(fs.readFileSync(codesFile, "utf-8"));
        return codes[violationCode]?.defenses ?? [];
    }
    catch {
        return [];
    }
}
function findTicketErrors(ticket) {
    const errors = [];
    const raw = ticket.rawData;
    // Missing required fields
    if (!ticket.location || ticket.location.trim() === "") {
        errors.push("Missing required field: location");
    }
    if (!ticket.violationCode || ticket.violationCode.trim() === "") {
        errors.push("Missing required field: violationCode");
    }
    if (!ticket.dateIssued || ticket.dateIssued.trim() === "") {
        errors.push("Missing required field: dateIssued");
    }
    // Vehicle make abbreviated (3 chars or less = likely truncated)
    const make = ticket.vehicleMake ?? raw["Vehicle Make"] ?? raw["Make"] ?? "";
    if (make.length > 0 && make.length <= 3) {
        errors.push(`Vehicle make "${make}" appears truncated (${make.length} characters — may be abbreviated)`);
    }
    // Missing "Date and Time First Observed" or "First Observed" field
    const hasFirstObserved = "Date and Time First Observed" in raw ||
        "First Observed" in raw ||
        "Date/Time First Observed" in raw;
    if (!hasFirstObserved) {
        errors.push('Missing field: "Date and Time First Observed" / "First Observed" — required for time-based violations');
    }
    // Location ambiguity: NYC tickets should mention a borough
    if (ticket.city === "nyc") {
        const boroughs = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
        const locationStr = ticket.location ?? "";
        const mentionsBoroughInLocation = boroughs.some((b) => locationStr.toLowerCase().includes(b.toLowerCase()));
        const rawValues = Object.values(raw).join(" ");
        const mentionsBoroughInRaw = boroughs.some((b) => rawValues.toLowerCase().includes(b.toLowerCase()));
        if (!mentionsBoroughInLocation && !mentionsBoroughInRaw) {
            errors.push("Location ambiguity: No NYC borough mentioned — ticket location may be unenforceable without borough specification");
        }
    }
    return errors;
}
function buildTrafficRuleUrl(city) {
    switch (city) {
        case "nyc":
            return "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCrules/0-0-0-1#JD_Title34";
        case "chicago":
            return "https://codelibrary.amlegal.com/codes/chicago/latest/chicago_il/0-0-0-1#JD_MunicipalCode";
        case "orlando":
            return "https://library.municode.com/fl/orlando/codes/code_of_ordinances?nodeId=COOR_CH39VE";
        default:
            return "";
    }
}
async function captureStreetView(ticket) {
    const cityLocation = CITY_LOCATION_MAP[ticket.city];
    if (!cityLocation || !ticket.location)
        return [];
    const query = encodeURIComponent(`${ticket.location}, ${cityLocation}`);
    const url = `https://www.google.com/maps/search/${query}`;
    const decisionsDir = getDecisionsDir();
    const outputPath = path.join(decisionsDir, `streetview-${ticket.violationNumber}.png`);
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        await page.screenshot({ path: outputPath, fullPage: false });
        return [outputPath];
    }
    finally {
        await browser.close();
    }
}
export async function gatherEvidence(ticket) {
    // 1. Load city-specific defenses
    const commonDefenses = loadCityDefenses(ticket.city, ticket.violationCode);
    // 2. Find ticket errors
    const ticketErrors = findTicketErrors(ticket);
    // 3. Capture Street View (best-effort)
    let streetViewImages = [];
    try {
        streetViewImages = await captureStreetView(ticket);
    }
    catch {
        // Street View capture is best-effort — failure is not fatal
    }
    // 4. Build traffic rule reference URL
    const trafficRuleText = buildTrafficRuleUrl(ticket.city);
    return {
        streetViewImages,
        registrationDiscrepancies: [],
        trafficRuleText,
        commonDefenses,
        locationNotes: ticket.location ?? "",
        ticketErrors,
    };
}
//# sourceMappingURL=evidence.js.map