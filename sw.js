// Service worker mínimo: permite instalar o Config como aplicativo. Sempre busca da rede
// (o firmware e o app mudam a cada versão; cache aqui só atrapalharia).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
