import net from "net";
import http from "http";
import { WebSocket } from "ws";
import { URL } from "url";

// ── 配置 ─────────────────────────────────────────────────────────────────────
const CFG = {
  server:   "broad.aicms.dpdns.org",
  port:     443,
  uuid:     "55a95ae1-4ae8-4461-8484-457279821b40",
  path:     "/?ed=2560",
  sni:      "broad.aicms.dpdns.org",
  wsHost:   "broad.aicms.dpdns.org",
  listenPort: 1099,
  security:   "none",   // "tls" 或 "none"
  rejectUnauthorized: false, // false = 允许自签名证书
};

// const CFG = {
//   server:     "vss.musicses.vip",
//   port:       443,
//   uuid:       "55a95ae1-4ae8-4461-8484-457279821b40",
//   path:       "/?ed=2560",
//   sni:        "vss.musicses.vip",
//   wsHost:     "vss.musicses.vip",
//   listenPort: 1099,
//   security:   "tls",   // "tls" 或 "none"
//   rejectUnauthorized: false, // false = 允许自签名证书
// };

// const CFG = {
//   server:     "www.gzdooh.com.cn",           // ← 改成你的 B 主机域名
//   port:       443,
//   uuid:       "55a95ae1-4ae8-4461-8484-457279821b40",
//   path:       "/vs?ed=2560",               // ← 使用 /vs 路径
//   sni:        "www.gzdooh.com.cn",           // ← 改成你的 B 主机域名
//   wsHost:     "www.gzdooh.com.cn",           // ← 改成你的 B 主机域名
//   listenPort: 1099,
//   security:   "tls",    // "tls" 或 "none"
//   rejectUnauthorized: false, // false = 允许自签名证书
// };

// ── VLESS 请求头构造 ──────────────────────────────────────────────────────────

function buildVlessHeader(uuid, host, port) {
  const uid = Buffer.from(uuid.replace(/-/g, ""), "hex");

  let atype, abuf;
  if (net.isIPv4(host)) {
    atype = 1;
    abuf  = Buffer.from(host.split(".").map(Number));
  } else if (net.isIPv6(host)) {
    atype = 3;
    abuf  = ipv6ToBytes(host.replace(/^\[|\]$/g, ""));
  } else {
    atype = 2;
    const db = Buffer.from(host, "utf8");
    abuf = Buffer.concat([Buffer.from([db.length]), db]);
  }

  const fixed = Buffer.allocUnsafe(22);
  let o = 0;
  fixed[o++] = 0x00;
  uid.copy(fixed, o); o += 16;
  fixed[o++] = 0x00;
  fixed[o++] = 0x01;
  fixed.writeUInt16BE(port, o); o += 2;
  fixed[o++] = atype;

  return Buffer.concat([fixed, abuf]);
}

