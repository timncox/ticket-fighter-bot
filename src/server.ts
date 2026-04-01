/**
 * Ticket Fighter MMP Bot.
 * Receives MMP webhooks (+ polls inbox as fallback),
 * handles DM commands for plate management and ticket fighting.
 */

import express from "express";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron from "node-cron";
import { McpClient } from "./mmp-client.js";
import { TfClient } from "./tf-client.js";
import {
  upsertUser,
  getUser,
  addUserPlate,
  removeUserPlate,
  getUserPlates,
  getUserTickets,
  getState,
  setState,
} from "./db.js";
import { runTicketCheck } from "./checker.js";

// --- Environment ---

const PORT = parseInt(process.env.PORT || "3003", 10);
const MMP_URL = process.env.MMP_URL || "https://mmp.chat/mcp";
const MMP_BOT_TOKEN = process.env.MMP_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const TF_PATH = process.env.TF_PATH || path.join(process.cwd(), "tf", "dist", "index.js");

// --- Clients ---

const mmpUrl = MMP_BOT_TOKEN
  ? `${MMP_URL}?token=${MMP_BOT_TOKEN}`
  : MMP_URL;
const mmpClient = new McpClient(mmpUrl);
const tfClient = new TfClient("node", [TF_PATH]);

// --- Express ---

const app = express();
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ticket-fighter-bot", timestamp: new Date().toISOString() });
});

// --- Gmail OAuth callback ---

app.get("/auth/gmail/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    // Exchange the code for tokens directly via Google's token endpoint
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || "https://tf.mmp.chat/auth/gmail/callback",
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
    }

    const data = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Store tokens in ticket-fighter's config directory via the filesystem
    // (shared between bot and tf subprocess)
    const os = await import("node:os");
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const authDir = nodePath.default.join(os.default.homedir(), ".ticket-fighter", "auth", "gmail");
    fs.default.mkdirSync(authDir, { recursive: true });
    const tokenPath = nodePath.default.join(authDir, "gmail-oauth-tokens.json");
    fs.default.writeFileSync(tokenPath, JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token || "",
      expires_at: Date.now() + data.expires_in * 1000,
    }, null, 2));

    res.send(
      `<html><body style="font-family:monospace;background:#08080A;color:#F0EBE0;display:flex;align-items:center;justify-content:center;min-height:100vh">` +
      `<div style="text-align:center"><h1 style="color:#FF2B2B">Gmail Connected!</h1>` +
      `<p>You can close this window. Ticket Fighter can now search your Gmail for dispute decisions.</p></div></body></html>`
    );
  } catch (err) {
    res.status(500).send(`OAuth error: ${(err as Error).message}`);
  }
});

// --- Webhook ---

function verifyWebhook(body: string, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) return true;
  if (!signature) return false;
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return signature === expected;
}

interface MmpWebhookPayload {
  event: string;
  content_type?: string;
  call_id?: string;
  message?: {
    id: string;
    from: string;
    from_handle: string;
    body: string;
    thread_id?: string;
    is_group?: boolean;
  };
}

