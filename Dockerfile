# Use the official Node.js 18 image.
# https://cloud.google.com/nodejs/docs/setup
FROM node:18-slim

# Create and change to the app directory inside the container.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json AND package-lock.json are copied.
# Copying this separately prevents re-running npm install when only the code changes.
COPY package*.json ./

# Install production dependencies.
RUN npm install --production

# Copy local code to the container image.
COPY . .

# Run the web service on the container's port 8080.
ENV PORT 8080
EXPOSE 8080

# Run the server.js script.
CMD [ "npm", "start" ]
