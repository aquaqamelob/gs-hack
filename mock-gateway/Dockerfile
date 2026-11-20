FROM oven/bun:1.3
WORKDIR /app
COPY server.ts ./
ENV PORT=80 SMTP_PORT=0
EXPOSE 80
CMD ["bun", "server.ts"]
