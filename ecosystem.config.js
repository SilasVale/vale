module.exports = {
  apps: [{
    name: 'dsh',
    script: '/home/zhengsaisi/.nvm/versions/node/v24.20.0/bin/dsh',
    interpreter: '/home/zhengsaisi/.nvm/versions/node/v24.20.0/bin/node',
    args: 'web --port 7738 --trusted-host dsh.saisi.online',
    cwd: '/home/zhengsaisi/vale',
    autorestart: true,       // auto-restart on crash
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production'
    }
  }, {
    name: 'vale-studio',
    script: 'server.mjs',
    cwd: '/home/zhengsaisi/vale/studio',
    interpreter: '/home/zhengsaisi/.nvm/versions/node/v24.20.0/bin/node',
    autorestart: true,
    watch: false,
    max_memory_restart: '600M',
    env: {
      NODE_ENV: 'production'
    }
  }]
}
