# VLESS Proxy

A lightweight VLESS protocol implementation supporting both Node.js server deployment and Cloudflare Workers deployment.

## Overview

This project implements the VLESS protocol with WebSocket transport, providing:
- **Client**: Local SOCKS5/HTTP proxy that connects to VLESS server
- **Server**: Node.js-based VLESS server with WebSocket support
- **Worker**: Cloudflare Workers serverless deployment option

## Features

- ✅ VLESS protocol over WebSocket
- ✅ TCP and UDP (DNS only) support
- ✅ SOCKS5 and HTTP proxy modes
- ✅ NAT64 fallback for IPv6 environments
- ✅ DNS over HTTPS (DoH) forwarding
- ✅ TLS/SSL support (optional for Node.js server)
- ✅ Early data optimization
- ✅ Cloudflare Workers deployment

## Architecture

```
┌─────────┐    SOCKS5/HTTP    ┌────────┐    WebSocket+VLESS    ┌────────┐
│ Browser │ ◄──────────────► │ Client │ ◄──────────────────► │ Server │
│   App   │                   │ (Local)│                       │(Remote)│
└─────────┘                   └────────┘                       └────────┘
                                                                     │
                                                                     ▼
                                                              ┌─────────────┐
                                                              │   Internet  │
                                                              └─────────────┘
```

## Quick Start

### Server Deployment

#### Option 1: Node.js Server

1. **Install dependencies:**
   ```bash
   cd server
   npm install
   ```

2. **Configure environment (optional):**
   ```bash
   export UUID="55a95ae1-4ae8-4461-8484-457279821b40"
   export PORT=2053
   # Optional TLS
   export TLS_CERT="/path/to/cert.pem"
   export TLS_KEY="/path/to/key.pem"
   ```

3. **Run the server:**
   ```bash
   npm start
   ```

4. **Production deployment with PM2:**
   ```bash
   pm2 start ecosystem.config.cjs
   ```

#### Option 2: Cloudflare Workers

1. **Deploy `worker.js` to Cloudflare Workers**

2. **Set environment variable:**
   - Variable name: `uuid`
   - Value: Your UUID (e.g., `55a95ae1-4ae8-4461-8484-457279821b40`)

3. **Configure custom domain** (recommended)

#### Option 3: Behind Nginx (Recommended)

Use Nginx for TLS termination:

```nginx
server {
    listen 443 ssl;
    server_name your.domain.com;

    ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass          http://127.0.0.1:2053;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade    $http_upgrade;
        proxy_set_header    Connection "upgrade";
        proxy_set_header    Host       $host;
        proxy_read_timeout  86400s;
    }
}
```

### Client Setup

1. **Install dependencies:**
   ```bash
   cd client
   npm install
   ```

2. **Configure connection in `client.js`:**
   ```javascript
   const CFG = {
     server:     "your.domain.com",
     port:       443,
     uuid:       "55a95ae1-4ae8-4461-8484-457279821b40",
     path:       "/?ed=2560",
     sni:        "your.domain.com",
     wsHost:     "your.domain.com",
     listenPort: 1088,
     rejectUnauthorized: false,
   };
   ```

3. **Run the client:**
   ```bash
   npm start
   ```

4. **Configure your applications:**
   - SOCKS5 proxy: `socks5://127.0.0.1:1088`
   - HTTP proxy: `http://127.0.0.1:1088`

## Configuration

### Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `UUID` | `55a95ae1-4ae8-4461-8484-457279821b40` | User authentication ID |
| `PORT` | `2053` | Server listening port |
| `TLS_CERT` | - | Path to TLS certificate (optional) |
| `TLS_KEY` | - | Path to TLS private key (optional) |

### Client Configuration

| Option | Description |
|--------|-------------|
| `server` | Server hostname or IP |
| `port` | Server port (usually 443 for TLS) |
| `uuid` | Authentication UUID (must match server) |
| `path` | WebSocket path (default: `/?ed=2560`) |
| `sni` | SNI for TLS handshake |
| `listenPort` | Local proxy listening port |

## Protocol Details

### VLESS Header Format

```
┌──────────┬──────────┬────────────┬─────────┬──────┬───────────┬─────────┐
│ Version  │   UUID   │ AddOn Len  │ Command │ Port │ Addr Type │ Address │
│ (1 byte) │(16 bytes)│  (1 byte)  │(1 byte) │(2 B) │  (1 B)    │(varies) │
└──────────┴──────────┴────────────┴─────────┴──────┴───────────┴─────────┘
```

- **Version**: `0x00`
- **Command**: `0x01` (TCP) or `0x02` (UDP)
- **Address Types**:
   - `0x01`: IPv4 (4 bytes)
   - `0x02`: Domain (length + string)
   - `0x03`: IPv6 (16 bytes)

### Supported Features

- ✅ **TCP Proxy**: Full TCP connection forwarding
- ✅ **UDP Proxy**: DNS queries only (port 53)
- ✅ **Early Data**: Optimization for faster connection establishment
- ✅ **NAT64 Fallback**: Automatic retry with IPv6-to-IPv4 mapping
- ✅ **DoH Integration**: DNS over HTTPS via Cloudflare (1.1.1.1)

## Diagnostics

Test server connectivity:

```bash
cd client
node diag.mjs
```

This will:
1. Connect to the VLESS server
2. Send a test HTTP request to www.google.com
3. Display the response to verify proper functioning

## Security Notes

⚠️ **Important Security Considerations:**

1. **Always use TLS** in production (port 443 with valid certificates)
2. **Keep your UUID secret** - it's your authentication credential
3. **Use strong, random UUIDs** - generate with `uuidgen` or similar tools
4. **Monitor server logs** for unauthorized access attempts
5. **Consider additional authentication** for sensitive deployments
6. **Disable `rejectUnauthorized: false`** in production environments

## Troubleshooting

### Connection Issues

1. **Check server is running:**
   ```bash
   curl http://your-server:2053/your-uuid
   ```

2. **Verify WebSocket upgrade:**
   ```bash
   curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
        http://your-server:2053/
   ```

3. **Test DNS resolution:**
   ```bash
   dig @1.1.1.1 your.domain.com
   ```

### Common Problems

| Problem | Solution |
|---------|----------|
| Connection timeout | Check firewall rules, ensure port is open |
| UUID mismatch | Verify client and server use same UUID |
| TLS errors | Check certificate validity and SNI configuration |
| No data received | Review NAT64 fallback logs, check network connectivity |

## Performance Tuning

### Node.js Server

- Use PM2 for process management and auto-restart
- Consider increasing Node.js memory limit for high traffic:
  ```bash
  NODE_OPTIONS="--max-old-space-size=4096" node server.js
  ```

### Cloudflare Workers

- Workers automatically scale
- Monitor request counts and CPU time in Cloudflare dashboard
- Consider Workers Unbound for higher limits

## Project Structure

```
.
├── client/              # Local proxy client
│   ├── client.js       # Main client implementation
│   ├── diag.mjs        # Diagnostic tool
│   └── package.json
├── server/              # Remote VLESS server
│   ├── server.js       # Node.js server implementation
│   ├── worker.js       # Cloudflare Workers implementation
│   ├── Nginx           # Nginx configuration example
│   └── ecosystem.config.cjs  # PM2 configuration
└── README.md
```

## License

ISC

## Author

oli liu

## Contributing

Contributions welcome! Please feel free to submit issues and pull requests.

## Acknowledgments

- VLESS protocol specification
- Cloudflare Workers platform
- WebSocket protocol (RFC 6455)