FROM node:22

WORKDIR /app

#CMD tail -f /dev/null
EXPOSE 4000

CMD ["node", "src/server.js"]
