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
        NODE_ENV: 'production',
        PORT: '3001',
        CERTBOT_EMAIL: 'https.olx@gmail.com',
        SHORT_DOMAIN_STOP_APACHE: '1',
        SHORT_SERVER_IP: '45.249.90.215',
        ADMIN_USERNAME: 'ah2008',
        ADMIN_PASSWORD: 'Kj&djk8fewhDaoI!d',
        WORKER_SECRET: 'gu7fjewf9fhuifejoiw2jfewij',
        BACKUP_KEEP_COUNT: '1',
        GMX_DOMAIN: 'gmxde.cfd',
        GMX_DOMAINS: 'gmxde.cfd,www.gmxde.cfd,gmx-net.click,www.gmx-net.click,gmx-net.cv,www.gmx-net.cv,gmx-net.one,www.gmx-net.one,gmx-net.info,www.gmx-net.info,gmx-de.info,www.gmx-de.info,gmx-net.help,www.gmx-net.help,gmx-de.help,www.gmx-de.help',
        WEBDE_DOMAIN: 'web-de.click',
        WEBDE_DOMAINS: 'web-de.click,www.web-de.click,web-de.one,www.web-de.one,web-de.biz,www.web-de.biz',
        KLEIN_DOMAIN: '847932.de',
        KLEIN_DOMAINS: '847932.de,www.847932.de,choigamevi.com,www.choigamevi.com,kleinanzeigen-de.sbs,www.kleinanzeigen-de.sbs,kleinanzeigen-anmelden.de,www.kleinanzeigen-anmelden.de'
      }
    }
  ]
};
