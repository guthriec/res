import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as url from "url";
import { ChannelControllerImpl } from "./channel-controller";
import { ContentIdAllocator } from "./content-id-allocator";
import { VersionStore, type VersionSidecar, type ContentVersion } from "./version-store";
import { UnsafeAutoMerge, type MergeStrategy } from "./merge-strategy";
import { createDirectoryWatcher } from "./file-watcher";
import { Logger } from "./logger";
import type {
  PublishRequest,
  PublishResponse,
  SyncContentResponse,
  SyncContentItem,
  SseEvent,
} from "./sync-protocol";

const API_PREFIX = "/api/v1";

export interface SyncServerConfig {
  port: number;
  host?: string;
}

/**
 * Find the latest linear edit (parentIds.length === 1) in a version chain
 * that post-dates a given version ID. Returns null if none found.
 */
function findLatestUnpublishedEdit(
  chain: ContentVersion[],
  lastPublishedVersionId: string | undefined,
): ContentVersion | null {
  if (!lastPublishedVersionId) {
    // Nothing has ever been published — the first non-merge is the candidate
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].parentIds.length === 1) return chain[i];
    }
    return null;
  }

  let foundPublished = false;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].id === lastPublishedVersionId) {
      foundPublished = true;
      break;
    }
    if (chain[i].parentIds.length === 1) {
      return chain[i];
    }
  }
  // If the published version wasn't found in the chain (e.g. chain was rebuilt),
  // fall back to checking the tip.
  if (!foundPublished && chain.length > 0) {
    const tip = chain[chain.length - 1];
    if (tip.parentIds.length === 1) return tip;
  }
  return null;
}

export class SyncServer {
  private readonly reservoirDir: string;
  private readonly channelController: ChannelControllerImpl;
  private readonly idAllocator: ContentIdAllocator;
  private readonly versionStore: VersionStore;
  private readonly mergeStrategy: MergeStrategy;
  private readonly logger: Logger;
  private httpServer: http.Server | undefined;
  private readonly sseClients: Map<string, Set<http.ServerResponse>>;
  private cleanupWatcher: (() => void) | undefined;

  constructor(reservoirDir: string) {
    this.reservoirDir = path.resolve(reservoirDir);
    this.channelController = new ChannelControllerImpl(this.reservoirDir);
    this.idAllocator = ContentIdAllocator.forReservoir(this.reservoirDir);
    this.versionStore = new VersionStore(this.reservoirDir);
    this.mergeStrategy = new UnsafeAutoMerge();
    this.logger = Logger.fromEnvironment();
    this.sseClients = new Map();
  }

