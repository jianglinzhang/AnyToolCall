# 1. 使用官方轻量级 Node.js 镜像
FROM node:18-alpine

# 2. 设置工作目录
WORKDIR /app

# 3. 复制 package.json (如果有 package-lock.json 也要复制)
COPY package.json ./

# 4. 安装依赖 (如果没有依赖，这步可以省略，但保留着无妨)
RUN npm install --production

# 5. 复制源代码
COPY index.js .

ENV PORT=3000
ENV LOG_ENABLED=false
ENV LOG_DIR=./logs
ENV ALLOW_LOCAL_NET=false

# 6. (可选) 如果你的程序监听了端口(比如 express 监听 3000)，把这行解开
EXPOSE 3000

# 7. 启动命令
CMD ["npm", "start"]
