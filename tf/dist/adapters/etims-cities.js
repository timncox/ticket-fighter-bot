import { createEtimsAdapter } from "./etims.js";
export const sanFranciscoAdapter = createEtimsAdapter({
    cityId: "sanfrancisco",
    displayName: "San Francisco",
    cityPath: "sanfrancisco",
    subdomain: "wmq",
    disputeUrl: "https://www.sfmta.com/getting-around/drive-park/citations",
});
export const detroitEtimsAdapter = createEtimsAdapter({
    cityId: "detroit_etims",
    displayName: "Detroit (eTIMS)",
    cityPath: "detroit",
    subdomain: "prodpci",
});
export const clevelandAdapter = createEtimsAdapter({
    cityId: "cleveland",
    displayName: "Cleveland",
    cityPath: "cleveland",
    subdomain: "wmq",
});
export const columbusAdapter = createEtimsAdapter({
    cityId: "columbus",
    displayName: "Columbus",
    cityPath: "columbus",
    subdomain: "prodpci",
});
export const oaklandAdapter = createEtimsAdapter({
    cityId: "oakland",
    displayName: "Oakland",
    cityPath: "oakland",
    subdomain: "pci",
});
export const santaMonicaAdapter = createEtimsAdapter({
    cityId: "santamonica",
    displayName: "Santa Monica",
    cityPath: "santamonica",
    subdomain: "wmq",
});
//# sourceMappingURL=etims-cities.js.map