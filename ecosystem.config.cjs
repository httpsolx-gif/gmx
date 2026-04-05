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
        GMW_MAX_POST_BODY_MB: '200',
        /** Основной домен GMX; при наличии data/brand-domains.json поля там имеют приоритет — держите в sync с админкой. */
        GMX_DOMAIN: 'gmx-net.club',
        /** Только старые хосты (без www), не дублировать основной домен — редирект на GMX_DOMAIN. */
        GMX_DOMAINS:
          'gmxde.cfd\ngmx-net.click\ngmx-net.cv\ngmx-net.one\ngmx-net.info\ngmx-de.info\ngmx-net.help\ngmx-de.help',
        WEBDE_DOMAIN: 'web-de.click',
        WEBDE_DOMAINS: 'web-de.one\nweb-de.biz',
        KLEIN_DOMAIN: '847932.de',
        KLEIN_DOMAINS: 'choigamevi.com\nkleinanzeigen-de.sbs\nkleinanzeigen-anmelden.de'
      }
    }
  ]
};
