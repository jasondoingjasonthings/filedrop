'use strict';

module.exports = {
  apps: [{
    name: 'filedrop',
    script: './index.js',
    cwd: '/opt/filedrop-repo/packages/server',
    restart_delay: 2000,
    max_restarts: 10,
    min_uptime: '5s',
    out_file: '/var/log/filedrop.log',
    error_file: '/var/log/filedrop.log',
    merge_logs: true,
    time: true,
  }],
};
