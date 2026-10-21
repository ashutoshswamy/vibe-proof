// Demo target for the slow-network signup bug. `node scripts/demo-site.mjs` = buggy, `--fixed` = fixed. Port 4000 (PORT to change).
import http from "node:http";
const fixed = process.argv.includes("--fixed");
const accounts = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo Signup</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Demo App${fixed ? " (fixed)" : ""}</h1>${body}</main></body></html>`;
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c)).on("end", async () => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/accounts") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ count: accounts.size, rows: [...accounts.values()] })); }
    if (url.pathname === "/signup" && req.method === "POST") {
      const email = (new URLSearchParams(Buffer.concat(chunks).toString()).get("email") ?? "").trim().toLowerCase();
      if (!email) { res.writeHead(400); return res.end("email required"); }
      if (fixed) { // atomic: the Map key is the unique constraint
        if (accounts.has(email)) { res.writeHead(409); return res.end("An account with this email already exists"); }
        accounts.set(email, { email }); await sleep(400);
      } else { // check-then-insert with slow work in between
        if ([...accounts.values()].some((a) => a.email === email)) { res.writeHead(409); return res.end("An account with this email already exists"); }
        await sleep(400);
        accounts.set(email + "#" + Math.random(), { email });
      }
      res.writeHead(201, { "content-type": "text/html" }); return res.end(page("<p>Account created. Welcome!</p>"));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page(`<form method="post" action="/signup"><label>Email <input type="email" name="email" required></label><label>Password <input type="password" name="password" required minlength="8"></label><button type="submit">Sign up</button></form>`));
  });
}).listen(Number(process.env.PORT ?? 4000), "127.0.0.1", () => console.log(`demo site (${fixed ? "fixed" : "buggy"}) on http://127.0.0.1:${process.env.PORT ?? 4000}`));
