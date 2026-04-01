module.exports = {
  apps: [
    {
      name: 'gmx-net',
      script: 'server.js',
      cwd: '/var/www/gmx-net.help-v2',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '15s',
      max_restarts: 1000,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      kill_timeout: 5000,
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
