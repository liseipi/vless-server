import net from "net";
import http from "http";
import https from "https";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";

// ── 配置 ─────────────────────────────────────────────────────────────────────

const CONFIG = {
  userID:  process.env.UUID     || "55a95ae1-4ae8-4461-8484-457279821b40",
  port:    parseInt(process.env.PORT || "2053"),
  tlsCert: process.env.TLS_CERT || "",
  tlsKey:  process.env.TLS_KEY  || "",
};

// ── HTTP/HTTPS 服务器 ─────────────────────────────────────────────────────────

let server;
if (CONFIG.tlsCert && CONFIG.tlsKey) {
  server = https.createServer({
    cert: fs.readFileSync(CONFIG.tlsCert),
    key:  fs.readFileSync(CONFIG.tlsKey),
  });
  console.log(`[mode] WSS (TLS)`);
} else {
  server = http.createServer();
  console.log(`[mode] WS (plain)`);
}

server.on("request", (req, res) => {
  // host 头只取域名部分，去掉端口
  const hostname = (req.headers.host || "").split(":")[0];
  const pathname = decodeURIComponent(
      new URL(req.url, `http://${req.headers.host}`).pathname
  );

  if (pathname === `/${CONFIG.userID}`) {
    res.writeHead(200, { "Content-Type": "text/plain;charset=utf-8" });
    res.end(getConfig(CONFIG.userID, hostname));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json;charset=utf-8" });
  res.end(JSON.stringify({ host: hostname, path: pathname }, null, 2));
});

// ── WebSocket 服务器 ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const earlyData = req.headers["sec-websocket-protocol"] || "";
  handleVless(ws, earlyData);
});

// ── VLESS 连接核心处理 ────────────────────────────────────────────────────────

function handleVless(ws, earlyData) {
  let remoteSocket   = null;
  let udpWriter      = null;
  let isDns          = false;
  let initialized    = false;   // 首包是否已解析
  let respHeader     = null;
  let pendingData    = null;    // 首包的 payload
  let retryFn        = null;

  // 统一消息入口
  function onMessage(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);

    // DNS UDP 模式
    if (isDns && udpWriter) {
      udpWriter(chunk);
      return;
    }

    // TCP 已连接，直接转发
    if (remoteSocket && !remoteSocket.destroyed) {
      remoteSocket.write(chunk);
      return;
    }

    // 首包：解析 VLESS 头
    if (!initialized) {
      initialized = true;
      const header = parseVlessHeader(chunk, CONFIG.userID);

      if (header.hasError) {
        console.error("[auth]", header.message);
        ws.close(1008, header.message);
        return;
      }

      respHeader  = Buffer.from([header.version[0], 0]);
      pendingData = chunk.slice(header.dataOffset);

      if (header.isUDP) {
        if (header.port !== 53) { ws.close(1008, "UDP: only port 53"); return; }
        isDns     = true;
        udpWriter = createDnsHandler(ws, respHeader);
        udpWriter(pendingData);
        return;
      }

      // 定义 NAT64 重试
      retryFn = async () => {
        try {
          const ipv6 = await resolveNAT64(header.address);
          console.log(`[retry] NAT64 ${ipv6}:${header.port}`);
          tcpConnect(ipv6, header.port);
        } catch (err) {
          console.error("[retry failed]", err.message);
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, "");
        }
      };

      tcpConnect(header.address, header.port);
    }
  }

  // 建立 TCP 连接并双向绑定
  function tcpConnect(host, port) {
    console.log(`[tcp] connect ${host}:${port}`);

    const socket = net.createConnection({ host, port });
    socket.setTimeout(30000);

    socket.once("connect", () => {
      remoteSocket = socket;
      // 发送首包 payload
      if (pendingData && pendingData.length > 0) socket.write(pendingData);

      let headerSent = false;
      let hasData    = false;

      // 远端 → WebSocket
      socket.on("data", (data) => {
        hasData = true;
        if (ws.readyState !== WebSocket.OPEN) return;

        if (!headerSent) {
          ws.send(Buffer.concat([respHeader, data]));
          headerSent = true;
        } else {
          ws.send(data);
        }
      });

      socket.once("close", () => {
        if (!hasData && retryFn) {
          const fn = retryFn;
          retryFn = null;
          fn();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, "");
      });

      socket.on("error", (err) => {
        console.error(`[tcp error] ${host}:${port} -`, err.message);
        safeDestroy(socket);
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, "");
      });

      socket.on("timeout", () => {
        console.error(`[tcp timeout] ${host}:${port}`);
        safeDestroy(socket);
      });
    });

    socket.once("error", (err) => {
      console.error(`[tcp connect error] ${host}:${port} -`, err.message);
      if (retryFn) {
        const fn = retryFn;
        retryFn = null;
        fn();
      } else {
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, "");
      }
    });
  }

  // 绑定 WebSocket 消息监听
  ws.on("message", onMessage);
  ws.on("close",   () => safeDestroy(remoteSocket));
  ws.on("error",   () => safeDestroy(remoteSocket));

  // 处理早期数据
  if (earlyData) {
    try {
      const buf = Buffer.from(
          earlyData.replace(/-/g, "+").replace(/_/g, "/"),
          "base64"
      );
      onMessage(buf);
    } catch (_) {}
  }
}