function ipv6ToBytes(addr) {
  let groups;
  if (addr.includes("::")) {
    const [l, r] = addr.split("::");
    const left  = l ? l.split(":") : [];
    const right = r ? r.split(":") : [];
    const mid   = new Array(8 - left.length - right.length).fill("0");
    groups = [...left, ...mid, ...right];
  } else {
    groups = addr.split(":");
  }
  const buf = Buffer.allocUnsafe(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return buf;
}

// ── 开隧道 ────────────────────────────────────────────────────────────────────

function buildWsUrl() {
  // 与 Swift VlessTunnel.swift 逻辑对齐：
  // security=="tls" 或 port==443 时用 wss，否则用 ws
  const scheme = (CFG.security === "tls" || CFG.port === 443) ? "wss" : "ws";
  // path 中若含 ?，拆出 query 部分单独处理，避免被 ws 库二次编码
  const qIdx = CFG.path.indexOf("?");
  if (qIdx !== -1) {
    const p = CFG.path.slice(0, qIdx);
    const q = CFG.path.slice(qIdx + 1);
    return `${scheme}://${CFG.server}:${CFG.port}${p}?${q}`;
  }
  return `${scheme}://${CFG.server}:${CFG.port}${CFG.path}`;
}

function openTunnel(cb) {
  const url = buildWsUrl();
  const ws = new WebSocket(url, {
    headers: {
      "Host":          CFG.wsHost,
      "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Cache-Control": "no-cache",
      "Pragma":        "no-cache",
    },
    servername:         CFG.sni,               // TLS SNI
    rejectUnauthorized: CFG.rejectUnauthorized, // ✅ 修复1
    handshakeTimeout:   15000,
  });

  let done = false;

  function onOpen() {
    if (done) return; done = true;
    ws.off("error", onError);
    cb(null, ws);
  }

  function onError(e) {
    if (done) return; done = true;
    ws.off("open", onOpen);
    console.error("[tunnel error]", e.message);
    cb(e);
  }

  ws.once("open",  onOpen);
  ws.once("error", onError);
}

// ── 双向中继 ──────────────────────────────────────────────────────────────────

function relay(sock, ws) {
  // ✅ 修复3: 正确解析 VLESS 响应头长度（与 Swift ProxyServer.swift 对齐）
  // 响应头格式: version(1) + addon_len(1) + addon(addon_len)
  // 需要读够 2 字节后才知道实际头长度
  let respBuf     = Buffer.alloc(0);
  let respSkipped = false;
  let respHdrSize = -1;

  const onMsg = (data) => {
    if (sock.destroyed) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (respSkipped) {
      sock.write(buf);
      return;
    }

    respBuf = Buffer.concat([respBuf, buf]);
    if (respBuf.length < 2) return;

    if (respHdrSize === -1) {
      // byte[0]=version, byte[1]=addon_len => 总头长 = 2 + addon_len
      respHdrSize = 2 + respBuf[1];
    }
    if (respBuf.length < respHdrSize) return;

    respSkipped = true;
    const payload = respBuf.slice(respHdrSize);
    respBuf = Buffer.alloc(0);
    if (payload.length > 0) sock.write(payload);
  };

  const onData = (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  ws.on("message",  onMsg);
  sock.on("data",   onData);

  const cleanup = () => {
    ws.off("message",  onMsg);
    sock.off("data",   onData);
    try { ws.terminate(); } catch (_) {}
    try { sock.destroy(); } catch (_) {}
  };

  ws.once("close",   cleanup);
  ws.once("error",   cleanup);
  sock.once("close", cleanup);
  sock.once("error", cleanup);
}

// ── SOCKS5 ───────────────────────────────────────────────────────────────────

function handleSocks5(sock) {
  sock.once("data", (buf) => {
    if (buf[0] !== 0x05) return sock.destroy();
    sock.write(Buffer.from([0x05, 0x00]));

    sock.once("data", (req) => {
      if (req[0] !== 0x05 || req[1] !== 0x01) return sock.destroy();

      let host, port;
      const atyp = req[3];
      try {
        if (atyp === 0x01) {
          host = [req[4], req[5], req[6], req[7]].join(".");
          port = req.readUInt16BE(8);
        } else if (atyp === 0x03) {
          const len = req[4];
          host = req.slice(5, 5 + len).toString();
          port = req.readUInt16BE(5 + len);
        } else if (atyp === 0x04) {
          const g = [];
          for (let i = 0; i < 8; i++) g.push(req.readUInt16BE(4 + i * 2).toString(16));
          host = g.join(":");
          port = req.readUInt16BE(20);
        } else return sock.destroy();
      } catch (_) { return sock.destroy(); }

      // 先回复 SOCKS5 成功
      sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));

      // ✅ 修复4: 在 openTunnel 调用前就开始收集 early data，
      // 之前的代码是注册后立即 off，导致 pending 永远为空
      const pending = [];
      const onEarlyData = (d) => pending.push(Buffer.from(d));
      sock.on("data", onEarlyData);

      openTunnel((err, ws) => {
        sock.off("data", onEarlyData);   // 隧道就绪后取消收集

        if (err || sock.destroyed) {
          sock.destroy(); return;
        }

        const vlessHdr = buildVlessHeader(CFG.uuid, host, port);
        const firstPkt = pending.length > 0
            ? Buffer.concat([vlessHdr, ...pending])
            : vlessHdr;
        ws.send(firstPkt);

        relay(sock, ws);
      });
    });
  });

  sock.once("error", () => sock.destroy());
}

// ── HTTP CONNECT ──────────────────────────────────────────────────────────────

