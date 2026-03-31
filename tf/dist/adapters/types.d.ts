export interface Plate {
    number: string;
    state: string;
    type: string;
    city: CityId;
}
export type CityId = "nyc" | "chicago" | "orlando" | "boston" | "miami" | "charlotte" | "denver" | "dallas" | "raleigh" | "baltimore" | "dc" | "atlanta" | string;
export interface Ticket {
    violationNumber: string;
    dateIssued: string;
    violationCode: string;
    description: string;
    amount: number;
    status: string;
    location: string;
    city: CityId;
    plate: string;
}
export interface TicketDetail extends Ticket {
    vehicleMake?: string;
    vehicleModel?: string;
    vehicleColor?: string;
    officerNotes?: string;
    meterNumber?: string;
    photoUrls?: string[];
    rawData: Record<string, string>;
}
export interface DisputeFormFields {
    city: CityId;
    requiredFields: string[];
    maxArgumentLength: number;
    maxEvidenceFiles: number;
    acceptedFileTypes: string[];
    notes: string;
}
export interface DisputeConfirmation {
    success: boolean;
    referenceNumber?: string;
    timestamp: string;
    message: string;
}
export interface DisputeStatus {
    violationNumber: string;
    city: CityId;
    status: "pending" | "scheduled" | "decided" | "unknown";
    disposition?: "guilty" | "dismissed" | "reduced" | null;
    amount?: number;
    decisionDate?: string;
    details?: string;
}
export interface CityAdapter {
    readonly cityId: CityId;
    readonly displayName: string;
    lookupTickets(plate: string, state: string, type: string): Promise<Ticket[]>;
    getTicketDetails(violationNumber: string): Promise<TicketDetail>;
    getDisputeFormStructure(): DisputeFormFields;
    submitDispute(violationNumber: string, args: string, evidencePaths: string[]): Promise<DisputeConfirmation>;
    checkDisposition(violationNumber: string): Promise<DisputeStatus>;
}
