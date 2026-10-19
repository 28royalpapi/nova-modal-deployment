const VERSION="nova-chat-v1";
const SHELL=["./","./index.html","./styles.css","./app.js","./config.js","./favicon.svg"];
self.addEventListener("install",e=>e.waitUntil(caches.open(VERSION).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==location.origin)return;e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{if(r.ok&&e.request.mode!=="navigate"){const c=r.clone();caches.open(VERSION).then(cache=>cache.put(e.request,c));}return r;}).catch(()=>caches.match("./index.html"))));});
