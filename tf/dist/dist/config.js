import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
const BASE_DIR = path.join(os.homedir(), ".ticket-fighter");
const CONFIG_FILE = path.join(BASE_DIR, "config.json");
const HISTORY_FILE = path.join(BASE_DIR, "history.json");
const DECISIONS_DIR = path.join(BASE_DIR, "decisions");
const AUTH_DIR = path.join(BASE_DIR, "auth", "gmail");
export function ensureDirs() {
    for (const dir of [BASE_DIR, DECISIONS_DIR, AUTH_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
export function getAuthDir() {
    ensureDirs();
    return AUTH_DIR;
}
export function getDecisionsDir() {
    ensureDirs();
    return DECISIONS_DIR;
}
export function loadConfig() {
    ensureDirs();
    if (!fs.existsSync(CONFIG_FILE)) {
        const defaults = { plates: [], gmail_auth_dir: AUTH_DIR };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
        return defaults;
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
}
export function saveConfig(config) {
    ensureDirs();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
export function addPlate(plate) {
    const config = loadConfig();
    const exists = config.plates.some((p) => p.number === plate.number && p.city === plate.city);
    if (exists)
        throw new Error(`Plate ${plate.number} already registered for ${plate.city}`);
    config.plates.push(plate);
    saveConfig(config);
    return config;
}
export function removePlate(number, city) {
    const config = loadConfig();
    const before = config.plates.length;
    config.plates = config.plates.filter((p) => !(p.number === number && p.city === city));
    if (config.plates.length === before) {
        throw new Error(`Plate ${number} not found for ${city}`);
    }
    saveConfig(config);
    return config;
}
export function loadHistory() {
    ensureDirs();
    if (!fs.existsSync(HISTORY_FILE))
        return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
}
export function saveHistory(history) {
    ensureDirs();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}
export function addHistoryEntry(entry) {
    const history = loadHistory();
    const idx = history.findIndex((h) => h.violationNumber === entry.violationNumber && h.city === entry.city);
    if (idx >= 0) {
        history[idx] = { ...history[idx], ...entry };
    }
    else {
        history.push(entry);
    }
    saveHistory(history);
}
export function getHistoryForCode(city, violationCode) {
    return loadHistory().filter((h) => h.city === city && h.violationCode === violationCode);
}
//# sourceMappingURL=config.js.map