/// <reference lib="webworker" />

import { precacheAndRoute } from "serwist/legacy";

declare const self: ServiceWorkerGlobalScope;

declare global {
  interface ServiceWorkerGlobalScope {
    __SW_MANIFEST: Array<{ url: string; revision?: string }>;
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

precacheAndRoute(self.__SW_MANIFEST);
