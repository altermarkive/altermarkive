#!/bin/sh

# Building/running containers from inside this container requires the host
# podman API socket. Enable it once on the host with:
#
#   systemctl --user enable --now podman.socket
#   loginctl enable-linger $(whoami)   # socket survives logout
#
# Verify with: podman -r info
# Tear it down again with:
#
#   systemctl --user disable --now podman.socket
#   loginctl disable-linger $(whoami)
#
# On SELinux hosts (Fedora/RHEL) also pass: --security-opt label=disable

podman run \
  -it \
  --rm \
  --pull=always \
  -e ANTHROPIC_API_KEY \
  -e HF_TOKEN \
  -e DISPLAY \
  -v /tmp/.X11-unix:/tmp/.X11-unix \
  --network host \
  --userns=keep-id \
  --device nvidia.com/gpu=all \
  -e PULSE_SERVER=unix:/run/user/$(id -u)/pulse/native \
  -e PIPEWIRE_REMOTE=/run/user/$(id -u)/pipewire-0 \
  -v /run/user/$(id -u)/pulse/native:/run/user/$(id -u)/pulse/native \
  -v /run/user/$(id -u)/pipewire-0:/run/user/$(id -u)/pipewire-0 \
  -v $HOME/.claude.json:/home/user/.claude.json \
  -v $HOME/.claude:/home/user/.claude \
  -v $HOME/.cache/huggingface:/home/user/.cache/huggingface \
  -v /run/user/$(id -u)/podman/podman.sock:/run/user/$(id -u)/podman/podman.sock \
  -e CONTAINER_HOST=unix:///run/user/$(id -u)/podman/podman.sock \
  -e DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock \
  -v $PWD:/home/user/workspace \
  -v $PWD:$PWD \
  -w /home/user/workspace \
  ghcr.io/marek-burza/utilities:latest
