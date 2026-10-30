# 反代公共头（被 nginx.conf 的各个 location include）。
#
# 扩展名刻意用 .inc 而不是 .conf：nginx 只会自动 include conf.d/*.conf，
# 这个文件必须靠显式 include 进来，不会被当成独立 server 块加载。
#
# X-Request-Id：客户端带了就透传（后端会校验格式），没带则由 nginx 生成，
# 这样从 nginx 到后端再到日志能串成一条链路。
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Request-Id      $forwarded_request_id;
proxy_http_version 1.1;
