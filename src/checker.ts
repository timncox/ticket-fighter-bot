/**
 * Periodic ticket checker.
 * Calls ticket-fighter check_tickets, detects new violations,
 * and notifies plate owners via MMP DM.
 */

import { McpClient } from "./mmp-client.js";
import { TfClient } from "./tf-client.js";
import {
  getAllPlates,
  getPlateOwners,
  getUser,
  upsertKnownTicket,
  getUnnotifiedTickets,
  markNotified,
} from "./db.js";

interface Ticket {
  violationNumber: string;
  violation_number?: string;
  city: string;
  plate?: string;
  plateNumber?: string;
  plate_number?: string;
  amount?: number;
  description?: string;
  location?: string;
  dateIssued?: string;
  date_issued?: string;
}

interface CheckResult {
  tickets: Ticket[];
  errors?: string[];
  checked?: string[];
}

/**
 * Run a full ticket check cycle:
 * 1. Call ticket-fighter check_tickets
 * 2. Store new tickets in DB
 * 3. DM owners about new tickets
 */
export async function runTicketCheck(
  mmpClient: McpClient,
  tfClient: TfClient,
): Promise<{ newCount: number; errors: string[] }> {
  const plates = getAllPlates();
  if (plates.length === 0) {
    return { newCount: 0, errors: [] };
  }

  let newCount = 0;
  const errors: string[] = [];

  // Check each plate individually to map results to owners
  for (const plate of plates) {
    try {
      const result = await tfClient.call<CheckResult>("check_tickets", {
        plate: plate.plate_number,
        city: plate.city,
      });

      for (const ticket of result.tickets || []) {
        const vNum = ticket.violationNumber || ticket.violation_number || "";
        const isNew = upsertKnownTicket({
          violation_number: vNum,
          city: ticket.city || plate.city,
          plate_number: plate.plate_number,
          amount: ticket.amount ?? null,
          description: ticket.description ?? null,
          location: ticket.location ?? null,
          date_issued: ticket.dateIssued || ticket.date_issued || null,
        });
        if (isNew) newCount++;
      }

      if (result.errors) {
        errors.push(...result.errors);
      }
    } catch (err) {
      errors.push(`${plate.city}/${plate.plate_number}: ${(err as Error).message}`);
    }
  }

  // Notify owners of unnotified tickets
  const unnotified = getUnnotifiedTickets();
  for (const ticket of unnotified) {
    const owners = getPlateOwners(ticket.plate_number, ticket.city);
    for (const owner of owners) {
      const user = getUser(owner.mmp_user_id);
      if (!user) continue;
      try {
        const lines = [
          `New ticket found for ${ticket.plate_number} (${ticket.city.toUpperCase()})`,
          ticket.violation_number ? `  Violation: ${ticket.violation_number}` : null,
          ticket.amount ? `  Amount: $${ticket.amount}` : null,
          ticket.description ? `  ${ticket.description}` : null,
          ticket.location ? `  Location: ${ticket.location}` : null,
          ticket.date_issued ? `  Issued: ${ticket.date_issued}` : null,
          ``,
          `Reply "analyze ${ticket.violation_number} ${ticket.city}" for defense strategy.`,
        ].filter(Boolean).join("\n");

        await mmpClient.callTool("mmp-send", { to: `@${user.mmp_handle}`, body: lines });
      } catch (err) {
        console.error(`Failed to notify @${user.mmp_handle}:`, err);
      }
    }
    markNotified(ticket.violation_number, ticket.city);
  }

  return { newCount, errors };
}
