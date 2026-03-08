"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_DUPLICATE_STRATEGY = exports.GLOBAL_LOCK_NAME = exports.DEFAULT_REFRESH_INTERVAL_SECONDS = exports.FetchMethod = void 0;
var FetchMethod;
(function (FetchMethod) {
    FetchMethod["RSS"] = "rss";
    FetchMethod["WebPage"] = "web_page";
})(FetchMethod || (exports.FetchMethod = FetchMethod = {}));
exports.DEFAULT_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60;
exports.GLOBAL_LOCK_NAME = '[global]';
exports.DEFAULT_DUPLICATE_STRATEGY = 'keep-both';
