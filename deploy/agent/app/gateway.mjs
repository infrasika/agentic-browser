export function gatewayConfiguration(origin) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || !/^[a-zA-Z0-9.:[\]-]+$/.test(url.host)) throw new Error('Invalid gateway origin');
  return `worker_processes 1;
error_log /dev/stderr warn;
pid /tmp/nginx.pid;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  access_log off;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  resolver 127.0.0.11 valid=10s ipv6=off;
  upstream chat { zone chat 64k; server agent:3080 resolve; }
  upstream viewer { zone viewer 64k; server browser:8082 resolve; }
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  server {
    listen 8080;
    server_name _;
    if ($http_host != "${url.host}") { return 421; }
    client_max_body_size 10m;
    client_body_timeout 15s;
    proxy_http_version 1.1;
    proxy_set_header Host "${url.host}";
    proxy_set_header X-Forwarded-Host "${url.host}";
    proxy_set_header X-Forwarded-Proto ${url.protocol.slice(0, -1)};
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Forwarded '';
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-User-ID '';
    proxy_set_header X-Tenant-ID '';
    proxy_set_header X-Conversation-ID '';
    proxy_set_header X-Task-ID '';
    proxy_set_header X-Actor '';
    proxy_set_header X-Agent-Run-ID '';
    proxy_set_header X-Service-Key '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_next_upstream off;
    location ~ ^/(?:mcp|api/mcp|internal|browser/(?:mcp|internal))(?:/|$) { return 404; }
    location ~ ^/(?:connect|view|claim)(?:/|$) { return 410; }
    location = /browser/v1/observe { proxy_pass http://viewer; }
    location = /browser/v1/input { proxy_pass http://viewer; }
    location = /browser { return 404; }
    location ^~ /browser/ { return 404; }
    location / { proxy_pass http://chat; }
  }
}
`;
}
