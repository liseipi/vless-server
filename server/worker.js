import { connect } from "cloudflare:sockets";

const WS_OPEN = 1;
let userID = "55a95ae1-4ae8-4461-8484-457279821b40";

export default {
  async fetch(request, env) {
    try {
      userID = env.uuid || userID;

      const upgradeHeader = request.headers.get("Upgrade");

      if (!upgradeHeader || upgradeHeader !== "websocket") {
        const pathname = decodeURIComponent(new URL(request.url).pathname);

        if (pathname === `/${userID}`) {
          return new Response(getConfig(userID, request.headers.get("Host")), {
            status: 200,
            headers: { "Content-Type": "text/plain;charset=utf-8" },
          });
        }

        return new Response(JSON.stringify(request.cf, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json;charset=utf-8" },
        });
      }

      return await handleWebSocket(request);
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  },
};

async function handleWebSocket(request) {
  const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
  serverSocket.accept();

  const earlyData = request.headers.get("sec-websocket-protocol") || "";
  let remoteSocket = null;
  let udpWriter = null;
  let isDns = false;

  wsToReadable(serverSocket, earlyData).pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpWriter) return udpWriter(chunk);

      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      const header = parseHeader(chunk, userID);
      if (header.hasError) throw new Error(header.message);

      const responseHeader = new Uint8Array([header.version[0], 0]);
      const rawData = chunk.slice(header.dataOffset);

      if (header.isUDP) {
        if (header.port !== 53) throw new Error("UDP only supports DNS port 53");
        isDns = true;
        const { write } = await handleDnsUDP(serverSocket, responseHeader);
        udpWriter = write;
        udpWriter(rawData);
        return;
      }

      async function connectAndWrite(host, port) {
        const socket = await connect({ hostname: host, port });
        remoteSocket = socket;
        const writer = socket.writable.getWriter();
        await writer.write(rawData);
        writer.releaseLock();
        return socket;
      }

      async function retryWithNAT64() {
        try {
          const ipv6 = await resolveNAT64(header.address);
          const socket = await connect({ hostname: ipv6, port: header.port });
          remoteSocket = socket;
          const writer = socket.writable.getWriter();
          await writer.write(rawData);
          writer.releaseLock();
          socket.closed
              .catch(() => {})
              .finally(() => {
                if (serverSocket.readyState === WS_OPEN) serverSocket.close(1000, "");
              });
          pipeToWebSocket(socket, serverSocket, responseHeader, null);
        } catch (err) {
          serverSocket.close(1011, String(err));
        }
      }

      try {
        const socket = await connectAndWrite(header.address, header.port);
        pipeToWebSocket(socket, serverSocket, responseHeader, retryWithNAT64);
      } catch (_) {
        serverSocket.close(1011, "");
      }
    },
    close() { safeClose(remoteSocket); },
  })).catch(() => {
    safeClose(remoteSocket);
    if (serverSocket.readyState === WS_OPEN) serverSocket.close(1011, "");
  });

  return new Response(null, { status: 101, webSocket: clientSocket });
}

function wsToReadable(ws, earlyData) {
  return new ReadableStream({
    start(controller) {
      ws.addEventListener("message", (e) => controller.enqueue(e.data));
      ws.addEventListener("close", () => controller.close());
      ws.addEventListener("error", (e) => controller.error(e));

      if (earlyData) {
        try {
          const decoded = atob(earlyData.replace(/-/g, "+").replace(/_/g, "/"));
          controller.enqueue(Uint8Array.from(decoded, (c) => c.charCodeAt(0)).buffer);
        } catch (_) {}
      }
    },
  });
}

