module.exports = {
    apps: [
        {
            name: 'vless-server',
            script: './server.js',
            // 不要使用 cluster 模式，因为 WebSocket 不适合多进程
            instances: 1,
            exec_mode: 'fork',
            // 自动重启
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production',
                PORT: 8080,
                HOST: '0.0.0.0',
                TLS_CERT: '/etc/letsencrypt/live/vs.musicses.vip/fullchain.pem',
                TLS_KEY: '/etc/letsencrypt/live/vs.musicses.vip/privkey.pem',
                DEBUG: 'false',
                WS_PATH: '/vs',
                UUID: '55a95ae1-4ae8-4461-8484-457279821b40'
            }
        }
    ]
};