app.post("/webhook/mmp", async (req, res) => {
  const rawBody = JSON.stringify(req.body);
  if (!verifyWebhook(rawBody, (req.headers["x-mmp-signature"] ?? req.headers["x-webhook-signature"]) as string | undefined)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body as MmpWebhookPayload;

  try {
    // Handle structured tool_call messages (Agent Protocol)
    if (payload.content_type === "tool_call" && payload.message) {
      const msg = payload.message;
      try {
        const { tool, call_id, input } = JSON.parse(msg.body);
        await handleToolCall(msg.from_handle, msg.from, call_id, tool, input || {});
      } catch (err) {
        console.error("Tool call error:", err);
        // Try to send error result if we have a call_id
        if (payload.call_id) {
          await mmpClient.callTool("mmp-send", {
            to: `@${msg.from_handle}`,
            body: JSON.stringify({ call_id: payload.call_id, output: null, error: (err as Error).message }),
            content_type: "tool_result",
            call_id: payload.call_id,
          }).catch(() => {});
        }
      }
      res.json({ ok: true });
      return;
    }

    if (payload.event === "message" && payload.message) {
      const msg = payload.message;
      if (msg.is_group) {
        await handleGroupMessage(msg);
      } else {
        await handleDM(msg);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Send helpers ---

async function sendDM(handle: string, body: string): Promise<void> {
  try {
    await mmpClient.callTool("mmp-send", { to: `@${handle}`, body });
  } catch (err) {
    console.error(`Failed to send DM to @${handle}:`, err);
  }
}

async function sendGroup(threadId: string, body: string): Promise<void> {
  try {
    await mmpClient.callTool("mmp-send", { thread_id: threadId, body });
  } catch (err) {
    console.error(`Failed to send to group ${threadId}:`, err);
  }
}

// --- Supported cities ---

const SUPPORTED_CITIES = [
  "nyc", "chicago", "orlando", "boston", "miami", "charlotte", "denver",
  "dallas", "raleigh", "baltimore", "dc", "atlanta", "sandiego", "detroit",
  "pittsburgh", "milwaukee", "sacramento", "neworleans", "sanfrancisco",
  "detroit_etims", "cleveland", "columbus", "oakland", "santamonica",
];

function isValidCity(city: string): boolean {
  return SUPPORTED_CITIES.includes(city.toLowerCase());
}

// --- Structured tool_call handler (Agent Protocol) ---

async function handleToolCall(
  fromHandle: string,
  fromId: string,
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<void> {
  upsertUser(fromId, fromHandle);

  let output: Record<string, unknown> = {};
  let error: string | null = null;

  try {
    switch (toolName) {
      case "add_plate": {
        const { plate, state, city } = input as { plate: string; state: string; city: string };
        if (!plate || !state || !city) { error = "Missing required fields: plate, state, city"; break; }
        if (!isValidCity(city)) { error = `Unsupported city "${city}". Supported: ${SUPPORTED_CITIES.join(", ")}`; break; }
        addUserPlate(fromId, plate, state, "PAS", city);
        try {
          await tfClient.callTool("manage_plates", { action: "add", number: plate.toUpperCase(), state: state.toUpperCase(), type: "PAS", city: city.toLowerCase() });
        } catch { /* best effort */ }
        output = { success: true, plate: plate.toUpperCase(), state: state.toUpperCase(), city };
        break;
      }
      case "remove_plate": {
        const { plate, city } = input as { plate: string; city: string };
        if (!plate || !city) { error = "Missing required fields: plate, city"; break; }
        const removed = removeUserPlate(fromId, plate, city);
        if (removed) {
          try { await tfClient.callTool("manage_plates", { action: "remove", number: plate.toUpperCase(), city: city.toLowerCase() }); } catch { /* ignore */ }
          output = { success: true, removed: true };
        } else {
          output = { success: false, removed: false, message: `Plate ${plate.toUpperCase()} (${city}) not found` };
        }
        break;
      }
      case "list_plates": {
        const plates = getUserPlates(fromId);
        output = { plates: plates.map(p => ({ plate: p.plate_number, state: p.state, city: p.city })) };
        break;
      }
      case "check_tickets": {
        const plates = getUserPlates(fromId);
        if (plates.length === 0) { output = { error: "No plates registered" }; break; }
        const { newCount, errors } = await runTicketCheck(mmpClient, tfClient);
        output = { new_tickets: newCount, errors };
        break;
      }
      case "list_tickets": {
        const tickets = getUserTickets(fromId);
        output = { tickets: tickets.map(t => ({ violation_number: t.violation_number, city: t.city, amount: t.amount, description: t.description })) };
        break;
      }
      case "analyze_ticket": {
        const { violation_number, city } = input as { violation_number: string; city: string };
        if (!violation_number || !city) { error = "Missing required fields: violation_number, city"; break; }
        if (!isValidCity(city)) { error = `Unsupported city "${city}"`; break; }
        const analysis = await tfClient.call<Record<string, unknown>>("analyze_ticket", { violation_number, city: city.toLowerCase() });
        output = analysis;
        break;
      }
      case "generate_dispute": {
        const { violation_number, city } = input as { violation_number: string; city: string };
        if (!violation_number || !city) { error = "Missing required fields: violation_number, city"; break; }
        if (!isValidCity(city)) { error = `Unsupported city "${city}"`; break; }
        const analysis = await tfClient.call<Record<string, unknown>>("analyze_ticket", { violation_number, city: city.toLowerCase() });
        const defenses = analysis.commonDefenses as string[] | undefined;
        const details = analysis.ticketDetails as Record<string, unknown> | undefined;
        let disputeArgs = `I am disputing violation ${violation_number}.`;
        if (defenses?.length) disputeArgs += ` ${defenses.join(". ")}`;
        const preview = await tfClient.call<Record<string, unknown>>("generate_dispute", { violation_number, city: city.toLowerCase(), arguments: disputeArgs });
        output = { ...preview, arguments: disputeArgs };
        break;
      }
      case "submit_dispute": {
        const { violation_number, city } = input as { violation_number: string; city: string };
        if (!violation_number || !city) { error = "Missing required fields: violation_number, city"; break; }
        if (!isValidCity(city)) { error = `Unsupported city "${city}"`; break; }
        const analysis = await tfClient.call<Record<string, unknown>>("analyze_ticket", { violation_number, city: city.toLowerCase() });
        const defenses = analysis.commonDefenses as string[] | undefined;
        let disputeArgs = `I am disputing violation ${violation_number}.`;
        if (defenses?.length) disputeArgs += ` ${defenses.join(". ")}`;
        const result = await tfClient.call<Record<string, unknown>>("submit_dispute", { violation_number, city: city.toLowerCase(), arguments: disputeArgs, confirmed: true });
        output = result;
        break;
      }
      case "check_status": {
        const { violation_number, city } = input as { violation_number: string; city: string };
        if (!violation_number || !city) { error = "Missing required fields: violation_number, city"; break; }
        const status = await tfClient.call<Record<string, unknown>>("check_status", { violation_number, city: city.toLowerCase() });
        output = status;
        break;
      }
      default:
        error = `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    error = (err as Error).message;
  }

  // Send tool_result back
  await mmpClient.callTool("mmp-send", {
    to: `@${fromHandle}`,
    body: JSON.stringify({ call_id: callId, output: output!, error }),
    content_type: "tool_result",
    call_id: callId,
  });
}

// --- DM handler ---

async function handleDM(msg: MmpWebhookPayload["message"] & {}): Promise<void> {
  const raw = msg.body.trim();
  const body = raw.toLowerCase();
  const fromId = msg.from;
  const fromHandle = msg.from_handle;

  // Ensure user exists
  upsertUser(fromId, fromHandle);

  // --- gmail / setup gmail ---
  if (body === "gmail" || body === "setup gmail" || body === "connect gmail") {
    try {
      const result = await tfClient.callTool("setup_gmail", {});
      const text = result.content?.[0]?.text ?? "";
      await sendDM(fromHandle, text);
    } catch (err) {
      await sendDM(fromHandle, `Error setting up Gmail: ${(err as Error).message}`);
    }
    return;
  }

  // --- add <plate> <state> <city> ---
  if (body.startsWith("add ")) {
    const parts = raw.replace(/^add\s+/i, "").trim().split(/\s+/);
    if (parts.length < 3) {
      await sendDM(fromHandle, `Usage: add <plate> <state> <city>\nExample: add ABC1234 NY nyc\n\nSupported cities: ${SUPPORTED_CITIES.join(", ")}`);
      return;
    }
    const [plateNum, state, city] = parts;
    if (!isValidCity(city)) {
      await sendDM(fromHandle, `Unsupported city "${city}". Supported: ${SUPPORTED_CITIES.join(", ")}`);
      return;
    }

    addUserPlate(fromId, plateNum, state, "PAS", city);

    // Also register with ticket-fighter
    try {
      await tfClient.callTool("manage_plates", {
        action: "add",
        number: plateNum.toUpperCase(),
        state: state.toUpperCase(),
        type: "PAS",
        city: city.toLowerCase(),
      });
    } catch (err) {
      console.error("Failed to register plate with ticket-fighter:", err);
    }

    await sendDM(fromHandle,
      `Added ${plateNum.toUpperCase()} (${state.toUpperCase()}, ${city}).\n` +
      `I'll check for tickets periodically and alert you when new ones appear.\n` +
      `Reply "check" to scan now.`);
    return;
  }

  // --- remove <plate> <city> ---
  if (body.startsWith("remove ") || body.startsWith("delete ")) {
    const parts = raw.replace(/^(remove|delete)\s+/i, "").trim().split(/\s+/);
    if (parts.length < 2) {
      await sendDM(fromHandle, `Usage: remove <plate> <city>\nExample: remove ABC1234 nyc`);
      return;
    }
    const [plateNum, city] = parts;
    const removed = removeUserPlate(fromId, plateNum, city);

    if (removed) {
      try {
        await tfClient.callTool("manage_plates", { action: "remove", number: plateNum.toUpperCase(), city: city.toLowerCase() });
      } catch { /* ignore */ }
      await sendDM(fromHandle, `Removed ${plateNum.toUpperCase()} (${city}).`);
    } else {
      await sendDM(fromHandle, `Plate ${plateNum.toUpperCase()} (${city}) not found in your plates.`);
    }
    return;
  }

  // --- plates / list / my plates ---
  if (body === "plates" || body === "list" || body === "my plates") {
    const plates = getUserPlates(fromId);
    if (plates.length === 0) {
      await sendDM(fromHandle, `No plates registered. Add one with:\nadd <plate> <state> <city>\nExample: add ABC1234 NY nyc`);
      return;
    }
    const lines = plates.map((p) => `  ${p.plate_number} — ${p.state}, ${p.city}`);
    await sendDM(fromHandle, `Your plates:\n${lines.join("\n")}`);
    return;
  }

  // --- check / check tickets ---
  if (body === "check" || body === "check tickets" || body === "scan") {
    const plates = getUserPlates(fromId);
    if (plates.length === 0) {
      await sendDM(fromHandle, `No plates to check. Add one first with: add <plate> <state> <city>`);
      return;
    }

    await sendDM(fromHandle, `Scanning ${plates.length} plate(s)... this may take a moment.`);

    try {
      const { newCount, errors } = await runTicketCheck(mmpClient, tfClient);
      if (newCount === 0 && errors.length === 0) {
        await sendDM(fromHandle, `No new tickets found. You're in the clear!`);
      } else if (newCount > 0) {
        // Notifications already sent by runTicketCheck
        await sendDM(fromHandle, `Scan complete. Found ${newCount} new ticket(s) — check your messages.`);
      }
      if (errors.length > 0) {
        await sendDM(fromHandle, `Some checks had errors:\n${errors.map((e) => `  ${e}`).join("\n")}`);
      }
    } catch (err) {
      await sendDM(fromHandle, `Error checking tickets: ${(err as Error).message}`);
    }
    return;
  }

  // --- tickets / my tickets ---
  if (body === "tickets" || body === "my tickets") {
    const tickets = getUserTickets(fromId);
    if (tickets.length === 0) {
      await sendDM(fromHandle, `No known tickets. Run "check" to scan, or "add" a plate first.`);
      return;
    }
    const lines = tickets.slice(0, 10).map((t) => {
      const amt = t.amount ? ` — $${t.amount}` : "";
      return `  ${t.violation_number} (${t.city})${amt}${t.description ? `: ${t.description}` : ""}`;
    });
    const more = tickets.length > 10 ? `\n  ... and ${tickets.length - 10} more` : "";
    await sendDM(fromHandle, `Your tickets:\n${lines.join("\n")}${more}\n\nReply "analyze <violation#> <city>" for defense strategy.`);
    return;
  }

  // --- analyze <violation#> <city> ---
  if (body.startsWith("analyze ") || body.startsWith("fight ")) {
    const parts = raw.replace(/^(analyze|fight)\s+/i, "").trim().split(/\s+/);
    if (parts.length < 2) {
      await sendDM(fromHandle, `Usage: analyze <violation#> <city>\nExample: analyze 1234567890 nyc`);
      return;
    }
    const [violationNum, city] = parts;
    if (!isValidCity(city)) {
      await sendDM(fromHandle, `Unsupported city "${city}". Supported: ${SUPPORTED_CITIES.join(", ")}`);
      return;
    }

    await sendDM(fromHandle, `Analyzing ticket ${violationNum}... gathering evidence and defense strategy.`);

    try {
      const analysis = await tfClient.call<Record<string, unknown>>("analyze_ticket", {
        violation_number: violationNum,
        city: city.toLowerCase(),
      });

      const lines: string[] = [`Ticket Analysis — ${violationNum} (${city.toUpperCase()})`, ""];

      // Ticket details
      const details = analysis.ticketDetails as Record<string, unknown> | undefined;
      if (details) {
        if (details.violationCode) lines.push(`Violation: ${details.violationCode} — ${details.description || ""}`);
        if (details.amount) lines.push(`Amount: $${details.amount}`);
        if (details.location) lines.push(`Location: ${details.location}`);
        if (details.dateIssued) lines.push(`Date: ${details.dateIssued}`);
        lines.push("");
      }

      // Common defenses
      const defenses = analysis.commonDefenses as string[] | undefined;
      if (defenses && defenses.length > 0) {
        lines.push("Common defenses:");
        for (const d of defenses.slice(0, 5)) {
          lines.push(`  • ${d}`);
        }
        lines.push("");
      }

      // Evidence
      const evidence = analysis.evidence as Record<string, unknown> | undefined;
      if (evidence) {
        if (evidence.streetViewPaths) lines.push(`Street View imagery gathered.`);
        if (evidence.ruleText) lines.push(`Traffic rule text retrieved.`);
        lines.push("");
      }

      // Past disputes
      if (analysis.pastDisputes && typeof analysis.pastDisputes === "object") {
        const past = analysis.pastDisputes as Array<Record<string, unknown>>;
        if (past.length > 0) {
          lines.push(`Past disputes for this code: ${past.length} on file.`);
          lines.push("");
        }
      }

      lines.push(`Reply "dispute ${violationNum} ${city}" to generate dispute arguments.`);

      await sendDM(fromHandle, lines.join("\n"));
    } catch (err) {
      await sendDM(fromHandle, `Error analyzing ticket: ${(err as Error).message}`);
    }
    return;
  }

  // --- dispute <violation#> <city> ---
  if (body.startsWith("dispute ")) {
    const parts = raw.replace(/^dispute\s+/i, "").trim().split(/\s+/);
    if (parts.length < 2) {
      await sendDM(fromHandle, `Usage: dispute <violation#> <city>\nExample: dispute 1234567890 nyc`);
      return;
    }
    const [violationNum, city] = parts;
    if (!isValidCity(city)) {
      await sendDM(fromHandle, `Unsupported city "${city}". Supported: ${SUPPORTED_CITIES.join(", ")}`);
      return;
    }

    await sendDM(fromHandle, `Generating dispute for ticket ${violationNum}...`);

    try {
      // First analyze to get context
      const analysis = await tfClient.call<Record<string, unknown>>("analyze_ticket", {
        violation_number: violationNum,
        city: city.toLowerCase(),
      });

      // Build dispute arguments from the analysis
      const details = analysis.ticketDetails as Record<string, unknown> | undefined;
      const defenses = analysis.commonDefenses as string[] | undefined;

      let disputeArgs = `I am disputing violation ${violationNum}.`;
      if (defenses && defenses.length > 0) {
        disputeArgs += ` ${defenses[0]}`;
      }
      if (details?.description) {
        disputeArgs += ` The citation for "${details.description}" is being contested on the following grounds: `;
        disputeArgs += (defenses || []).join(". ");
      }

      // Generate formatted dispute
      const preview = await tfClient.call<Record<string, unknown>>("generate_dispute", {
        violation_number: violationNum,
        city: city.toLowerCase(),
        arguments: disputeArgs,
      });

      const lines = [
        `Dispute Preview — ${violationNum} (${city.toUpperCase()})`,
        "",
        `Arguments:`,
        disputeArgs,
        "",
        preview.form_notes ? `Notes: ${preview.form_notes}` : "",
        "",
        `Status: ${preview.status}`,
        "",
        `To submit this dispute, reply:`,
        `  submit ${violationNum} ${city}`,
        ``,
        `This will submit the dispute to the ${city.toUpperCase()} violations portal.`,
      ].filter(Boolean);

      await sendDM(fromHandle, lines.join("\n"));
    } catch (err) {
      await sendDM(fromHandle, `Error generating dispute: ${(err as Error).message}`);
    }
    return;
  }

  // --- submit <violation#> <city> ---
  if (body.startsWith("submit ")) {
    const parts = raw.replace(/^submit\s+/i, "").trim().split(/\s+/);
    if (parts.length < 2) {
      await sendDM(fromHandle, `Usage: submit <violation#> <city>`);
      return;
    }
    const [violationNum, city] = parts;
    if (!isValidCity(city)) {
      await sendDM(fromHandle, `Unsupported city. Supported: ${SUPPORTED_CITIES.join(", ")}`);
      return;
    }

    await sendDM(fromHandle,
      `Are you sure you want to submit the dispute for ${violationNum} (${city.toUpperCase()})?\n` +
      `Reply "confirm ${violationNum} ${city}" to proceed.`);
    return;
  }

  // --- confirm <violation#> <city> ---
  if (body.startsWith("confirm ")) {
    const parts = raw.replace(/^confirm\s+/i, "").trim().split(/\s+/);
    if (parts.length < 2) {
      await sendDM(fromHandle, `Usage: confirm <violation#> <city>`);
      return;
    }
    const [violationNum, city] = parts;

    await sendDM(fromHandle, `Submitting dispute for ${violationNum}... this may take a minute.`);

    try {
      // Re-analyze and generate arguments
      const analysis = await tfClient.call<Record<string, unknown>>("analyze_ticket", {
        violation_number: violationNum,
        city: city.toLowerCase(),
      });
      const defenses = analysis.commonDefenses as string[] | undefined;
      const details = analysis.ticketDetails as Record<string, unknown> | undefined;

      let disputeArgs = `I am disputing violation ${violationNum}.`;
      if (defenses && defenses.length > 0) {
        disputeArgs += ` ${defenses.join(". ")}`;
      }

      const result = await tfClient.call<Record<string, unknown>>("submit_dispute", {
        violation_number: violationNum,
        city: city.toLowerCase(),
        arguments: disputeArgs,
        confirmed: true,
      });

      await sendDM(fromHandle,
        `Dispute submitted for ${violationNum}!\n` +
        (result.referenceNumber ? `Reference: ${result.referenceNumber}\n` : "") +
        `\nReply "status ${violationNum} ${city}" to check the outcome later.`);
    } catch (err) {
      await sendDM(fromHandle, `Error submitting dispute: ${(err as Error).message}`);
    }
    return;
  }

  // --- status <violation#> <city> ---
  if (body.startsWith("status ")) {
    const parts = raw.replace(/^status\s+/i, "").trim().split(/\s+/);
    if (parts.length < 2) {
      await sendDM(fromHandle, `Usage: status <violation#> <city>\nExample: status 1234567890 nyc`);
      return;
    }
    const [violationNum, city] = parts;

    try {
      const status = await tfClient.call<Record<string, unknown>>("check_status", {
        violation_number: violationNum,
        city: city.toLowerCase(),
      });

      const lines = [
        `Status — ${violationNum} (${city.toUpperCase()})`,
        status.disposition ? `  Disposition: ${status.disposition}` : null,
        status.status ? `  Status: ${status.status}` : null,
        status.amount_due ? `  Amount due: $${status.amount_due}` : null,
        status.hearing_date ? `  Hearing: ${status.hearing_date}` : null,
      ].filter(Boolean);

      await sendDM(fromHandle, lines.join("\n") || `No status information available for ${violationNum}.`);
    } catch (err) {
      await sendDM(fromHandle, `Error checking status: ${(err as Error).message}`);
    }
    return;
  }

  // --- help / default ---
  await sendDM(fromHandle,
    `Ticket Fighter Bot — Commands:\n` +
    `\n` +
    `  add <plate> <state> <city> — Monitor a plate\n` +
    `    Example: add ABC1234 NY nyc\n` +
    `  remove <plate> <city> — Stop monitoring\n` +
    `  plates — List your plates\n` +
    `  check — Scan for new tickets now\n` +
    `  tickets — Show known tickets\n` +
    `  analyze <violation#> <city> — Evidence & defense strategy\n` +
    `  dispute <violation#> <city> — Generate dispute\n` +
    `  submit <violation#> <city> — Submit dispute\n` +
    `  status <violation#> <city> — Check dispute outcome\n` +
    `  gmail — Connect Gmail for decision tracking\n` +
    `  help — Show this message\n` +
    `\n` +
    `Supported cities: ${SUPPORTED_CITIES.join(", ")}\n` +
    `\n` +
    `I check for new tickets every 30 minutes and alert you automatically.`);
}

// --- Group message handler ---

async function handleGroupMessage(msg: MmpWebhookPayload["message"] & {}): Promise<void> {
  const body = msg.body.trim().toLowerCase();
  const threadId = msg.thread_id;
  if (!threadId) return;

  if (body === "help") {
    await sendGroup(threadId,
      `Ticket Fighter Bot — DM me to get started!\n` +
      `Send me "add <plate> <state> <city>" to monitor your plates.`);
  }
}

// --- Periodic ticket checking ---

// Every 30 minutes
cron.schedule("*/30 * * * *", async () => {
  console.log("[cron] Running periodic ticket check...");
  try {
    const { newCount, errors } = await runTicketCheck(mmpClient, tfClient);
    console.log(`[cron] Check complete: ${newCount} new tickets, ${errors.length} errors`);
  } catch (err) {
    console.error("[cron] Ticket check failed:", err);
  }
});

// --- Inbox polling fallback ---

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
let lastSeenMessageId: string | null = getState("lastSeenMessageId");

async function pollInbox(): Promise<void> {
  try {
    const inbox = await mmpClient.call<{
      messages: Array<{
        id: string;
        thread_id: string;
        thread_type?: string;
        from_handle: string;
        body: string;
        content_type?: string;
        call_id?: string;
      }>;
    }>("mmp-inbox", {});

    for (const msg of inbox.messages || []) {
      if (msg.from_handle === "ticket_fighter") continue;
      if (msg.id === lastSeenMessageId) break;

      if (!lastSeenMessageId) {
        lastSeenMessageId = msg.id;
        setState("lastSeenMessageId", msg.id);
        console.log(`[poll] Initial sync — latest from @${msg.from_handle}`);
        break;
      }

      lastSeenMessageId = msg.id;
      setState("lastSeenMessageId", msg.id);
      console.log(`[poll] New message from @${msg.from_handle}: ${msg.body.slice(0, 80)}`);

      // Handle tool_call messages from polling
      if (msg.content_type === "tool_call") {
        try {
          const { tool, call_id, input } = JSON.parse(msg.body);
          await handleToolCall(msg.from_handle, `user:${msg.from_handle}`, call_id, tool, input || {});
        } catch (err) {
          console.error("[poll] Tool call error:", err);
        }
        continue;
      }

      const isDM = msg.thread_type === "dm" || !msg.thread_type;
      if (isDM) {
        await handleDM({
          id: msg.id,
          from: `user:${msg.from_handle}`,
          from_handle: msg.from_handle,
          body: msg.body,
          is_group: false,
          thread_id: msg.thread_id,
        });
      } else {
        await handleGroupMessage({
          id: msg.id,
          from: `user:${msg.from_handle}`,
          from_handle: msg.from_handle,
          body: msg.body,
          is_group: true,
          thread_id: msg.thread_id,
        });
      }
    }
  } catch (err) {
    console.error("[poll] Error:", (err as Error).message);
  }
}

// --- Start ---

app.listen(PORT, async () => {
  console.log(`ticket-fighter-bot listening on :${PORT}`);

  // Connect to ticket-fighter subprocess
  try {
    await tfClient.connect();
    console.log("ticket-fighter MCP client connected");
  } catch (err) {
    console.error("Failed to connect to ticket-fighter:", err);
  }

  // Advertise agent protocol capabilities
  try {
    await mmpClient.callTool("mmp-set_profile", {
      type: "bot",
      capabilities: JSON.stringify([
        { name: "add_plate", description: "Monitor a license plate for parking tickets", input_schema: { plate: { type: "string", required: true }, state: { type: "string", required: true }, city: { type: "string", required: true } } },
        { name: "remove_plate", description: "Stop monitoring a license plate", input_schema: { plate: { type: "string", required: true }, city: { type: "string", required: true } } },
        { name: "list_plates", description: "List all monitored license plates" },
        { name: "check_tickets", description: "Scan all monitored plates for new tickets now" },
        { name: "list_tickets", description: "Show all known parking tickets" },
        { name: "analyze_ticket", description: "Get evidence and defense strategy for a ticket", input_schema: { violation_number: { type: "string", required: true }, city: { type: "string", required: true } } },
        { name: "generate_dispute", description: "Generate a dispute letter for a ticket", input_schema: { violation_number: { type: "string", required: true }, city: { type: "string", required: true } } },
        { name: "submit_dispute", description: "Submit a dispute to the violations portal", input_schema: { violation_number: { type: "string", required: true }, city: { type: "string", required: true } } },
        { name: "check_status", description: "Check the status/outcome of a ticket or dispute", input_schema: { violation_number: { type: "string", required: true }, city: { type: "string", required: true } } },
      ]),
    });
    console.log("Agent protocol capabilities advertised");
  } catch (err) {
    console.error("Failed to set bot profile:", err);
  }

  console.log(`Polling MMP inbox every ${POLL_INTERVAL / 1000}s`);
  setInterval(pollInbox, POLL_INTERVAL);
  setTimeout(pollInbox, 5000);
});

export { mmpClient, tfClient, app };