function parseHeader(buffer, uid) {
  if (buffer.byteLength < 24) return { hasError: true, message: "Header too short" };

  const view = new DataView(buffer);
  const version = new Uint8Array(buffer.slice(0, 1));

  if (bytesToUUID(new Uint8Array(buffer.slice(1, 17))) !== uid) {
    return { hasError: true, message: "Invalid UUID" };
  }

  const optionLength = view.getUint8(17);
  const command = view.getUint8(18 + optionLength);

  if (command !== 1 && command !== 2) {
    return { hasError: true, message: "Unsupported command (TCP=1, UDP=2)" };
  }

  let offset = 19 + optionLength;
  const port = view.getUint16(offset); offset += 2;
  const addressType = view.getUint8(offset++);
  let address = "";

  switch (addressType) {
    case 1:
      address = Array.from(new Uint8Array(buffer.slice(offset, offset + 4))).join(".");
      offset += 4;
      break;
    case 2: {
      const len = view.getUint8(offset++);
      address = new TextDecoder().decode(buffer.slice(offset, offset + len));
      offset += len;
      break;
    }
    case 3: {
      const parts = [];
      for (let i = 0; i < 8; i++) {
        parts.push(view.getUint16(offset).toString(16).padStart(4, "0"));
        offset += 2;
      }
      address = parts.join(":").replace(/(^|:)0+(\w)/g, "$1$2");
      break;
    }
    default:
      return { hasError: true, message: "Unknown address type" };
  }

  return {
    hasError: false,
    address,
    port,
    dataOffset: offset,
    version,
    isUDP: command === 2,
  };
}

function pipeToWebSocket(remoteSocket, ws, responseHeader, retry) {
  let headerSent = false;
  let hasData = false;

  remoteSocket.readable.pipeTo(new WritableStream({
    write(chunk) {
      hasData = true;
      if (ws.readyState !== WS_OPEN) return;

      if (!headerSent) {
        const combined = new Uint8Array(responseHeader.byteLength + chunk.byteLength);
        combined.set(new Uint8Array(responseHeader));
        combined.set(new Uint8Array(chunk), responseHeader.byteLength);
        ws.send(combined.buffer);
        headerSent = true;
      } else {
        ws.send(chunk);
      }
    },
    close() {
      if (!hasData && retry) { retry(); return; }
      if (ws.readyState === WS_OPEN) ws.close(1000, "");
    },
    abort() { safeClose(remoteSocket); },
  })).catch(() => {
    safeClose(remoteSocket);
    if (ws.readyState === WS_OPEN) ws.close(1011, "");
  });
}

async function handleDnsUDP(ws, responseHeader) {
  let headerSent = false;

  const transform = new TransformStream({
    transform(chunk, controller) {
      for (let i = 0; i < chunk.byteLength;) {
        const len = new DataView(chunk.slice(i, i + 2)).getUint16(0);
        controller.enqueue(new Uint8Array(chunk.slice(i + 2, i + 2 + len)));
        i += 2 + len;
      }
    },
  });

  transform.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const response = await fetch("https://1.1.1.1/dns-query", {
        method: "POST",
        headers: { "content-type": "application/dns-message" },
        body: chunk,
      });
      const buffer = await response.arrayBuffer();
      const size = buffer.byteLength;
      const sizeBytes = new Uint8Array([(size >> 8) & 0xff, size & 0xff]);

      if (ws.readyState === WS_OPEN) {
        const parts = headerSent ? [sizeBytes, buffer] : [responseHeader, sizeBytes, buffer];
        ws.send(await new Blob(parts).arrayBuffer());
        headerSent = true;
      }
    },
  })).catch(() => {});

  const writer = transform.writable.getWriter();
  return { write: (chunk) => writer.write(chunk) };
}

async function resolveNAT64(domain) {
  const response = await fetch(
      `https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      { headers: { Accept: "application/dns-json" } }
  );
  const data = await response.json();
  const record = data.Answer?.find((r) => r.type === 1);
  if (!record) throw new Error(`Cannot resolve A record for ${domain}`);

  const parts = record.data.split(".");
  if (parts.length !== 4) throw new Error("Invalid IPv4 address");

  const hex = parts.map((p) => parseInt(p, 10).toString(16).padStart(2, "0"));
  return `[2602:fc59:b0:64::${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
}

function safeClose(socket) {
  try { socket?.close(); } catch (_) {}
}

function bytesToUUID(bytes) {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function getConfig(uid, host) {
  const protocol = "vless";
  const link = `${protocol}://${uid}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=${encodeURIComponent("/?ed=2560")}#${host}`;
  return [
    `addr : ${host}`,
    `port : 443`,
    `uuid : ${uid}`,
    `net  : ws`,
    `tls  : tls`,
    `path : /?ed=2560`,
    ``,
    link,
  ].join("\n");
}