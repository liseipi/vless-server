// 最小化 VLESS 测试：直接连接 server，请求 www.google.com:80，看能否收到 HTTP 响应
import { WebSocket } from "ws";
import net from "net";

const CFG = {
  server: "vs.musicses.vip",
  port:   443,
  uuid:   "55a95ae1-4ae8-4461-8484-457279821b40",
  path:   "/?ed=2560",
  sni:    "vs.musicses.vip",
  wsHost: "vs.musicses.vip",
};

function buildHeader(uuid, host, port) {
  const uid = Buffer.from(uuid.replace(/-/g,""), "hex");
  const db  = Buffer.from(host, "utf8");
  // atype=2 (domain), fixed 22 bytes + [len, domain]
  const fixed = Buffer.allocUnsafe(22);
  let o = 0;
  fixed[o++] = 0x00;           // version
  uid.copy(fixed, o); o += 16; // uuid
  fixed[o++] = 0x00;           // addon len
  fixed[o++] = 0x01;           // cmd TCP
  fixed.writeUInt16BE(port, o); o += 2; // port
  fixed[o++] = 0x02;           // atype: domain
  return Buffer.concat([fixed, Buffer.from([db.length]), db]);
}

const ws = new WebSocket(`wss://${CFG.server}:${CFG.port}${CFG.path}`, {
  headers: { Host: CFG.wsHost },
  servername: CFG.sni,
  rejectUnauthorized: false,
  handshakeTimeout: 10000,
});

ws.once("open", () => {
  console.log("✓ WS 连接成功");
  const hdr = buildHeader(CFG.uuid, "www.google.com", 80);
  console.log(`  发送 VLESS 头 ${hdr.length} 字节`);
  console.log(`  header hex: ${hdr.toString("hex")}`);
  ws.send(hdr);

  // 发送 HTTP 请求
  const req = Buffer.from("GET / HTTP/1.1\r\nHost: www.google.com\r\nConnection: close\r\n\r\n");
  ws.send(req);
  console.log(`  发送 HTTP GET ${req.length} 字节`);
});

let msgCount = 0;
ws.on("message", (data) => {
  msgCount++;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (msgCount === 1) {
    console.log(`\n✓ 收到服务端首包 ${buf.length} 字节`);
    console.log(`  VLESS响应头(2字节): ${buf.slice(0,2).toString("hex")}`);
    const payload = buf.slice(2);
    console.log(`  payload(${payload.length}字节): ${payload.slice(0,100).toString()}`);
    if (buf.length > 2) {
      console.log("\n✓ 成功！服务端正常转发数据");
    } else {
      console.log("\n⚠ 首包只有2字节响应头，等待数据包...");
    }
  } else {
    console.log(`  包#${msgCount} ${buf.length}字节: ${buf.slice(0,80).toString().replace(/\r\n/g,"\\r\\n")}`);
    if (msgCount >= 3) { ws.terminate(); process.exit(0); }
  }
});

ws.once("error", (e) => console.error("✗ WS错误:", e.message));
ws.once("close", (code, reason) => {
  console.log(`\nWS关闭 code=${code} reason=${reason}`);
  if (msgCount === 0) console.error("✗ 没有收到任何数据！");
  process.exit(0);
});

setTimeout(() => { console.error("✗ 超时"); process.exit(1); }, 15000);
