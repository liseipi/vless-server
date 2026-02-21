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
                PORT: 2053,
                HOST: '0.0.0.0',
                UUID: '55a95ae1-4ae8-4461-8484-457279821b40'
            }
        }
    ]
};