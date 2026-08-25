module.exports = {
  apps: [{
    name: 'dsh',
    script: '/home/zhengsaisi/.nvm/versions/node/v22.22.3/bin/dsh',
    args: 'web --port 7738 --trusted-host dsh.saisi.online',
    cwd: '/home/zhengsaisi/vale',
    autorestart: true,       // 崩溃自动重启
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }, {
    name: 'vale-studio',
    script: 'server.mjs',
    cwd: '/home/zhengsaisi/vale/studio',
    interpreter: '/home/zhengsaisi/.nvm/versions/node/v22.22.3/bin/node',
    autorestart: true,
    watch: false,
    max_memory_restart: '600M',
    env: {
      NODE_ENV: 'production'
    }
  }]
}
