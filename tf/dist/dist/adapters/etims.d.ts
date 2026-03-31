import type { CityAdapter } from "./types.js";
export declare function createEtimsAdapter(config: {
    cityId: string;
    displayName: string;
    cityPath: string;
    subdomain?: string;
    disputeUrl?: string;
}): CityAdapter;
