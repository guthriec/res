import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import { ChannelControllerImpl } from "./channel-controller";
import { ChangeDetector } from "./change-detector";
import { ContentIdAllocator } from "./content-id-allocator";
import { VersionStore, type VersionSidecar, type ContentVersion } from "./version-store";
import { UnsafeAutoMerge, type MergeStrategy } from "./merge-strategy";
import { Logger } from "./logger";
import { RelativePathHelper } from "./relative-path-helper";
import type {
  PublishRequest,
  PublishResponse,
  SyncContentResponse,
  SyncContentItem,
  ContentUpdatedEvent,
  ContentDeletedEvent,
} from "./sync-protocol";

const PUBLISH_TICK_MS = 10_000;
const SSE_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export type SyncClientStatus =
  | { state: "starting" }
  | { state: "connected"; sseConnected: boolean }
  | { state: "reconnecting"; attempt: number; delayMs: number }
  | { state: "error"; message: string; context: "initial-pull" | "sse" | "publish" };

export interface SyncClientSubscription {
  serverUrl: string;
  serverChannelId: string;
  localChannelId: string;
  /** Optional shared secret sent as Authorization: Bearer <secret> header. */
  secret?: string;
  /** When true, deletions propagate both ways (destructive — opt-in). */
  syncDeletions?: boolean;
  /** Called when the client's connection status changes. */
  onStatusChange?: (status: SyncClientStatus) => void;
}

export class SyncClient {
  private readonly reservoirDir: string;
  private readonly subscription: SyncClientSubscription;
  private readonly channelController: ChannelControllerImpl;
  private readonly idAllocator: ContentIdAllocator;
  private readonly versionStore: VersionStore;
  private readonly changeDetector: ChangeDetector;
  private readonly mergeStrategy: MergeStrategy;
  private readonly logger: Logger;
  private readonly relativePathHelper: RelativePathHelper;

  private stopRequested = false;
  private publishTimer: ReturnType<typeof setInterval> | undefined;

  constructor(reservoirDir: string, subscription: SyncClientSubscription) {
    this.reservoirDir = path.resolve(reservoirDir);
    this.subscription = subscription;
    this.channelController = new ChannelControllerImpl(this.reservoirDir);
    this.idAllocator = ContentIdAllocator.forReservoir(this.reservoirDir);
    this.versionStore = new VersionStore(this.reservoirDir);
    this.changeDetector = new ChangeDetector(this.reservoirDir);
    this.mergeStrategy = new UnsafeAutoMerge();
    this.logger = Logger.fromEnvironment();
    this.relativePathHelper = new RelativePathHelper(this.reservoirDir);
  }

