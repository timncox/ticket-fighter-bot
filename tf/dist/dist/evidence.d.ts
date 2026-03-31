import type { TicketDetail } from "./adapters/types.js";
export interface EvidencePackage {
    streetViewImages: string[];
    registrationDiscrepancies: string[];
    trafficRuleText: string;
    commonDefenses: string[];
    locationNotes: string;
    ticketErrors: string[];
}
export declare function gatherEvidence(ticket: TicketDetail): Promise<EvidencePackage>;
