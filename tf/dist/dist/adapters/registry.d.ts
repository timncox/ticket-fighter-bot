import type { CityAdapter, CityId } from "./types.js";
export declare function registerAdapter(adapter: CityAdapter): void;
export declare function getAdapter(city: CityId): CityAdapter;
export declare function getAllAdapters(): CityAdapter[];
