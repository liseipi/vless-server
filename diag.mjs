import { WebSocket } from "ws";
import https from "https";
import net from "net";

// 测试1: 基础 TCP 连通性
function testTCP(host, port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    s.setTimeout(5000);
    s.once("connect", () => { s.destroy(); resolve({ ok: true, msg: `TCP ${host}:${port} 连通` }); });
    s.once("error",   (e) => resolve({ ok: false, msg: `TCP ${host}:${port} 失败: ${e.message}` }));
    s.once("timeout", ()  => { s.destroy(); resolve({ ok: false, msg: `TCP ${host}:${port} 超时` }); });
  });
}

// 测试2: HTTPS 连通性
function testHTTPS(host, port) {
  return new Promise((resolve) => {
    const req = https.request({ host, port, path: "/", method: "HEAD",
      servername: host, rejectUnauthorized: false, timeout: 5000 }, (res) => {
      resolve({ ok: true, msg: `HTTPS ${host}:${port} 响应 ${res.statusCode}` });
    });
    req.on("error",   (e) => resolve({ ok: false, msg: `HTTPS ${host}:${port} 失败: ${e.message}` }));
    req.on("timeout", ()  => { req.destroy(); resolve({ ok: false, msg: `HTTPS ${host}:${port} 超时` }); });
    req.end();
  });
}

// 测试3: WebSocket 连通性
function testWS(url, sni, wsHost) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { Host: wsHost },
      servername: sni,
      rejectUnauthorized: false,
      handshakeTimeout: 8000,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ ok: false, msg: `WS ${url} 超时` });
    }, 8000);
    ws.once("open",  () => { clearTimeout(timer); ws.terminate(); resolve({ ok: true,  msg: `WS ${url} 连通` }); });
    ws.once("error", (e) => { clearTimeout(timer); resolve({ ok: false, msg: `WS ${url} 失败: ${e.message}` }); });
  });
}

async function main() {
  console.log("=== 网络诊断 ===\n");
  const tests = [
    testTCP("broad.aicms.dpdns.org", 443),
    testTCP("vs.musicses.vip", 2053),
    testHTTPS("broad.aicms.dpdns.org", 443),
    testHTTPS("vs.musicses.vip", 2053),
    testWS("wss://broad.aicms.dpdns.org:443/?ed=2560", "broad.aicms.dpdns.org", "broad.aicms.dpdns.org"),
    testWS("wss://vs.musicses.vip:2053/?ed=2560",      "vs.musicses.vip",       "vs.musicses.vip"),
  ];
  const results = await Promise.all(tests);
  results.forEach(r => console.log((r.ok ? "✓" : "✗"), r.msg));
}

main();
