import { createRmcPayAdapter } from "./rmcpay.js";
export const bostonAdapter = createRmcPayAdapter({
    cityId: "boston",
    displayName: "Boston",
    subdomain: "bostonma",
});
export const miamiAdapter = createRmcPayAdapter({
    cityId: "miami",
    displayName: "Miami",
    subdomain: "mpa",
});
export const charlotteAdapter = createRmcPayAdapter({
    cityId: "charlotte",
    displayName: "Charlotte",
    subdomain: "charlotte",
});
export const denverAdapter = createRmcPayAdapter({
    cityId: "denver",
    displayName: "Denver",
    subdomain: "denvergov",
});
export const dallasAdapter = createRmcPayAdapter({
    cityId: "dallas",
    displayName: "Dallas",
    subdomain: "cityofdallas",
});
export const raleighAdapter = createRmcPayAdapter({
    cityId: "raleigh",
    displayName: "Raleigh",
    subdomain: "raleighparking",
});
//# sourceMappingURL=rmcpay-cities.js.map