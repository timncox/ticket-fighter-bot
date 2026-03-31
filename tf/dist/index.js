#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, addPlate, removePlate, addHistoryEntry, getHistoryForCode, } from "./config.js";
import { getAdapter } from "./adapters/registry.js";
import { setupGmailAuth, searchGmailForDecisions } from "./gmail.js";
import { gatherEvidence } from "./evidence.js";
import { registerAdapter } from "./adapters/registry.js";
import { nycAdapter } from "./adapters/nyc.js";
import { chicagoAdapter } from "./adapters/chicago.js";
import { orlandoAdapter } from "./adapters/orlando.js";
import { bostonAdapter, miamiAdapter, charlotteAdapter, denverAdapter, dallasAdapter, raleighAdapter } from "./adapters/rmcpay-cities.js";
import { baltimoreAdapter } from "./adapters/baltimore.js";
import { dcAdapter } from "./adapters/dc.js";
import { atlantaAdapter } from "./adapters/atlanta.js";
import { sanDiegoAdapter, detroitDsAdapter, pittsburghAdapter, milwaukeeAdapter, sacramentoAdapter, newOrleansAdapter } from "./adapters/dspayments-cities.js";
import { detroitEtimsAdapter, clevelandAdapter, columbusAdapter, oaklandAdapter, santaMonicaAdapter } from "./adapters/etims-cities.js";
import { sfAdapter } from "./adapters/sf.js";
import { readFileSync } from "node:fs";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE, } from "@modelcontextprotocol/ext-apps/server";
registerAdapter(nycAdapter);
registerAdapter(chicagoAdapter);
registerAdapter(orlandoAdapter);
registerAdapter(bostonAdapter);
registerAdapter(miamiAdapter);
registerAdapter(charlotteAdapter);
registerAdapter(denverAdapter);
registerAdapter(dallasAdapter);
registerAdapter(raleighAdapter);
registerAdapter(baltimoreAdapter);
registerAdapter(dcAdapter);
registerAdapter(atlantaAdapter);
registerAdapter(sanDiegoAdapter);
registerAdapter(detroitDsAdapter);
registerAdapter(pittsburghAdapter);
registerAdapter(milwaukeeAdapter);
registerAdapter(sacramentoAdapter);
registerAdapter(newOrleansAdapter);
registerAdapter(sfAdapter);
registerAdapter(detroitEtimsAdapter);
registerAdapter(clevelandAdapter);
registerAdapter(columbusAdapter);
registerAdapter(oaklandAdapter);
registerAdapter(santaMonicaAdapter);
registerAdapter(atlantaAdapter);
const WIDGET_URI = "ui://ticket-fighter/widget.html";
let widgetHtml;
try {
    widgetHtml = readFileSync(new URL("../app/dist/index.html", import.meta.url), "utf-8");
}
catch {
    widgetHtml = "<div>Widget not built. Run: cd app && npm run build</div>";
}
const server = new McpServer({
    name: "ticket-fighter",
    version: "1.0.0",
}, { capabilities: { tools: {}, resources: {} } });
server.registerTool("manage_plates", {
    description: "Add, remove, or list saved license plates for ticket monitoring",
    inputSchema: {
        action: z.enum(["add", "remove", "list"]).describe("Action to perform"),
        number: z.string().optional().describe("Plate number (for add/remove)"),
        state: z.string().optional().describe("Plate state, e.g. NY, IL, FL (for add)"),
        type: z.string().optional().describe("Plate type, e.g. PAS, COM (for add)"),
        city: z.enum(["nyc", "chicago", "orlando"]).optional().describe("City (for add/remove)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI } },
}, async ({ action, number, state, type, city }) => {
    try {
        if (action === "list") {
            const config = loadConfig();
            return {
                structuredContent: { tool: "manage_plates", action: "list", plates: config.plates },
                content: [{ type: "text", text: JSON.stringify(config.plates, null, 2) }],
            };
        }
        if (!number || !city) {
            return { content: [{ type: "text", text: "Error: number and city are required for add/remove" }], isError: true };
        }
        if (action === "add") {
            if (!state || !type) {
                return { content: [{ type: "text", text: "Error: state and type are required for add" }], isError: true };
            }
            const config = addPlate({ number: number.toUpperCase(), state: state.toUpperCase(), type: type.toUpperCase(), city });
            return {
                structuredContent: { tool: "manage_plates", action: "add", plates: config.plates },
                content: [{ type: "text", text: `Added ${number.toUpperCase()} (${city}). Plates:\n${JSON.stringify(config.plates, null, 2)}` }],
            };
        }
        const config = removePlate(number.toUpperCase(), city);
        return {
            structuredContent: { tool: "manage_plates", action: "remove", plates: config.plates },
            content: [{ type: "text", text: `Removed ${number.toUpperCase()} (${city}). Plates:\n${JSON.stringify(config.plates, null, 2)}` }],
        };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
});
server.registerTool("check_tickets", {
    description: "Check for open parking tickets by scraping city violation portals. Checks all saved plates if no plate specified.",
    inputSchema: {
        plate: z.string().optional().describe("Specific plate number to check"),
        city: z.enum(["nyc", "chicago", "orlando"]).optional().describe("Filter to one city"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI } },
}, async ({ plate, city }) => {
    try {
        const config = loadConfig();
        let platesToCheck = config.plates;
        if (plate) {
            platesToCheck = platesToCheck.filter((p) => p.number === plate.toUpperCase());
            if (platesToCheck.length === 0) {
                return { content: [{ type: "text", text: `Plate ${plate} not found in saved plates.` }], isError: true };
            }
        }
        if (city)
            platesToCheck = platesToCheck.filter((p) => p.city === city);
        if (platesToCheck.length === 0) {
            return { content: [{ type: "text", text: "No plates to check. Add plates with manage_plates first." }], isError: true };
        }
        const allTickets = [];
        const errors = [];
        for (const p of platesToCheck) {
            try {
                const adapter = getAdapter(p.city);
                const tickets = await adapter.lookupTickets(p.number, p.state, p.type);
                allTickets.push(...tickets);
            }
            catch (err) {
                errors.push(`${p.city}/${p.number}: ${err.message}`);
            }
        }
        const result = { tickets: allTickets, errors: errors.length > 0 ? errors : undefined, checked: platesToCheck.map((p) => `${p.number} (${p.city})`) };
        return {
            structuredContent: { tool: "check_tickets", ...result },
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
});
server.registerTool("analyze_ticket", {
    description: "Gather evidence for a specific violation: ticket details, registration cross-ref, Street View imagery, traffic rule lookup, common defenses, and past dispute history",
    inputSchema: {
        violation_number: z.string().describe("The violation/ticket number"),
        city: z.enum(["nyc", "chicago", "orlando"]).describe("Which city issued the ticket"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI } },
}, async ({ violation_number, city }) => {
    try {
        const adapter = getAdapter(city);
        const detail = await adapter.getTicketDetails(violation_number);
        const evidence = await gatherEvidence(detail);
        const pastDisputes = getHistoryForCode(city, detail.violationCode);
        const result = { ticketDetails: detail, evidence, commonDefenses: evidence.commonDefenses, pastDisputes: pastDisputes.length > 0 ? pastDisputes : "No past disputes for this violation code", formStructure: adapter.getDisputeFormStructure() };
        return {
            structuredContent: { tool: "analyze_ticket", ...result },
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
});
server.registerTool("generate_dispute", {
    description: "Format dispute arguments into city-specific form structure. Returns a preview — does NOT submit.",
    inputSchema: {
        violation_number: z.string().describe("The violation/ticket number"),
        city: z.enum(["nyc", "chicago", "orlando"]).describe("Which city"),
        arguments: z.string().describe("The dispute text/arguments to submit"),
        evidence_paths: z.array(z.string()).optional().describe("File paths to photos/documents to attach"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI } },
}, async ({ violation_number, city, arguments: args, evidence_paths }) => {
    try {
        const adapter = getAdapter(city);
        const form = adapter.getDisputeFormStructure();
        if (args.length > form.maxArgumentLength) {
            return { content: [{ type: "text", text: `Error: Arguments exceed max length (${form.maxArgumentLength} chars)` }], isError: true };
        }
        const evidenceFiles = evidence_paths || [];
        if (evidenceFiles.length > form.maxEvidenceFiles) {
            return { content: [{ type: "text", text: `Error: Too many evidence files. Max ${form.maxEvidenceFiles}` }], isError: true };
        }
        const result = { violation_number, city, arguments: args, evidence_files: evidenceFiles, form_notes: form.notes, status: "PREVIEW — not yet submitted. Call submit_dispute with confirmed=true to submit." };
        return {
            structuredContent: { tool: "generate_dispute", ...result },
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
});
server.registerTool("submit_dispute", {
    description: "Submit a previously previewed dispute. Requires confirmed=true as a safety gate.",
    inputSchema: {
        violation_number: z.string().describe("The violation/ticket number"),
        city: z.enum(["nyc", "chicago", "orlando"]).describe("Which city"),
        arguments: z.string().describe("The dispute text to submit"),
        evidence_paths: z.array(z.string()).optional().describe("File paths to evidence"),
        confirmed: z.boolean().describe("Must be true to submit. Safety gate."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI } },
}, async ({ violation_number, city, arguments: args, evidence_paths, confirmed }) => {
    if (!confirmed) {
        return { content: [{ type: "text", text: "Submission blocked: confirmed must be true." }], isError: true };
    }
    try {
        const adapter = getAdapter(city);
        const result = await adapter.submitDispute(violation_number, args, evidence_paths || []);
        addHistoryEntry({
            violationNumber: violation_number, city, plate: "", dateIssued: "", violationCode: "", amount: 0,
            disputeSubmitted: new Date().toISOString(), argumentsSummary: args.slice(0, 200), evidenceAttached: (evidence_paths || []).length > 0,
        });
        return {
            structuredContent: { tool: "submit_dispute", ...result },
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
});
server.registerTool("check_status", {
    description: "Check dispute status via city portal scrape or Gmail search for decision emails",
    inputSchema: {
        violation_number: z.string().optional().describe("Violation number to check on city portal"),
        city: z.enum(["nyc", "chicago", "orlando"]).optional().describe("City (required with violation_number)"),
        gmail_search: z.string().optional().describe("Search Gmail for decision emails"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI } },
}, async ({ violation_number, city, gmail_search }) => {
    try {
        if (violation_number && city) {
            const adapter = getAdapter(city);
            const status = await adapter.checkDisposition(violation_number);
            return {
                structuredContent: { tool: "check_status", ...status },
                content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
            };
        }
        if (gmail_search) {
            const results = await searchGmailForDecisions(gmail_search);
            return {
                structuredContent: { tool: "check_status", results },
                content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            };
        }
        return { content: [{ type: "text", text: "Provide either violation_number+city or gmail_search" }], isError: true };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
});
server.registerTool("setup_gmail", {
    description: "Launch a visible browser for Gmail login. Saves auth state for headless reuse by check_status.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI } },
}, async () => {
    try {
        const result = await setupGmailAuth();
        return {
            structuredContent: { tool: "setup_gmail", result },
            content: [{ type: "text", text: result }],
        };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
});
registerAppResource(server, "Ticket Fighter", WIDGET_URI, {
    description: "Ticket Fighter — parking ticket dashboard and dispute assistant",
    _meta: {
        ui: {
            csp: { connectDomains: [], resourceDomains: [] },
        },
    },
}, async () => ({
    contents: [{
            uri: WIDGET_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: widgetHtml,
            _meta: {
                ui: {
                    csp: { connectDomains: [], resourceDomains: [] },
                },
            },
        }],
}));
registerAppTool(server, "open_dashboard", {
    description: "Open the Ticket Fighter dashboard in the MCP App UI.",
    _meta: { ui: { resourceUri: WIDGET_URI } },
}, async () => {
    const config = loadConfig();
    return {
        structuredContent: { tool: "manage_plates", action: "list", plates: config.plates },
        content: [{ type: "text", text: `${config.plates.length} plates saved.` }],
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch(console.error);
//# sourceMappingURL=index.js.map