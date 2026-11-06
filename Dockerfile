FROM node:lts-alpine

# 应用目录固定为 /app: 入口用绝对路径启动, 与 cwd 无关
WORKDIR /app

COPY index.js index.html package.json ./

EXPOSE 3000/tcp

RUN apk add --no-cache ca-certificates gcompat &&\
    chmod +x /app/index.js

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/index.js"]
