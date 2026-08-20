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
uv run utilities/scripts/souffleur.py
```
