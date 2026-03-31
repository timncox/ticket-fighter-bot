import type { CityAdapter } from "./types.js";
export declare function createRmcPayAdapter(config: {
    cityId: string;
    displayName: string;
    subdomain: string;
}): CityAdapter;
