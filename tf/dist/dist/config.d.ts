import type { Plate, CityId } from "./adapters/types.js";
export interface HistoryEntry {
    violationNumber: string;
    city: CityId;
    plate: string;
    dateIssued: string;
    violationCode: string;
    amount: number;
    disputeSubmitted?: string;
    argumentsSummary?: string;
    evidenceAttached: boolean;
    disposition?: "guilty" | "dismissed" | "reduced" | null;
    decisionDate?: string;
    lessonsLearned?: string;
}
export interface Config {
    plates: Plate[];
    gmail_auth_dir: string;
}
export declare function ensureDirs(): void;
export declare function getAuthDir(): string;
export declare function getDecisionsDir(): string;
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
export declare function addPlate(plate: Plate): Config;
export declare function removePlate(number: string, city: CityId): Config;
export declare function loadHistory(): HistoryEntry[];
export declare function saveHistory(history: HistoryEntry[]): void;
export declare function addHistoryEntry(entry: HistoryEntry): void;
export declare function getHistoryForCode(city: CityId, violationCode: string): HistoryEntry[];
