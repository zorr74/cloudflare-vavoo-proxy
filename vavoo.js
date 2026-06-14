/**
 * Cloudflare Worker for Vavoo Stream Extraction
 * Version: 1.0
 *
 * Features:
 * - Vavoo: Stream extraction with 302 redirect.
 * - M3U playlist proxy for Vavoo links.
 */

// --- CORS and Utility ---

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, Accept, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Location',
};

function getClientIP(request) {
  // Check explicit ip query parameter first (sent by backend servers that know the real client IP)
  try {
      const url = new URL(request.url);
      const explicitIp = url.searchParams.get('ip');
      if (explicitIp && explicitIp.trim()) return explicitIp.trim();
  } catch {}
  return request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
      request.headers.get('X-Real-IP') ||
      '127.0.0.1';
}

class ExtractorError extends Error {
  constructor(message) {
      super(message);
      this.name = 'ExtractorError';
  }
}

// --- Vavoo Extractor Logic ---

class VavooExtractor {
  async getAuthSignature(clientIP) {
      const currentTime = Date.now();
      const authPayload = {
          token: "",
          reason: "app-focus",
          locale: "de",
          theme: "dark",
          metadata: {
              device: { type: "phone", uniqueId: "vypn-test" },
              os: { name: "android", version: "14", abis: ["arm64-v8a"], host: "android" },
              app: { platform: "android" },
              version: { package: "net.vypn.app", binary: "1.4.1", js: "1.4.1" }
          },
          appFocusTime: 0,
          playerActive: false,
          playDuration: 0,
          devMode: false,
          hasAddon: true,
          castConnected: false,
          package: "net.vypn.app",
          version: "1.4.1",
          process: "app",
          firstAppStart: currentTime - 86400000,
          lastAppStart: currentTime,
          ipLocation: null,
          adblockEnabled: true,
          migrationApplied: false,
          migrationTargetInstalled: false,
          proxy: {
              supported: ["ss"],
              engine: "Mu",
              ssVersion: "2022",
              enabled: false,
              autoServer: true,
              id: ""
          },
          iap: { supported: false, error: "" }
      };
      const authHeaders = {
          "user-agent": "okhttp/4.11.0",
          "accept": "application/json",
          "content-type": "application/json; charset=utf-8",
          "accept-encoding": "gzip",
      };
      const response = await fetch("https://www.vypn.net/api/app/ping", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(authPayload)
      });
      if (!response.ok) throw new ExtractorError(`Vavoo Auth API failed: ${response.status}`);
      const result = await response.json();
      const sig = result.addonSig || result.mhub;
      if (!sig) throw new ExtractorError('Vavoo auth response missing addonSig.');

      // Rewrite IPs in addonSig to use client IP
      let addonSig = sig;
      try {
          const decoded = atob(addonSig);
          const sigObj = JSON.parse(decoded);
          if (sigObj && sigObj.data) {
              const dataObj = JSON.parse(sigObj.data);
              if (clientIP) {
                  const currentIps = Array.isArray(dataObj.ips) ? dataObj.ips : [];
                  dataObj.ips = [clientIP, ...currentIps.filter(x => x && x !== clientIP)];
                  if (typeof dataObj.ip === 'string') dataObj.ip = clientIP;
                  sigObj.data = JSON.stringify(dataObj);
                  addonSig = btoa(JSON.stringify(sigObj));
              }
          }
      } catch (e) { /* keep original sig if rewrite fails */ }

      return addonSig;
  }

  async resolveStream(vavooUrl, signature, clientIP) {
      const resolvePayload = {
          language: "de",
          region: "AT",
          url: vavooUrl,
          clientVersion: "3.0.2"
      };
      const resolveHeaders = {
          "user-agent": "MediaHubMX/2",
          "accept": "application/json",
          "content-type": "application/json; charset=utf-8",
          "accept-encoding": "gzip",
          "mediahubmx-signature": signature,
          "X-Forwarded-For": clientIP,
          "X-Real-IP": clientIP,
      };
      const response = await fetch("https://vavoo.to/mediahubmx-resolve.json", {
          method: "POST",
          headers: resolveHeaders,
          body: JSON.stringify(resolvePayload)
      });
      if (!response.ok) throw new ExtractorError(`Vavoo Resolve API failed: ${response.status}`);
      const result = await response.json();
      let streamUrl;
      if (Array.isArray(result)) {
          // Try to find an HTTPS stream first
          const httpsStream = result.find(item => item.url && item.url.startsWith('https://'));
          streamUrl = httpsStream ? httpsStream.url : result[0]?.url;
      } else {
          streamUrl = result?.url;
      }

      if (!streamUrl) throw new ExtractorError('Vavoo resolve response contains no valid stream URL.');

      return streamUrl;
  }

  async handle(url, request) {
      const clientIP = getClientIP(request);
      if (clientIP && clientIP.includes(':')) {
          return new Response('IPv6 connections are not allowed for this service.', { status: 403, headers: CORS_HEADERS });
      }

      const signature = await this.getAuthSignature(clientIP);
      const streamUrl = await this.resolveStream(url, signature, clientIP);

      // Workaround: il CDN finale di Vavoo ha cert SSL scaduto (Apr 23 2026).
      // Forziamo HTTP, il CDN risponde anche in cleartext.
      const finalUrl = streamUrl.replace(/^https:\/\//, 'http://');

      return new Response(null, {
          status: 302,
          headers: { ...CORS_HEADERS, 'Location': finalUrl },
      });
  }
}

