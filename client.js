import net from "net";
import http from "http";
import https from "https";
import tls from "tls";
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
// };

const CFG = {
  server:     "vs.musicses.vip",
  port:       443,
  uuid:       "55a95ae1-4ae8-4461-8484-457279821b40",
  path:       "/?ed=2560",
  sni:        "vs.musicses.vip",
  wsHost:     "vs.musicses.vip",
  listenPort: 1088,
};

// ── VLESS 请求头 ──────────────────────────────────────────────────────────────

function buildVlessHeader(uuid, host, port) {
  const uid = Buffer.from(uuid.replace(/-/g, ""), "hex"); // 16 bytes

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

  const fixed = Buffer.allocUnsafe(22); // 1+16+1+1+2+1
  let o = 0;
  fixed[o++] = 0x00;                     // version
  uid.copy(fixed, o); o += 16;           // uuid
  fixed[o++] = 0x00;                     // addon length
  fixed[o++] = 0x01;                     // cmd TCP
  fixed.writeUInt16BE(port, o); o += 2;  // port
  fixed[o++] = atype;                    // addr type

  return Buffer.concat([fixed, abuf]);
}

function ipv6ToBytes(addr) {
  let groups;
  if (addr.includes("::")) {
    const [l, r] = addr.split("::");
    const left   = l ? l.split(":") : [];
    const right  = r ? r.split(":") : [];
    const mid    = new Array(8 - left.length - right.length).fill("0");
    groups = [...left, ...mid, ...right];
  } else {
    groups = addr.split(":");
  }
  const buf = Buffer.allocUnsafe(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return buf;
}

// ── 开隧道 ────────────────────────────────────────────────────────────────────

function openTunnel(host, port, cb) {
  const ws = new WebSocket(`wss://${CFG.server}:${CFG.port}${CFG.path}`, {
    headers:            { Host: CFG.wsHost },
    servername:         CFG.sni,
    rejectUnauthorized: false,
    handshakeTimeout:   10000,
  });

  // ⚠️ 只注册一次 open / error，不重复注册
  let done = false;
  function onOpen() {
    if (done) return; done = true;
    ws.off("error", onError);
    try {
      ws.send(buildVlessHeader(CFG.uuid, host, port));
      cb(null, ws);
    } catch (e) {
      ws.terminate();
      cb(e);
    }
  }
  function onError(e) {
    if (done) return; done = true;
    ws.off("open", onOpen);
    cb(e);
  }

  ws.once("open",  onOpen);
  ws.once("error", onError);
}

// ── 中继 ──────────────────────────────────────────────────────────────────────

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

  ws.on("message",   onMsg);
  sock.on("data",    onData);

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

      console.log(`[socks5] ${host}:${port}`);
      openTunnel(host, port, (err, ws) => {
        if (err) {
          console.error(`[socks5] failed ${host}:${port} -`, err.message);
          try { sock.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0,0,0,0, 0,0])); } catch (_) {}
          return sock.destroy();
        }
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
        relay(sock, ws);
      });
    });
  });
}

// ── HTTP CONNECT ──────────────────────────────────────────────────────────────

function handleConnect(req, sock, head) {
  const idx  = req.url.lastIndexOf(":");
  const host = req.url.slice(0, idx);
  const port = parseInt(req.url.slice(idx + 1), 10) || 443;

  console.log(`[connect] ${host}:${port}`);
  openTunnel(host, port, (err, ws) => {
    if (err) {
      console.error(`[connect] failed ${host}:${port} -`, err.message);
      try { sock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch (_) {}
      return sock.destroy();
    }
    try { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch (_) { return; }
    if (head && head.length) ws.send(head);
    relay(sock, ws);
  });
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
  req.on("end", () => {
    console.log(`[http] ${host}:${port}`);
    openTunnel(host, port, (err, ws) => {
      if (err) {
        console.error(`[http] failed ${host}:${port} -`, err.message);
        res.writeHead(502); return res.end();
      }

      const line  = `${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
      const hdrs  = Object.entries(req.headers)
          .filter(([k]) => k !== "proxy-connection")
          .map(([k, v]) => `${k}: ${v}`).join("\r\n");
      ws.send(Buffer.concat([Buffer.from(`${line}${hdrs}\r\n\r\n`), ...chunks]));

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

// ── 混合入口 ──────────────────────────────────────────────────────────────────

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
      // A-Z 开头，HTTP 方法（GET/POST/CONNECT 等）
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