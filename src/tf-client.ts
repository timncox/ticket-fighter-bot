/**
 * Stdio MCP client for the ticket-fighter subprocess.
 * Spawns ticket-fighter as a child process and communicates
 * via JSON-RPC over stdin/stdout.
 */

import { spawn, type ChildProcess } from "node:child_process";

const TIMEOUT = 120_000; // 2 min — scraping can be slow

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class TfClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private initialized = false;

  constructor(
    private command: string,
    private args: string[],
  ) {}

  async connect(): Promise<void> {
    if (this.initialized) return;

    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.setEncoding("utf-8");
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr!.setEncoding("utf-8");
    this.proc.stderr!.on("data", (data: string) => {
      // Only log non-empty lines
      for (const line of data.split("\n")) {
        if (line.trim()) console.error(`[tf] ${line}`);
      }
    });

    this.proc.on("exit", (code) => {
      console.error(`[tf] Process exited with code ${code}`);
      this.initialized = false;
      this.proc = null;
      // Reject all pending requests
      for (const [id, { reject }] of this.pending) {
        reject(new Error("ticket-fighter process exited"));
        this.pending.delete(id);
      }
    });

    // Initialize MCP session
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "ticket-fighter-bot", version: "1.0.0" },
    });

    // Send initialized notification (no id = notification)
    this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    this.initialized = true;
    console.log("[tf] Connected to ticket-fighter MCP server");
  }

  private send(msg: object): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error("ticket-fighter process not running");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (${TIMEOUT}ms)`));
      }, TIMEOUT);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      try {
        this.send({ jsonrpc: "2.0", method, params: params ?? {}, id });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.id != null && this.pending.has(data.id)) {
          const { resolve, reject } = this.pending.get(data.id)!;
          this.pending.delete(data.id);
          if (data.error) {
            reject(new Error(data.error.message ?? "MCP error"));
          } else {
            resolve(data.result);
          }
        }
      } catch {
        // Ignore non-JSON lines (e.g., debug output)
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    if (!this.initialized) await this.connect();
    return (await this.request("tools/call", { name, arguments: args })) as McpToolResult;
  }

  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callTool(name, args);
    if (result.isError) {
      throw new Error(result.content?.[0]?.text ?? "Tool error");
    }
    const text = result.content?.[0]?.text ?? "{}";
    return JSON.parse(text) as T;
  }

  async disconnect(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.initialized = false;
    }
  }
}