// ── DNS over UDP → DoH 转发 ───────────────────────────────────────────────────

function createDnsHandler(ws, respHeader) {
  let headerSent = false;
  let buf        = Buffer.alloc(0);

  return function (chunk) {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= 2) {
      const pktLen = buf.readUInt16BE(0);
      if (buf.length < 2 + pktLen) break;

      const packet = buf.slice(2, 2 + pktLen);
      buf = buf.slice(2 + pktLen);

      fetch("https://1.1.1.1/dns-query", {
        method:  "POST",
        headers: { "content-type": "application/dns-message" },
        body:    packet,
      })
          .then((r) => r.arrayBuffer())
          .then((ab) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const data    = Buffer.from(ab);
            const sizeBuf = Buffer.allocUnsafe(2);
            sizeBuf.writeUInt16BE(data.length);
            const payload = Buffer.concat(
                headerSent ? [sizeBuf, data] : [respHeader, sizeBuf, data]
            );
            ws.send(payload);
            headerSent = true;
          })
          .catch((e) => console.error("[dns error]", e.message));
    }
  };
}

// ── VLESS 协议头解析 ──────────────────────────────────────────────────────────

function parseVlessHeader(buf, uid) {
  if (buf.length < 24) return { hasError: true, message: "Header too short" };

  const version = buf.slice(0, 1);
  if (bytesToUUID(buf.slice(1, 17)) !== uid) {
    return { hasError: true, message: "Invalid UUID" };
  }

  const optLen  = buf[17];
  const command = buf[18 + optLen];
  if (command !== 1 && command !== 2) {
    return { hasError: true, message: "Unsupported command" };
  }

  let offset = 19 + optLen;
  const port = buf.readUInt16BE(offset); offset += 2;
  const addrType = buf[offset++];
  let address = "";

  switch (addrType) {
    case 1:
      address = Array.from(buf.slice(offset, offset + 4)).join(".");
      offset += 4;
      break;
    case 2: {
      const len = buf[offset++];
      address   = buf.slice(offset, offset + len).toString();
      offset   += len;
      break;
    }
    case 3: {
      const parts = [];
      for (let i = 0; i < 8; i++) {
        parts.push(buf.readUInt16BE(offset).toString(16).padStart(4, "0"));
        offset += 2;
      }
      address = parts.join(":").replace(/(^|:)0+(\w)/g, "$1$2");
      break;
    }
    default:
      return { hasError: true, message: "Unknown address type" };
  }

  return { hasError: false, address, port, dataOffset: offset, version, isUDP: command === 2 };
}

// ── NAT64 回退 ────────────────────────────────────────────────────────────────

async function resolveNAT64(domain) {
  const res  = await fetch(
      `https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      { headers: { Accept: "application/dns-json" } }
  );
  const data = await res.json();
  const rec  = data.Answer?.find((r) => r.type === 1);
  if (!rec) throw new Error(`No A record: ${domain}`);
  return `::ffff:${rec.data}`;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function safeDestroy(socket) {
  try { socket?.destroy(); } catch (_) {}
}

function bytesToUUID(buf) {
  const h = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function getConfig(uid, hostname) {
  const isTLS    = !!(CONFIG.tlsCert && CONFIG.tlsKey);
  const security = isTLS ? "tls" : "none";
  const protocol = "vless";
  const link = [
    `${protocol}://${uid}@${hostname}:${CONFIG.port}`,
    `?encryption=none`,
    `&security=${security}`,
    `&sni=${hostname}`,
    `&fp=randomized`,
    `&type=ws`,
    `&host=${hostname}`,
    `&path=${encodeURIComponent("/?ed=2560")}`,
    `#${hostname}`,
  ].join("");

  return [
    `addr : ${hostname}`,
    `port : ${CONFIG.port}`,
    `uuid : ${uid}`,
    `net  : ws`,
    `tls  : ${security}`,
    `sni  : ${hostname}`,
    `path : /?ed=2560`,
    ``,
    link,
  ].join("\n");
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

server.listen(CONFIG.port, "0.0.0.0", () => {
  console.log(`[vless] server started on port ${CONFIG.port}`);
  console.log(`[vless] uuid : ${CONFIG.userID}`);
  console.log(`[vless] config: http://YOUR_IP:${CONFIG.port}/${CONFIG.userID}`);
});

server.on("error", (err) => console.error("[server error]", err.message));
