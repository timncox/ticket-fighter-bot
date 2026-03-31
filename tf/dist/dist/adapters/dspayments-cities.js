import { createDsPaymentsAdapter } from "./dspayments.js";
export const sanDiegoAdapter = createDsPaymentsAdapter({
    cityId: "sandiego",
    displayName: "San Diego",
    citySlug: "SanDiego",
    appealSlug: "SanDiegoReview",
});
export const detroitDsAdapter = createDsPaymentsAdapter({
    cityId: "detroit",
    displayName: "Detroit",
    citySlug: "Detroit",
    appealSlug: "DetroitReview",
});
export const pittsburghAdapter = createDsPaymentsAdapter({
    cityId: "pittsburgh",
    displayName: "Pittsburgh",
    citySlug: "Pittsburgh",
    appealSlug: "PittsburghReview",
});
export const milwaukeeAdapter = createDsPaymentsAdapter({
    cityId: "milwaukee",
    displayName: "Milwaukee",
    citySlug: "Milwaukee",
    appealSlug: "MilwaukeeReview",
});
export const sacramentoAdapter = createDsPaymentsAdapter({
    cityId: "sacramento",
    displayName: "Sacramento",
    citySlug: "Sacramento",
    appealSlug: "SacramentoReview",
});
export const newOrleansAdapter = createDsPaymentsAdapter({
    cityId: "neworleans",
    displayName: "New Orleans",
    citySlug: "neworleans",
    portalDomain: "dsparkingportal.com",
    appealSlug: "NewOrleansReview",
});
//# sourceMappingURL=dspayments-cities.js.map