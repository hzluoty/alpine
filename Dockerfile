FROM node:lts-alpine
WORKDIR /tmp

COPY index.js index.html package.json ./

EXPOSE 3000/tcp

RUN apk add --no-cache ca-certificates gcompat &&\
    chmod +x index.js

CMD ["node", "index.js"]