  async start(): Promise<void> {
    this.stopRequested = false;

    // Ensure local channel exists
    const channels = this.channelController.listChannels();
    const localChannel = channels.find((c) => c.id === this.subscription.localChannelId);
    if (!localChannel) {
      this.logger.info(
        `[sync] local channel "${this.subscription.localChannelId}" not found, skipping subscription`,
      );
      return;
    }

    this.logger.info(
      `[sync] starting sync: ${this.subscription.serverUrl}/${this.subscription.serverChannelId}` +
        ` → ${this.subscription.localChannelId}`,
    );

    // 1. Initial pull
    await this.initialPull();

    // 2. Scan for local changes so they get sidecars before publish loop starts
    this.logger.debug("[sync] scanning local files for changes...");
    await this.changeDetector.scanAll();

    // 3. Start SSE subscription (runs concurrently)
    this.runSseLoop();

    // 4. Start publish loop
    this.logger.debug(`[sync] publish loop every ${PUBLISH_TICK_MS / 1000}s`);
    this.publishTimer = setInterval(() => this.publishIfNeeded(), PUBLISH_TICK_MS);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.publishTimer) {
      clearInterval(this.publishTimer);
      this.publishTimer = undefined;
    }
  }

  /**
   * Trigger an immediate publish cycle. Safe to call frequently — internally
   * debounces via scanAll which skips unchanged files. Designed to be called
   * from Obsidian vault events.
   */
  async triggerPublish(): Promise<void> {
    if (this.stopRequested) return;
    await this.publishIfNeeded();
  }

  // ─── HTTP helper ──────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    if (!this.subscription.secret) return {};
    return { Authorization: `Bearer ${this.subscription.secret}` };
  }

  private async fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
    const headers = { ...this.authHeaders(), ...(options?.headers as Record<string, string> ?? {}) };
    return fetch(url, { ...options, headers });
  }


  // ─── Initial pull ─────────────────────────────────────────────────────────

  private async initialPull(): Promise<void> {
    const pullStart = Date.now();
    const baseUrl = this.subscription.serverUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/api/v1/channels/${this.subscription.serverChannelId}/content`;

    this.emitStatus({ state: "starting" });
    this.logger.debug(`[sync] initial pull from ${url}`);
    try {
      const response = await this.fetchWithAuth(url);
      if (!response.ok) {
        const msg = `${response.status} ${response.statusText}`;
        this.logger.error(`[sync] initial pull failed: ${msg}`);
        this.emitStatus({ state: "error", message: msg, context: "initial-pull" });
        return;
      }

      const data = (await response.json()) as SyncContentResponse;
      this.logger.info(`[sync] initial pull: ${data.items.length} items`);
      for (const item of data.items) {
        this.logger.debug(`[sync] initial pull applying: ${item.filename}`);
        await this.applyServerContent(item);
      }
      if (this.subscription.syncDeletions) {
        const serverFilenames = new Set(data.items.map((i) => i.filename));
        await this.reconcileDeletions(serverFilenames);
      }
      this.logger.info(`[sync] initial pull done: ${data.items.length} items in ${Date.now() - pullStart}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[sync] initial pull error: ${message}`);
      this.emitStatus({ state: "error", message, context: "initial-pull" });
    }
  }

  // ─── SSE loop with auto-reconnect ─────────────────────────────────────────

  private async runSseLoop(): Promise<void> {
    let reconnectDelay = SSE_RECONNECT_DELAY_MS;
    let attempt = 0;

    while (!this.stopRequested) {
      try {
        const baseUrl = this.subscription.serverUrl.replace(/\/+$/, "");
        const url = `${baseUrl}/api/v1/channels/${this.subscription.serverChannelId}/events`;

        this.logger.debug(`[sync] SSE connecting to ${url}`);
        const response = await this.fetchWithAuth(url);
        if (!response.ok) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        this.logger.debug("[sync] SSE connected");
        this.emitStatus({ state: "connected", sseConnected: true });
        reconnectDelay = SSE_RECONNECT_DELAY_MS;
        attempt = 0;

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!this.stopRequested) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = this.parseSseEvents(buffer);
          buffer = events.remaining;

          for (const { event, data } of events.parsed) {
            if (event !== "heartbeat") {
              this.logger.info(`[sync] SSE event: ${event}`);
            }
            await this.handleSseEvent(event, data);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[sync] SSE disconnected: ${message}`);
        this.emitStatus({ state: "error", message, context: "sse" });
      }

      if (this.stopRequested) break;

      attempt++;
      this.emitStatus({ state: "reconnecting", attempt, delayMs: reconnectDelay });
      this.logger.debug(`[sync] SSE reconnecting in ${reconnectDelay}ms`);
      await this.sleep(reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  private parseSseEvents(buffer: string): {
    parsed: Array<{ event: string; data: string }>;
    remaining: string;
  } {
    const parsed: Array<{ event: string; data: string }> = [];
    const lines = buffer.split("\n");
    let currentEvent = "";
    let currentData = "";
    let remaining = "";
    let i = 0;

    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        currentData = line.slice(6).trim();
      } else if (line === "") {
        if (currentEvent && currentData) {
          parsed.push({ event: currentEvent, data: currentData });
        }
        currentEvent = "";
        currentData = "";
      }
    }

    // If the buffer doesn't end with a complete event (trailing newlines), keep it
    if (currentEvent || currentData) {
      remaining = lines.slice(i - (currentEvent || currentData ? 0 : 0)).join("\n");
    }

    return { parsed, remaining };
  }

  private async handleSseEvent(event: string, data: string): Promise<void> {
    if (event === "heartbeat") return;
    if (event === "content-updated") {
      try {
        const eventData = JSON.parse(data) as ContentUpdatedEvent;
        this.logger.info(`[sync] SSE content-updated: ${eventData.filename}`);
        await this.applyServerContent({
          filename: eventData.filename,
          content: eventData.content,
          versionChain: eventData.versionChain,
        });
        this.logger.debug(`[sync] SSE applied: ${eventData.filename}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[sync] content-updated error: ${message}`);
      }
    } else if (event === "content-deleted") {
      if (!this.subscription.syncDeletions) {
        this.logger.debug(`[sync] ignoring content-deleted (syncDeletions disabled): ${data}`);
        return;
      }
      try {
        const eventData = JSON.parse(data) as ContentDeletedEvent;
        this.logger.info(`[sync] SSE content-deleted: ${eventData.filename}`);
        await this.deleteLocalFile(eventData.filename);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[sync] content-deleted error: ${message}`);
      }
    } else {
      this.logger.debug(`[sync] SSE unknown event: ${event}`);
    }
  }

  // ─── Applying server content (pull + SSE) ─────────────────────────────────

  private async applyServerContent(item: SyncContentItem): Promise<void> {
    const start = Date.now();
    const channelDir = this.channelController.resolveChannelContentRoot(
      this.subscription.localChannelId,
    );
    const mdPath = path.join(channelDir, item.filename);
    this.logger.debug(`[sync] applyServerContent: ${item.filename}`);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const mdExists = fs.existsSync(mdPath);

    let contentToWrite: string;
    let newChain: ContentVersion[];

    if (mdExists) {
      const localContent = fs.readFileSync(mdPath, "utf-8");
      const sidecar = this.versionStore.read(mdPath);

      // If sidecar is missing or chain is empty, just accept server content
      if (!sidecar || sidecar.chain.length === 0) {
        contentToWrite = item.content;
        newChain = item.versionChain;
      } else {
        const localTip = sidecar.chain[sidecar.chain.length - 1];
        const serverTip = item.versionChain[item.versionChain.length - 1];
        const localHash = VersionStore.hashFile(mdPath);

        // If local tip matches server tip hash, already in sync
        if (serverTip && localHash !== null && localHash === serverTip.hash) {
          return;
        }

        // Find LCA
        const ancestor = VersionStore.findLCAbyHash(sidecar.chain, item.versionChain);

        // Merge
        contentToWrite = this.mergeStrategy.merge({
          ancestor: null,
          ours: localTip,
          theirs: serverTip,
          ancestorContent: ancestor ? localContent : null,
          oursContent: localContent,
          theirsContent: item.content,
        });

        // Build merge chain: append a merge version
        newChain = [
          ...sidecar.chain,
          {
            id: `v${sidecar.chain.length + 1}`,
            parentIds: [localTip.id, serverTip.id],
            hash: "",
            timestamp: new Date().toISOString(),
          },
        ];
      }
    } else {
      // New file from server
      contentToWrite = item.content;
      newChain = item.versionChain;
    }

    // Write file
    fs.writeFileSync(mdPath, contentToWrite);

    // Compute hash of written content
    const fileHash = VersionStore.hashFile(mdPath);

    if (newChain.length > 0 && newChain[newChain.length - 1].hash !== fileHash) {
      // Update the last version's hash to match what we actually wrote
      newChain[newChain.length - 1] = {
        ...newChain[newChain.length - 1],
        hash: fileHash ?? "",
      };
    }

    // Resolve contentId
    const relPath = this.relativePathHelper.toRelativePath(mdPath);
    let contentId = this.idAllocator.findIdByFile(relPath);
    if (!contentId) {
      contentId = await this.idAllocator.assignIdToFile(relPath);
    }

    // Write sidecar with source info
    const sidecar: VersionSidecar = {
      contentId,
      chain: newChain,
      source: {
        serverUrl: this.subscription.serverUrl,
        serverChannelId: this.subscription.serverChannelId,
      },
      lastPublishedVersionId:
        newChain.length > 0 ? newChain[newChain.length - 1].id : undefined,
    };
    await this.versionStore.write(mdPath, sidecar);
    const elapsed = Date.now() - start;
    this.logger.debug(`[sync] applyServerContent: ${item.filename} done in ${elapsed}ms`);
  }

  // ─── Publish loop ─────────────────────────────────────────────────────────

  private async publishIfNeeded(): Promise<void> {
    if (this.stopRequested) return;

    const scanStart = Date.now();
    await this.changeDetector.scanAll().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[sync] scanAll failed: ${message}`);
    });
    const scanMs = Date.now() - scanStart;

    const channelDir = this.channelController.resolveChannelContentRoot(
      this.subscription.localChannelId,
    );

    if (!fs.existsSync(channelDir)) {
      this.logger.debug(`[sync] tick: scanAll=${scanMs}ms, publish=skipped (no dir)`);
      return;
    }

    const pubStart = Date.now();
    await this.publishFilesInDir(channelDir);
    const pubMs = Date.now() - pubStart;
    this.logger.debug(`[sync] tick: scanAll=${scanMs}ms, publish=${pubMs}ms`);
  }

  private async publishFilesInDir(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const channelDir = this.channelController.resolveChannelContentRoot(
      this.subscription.localChannelId,
    );

    for (const entry of entries) {
      if (this.stopRequested) return;

      const absPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.publishFilesInDir(absPath);
        continue;
      }

      if (entry.name.endsWith(".res-version.json")) {
        if (this.subscription.syncDeletions) {
          await this.maybePublishDeletion(absPath, channelDir);
        }
        continue;
      }

      if (!entry.name.endsWith(".md")) continue;

      const sidecar = this.versionStore.read(absPath);
      if (!sidecar) continue;
      if (sidecar.chain.length === 0) continue;

      const tip = sidecar.chain[sidecar.chain.length - 1];
      if (tip.id === sidecar.lastPublishedVersionId) continue;

      const unpublisedEdit = this.findUnpublisedLinearEdit(
        sidecar.chain,
        sidecar.lastPublishedVersionId,
      );
      if (!unpublisedEdit) continue;

      // Use relative path from channel root so subdirectory structure is preserved
      const relativePath = path.relative(channelDir, absPath);

      const content = fs.readFileSync(absPath, "utf-8");
      await this.publishContent(relativePath, content, sidecar);
    }
  }

  /**
   * If a sidecar is a tombstone (file deleted locally) and we haven't yet
   * published the deletion, send a delete to the server.
   */
  private async maybePublishDeletion(sidecarPath: string, channelDir: string): Promise<void> {
    const mdPath = sidecarPath.replace(/\.res-version\.json$/, "");
    if (fs.existsSync(mdPath)) return; // file still present; not a deletion
    const sidecar = this.versionStore.read(mdPath);
    if (!sidecar) return;
    const tip = sidecar.chain[sidecar.chain.length - 1];
    if (!tip || tip.hash !== null) return; // not a tombstone
    if (sidecar.lastPublishedVersionId === tip.id) return; // already published as deleted
    await this.publishDelete(path.relative(channelDir, mdPath), sidecar, mdPath);
  }

  private async publishDelete(
    filename: string,
    sidecar: VersionSidecar,
    mdPath: string,
  ): Promise<void> {
    const baseUrl = this.subscription.serverUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/api/v1/channels/${this.subscription.serverChannelId}/publish`;
    const publishReq: PublishRequest = {
      filename,
      content: "",
      localVersionChain: sidecar.chain,
      deleted: true,
    };
    this.logger.debug(`[sync] publishing deletion ${filename}`);
    try {
      const headers = { "Content-Type": "application/json", ...this.authHeaders() };
      const response = await this.fetchWithAuth(url, {
        method: "POST",
        headers,
        body: JSON.stringify(publishReq),
      });
      if (!response.ok) {
        this.logger.error(`[sync] publish delete failed: ${response.status} for ${filename}`);
        return;
      }
      sidecar.lastPublishedVersionId = sidecar.chain[sidecar.chain.length - 1].id;
      await this.versionStore.write(mdPath, sidecar);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[sync] publish delete error: ${message}`);
      this.emitStatus({ state: "error", message: `delete ${filename}: ${message}`, context: "publish" });
    }
  }

  private async deleteLocalFile(filename: string): Promise<void> {
    const channelDir = this.channelController.resolveChannelContentRoot(
      this.subscription.localChannelId,
    );
    const mdPath = path.join(channelDir, filename);
    for (const p of [mdPath, `${mdPath}.res-version.json`]) {
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`[sync] failed to delete ${p}: ${message}`);
        }
      }
    }
  }

  /**
   * After an initial pull, remove local files that are not on the server.
   * Only touches files that were previously synced (have a published version),
   * so brand-new local-only files are never deleted.
   */
  private async reconcileDeletions(serverFilenames: Set<string>): Promise<void> {
    const channelDir = this.channelController.resolveChannelContentRoot(
      this.subscription.localChannelId,
    );
    if (!fs.existsSync(channelDir)) return;

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(channelDir, abs);
        if (e.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!e.name.endsWith(".md") || e.name.endsWith(".res-version.json")) continue;
        const sidecar = this.versionStore.read(abs);
        if (sidecar && sidecar.lastPublishedVersionId && !serverFilenames.has(rel)) {
          this.logger.info(`[sync] deleting local file absent from server: ${rel}`);
          this.deleteLocalFile(rel);
        }
      }
    };
    walk(channelDir);
  }

  private findUnpublisedLinearEdit(
    chain: ContentVersion[],
    lastPublishedVersionId: string | undefined,
  ): ContentVersion | null {
    if (!lastPublishedVersionId) {
      // Nothing ever published: return the newest version that is either
      // a root version (parentIds.length === 0) or a linear edit (length === 1).
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].parentIds.length <= 1) return chain[i];
      }
      return null;
    }

    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].id === lastPublishedVersionId) break;
      if (chain[i].parentIds.length <= 1) return chain[i];
    }
    return null;
  }

  private async publishContent(
    filename: string,
    content: string,
    sidecar: VersionSidecar,
  ): Promise<void> {
    const baseUrl = this.subscription.serverUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/api/v1/channels/${this.subscription.serverChannelId}/publish`;

    const publishReq: PublishRequest = {
      filename,
      content,
      localVersionChain: sidecar.chain,
    };

    this.logger.debug(`[sync] publishing ${filename}`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      Object.assign(headers, this.authHeaders());
      const response = await this.fetchWithAuth(url, {
        method: "POST",
        headers,
        body: JSON.stringify(publishReq),
      });

      if (!response.ok) {
        this.logger.error(`[sync] publish failed: ${response.status} for ${filename}`);
        return;
      }

      const result = (await response.json()) as PublishResponse;

      // Update last published version
      sidecar.lastPublishedVersionId = sidecar.chain[sidecar.chain.length - 1].id;

      if (result.merged) {
        // Server merged our changes — apply the result
        await this.applyServerContent({
          filename: result.filename,
          content: result.content,
          versionChain: result.serverVersionChain,
        });
      } else {
        // No merge needed — just update the sidecar
        await this.versionStore.write(
          path.join(
            this.channelController.resolveChannelContentRoot(this.subscription.localChannelId),
            filename,
          ),
          sidecar,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(`[sync] publish error for ${filename}: ${message}`);
      this.emitStatus({ state: "error", message: `${filename}: ${message}`, context: "publish" });
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  private emitStatus(status: SyncClientStatus): void {
    this.subscription.onStatusChange?.(status);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Sync daemon (multiple subscriptions) ───────────────────────────────────

const SYNC_PID_FILE = ".res-sync.pid";
const SYNC_STATUS_FILE = ".res-sync-status.json";

export interface SyncDaemonStatus {
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  subscriptions: Array<{
    serverUrl: string;
    serverChannelId: string;
    localChannelId: string;
    status: "connecting" | "connected" | "error";
    lastError?: string;
  }>;
}

export function getSyncDaemonPidPath(reservoirDir: string): string {
  return path.join(path.resolve(reservoirDir), SYNC_PID_FILE);
}

export function getSyncDaemonStatusPath(reservoirDir: string): string {
  return path.join(path.resolve(reservoirDir), SYNC_STATUS_FILE);
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(pidPath: string): number | null {
  if (!fs.existsSync(pidPath)) return null;
  const parsed = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function getSyncDaemonStatus(reservoirDir: string): { running: boolean; pid?: number } {
  const pidPath = getSyncDaemonPidPath(reservoirDir);
  const pid = readPidFile(pidPath);
  if (!pid || !isProcessRunning(pid)) {
    return { running: false };
  }
  return { running: true, pid };
}

export async function startSyncDaemon(reservoirDir: string): Promise<void> {
  const absDir = path.resolve(reservoirDir);
  const existing = getSyncDaemonStatus(absDir);
  if (existing.running && existing.pid) {
    throw new Error(`Sync daemon already running (pid ${existing.pid})`);
  }

  // Write PID file
  const pidPath = getSyncDaemonPidPath(absDir);
  fs.writeFileSync(pidPath, `${process.pid}\n`, "utf-8");

  const { readSyncConfig } = await import("./sync-config");

  const config = readSyncConfig(absDir);
  const clients: SyncClient[] = [];

  try {
    for (const sub of config.subscriptions) {
      const client = new SyncClient(absDir, {
        serverUrl: sub.serverUrl,
        serverChannelId: sub.serverChannelId,
        localChannelId: sub.localChannelId,
      });
      clients.push(client);
      await client.start();
    }

    // Write status
    writeSyncStatus(absDir, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });

    // Keep alive until SIGINT/SIGTERM
    await waitForSignal(() => {
      clearPidFile(pidPath);
    });
  } finally {
    for (const client of clients) {
      await client.stop();
    }
  }
}

export function stopSyncDaemon(reservoirDir: string): { stopped: boolean; message: string; pid?: number } {
  const absDir = path.resolve(reservoirDir);
  const pidPath = getSyncDaemonPidPath(absDir);
  const pid = readPidFile(pidPath);

  if (!pid) {
    return { stopped: false, message: "Sync daemon is not running" };
  }

  if (!isProcessRunning(pid)) {
    clearPidFile(pidPath);
    return { stopped: false, message: "Sync daemon is not running" };
  }

  if (pid === process.pid) {
    const statusPath = getSyncDaemonStatusPath(absDir);
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
      if (status.pid === process.pid) {
        process.emit("SIGTERM");
      }
    }
  } else {
    process.kill(pid, "SIGTERM");
  }

  clearPidFile(pidPath);
  return { stopped: true, pid, message: `Stopped sync daemon (pid ${pid})` };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

interface SyncDaemonStatusFile {
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
}

function writeSyncStatus(reservoirDir: string, status: SyncDaemonStatusFile): void {
  const statusPath = getSyncDaemonStatusPath(reservoirDir);
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");
}

function clearPidFile(pidPath: string): void {
  try {
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }
  } catch {
    // ignore
  }
}

function waitForSignal(onShutdown: () => void): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = (): void => {
      onShutdown();
      resolve();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
