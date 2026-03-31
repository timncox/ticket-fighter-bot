import type { CityAdapter } from "./types.js";
export declare function createDsPaymentsAdapter(config: {
    cityId: string;
    displayName: string;
    citySlug: string;
    portalDomain?: string;
    appealSlug?: string;
}): CityAdapter;
