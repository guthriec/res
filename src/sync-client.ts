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
} from "./sync-protocol";

const PUBLISH_TICK_MS = 10_000;
const SSE_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface SyncClientSubscription {
  serverUrl: string;
  serverChannelId: string;
  localChannelId: string;
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

    // 2. Start SSE subscription (runs concurrently)
    this.runSseLoop();

    // 3. Start publish loop
    this.publishTimer = setInterval(() => this.publishIfNeeded(), PUBLISH_TICK_MS);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.publishTimer) {
      clearInterval(this.publishTimer);
      this.publishTimer = undefined;
    }
  }

  // ─── Initial pull ─────────────────────────────────────────────────────────

  private async initialPull(): Promise<void> {
    const baseUrl = this.subscription.serverUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/api/v1/channels/${this.subscription.serverChannelId}/content`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        this.logger.error(`[sync] initial pull failed: ${response.status}`);
        return;
      }

      const data = (await response.json()) as SyncContentResponse;
      for (const item of data.items) {
        await this.applyServerContent(item);
      }

      this.logger.info(`[sync] initial pull complete: ${data.items.length} items`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[sync] initial pull error: ${message}`);
    }
  }

  // ─── SSE loop with auto-reconnect ─────────────────────────────────────────

  private async runSseLoop(): Promise<void> {
    let reconnectDelay = SSE_RECONNECT_DELAY_MS;

    while (!this.stopRequested) {
      try {
        const baseUrl = this.subscription.serverUrl.replace(/\/+$/, "");
        const url = `${baseUrl}/api/v1/channels/${this.subscription.serverChannelId}/events`;

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        this.logger.debug("[sync] SSE connected");
        reconnectDelay = SSE_RECONNECT_DELAY_MS; // reset on success

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
            await this.handleSseEvent(event, data);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`[sync] SSE disconnected: ${message}`);
      }

      if (this.stopRequested) break;

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
        await this.applyServerContent({
          filename: eventData.filename,
          content: eventData.content,
          versionChain: eventData.versionChain,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[sync] failed to handle content-updated: ${message}`);
      }
    }
  }

  // ─── Applying server content (pull + SSE) ─────────────────────────────────

  private async applyServerContent(item: SyncContentItem): Promise<void> {
    const channelDir = this.channelController.resolveChannelContentRoot(
      this.subscription.localChannelId,
    );
    fs.mkdirSync(channelDir, { recursive: true });

    const mdPath = path.join(channelDir, item.filename);
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
  }

  // ─── Publish loop ─────────────────────────────────────────────────────────

  private async publishIfNeeded(): Promise<void> {
    if (this.stopRequested) return;

    const channelDir = this.channelController.resolveChannelContentRoot(
      this.subscription.localChannelId,
    );

    if (!fs.existsSync(channelDir)) return;

    const entries = fs.readdirSync(channelDir, { withFileTypes: true });
    for (const entry of entries) {
      if (this.stopRequested) return;
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name.endsWith(".res-version.json")) continue;

      const mdPath = path.join(channelDir, entry.name);
      const sidecar = this.versionStore.read(mdPath);
      if (!sidecar || sidecar.chain.length === 0) continue;

      const tip = sidecar.chain[sidecar.chain.length - 1];
      if (tip.id === sidecar.lastPublishedVersionId) continue;

      // Walk the chain to find if there's an unpublised linear edit
      const unpublisedEdit = this.findUnpublisedLinearEdit(
        sidecar.chain,
        sidecar.lastPublishedVersionId,
      );
      if (!unpublisedEdit) continue;

      // Publish
      const content = fs.readFileSync(mdPath, "utf-8");
      await this.publishContent(entry.name, content, sidecar);
    }
  }

  private findUnpublisedLinearEdit(
    chain: ContentVersion[],
    lastPublishedVersionId: string | undefined,
  ): ContentVersion | null {
    if (!lastPublishedVersionId) {
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].parentIds.length === 1) return chain[i];
      }
      return null;
    }

    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].id === lastPublishedVersionId) break;
      if (chain[i].parentIds.length === 1) return chain[i];
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

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

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
