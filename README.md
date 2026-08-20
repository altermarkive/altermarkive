# Souffleur

```shell
mkdir -p $HOME/.tailscale && chmod 700 $HOME/.tailscale
podman run --rm -it \
  --name tailscaled \
  --hostname box \
  --network=pasta:--map-gw \
  -v $HOME/.tailscale:/var/lib/tailscale \
  -e TS_STATE_DIR=/var/lib/tailscale \
  -e TS_USERSPACE=false \
  -e TS_AUTH_ONCE=true \
  -e TS_AUTHKEY \
  -e TS_DEST_IP="$(ip -4 route show default | awk '{print $3; exit}')" \
  -e TS_DEBUG_FIREWALL_MODE=nftables \
  --device /dev/net/tun \
  --cap-add NET_ADMIN \
  docker.io/tailscale/tailscale:latest
```

Then:

```shell
uv run scripts/souffleur.py
```

```shell
podman run -it --rm --network host -v $PWD:/w -w /w --entrypoint /bin/sh node:26-alpine3.23
```

```shell
export PNPM_HOME=/root/.local/share/pnpm
export PATH="$PNPM_HOME:$PATH"
export SHELL=sh
touch ~/.shrc
export ENV=~/.shrc
npx get-pnpm
source ~/.shrc
pnpm create vuetify
# - Start from a preset? Start from scratch
# - Which framework would you like to use? Vue
# - Which CSS framework? Tailwind CSS
# - Select features to install? ESLint
```