  async start(config: SyncServerConfig): Promise<void> {
    const host = config.host ?? "127.0.0.1";

    this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve) => {
      this.httpServer!.listen(config.port, host, () => {
        this.logger.info(`[sync-server] listening on ${host}:${config.port}`);

        // Start watching shared channel directories for local edits
        this.startWatchingSharedChannels();

        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all SSE connections
    for (const clients of this.sseClients.values()) {
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
    }
    this.sseClients.clear();

    if (this.cleanupWatcher) {
      this.cleanupWatcher();
      this.cleanupWatcher = undefined;
    }

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
        this.httpServer = undefined;
      } else {
        resolve();
      }
    });
  }

  // ─── Request routing ──────────────────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsed = url.parse(req.url ?? "", true);
    const method = req.method ?? "GET";
    const pathname = parsed.pathname ?? "";

    try {
      if (!pathname.startsWith(API_PREFIX)) {
        this.writeJson(res, 404, { error: "not found" });
        return;
      }

      const route = pathname.slice(API_PREFIX.length);

      // GET /channels
      if (route === "/channels" && method === "GET") {
        this.handleListChannels(res);
        return;
      }

      // Extract channelId from routes
      const contentMatch = route.match(/^\/channels\/([^/]+)\/content$/);
      const eventsMatch = route.match(/^\/channels\/([^/]+)\/events$/);
      const publishMatch = route.match(/^\/channels\/([^/]+)\/publish$/);

      if (contentMatch && method === "GET") {
        this.handleGetChannelContent(contentMatch[1], res);
        return;
      }

      if (eventsMatch && method === "GET") {
        this.handleSseSubscribe(eventsMatch[1], res);
        return;
      }

      if (publishMatch && method === "POST") {
        this.handlePublish(publishMatch[1], req, res);
        return;
      }

      this.writeJson(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[sync-server] request error: ${message}`);
      this.writeJson(res, 500, { error: message });
    }
  }

  // ─── Route handlers ───────────────────────────────────────────────────────

  private handleListChannels(res: http.ServerResponse): void {
    const channels = this.channelController
      .listChannels()
      .filter((c) => c.shared === true)
      .map((c) => ({ id: c.id, name: c.name }));
    this.writeJson(res, 200, channels);
  }

  private handleGetChannelContent(channelId: string, res: http.ServerResponse): void {
    if (!this.isChannelShared(channelId)) {
      this.writeJson(res, 404, { error: "channel not found" });
      return;
    }

    const items: SyncContentItem[] = [];
    const contentRoot = this.channelController.resolveChannelContentRoot(channelId);

    if (!fs.existsSync(contentRoot)) {
      this.writeJson(res, 200, { items: [] });
      return;
    }

    const entries = fs.readdirSync(contentRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name.endsWith(".res-version.json")) continue;

      const mdPath = path.join(contentRoot, entry.name);
      const content = fs.readFileSync(mdPath, "utf-8");
      const sidecar = this.versionStore.read(mdPath);

      items.push({
        filename: entry.name,
        content,
        versionChain: sidecar?.chain ?? [],
      });
    }

    this.writeJson(res, 200, { items });
  }

  private handleSseSubscribe(channelId: string, res: http.ServerResponse): void {
    if (!this.isChannelShared(channelId)) {
      this.writeJson(res, 404, { error: "channel not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Track this client
    if (!this.sseClients.has(channelId)) {
      this.sseClients.set(channelId, new Set());
    }
    this.sseClients.get(channelId)!.add(res);

    // Send initial heartbeat
    this.sendSseMessage(res, "heartbeat", { timestamp: new Date().toISOString() });

    // Keep-alive heartbeat every 30s
    const heartbeat = setInterval(() => {
      try {
        this.sendSseMessage(res, "heartbeat", { timestamp: new Date().toISOString() });
      } catch {
        clearInterval(heartbeat);
      }
    }, 30000);

    // Cleanup on disconnect
    reqOnClose(res, () => {
      clearInterval(heartbeat);
      this.sseClients.get(channelId)?.delete(res);
      if (this.sseClients.get(channelId)?.size === 0) {
        this.sseClients.delete(channelId);
      }
    });
  }

  private async handlePublish(
    channelId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isChannelShared(channelId)) {
      this.writeJson(res, 404, { error: "channel not found" });
      return;
    }

    const body = await readJsonBody(req);
    const publishReq = body as PublishRequest;

    if (!publishReq.filename || typeof publishReq.content !== "string") {
      this.writeJson(res, 400, { error: "filename and content are required" });
      return;
    }

    const contentRoot = this.channelController.resolveChannelContentRoot(channelId);
    fs.mkdirSync(contentRoot, { recursive: true });

    const mdPath = path.join(contentRoot, publishReq.filename);
    const mdExists = fs.existsSync(mdPath);

    let serverContent: string;
    let serverChain: ContentVersion[];

    if (mdExists) {
      const existingContent = fs.readFileSync(mdPath, "utf-8");
      const existingHash = VersionStore.hashFile(mdPath);
      const sidecar = this.versionStore.read(mdPath);
      serverChain = sidecar?.chain ?? [];
      const tipHash = serverChain.length > 0 ? serverChain[serverChain.length - 1].hash : null;

      // Check if client already has the same content we do
      const clientTip = publishReq.localVersionChain[publishReq.localVersionChain.length - 1];
      if (clientTip && existingHash !== null && clientTip.hash === existingHash) {
        // Client is already up to date — no merge needed
        const response: PublishResponse = {
          filename: publishReq.filename,
          merged: false,
          content: existingContent,
          serverVersionChain: serverChain,
        };
        this.writeJson(res, 200, response);
        return;
      }

      // Find LCA
      const ancestor = VersionStore.findLCAbyHash(publishReq.localVersionChain, serverChain);

      // Perform merge
      const mergedContent = this.mergeStrategy.merge({
        ancestor: null, // findLCAbyHash returns ContentVersion; we pass null for simplicity
        ours: serverChain.length > 0
          ? serverChain[serverChain.length - 1]
          : { id: "v0", parentIds: [], hash: null, timestamp: new Date().toISOString() },
        theirs: publishReq.localVersionChain[publishReq.localVersionChain.length - 1],
        ancestorContent: ancestor ? this.getContentForHash(existingContent, ancestor.hash) : existingContent,
        oursContent: existingContent,
        theirsContent: publishReq.content,
      });

      if (mergedContent === existingContent) {
        // No change — loop breaker
        const response: PublishResponse = {
          filename: publishReq.filename,
          merged: false,
          content: existingContent,
          serverVersionChain: serverChain,
        };
        this.writeJson(res, 200, response);
        return;
      }

      serverContent = mergedContent;
      fs.writeFileSync(mdPath, serverContent);

      // Record merge commit in sidecar
      const fileHash = VersionStore.hashFile(mdPath);
      if (sidecar && fileHash) {
        const newVersion: ContentVersion = {
          id: `v${sidecar.chain.length + 1}`,
          parentIds: [serverChain.length > 0 ? serverChain[serverChain.length - 1].id : "v0",
                     publishReq.localVersionChain[publishReq.localVersionChain.length - 1].id],
          hash: fileHash,
          timestamp: new Date().toISOString(),
        };
        sidecar.chain.push(newVersion);
        await this.versionStore.write(mdPath, sidecar);
        serverChain = sidecar.chain;
      }
    } else {
      // New file from client
      serverContent = publishReq.content;
      fs.writeFileSync(mdPath, serverContent);

      // Resolve contentId
      const relPath = path.relative(this.reservoirDir, mdPath);
      let contentId = this.idAllocator.findIdByFile(relPath);
      if (!contentId) {
        contentId = await this.idAllocator.assignIdToFile(relPath);
      }

      // Create sidecar from client's chain, or start fresh
      if (publishReq.localVersionChain.length > 0) {
        const sidecar: VersionSidecar = {
          contentId,
          chain: publishReq.localVersionChain,
        };
        await this.versionStore.write(mdPath, sidecar);
        serverChain = publishReq.localVersionChain;
      } else {
        const fileHash = VersionStore.hashFile(mdPath);
        const sidecar: VersionSidecar = {
          contentId,
          chain: [{
            id: "v1",
            parentIds: [],
            hash: fileHash ?? "",
            timestamp: new Date().toISOString(),
          }],
        };
        await this.versionStore.write(mdPath, sidecar);
        serverChain = sidecar.chain;
      }
    }

    // Push SSE event
    this.pushSseEvent(channelId, {
      type: "content-updated",
      data: {
        channelId,
        filename: publishReq.filename,
        content: serverContent,
        versionChain: serverChain,
      },
    });

    const response: PublishResponse = {
      filename: publishReq.filename,
      merged: true,
      content: serverContent,
      serverVersionChain: serverChain,
    };
    this.writeJson(res, 200, response);
  }

  // ─── SSE helpers ──────────────────────────────────────────────────────────

  private pushSseEvent(channelId: string, event: SseEvent): void {
    const clients = this.sseClients.get(channelId);
    if (!clients) return;

    const eventName = event.type;
    const payload = JSON.stringify(event.data);
    const message = `event: ${eventName}\ndata: ${payload}\n\n`;

    for (const client of clients) {
      try {
        client.write(message);
      } catch {
        clients.delete(client);
      }
    }
  }

  private sendSseMessage(res: http.ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private isChannelShared(channelId: string): boolean {
    try {
      const channel = this.channelController.viewChannel(channelId);
      return channel.shared === true;
    } catch {
      return false;
    }
  }

  private getContentForHash(currentContent: string, hash: string | null): string {
    if (hash === null) return "";
    // For now, return the current content — in practice, we'd need to look
    // up historical content by hash from the version store.
    return currentContent;
  }

  private writeJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private startWatchingSharedChannels(): void {
    const sharedChannels = this.channelController
      .listChannels()
      .filter((c) => c.shared === true);

    if (sharedChannels.length === 0) return;

    // Watch the reservoir content root for changes in shared channels.
    // This picks up local file edits and pushes SSE events.
    this.cleanupWatcher = createDirectoryWatcher(this.reservoirDir, () => {
      for (const channel of sharedChannels) {
        const contentRoot = this.channelController.resolveChannelContentRoot(channel.id);
        if (!fs.existsSync(contentRoot)) continue;

        const entries = fs.readdirSync(contentRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          if (entry.name.endsWith(".res-version.json")) continue;

          const mdPath = path.join(contentRoot, entry.name);
          const sidecar = this.versionStore.read(mdPath);
          if (!sidecar) continue;

          const tip = sidecar.chain[sidecar.chain.length - 1];
          const currentHash = VersionStore.hashFile(mdPath);
          if (currentHash === null) {
            // File was deleted — push delete event
            this.pushSseEvent(channel.id, {
              type: "content-deleted",
              data: { channelId: channel.id, filename: entry.name },
            });
          } else if (tip && tip.hash !== currentHash) {
            // File was modified — push update event
            const content = fs.readFileSync(mdPath, "utf-8");
            this.pushSseEvent(channel.id, {
              type: "content-updated",
              data: {
                channelId: channel.id,
                filename: entry.name,
                content,
                versionChain: sidecar.chain,
              },
            });
          }
        }
      }
    });
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function reqOnClose(res: http.ServerResponse, cb: () => void): void {
  res.on("close", cb);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
