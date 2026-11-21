import { pyJson } from "./json.ts";

export const MANIFEST = pyJson({
  name: "Trio Mix-Assistant",
  short_name: "Mix-Assistant",
  description: "Live operator dashboard for the Acoustic Trio Mix-Assistant.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "landscape",
  background_color: "#0a0e14",
  theme_color: "#0a0e14",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#ff7a45"/><stop offset="1" stop-color="#2dd4bf"/>
</linearGradient></defs>
<rect width="512" height="512" rx="112" fill="#0a0e14"/>
<rect x="40" y="40" width="432" height="432" rx="84" fill="none" stroke="url(#g)"
 stroke-width="14" opacity="0.5"/>
<g stroke-linecap="round">
<line x1="150" y1="120" x2="150" y2="392" stroke="#222d3a" stroke-width="20"/>
<line x1="256" y1="120" x2="256" y2="392" stroke="#222d3a" stroke-width="20"/>
<line x1="362" y1="120" x2="362" y2="392" stroke="#222d3a" stroke-width="20"/>
<circle cx="150" cy="200" r="30" fill="#ff7a45"/>
<circle cx="256" cy="300" r="30" fill="#2dd4bf"/>
<circle cx="362" cy="170" r="30" fill="#f6c453"/>
</g></svg>`;

export const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Mix-Assistant — locked</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;height:100vh;display:grid;place-items:center;background:#0a0e14;
 color:#e6edf3;font:16px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
.card{width:min(92vw,340px);padding:28px 26px;border:1px solid #1c2733;border-radius:16px;
 background:#0e141c;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)}
h1{font-size:18px;margin:0 0 4px}p{color:#8aa0b2;font-size:13px;margin:0 0 18px}
input{width:100%;padding:13px;font-size:20px;text-align:center;letter-spacing:.3em;
 border:1px solid #26323f;border-radius:10px;background:#0a0f16;color:#e6edf3}
button{width:100%;margin-top:12px;padding:12px;font-size:15px;font-weight:700;border:0;
 border-radius:10px;cursor:pointer;color:#04121e;background:linear-gradient(180deg,#8fd0ff,#5db4ff)}
.err{color:#ff9ba3;font-size:13px;min-height:18px;margin-top:10px}
</style></head><body><form class="card" id="f">
<h1>🎚️ Mix-Assistant</h1><p>Enter the access PIN to continue</p>
<input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code"
 autofocus aria-label="PIN"><button>Unlock</button><div class="err" id="err"></div>
</form><script src="/login.js"></script></body></html>`;
