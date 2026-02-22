import net from "net";
import http from "http";
import { WebSocket } from "ws";
import { URL } from "url";

// ── 配置 ─────────────────────────────────────────────────────────────────────
// const CFG = {
//   server:   "broad.aicms.dpdns.org",
//   port:     443,
//   uuid:     "55a95ae1-4ae8-4461-8484-457279821b40",
//   path:     "/?ed=2560",
//   sni:      "broad.aicms.dpdns.org",
//   wsHost:   "broad.aicms.dpdns.org",
//   listenPort: 1088,
//   rejectUnauthorized: false,
// };

const CFG = {
  server:     "vs.musicses.vip",
  port:       443,
  uuid:       "55a95ae1-4ae8-4461-8484-457279821b40",
  path:       "/?ed=2560",
  sni:        "vs.musicses.vip",
  wsHost:     "vs.musicses.vip",
  listenPort: 1088,
  rejectUnauthorized: false,
};

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
//
// 核心修复：不在 open 时立刻发 VLESS 头
// 而是返回 ws 对象，由调用方把 VLESS头 + 第一个数据包 合并后一次发送
// 这样 server.js 的 pendingData 就包含数据，不会出现竞态丢包

function openTunnel(cb) {
  const ws = new WebSocket(`wss://${CFG.server}:${CFG.port}${CFG.path}`, {
    headers: {
      "Host":          CFG.wsHost,
      "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Cache-Control": "no-cache",
      "Pragma":        "no-cache",
    },
    servername:         CFG.sni,
    rejectUnauthorized: CFG.rejectUnauthorized,
    handshakeTimeout:   10000,
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
    cb(e);
  }

  ws.once("open",  onOpen);
  ws.once("error", onError);
}

// ── 双向中继 ──────────────────────────────────────────────────────────────────

function relay(sock, ws) {
  let first = true;

  const onMsg = (data) => {
    if (sock.destroyed) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (first) {
      first = false;
      // 跳过 VLESS 响应头 2 字节
      if (buf.length > 2) sock.write(buf.slice(2));
      return;
    }
    sock.write(buf);
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

      // 先回复 SOCKS5 成功，让本地立刻开始发数据
      sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));

      // 同时开隧道
      openTunnel((err, ws) => {
        if (err || sock.destroyed) {
          sock.destroy(); return;
        }

        // 收集 sock 在隧道建立期间发来的数据
        const pending = [];
        const onEarlyData = (d) => pending.push(Buffer.from(d));
        sock.on("data", onEarlyData);

        // 等 WS open 后，把 VLESS头 + 所有已到达数据 合并一次发送
        // openTunnel 回调时 WS 已 open，直接发
        sock.off("data", onEarlyData);
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

  // 先回 200，让浏览器/客户端立刻开始发 TLS ClientHello
  try { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch (_) { return; }

  // 收集 200 之后本地发来的早期数据（TLS ClientHello 等）
  const pending = [];
  const onEarlyData = (d) => pending.push(Buffer.from(d));
  sock.on("data", onEarlyData);

  openTunnel((err, ws) => {
    sock.off("data", onEarlyData);

    if (err || sock.destroyed) {
      sock.destroy(); return;
    }

    // VLESS头 + head(如有) + 所有早期数据 合并一次发送
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

  // 先读完整 HTTP 请求 body
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end",  () => {
    openTunnel((err, ws) => {
      if (err) { res.writeHead(502); return res.end(); }

      // VLESS头 + 完整 HTTP 请求 合并一次发送
      const vlessHdr = buildVlessHeader(CFG.uuid, host, port);
      const line = `${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
      const hdrs = Object.entries(req.headers)
          .filter(([k]) => k !== "proxy-connection")
          .map(([k, v]) => `${k}: ${v}`).join("\r\n");
      const rawReq = Buffer.from(`${line}${hdrs}\r\n\r\n`);
      ws.send(Buffer.concat([vlessHdr, rawReq, ...chunks]));

      let skip = true, parsed = false, rbuf = Buffer.alloc(0);

      ws.on("message", (data) => {
        let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (skip) { skip = false; buf = buf.slice(2); }
        if (!buf.length) return;

        if (parsed) { try { res.write(buf); } catch (_) {} return; }

        rbuf = Buffer.concat([rbuf, buf]);
        const idx = rbuf.indexOf("\r\n\r\n");
        if (idx === -1) return;

        parsed = true;
        const lines = rbuf.slice(0, idx).toString().split("\r\n");
        const [, code, ...msg] = lines[0].split(" ");
        const rhdrs = {};
        lines.slice(1).forEach(l => {
          const i = l.indexOf(": ");
          if (i > 0) rhdrs[l.slice(0, i).toLowerCase()] = l.slice(i + 2);
        });
        try {
          res.writeHead(parseInt(code, 10) || 200, msg.join(" "), rhdrs);
          const body = rbuf.slice(idx + 4);
          if (body.length) res.write(body);
        } catch (_) {}
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
  console.log(`[proxy] 远端   → wss://${CFG.server}:${CFG.port}${CFG.path}\n`);
});

server.on("error", (e) => console.error("[server error]", e.message));
