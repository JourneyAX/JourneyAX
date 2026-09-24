# Pinned Activepieces image (LTS release 0.39.1)
FROM activepieces/activepieces:0.39.1

USER root

# Directory for Activepieces application and packages
WORKDIR /usr/src/app

# Copy the JourneyAX custom piece into the activepieces container
COPY packages/activepieces-piece-journeyax /usr/src/app/packages/activepieces-piece-journeyax

# Build and install the JourneyAX piece
RUN cd /usr/src/app/packages/activepieces-piece-journeyax \
    && npm ci --omit=dev || npm install --omit=dev \
    && npm run build

# Switch back to unprivileged node user
USER node

EXPOSE 80
