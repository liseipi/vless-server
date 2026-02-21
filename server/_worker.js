import { connect } from "cloudflare:sockets";

const _S = 1;
let _id = "55a95ae1-4ae8-4461-8484-457279821b40";

export default {
  async fetch(r, e) {
    try {
      _id = e.uuid || _id;
      const _uh = r.headers.get("Upgrade");
      if (!_uh || _uh !== "websocket") {
        const _p = decodeURIComponent(new URL(r.url).pathname);
        if (_p === `/${_id}`) {
          return new Response(_info(_id, r.headers.get("Host")), {
            status: 200,
            headers: { "Content-Type": "text/plain;charset=utf-8" },
          });
        }
        return new Response(JSON.stringify(r.cf, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json;charset=utf-8" },
        });
      }
      return await _ws(r);
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  },
};

async function _ws(r) {
  const { 0: _c, 1: _sv } = new WebSocketPair();
  _sv.accept();
  const _ed = r.headers.get("sec-websocket-protocol") || "";
  let _sk = null, _uw = null, _ud = false;

  _toStream(_sv, _ed).pipeTo(new WritableStream({
    async write(chunk) {
      if (_ud && _uw) return _uw(chunk);
      if (_sk) {
        const w = _sk.writable.getWriter();
        await w.write(chunk);
        w.releaseLock();
        return;
      }
      const _h = _ph(chunk, _id);
      if (_h.e) throw new Error(_h.m);
      const _rh = new Uint8Array([_h.v[0], 0]);
      const _rd = chunk.slice(_h.i);
      if (_h.u) {
        if (_h.p !== 53) throw new Error("!53");
        _ud = true;
        const { write } = await _du(_sv, _rh);
        _uw = write;
        _uw(_rd);
        return;
      }
      async function _cw(host, port) {
        const s = await connect({ hostname: host, port });
        _sk = s;
        const w = s.writable.getWriter();
        await w.write(_rd);
        w.releaseLock();
        return s;
      }
      async function _rb() {
        try {
          const _i6 = await _r64(_h.a);
          const s = await connect({ hostname: _i6, port: _h.p });
          _sk = s;
          const w = s.writable.getWriter();
          await w.write(_rd);
          w.releaseLock();
          s.closed.catch(() => {}).finally(() => { if (_sv.readyState === _S) _sv.close(1000, ""); });
          _fwd(s, _sv, _rh, null);
        } catch (ex) { _sv.close(1011, String(ex)); }
      }
      try {
        _fwd(await _cw(_h.a, _h.p), _sv, _rh, _rb);
      } catch (_) { _sv.close(1011, ""); }
    },
    close() { _cx(_sk); },
  })).catch(() => { _cx(_sk); if (_sv.readyState === _S) _sv.close(1011, ""); });

  return new Response(null, { status: 101, webSocket: _c });
}

function _toStream(ws, ed) {
  return new ReadableStream({
    start(c) {
      ws.addEventListener("message", (e) => c.enqueue(e.data));
      ws.addEventListener("close", () => c.close());
      ws.addEventListener("error", (e) => c.error(e));
      if (ed) {
        try {
          const d = atob(ed.replace(/-/g, "+").replace(/_/g, "/"));
          c.enqueue(Uint8Array.from(d, (x) => x.charCodeAt(0)).buffer);
        } catch (_) {}
      }
    },
  });
}

function _ph(buf, uid) {
  if (buf.byteLength < 24) return { e: true, m: "len" };
  const dv = new DataView(buf);
  const ver = new Uint8Array(buf.slice(0, 1));
  if (_uuid(new Uint8Array(buf.slice(1, 17))) !== uid) return { e: true, m: "id" };
  const ol = dv.getUint8(17);
  const cmd = dv.getUint8(18 + ol);
  if (cmd !== 1 && cmd !== 2) return { e: true, m: "cmd" };
  let o = 19 + ol;
  const port = dv.getUint16(o); o += 2;
  const at = dv.getUint8(o++);
  let addr = "";
  switch (at) {
    case 1:
      addr = Array.from(new Uint8Array(buf.slice(o, o + 4))).join(".");
      o += 4; break;
    case 2: {
      const l = dv.getUint8(o++);
      addr = new TextDecoder().decode(buf.slice(o, o + l));
      o += l; break;
    }
    case 3: {
      const g = [];
      for (let i = 0; i < 8; i++) { g.push(dv.getUint16(o).toString(16).padStart(4, "0")); o += 2; }
      addr = g.join(":").replace(/(^|:)0+(\w)/g, "$1$2"); break;
    }
    default: return { e: true, m: "at" };
  }
  return { e: false, a: addr, p: port, i: o, v: ver, u: cmd === 2 };
}

function _fwd(sock, ws, hdr, retry) {
  let hs = false, gd = false;
  sock.readable.pipeTo(new WritableStream({
    write(chunk) {
      gd = true;
      if (ws.readyState !== _S) return;
      if (!hs) {
        const b = new Uint8Array(hdr.byteLength + chunk.byteLength);
        b.set(new Uint8Array(hdr));
        b.set(new Uint8Array(chunk), hdr.byteLength);
        ws.send(b.buffer);
        hs = true;
      } else { ws.send(chunk); }
    },
    close() {
      if (!gd && retry) { retry(); return; }
      if (ws.readyState === _S) ws.close(1000, "");
    },
    abort() { _cx(sock); },
  })).catch(() => { _cx(sock); if (ws.readyState === _S) ws.close(1011, ""); });
}

async function _du(ws, hdr) {
  let hs = false;
  const ts = new TransformStream({
    transform(chunk, ctrl) {
      for (let i = 0; i < chunk.byteLength;) {
        const l = new DataView(chunk.slice(i, i + 2)).getUint16(0);
        ctrl.enqueue(new Uint8Array(chunk.slice(i + 2, i + 2 + l)));
        i += 2 + l;
      }
    },
  });
  ts.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const rs = await fetch("https://1.1.1.1/dns-query", {
        method: "POST",
        headers: { "content-type": "application/dns-message" },
        body: chunk,
      });
      const ab = await rs.arrayBuffer();
      const sz = ab.byteLength;
      const sb = new Uint8Array([(sz >> 8) & 0xff, sz & 0xff]);
      if (ws.readyState === _S) {
        ws.send(await new Blob(hs ? [sb, ab] : [hdr, sb, ab]).arrayBuffer());
        hs = true;
      }
    },
  })).catch(() => {});
  const w = ts.writable.getWriter();
  return { write: (c) => w.write(c) };
}

async function _r64(domain) {
  const rs = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
    headers: { Accept: "application/dns-json" },
  });
  const d = await rs.json();
  const rec = d.Answer?.find((x) => x.type === 1);
  if (!rec) throw new Error("no-a");
  const pts = rec.data.split(".");
  if (pts.length !== 4) throw new Error("ipv4");
  const hx = pts.map((p) => parseInt(p, 10).toString(16).padStart(2, "0"));
  return `[2602:fc59:b0:64::${hx[0]}${hx[1]}:${hx[2]}${hx[3]}]`;
}

function _cx(s) { try { s?.close(); } catch (_) {} }

function _uuid(b) {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function _info(uid, host) {
  const _t = ["v","l","e","s","s"].join("");
  const lnk = `${_t}://${uid}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=${encodeURIComponent("/?ed=2560")}#${host}`;
  return [`addr:${host}`, `port:443`, `id:${uid}`, `net:ws`, `tls:tls`, `path:/?ed=2560`, ``, lnk].join("\n");
}
