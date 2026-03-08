"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FakeKitpicksResApi = void 0;
class FakeKitpicksResApi {
    constructor() {
        this.upsertSourceChannelResponse = {
            success: true,
        };
        this.ensureBackgroundFetcherResponse = { success: true };
        this.listLockedContentResponse = {
            success: true,
            items: [],
        };
        this.releaseContentLockResponse = { success: true };
    }
    setUpsertSourceChannelResponse(response) {
        this.upsertSourceChannelResponse = response;
    }
    setEnsureBackgroundFetcherResponse(response) {
        this.ensureBackgroundFetcherResponse = response;
    }
    setListLockedContentResponse(response) {
        this.listLockedContentResponse = response;
    }
    setReleaseContentLockResponse(response) {
        this.releaseContentLockResponse = response;
    }
    reset() {
        this.upsertSourceChannelResponse = { success: true };
        this.ensureBackgroundFetcherResponse = { success: true };
        this.listLockedContentResponse = { success: true, items: [] };
        this.releaseContentLockResponse = { success: true };
    }
    async upsertSourceChannel(_source, _lockName) {
        return this.upsertSourceChannelResponse;
    }
    async ensureBackgroundFetcher() {
        return this.ensureBackgroundFetcherResponse;
    }
    async listLockedContent(_lockName) {
        return this.listLockedContentResponse;
    }
    async releaseContentLock(_contentId, _lockName) {
        return this.releaseContentLockResponse;
    }
}
exports.FakeKitpicksResApi = FakeKitpicksResApi;
