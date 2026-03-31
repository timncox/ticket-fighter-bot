const adapters = new Map();
export function registerAdapter(adapter) {
    adapters.set(adapter.cityId, adapter);
}
export function getAdapter(city) {
    const adapter = adapters.get(city);
    if (!adapter) {
        throw new Error(`No adapter registered for city: ${city}. Supported cities: ${[...adapters.keys()].join(", ")}`);
    }
    return adapter;
}
export function getAllAdapters() {
    return [...adapters.values()];
}
//# sourceMappingURL=registry.js.map