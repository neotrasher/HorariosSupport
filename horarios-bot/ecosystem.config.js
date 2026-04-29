module.exports = {
  apps: [
    {
      name: 'horarios-bot',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC'
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      time: true
    }
  ]
};
