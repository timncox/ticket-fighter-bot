import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "tf-bot.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      mmp_user_id TEXT PRIMARY KEY,
      mmp_handle TEXT NOT NULL,
      joined_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mmp_user_id TEXT NOT NULL,
      plate_number TEXT NOT NULL,
      state TEXT NOT NULL,
      plate_type TEXT NOT NULL DEFAULT 'PAS',
      city TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      UNIQUE(mmp_user_id, plate_number, city),
      FOREIGN KEY (mmp_user_id) REFERENCES users(mmp_user_id)
    );

    CREATE TABLE IF NOT EXISTS known_tickets (
      violation_number TEXT NOT NULL,
      city TEXT NOT NULL,
      plate_number TEXT NOT NULL,
      amount REAL,
      description TEXT,
      location TEXT,
      date_issued TEXT,
      first_seen INTEGER NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (violation_number, city)
    );
  `);

  return db;
}

// --- Users ---

export interface User {
  mmp_user_id: string;
  mmp_handle: string;
  joined_at: number;
}

export function upsertUser(userId: string, handle: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO users (mmp_user_id, mmp_handle, joined_at)
    VALUES (?, ?, ?)
  `).run(userId, handle, Math.floor(Date.now() / 1000));
}

export function getUser(userId: string): User | null {
  return getDb().prepare("SELECT * FROM users WHERE mmp_user_id = ?").get(userId) as User | null;
}

// --- Plates ---

export interface Plate {
  id: number;
  mmp_user_id: string;
  plate_number: string;
  state: string;
  plate_type: string;
  city: string;
  added_at: number;
}

export function addUserPlate(userId: string, plateNumber: string, state: string, plateType: string, city: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO plates (mmp_user_id, plate_number, state, plate_type, city, added_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, plateNumber.toUpperCase(), state.toUpperCase(), plateType.toUpperCase(), city.toLowerCase(), Math.floor(Date.now() / 1000));
}

export function removeUserPlate(userId: string, plateNumber: string, city: string): boolean {
  const result = getDb().prepare(
    "DELETE FROM plates WHERE mmp_user_id = ? AND plate_number = ? AND city = ?",
  ).run(userId, plateNumber.toUpperCase(), city.toLowerCase());
  return result.changes > 0;
}

export function getUserPlates(userId: string): Plate[] {
  return getDb().prepare("SELECT * FROM plates WHERE mmp_user_id = ?").all(userId) as Plate[];
}

export function getAllPlates(): Plate[] {
  return getDb().prepare("SELECT * FROM plates").all() as Plate[];
}

export function getPlateOwners(plateNumber: string, city: string): Plate[] {
  return getDb().prepare(
    "SELECT * FROM plates WHERE plate_number = ? AND city = ?",
  ).all(plateNumber.toUpperCase(), city.toLowerCase()) as Plate[];
}

// --- Known tickets ---

export interface KnownTicket {
  violation_number: string;
  city: string;
  plate_number: string;
  amount: number | null;
  description: string | null;
  location: string | null;
  date_issued: string | null;
  first_seen: number;
  notified: number;
  dismissed: number;
}

export function upsertKnownTicket(t: Omit<KnownTicket, "first_seen" | "notified" | "dismissed">): boolean {
  const existing = getDb().prepare(
    "SELECT 1 FROM known_tickets WHERE violation_number = ? AND city = ?",
  ).get(t.violation_number, t.city);

  if (existing) return false; // already known

  getDb().prepare(`
    INSERT INTO known_tickets (violation_number, city, plate_number, amount, description, location, date_issued, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.violation_number, t.city, t.plate_number, t.amount, t.description, t.location, t.date_issued, Math.floor(Date.now() / 1000));
  return true; // new ticket
}

export function markNotified(violationNumber: string, city: string): void {
  getDb().prepare(
    "UPDATE known_tickets SET notified = 1 WHERE violation_number = ? AND city = ?",
  ).run(violationNumber, city);
}

export function getUnnotifiedTickets(): KnownTicket[] {
  return getDb().prepare("SELECT * FROM known_tickets WHERE notified = 0").all() as KnownTicket[];
}

export function getUserTickets(userId: string): KnownTicket[] {
  const plates = getUserPlates(userId);
  if (plates.length === 0) return [];
  const placeholders = plates.map(() => "(?, ?)").join(", ");
  const params = plates.flatMap((p) => [p.plate_number, p.city]);
  return getDb().prepare(
    `SELECT * FROM known_tickets WHERE (plate_number, city) IN (VALUES ${placeholders}) ORDER BY first_seen DESC`,
  ).all(...params) as KnownTicket[];
}
