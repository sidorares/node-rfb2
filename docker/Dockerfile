# RFB (VNC) test servers for node-rfb2's integration tests; see README.md. One build target per
# server (tigervnc, x11vnc, tightvnc, turbovnc, qemu), used by compose.yaml.
#
# Multi-arch: everything comes from Debian packages (or the official TurboVNC .deb for the build
# architecture), so the images build natively on amd64 (CI) and arm64 (Apple Silicon).
# Test-only: no secrets; the credentials and certificates are public on purpose.

ARG DEBIAN=debian:trixie-20260918-slim
# Nothing here uses GL: Mesa's drivers (and LLVM, which they pull in) only take space.
ARG STRIP_MESA="rm -rf /usr/lib/*/dri /usr/lib/*/libgallium-*.so /usr/lib/*/libLLVM*.so* /usr/lib/*/libz3.so*"

FROM ${DEBIAN} AS debian
# Optional: install packages from a fixed snapshot.debian.org date (e.g. 20260918T000000Z) instead
# of the live trixie mirrors, to pin every package version.
ARG DEBIAN_SNAPSHOT=
RUN set -eu; \
  if [ -n "$DEBIAN_SNAPSHOT" ]; then \
    printf '%s\n' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}" \
      'Suites: trixie trixie-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      'Check-Valid-Until: no' \
      '' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}" \
      'Suites: trixie-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      'Check-Valid-Until: no' \
      > /etc/apt/sources.list.d/debian.sources; \
  fi

# rfb2-xsetup (test card, cursor, pointer position on an X server), rfb2-clipboard, the test card
# as PPM, and the QEMU boot card (a boot sector on a 1.44 MB floppy image).
FROM debian AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev libx11-dev libxext-dev libxfixes-dev netpbm nasm \
  && rm -rf /var/lib/apt/lists/*
COPY src/rfb2-xsetup.c src/rfb2-clipboard.c src/bootcard.asm assets/testcard.png /src/
RUN gcc -O2 -Wall -Wextra -o /src/rfb2-xsetup /src/rfb2-xsetup.c -lXext -lX11 \
  && gcc -O2 -Wall -Wextra -o /src/rfb2-clipboard /src/rfb2-clipboard.c -lXfixes -lX11 \
  && pngtopnm /src/testcard.png > /src/testcard.ppm \
  && nasm -f bin -o /src/bootcard.img /src/bootcard.asm \
  && truncate -s 1474560 /src/bootcard.img

# The TurboVNC server, from the official release .deb for this architecture (checksums from the
# GitHub release). Only Xvnc, vncpasswd and the security config are kept: no Java viewer.
FROM debian AS turbovnc-fetch
ARG TURBOVNC_VERSION=3.3.1
ARG TURBOVNC_SHA256_AMD64=5d99050312360a07c28aca484b944816aa32e9fe07912e3ed50e6bfda45f80ad
ARG TURBOVNC_SHA256_ARM64=ad2448cd80997174c47b507e058fc385716aa9bd71c04e149f8da5a98fa77a9b
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
  arch=$(dpkg --print-architecture); \
  case "$arch" in \
    amd64) sha=$TURBOVNC_SHA256_AMD64 ;; \
    arm64) sha=$TURBOVNC_SHA256_ARM64 ;; \
    *) echo "no TurboVNC .deb for $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/turbovnc.deb \
    "https://github.com/TurboVNC/turbovnc/releases/download/${TURBOVNC_VERSION}/turbovnc_${TURBOVNC_VERSION}_${arch}.deb"; \
  echo "$sha  /tmp/turbovnc.deb" | sha256sum -c -; \
  dpkg-deb -x /tmp/turbovnc.deb /x; \
  mkdir -p /out/opt/TurboVNC/bin /out/etc; \
  cp /x/opt/TurboVNC/bin/Xvnc /x/opt/TurboVNC/bin/vncpasswd /out/opt/TurboVNC/bin/; \
  cp /x/etc/turbovncserver-security.conf /out/etc/

# Common to all servers: the user rfb (password rfb2test, for PAM), the healthcheck.
FROM debian AS base
RUN useradd --create-home --uid 1000 --shell /bin/bash rfb \
  && echo 'rfb:rfb2test' | chpasswd \
  && mkdir -p -m 1777 /tmp/.X11-unix
COPY --chmod=755 bin/rfb2-healthcheck /usr/local/bin/
ENV LANG=C.UTF-8

# X servers: rfb2-xsetup and the assets it puts on screen, rfb2-clipboard.
FROM base AS xbase
RUN apt-get update \
  && apt-get install -y --no-install-recommends libx11-6 libxext6 libxfixes3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/rfb2-xsetup /src/rfb2-clipboard /usr/local/bin/
COPY --from=build /src/testcard.ppm /usr/share/rfb2/
COPY assets/testcard.png assets/cursor.png assets/cursor.xbm assets/cursor-mask.xbm /usr/share/rfb2/
COPY --chmod=755 bin/rfb2-x11-setup /usr/local/bin/

FROM xbase AS tigervnc
ARG STRIP_MESA
RUN apt-get update \
  && apt-get install -y --no-install-recommends tigervnc-standalone-server tigervnc-tools \
  && sh -c "$STRIP_MESA" \
  && rm -rf /var/lib/apt/lists/*
COPY certs/test-server.pem certs/test-server-key.pem /etc/rfb2/certs/
COPY --chmod=755 bin/start-tigervnc /usr/local/bin/
USER rfb
WORKDIR /home/rfb
ENTRYPOINT ["start-tigervnc"]

FROM xbase AS x11vnc
ARG STRIP_MESA
RUN apt-get update \
  && apt-get install -y --no-install-recommends x11vnc xvfb openssl openssl-provider-legacy \
  && sh -c "$STRIP_MESA" \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 bin/start-x11vnc bin/rfb2-x11vnc-warmup /usr/local/bin/
USER rfb
WORKDIR /home/rfb
ENTRYPOINT ["start-x11vnc"]

FROM xbase AS tightvnc
ARG STRIP_MESA
RUN apt-get update \
  && apt-get install -y --no-install-recommends tightvncserver xfonts-base \
  && sh -c "$STRIP_MESA" \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 bin/start-tightvnc /usr/local/bin/
USER rfb
WORKDIR /home/rfb
ENTRYPOINT ["start-tightvnc"]

FROM xbase AS turbovnc
ARG STRIP_MESA
# The libraries TurboVNC's Xvnc links, plus xkbcomp and the XKB data for its keyboard.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libxau6 libxdmcp6 libxfont2 libpixman-1-0 libxshmfence1 libgbm1 libgl1 libsm6 libice6 libdrm2 \
    x11-xkb-utils xkb-data \
  && sh -c "$STRIP_MESA" \
  && rm -rf /var/lib/apt/lists/*
COPY --from=turbovnc-fetch /out/ /
COPY --chmod=755 bin/start-turbovnc /usr/local/bin/
USER rfb
WORKDIR /home/rfb
ENTRYPOINT ["start-turbovnc"]

FROM base AS qemu
RUN apt-get update \
  && apt-get install -y --no-install-recommends qemu-system-x86 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/bootcard.img /usr/share/rfb2/
COPY --chmod=755 bin/start-qemu /usr/local/bin/
USER rfb
WORKDIR /home/rfb
ENTRYPOINT ["start-qemu"]