// --- M3U Playlist Proxy ---

async function handlePlaylistProxy(request) {
  const url = new URL(request.url);
  const m3uUrlsParam = url.searchParams.get('url');
  if (!m3uUrlsParam) {
      return new Response('Error: Missing url parameter for playlist.', { status: 400, headers: CORS_HEADERS });
  }

  const m3uUrls = m3uUrlsParam.split(';').filter(u => u.trim() !== '');
  if (m3uUrls.length === 0) {
      return new Response('Error: No valid playlist URLs provided.', { status: 400, headers: CORS_HEADERS });
  }

  let combinedM3U = '';
  for (const m3uUrl of m3uUrls) {
      try {
          const response = await fetch(m3uUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (response.ok) {
              const text = await response.text();
              combinedM3U += text + '\n';
          }
      } catch (e) {
          console.error(`Failed to fetch or process playlist ${m3uUrl}: ${e.message}`);
      }
  }

  const workerDomain = url.origin;
  const modifiedM3U = rewritePlaylistUrls(combinedM3U, workerDomain);

  return new Response(modifiedM3U, {
      headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Content-Disposition': 'inline; filename="playlist.m3u"',
          'Cache-Control': 's-maxage=3600, stale-while-revalidate',
      }
  });
}

function rewritePlaylistUrls(m3uContent, workerDomain) {
  const lines = m3uContent.split('\n');
  const processedM3uParts = [];
  let lastExtinf = null;

  if (!lines[0]?.startsWith('#EXTM3U')) {
      processedM3uParts.push('#EXTM3U');
  }

  for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      if (trimmedLine.startsWith('#EXTM3U')) {
          if (!processedM3uParts.includes('#EXTM3U')) processedM3uParts.push(trimmedLine);
      } else if (trimmedLine.startsWith('#EXTINF:')) {
          lastExtinf = trimmedLine;
      } else if (trimmedLine.startsWith('#EXTVLCOPT:')) {
          processedM3uParts.push(trimmedLine);
      } else if (trimmedLine.startsWith('http') && lastExtinf) {
          if (trimmedLine.includes('vavoo.to')) {
              processedM3uParts.push(lastExtinf);
              const newUrl = `${workerDomain}/manifest.m3u8?url=${encodeURIComponent(trimmedLine)}`;
              processedM3uParts.push(newUrl);
          } else {
              // URL non Vavoo, lo lasciamo invariato
              processedM3uParts.push(lastExtinf);
              processedM3uParts.push(trimmedLine);
          }
          lastExtinf = null;
      }
  }
  return processedM3uParts.join('\n');
}

// --- Info & Status Pages ---

