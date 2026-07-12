FROM ubuntu:26.04

RUN apt update
RUN apt upgrade -y
RUN apt install -y \
      # for pnpm
      libatomic1 \
      xz-utils \
      curl \
      make \
      git
RUN apt autoremove -y

WORKDIR /root

# nodejs
WORKDIR /root
# https://nodejs.org/en/download/prebuilt-binaries
ARG NODE_VERSION=24.18.0
RUN curl -OL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz
RUN tar -xvf node-v${NODE_VERSION}-linux-x64.tar.xz
RUN rm node-v${NODE_VERSION}-linux-x64.tar.xz
RUN mv node-v${NODE_VERSION}-linux-x64 .node
ENV PATH $PATH:/root/.node/bin

# pnpm
RUN curl -fsSL https://get.pnpm.io/install.sh | bash -s -- -y
ENV PATH $PATH:/root/.local/share/pnpm/bin

RUN pnpm install -g @openai/codex

RUN git config --global --add safe.directory /application
WORKDIR /application