function handleConnect(req, sock, head) {
  const idx  = req.url.lastIndexOf(":");
  const host = req.url.slice(0, idx);
  const port = parseInt(req.url.slice(idx + 1), 10) || 443;

  try { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch (_) { return; }

  const pending = [];
  const onEarlyData = (d) => pending.push(Buffer.from(d));
  sock.on("data", onEarlyData);

  openTunnel((err, ws) => {
    sock.off("data", onEarlyData);

    if (err || sock.destroyed) {
      sock.destroy(); return;
    }

    const vlessHdr = buildVlessHeader(CFG.uuid, host, port);
    const parts = [vlessHdr];
    if (head && head.length) parts.push(head);
    if (pending.length > 0)  parts.push(...pending);
    ws.send(Buffer.concat(parts));

    relay(sock, ws);
  });

  sock.once("error", () => sock.destroy());
}

// ── 普通 HTTP 代理 ────────────────────────────────────────────────────────────

function handleHttp(req, res) {
  let u;
  try {
    u = new URL(req.url.startsWith("http") ? req.url : `http://${req.headers.host}${req.url}`);
  } catch (_) { res.writeHead(400); return res.end(); }

  const host = u.hostname;
  const port = parseInt(u.port, 10) || (u.protocol === "https:" ? 443 : 80);

  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end",  () => {
    openTunnel((err, ws) => {
      if (err) { res.writeHead(502); return res.end(); }

      const vlessHdr = buildVlessHeader(CFG.uuid, host, port);
      const line = `${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
      const hdrs = Object.entries(req.headers)
          .filter(([k]) => k !== "proxy-connection")
          .map(([k, v]) => `${k}: ${v}`).join("\r\n");
      const rawReq = Buffer.from(`${line}${hdrs}\r\n\r\n`);
      ws.send(Buffer.concat([vlessHdr, rawReq, ...chunks]));

      // ✅ 修复3: 同样用正确的 VLESS 响应头解析逻辑
      let respBuf     = Buffer.alloc(0);
      let respSkipped = false;
      let respHdrSize = -1;

      ws.on("message", (data) => {
        let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

        if (!respSkipped) {
          respBuf = Buffer.concat([respBuf, buf]);
          if (respBuf.length < 2) return;
          if (respHdrSize === -1) respHdrSize = 2 + respBuf[1];
          if (respBuf.length < respHdrSize) return;
          respSkipped = true;
          buf = respBuf.slice(respHdrSize);
          respBuf = Buffer.alloc(0);
          if (!buf.length) return;
        }

        if (!res.headersSent) {
          // 还没解析到 HTTP 响应头，先缓冲
          respBuf = Buffer.concat([respBuf, buf]);
          const sep = respBuf.indexOf("\r\n\r\n");
          if (sep === -1) return;

          const lines = respBuf.slice(0, sep).toString().split("\r\n");
          const [, code, ...msg] = lines[0].split(" ");
          const rhdrs = {};
          lines.slice(1).forEach(l => {
            const i = l.indexOf(": ");
            if (i > 0) rhdrs[l.slice(0, i).toLowerCase()] = l.slice(i + 2);
          });
          try {
            res.writeHead(parseInt(code, 10) || 200, msg.join(" "), rhdrs);
            const body = respBuf.slice(sep + 4);
            if (body.length) res.write(body);
          } catch (_) {}
          respBuf = Buffer.alloc(0);
        } else {
          try { res.write(buf); } catch (_) {}
        }
      });

      ws.once("close", () => { try { res.end(); } catch (_) {} });
      ws.once("error", () => { try { res.end(); } catch (_) {} });
    });
  });
}

// ── 混合监听 ──────────────────────────────────────────────────────────────────

const httpSrv = http.createServer(handleHttp);
httpSrv.on("connect", handleConnect);

const server = net.createServer((sock) => {
  sock.once("error", () => sock.destroy());
  sock.once("data", (buf) => {
    sock.pause();
    if (buf[0] === 0x05) {
      sock.unshift(buf); sock.resume();
      handleSocks5(sock);
    } else if (buf[0] >= 0x41 && buf[0] <= 0x5a) {
      sock.unshift(buf); sock.resume();
      httpSrv.emit("connection", sock);
    } else {
      sock.destroy();
    }
  });
});

server.listen(CFG.listenPort, "127.0.0.1", () => {
  console.log(`\n[proxy] 混合代理启动`);
  console.log(`[proxy] SOCKS5 → socks5://127.0.0.1:${CFG.listenPort}`);
  console.log(`[proxy] HTTP   → http://127.0.0.1:${CFG.listenPort}`);
  console.log(`[proxy] 远端   → ${buildWsUrl()}\n`);
});

server.on("error", (e) => console.error("[server error]", e.message));