function handleInfoPage(request) {
  const workerDomain = new URL(request.url).origin;
  const htmlContent = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>?? Vavoo Stream Extractor</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
      :root {
          --bg-primary: #0a0a0b; --bg-card: #16181c; --text-primary: #ffffff; --text-secondary: #b3b3b3;
          --accent-primary: #3b82f6; --accent-green: #10b981; --border-color: #374151;
          --gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      }
      body { font-family: 'Inter', sans-serif; background: var(--bg-primary); color: var(--text-primary); line-height: 1.7; margin: 0; }
      .container { max-width: 1000px; margin: 0 auto; padding: 2rem; }
      .header { text-align: center; margin-bottom: 3rem; }
      .header h1 { font-size: clamp(2.5rem, 5vw, 4rem); font-weight: 700; background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 0.5rem; }
      .version-badge { display: inline-flex; align-items: center; gap: 0.5rem; background: var(--bg-card); border: 1px solid var(--border-color); padding: 0.5rem 1.2rem; border-radius: 2rem; font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 1rem; }
      .status-badge { background: var(--accent-green); color: white; padding: 0.2rem 0.6rem; border-radius: 1rem; font-size: 0.8rem; font-weight: 600; }
      .description { font-size: 1.2rem; color: var(--text-secondary); max-width: 700px; margin: 0 auto 2rem; }
      .cards-grid { display: grid; gap: 2rem; margin: 3rem 0; }
      .card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 1.5rem; padding: 2rem; transition: all 0.3s ease; }
      .card:hover { transform: translateY(-8px); border-color: var(--accent-primary); }
      .card-title { font-size: 1.4rem; font-weight: 600; margin-bottom: 1rem; }
      .card-description { color: var(--text-secondary); margin-bottom: 1.5rem; }
      .endpoint-code { background: #1a1a1d; border: 1px solid var(--border-color); border-radius: 0.8rem; padding: 1rem; font-family: 'SF Mono', monospace; font-size: 0.9rem; color: var(--accent-primary); word-break: break-all; }
      .footer { text-align: center; margin-top: 4rem; padding: 2rem 0; border-top: 1px solid var(--border-color); color: #6b7280; }
      .warning { color: #f59e0b; font-weight: 500; }
  </style>
</head>
<body>
  <div class="container">
      <header class="header">
          <h1>?? Vavoo Stream Extractor</h1>
          <div class="version-badge">
              <span>v1.0</span>
              <span class="status-badge">ONLINE</span>
          </div>
          <p class="description">
              Estrazione stream Vavoo con autenticazione automatica e redirect diretto.
          </p>
      </header>
      <div class="cards-grid">
          <div class="card">
              <h3 class="card-title">Estrazione Stream</h3>
              <p class="card-description">
                  Fornisci un URL Vavoo per ottenere un redirect (302) diretto allo stream finale.<br>
                  <span class="warning">?? Nota:</span> Se gli stream non partono, disattiva IPv6 sulla tua connessione.
              </p>
              <div class="endpoint-code">${workerDomain}/manifest.m3u8?url=&lt;VAVOO_URL&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Proxy Playlist M3U</h3>
              <p class="card-description">
                  Fornisci una o pi? playlist M3U (separate da ';'). Il worker le unir? e riscriver? i canali Vavoo.
              </p>
              <div class="endpoint-code">${workerDomain}/playlist?url=&lt;URL1&gt;;&lt;URL2&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Debug & Status</h3>
              <p class="card-description">Visualizza informazioni sulla tua connessione e sullo stato del worker.</p>
              <div class="endpoint-code">${workerDomain}/status</div>
          </div>
      </div>
      <footer class="footer">
          <p>&copy; 2025 Vavoo Extractor</p>
      </footer>
  </div>
</body>
</html>`;
  return new Response(htmlContent, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

function handleStatus(request) {
  const clientIP = getClientIP(request);
  const statusInfo = {
      status: "operational",
      version: "1.0",
      timestamp: new Date().toISOString(),
      client_info: {
          ip: clientIP,
          country: request.headers.get('CF-IPCountry') || 'unknown',
          user_agent: request.headers.get('User-Agent') || 'unknown',
          is_ipv6: clientIP.includes(':'),
      },
      supported_services: {
          vavoo: { mode: "redirect", path: "/manifest.m3u8?url=https://vavoo.to/..." },
      },
      endpoints: {
          info: new URL(request.url).origin + '/',
          status: new URL(request.url).origin + '/status',
          playlist_proxy: new URL(request.url).origin + '/playlist?url=<m3u_url>',
      }
  };
  return new Response(JSON.stringify(statusInfo, null, 2), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

// --- Main Worker Fetch Handler ---

export default {
  async fetch(request) {
      if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);

      try {
          // --- ROUTING ---
          if (url.pathname === '/' || url.pathname === '') {
              return handleInfoPage(request);
          }
          if (url.pathname === '/status') {
              return handleStatus(request);
          }
          if (url.pathname === '/playlist') {
              return await handlePlaylistProxy(request);
          }

          if (url.pathname === '/manifest.m3u8') {
              if (url.searchParams.has('url')) {
                  const targetUrl = url.searchParams.get('url');

                  if (targetUrl.includes('vavoo.to')) {
                      const extractor = new VavooExtractor();
                      return await extractor.handle(targetUrl, request);
                  }

                  return new Response(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported.' }), {
                      status: 400,
                      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                  });
              }

              return new Response(JSON.stringify({ error: 'Missing "url" parameter' }), {
                  status: 400,
                  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
              });
          }

          if (url.pathname === '/proxy/hls/manifest.m3u8' || url.pathname === '/extractor/video') {
              const targetUrl = url.searchParams.get('d');
              // api_password is explicitly ignored

              if (targetUrl) {
                  if (targetUrl.includes('vavoo.to')) {
                      const extractor = new VavooExtractor();
                      return await extractor.handle(targetUrl, request);
                  }
                  return new Response(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported in parameter "d".' }), {
                      status: 400,
                      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                  });
              }

              return new Response(JSON.stringify({ error: 'Missing "d" parameter' }), {
                  status: 400,
                  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
              });
          }

          // --- 404 Not Found ---
          return new Response(JSON.stringify({ error: '404 Not Found' }), {
              status: 404,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });

      } catch (error) {
          console.error(`Worker Error: ${error.stack}`);
          const errorResponse = {
              error: error.message,
              type: error.name,
          };
          return new Response(JSON.stringify(errorResponse), {
              status: 500,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
      }
  },
};
