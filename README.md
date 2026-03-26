# Harry Botter — NanoClaw Runner for Slack

Slack chatbot that provisions per-user NanoClaw (OpenClaw) instances as Kubernetes pods on Minikube. Users interact via slash commands and DMs. Per-user Slack apps created via Manifest API. BYOK Anthropic keys with org-shared fallback.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Slack User     │────▶│  Harry Botter Master  │────▶│   K8s API       │
│  /harrybotter    │     │  (Orchestrator Pod)   │     │  (Minikube)     │
└─────────────────┘     └──────────────────────┘     └────────┬────────┘
                                │                              │
                                │ Manifest API                 │
                                ▼                              ▼
                        ┌──────────────┐            ┌──────────────────┐
                        │ Per-User     │            │  nc-{user_hash}  │
                        │ Slack App    │◀──────────▶│  NanoClaw Pod    │
                        └──────────────┘            └──────────────────┘
```

## Milestones

- **M0**: Infrastructure Bootstrap (Minikube + namespace + base image)
- **M1**: Single NanoClaw Pod (prove it runs in K8s)
- **M2**: Harry Botter Slack App (orchestrator + Manifest API)
- **M3**: Pod Lifecycle & Self-Service Provisioning
- **M4**: Secrets Management (BYOK)
- **M5**: Data Persistence & Retention (Option C)
- **M6**: Observability & Hardening

## Quick Start

```bash
make setup        # Bootstrap Minikube + build all Docker images
```

Then configure your environment and start the services:

```bash
cp orchestrator/.env.example orchestrator/.env
# Fill in Slack tokens and other secrets in orchestrator/.env
```

In one terminal:
```bash
make tunnel       # Start ngrok tunnel (copy the https URL to EVENT_GATEWAY_URL in .env)
```

In another terminal:
```bash
make dev          # Start the orchestrator (local dev mode)
```

Then use `/harrybotter create` in Slack.

## Available Make Targets

| Target | Description |
|---|---|
| `make setup` | Full local dev setup: bootstrap Minikube + build all images |
| `make bootstrap` | Start Minikube, create namespace, build base image |
| `make build` | Build all Docker images (orchestrator + NanoClaw) |
| `make deploy` | Deploy orchestrator to Kubernetes via Helm |
| `make dev` | Run orchestrator locally in dev mode |
| `make tunnel` | Start ngrok tunnel on `NGROK_PORT` (default: 3001) |
| `make test` | Run unit tests |
| `make test-pod` | Run single pod integration test |
| `make pods` | List pods in the `harrybotter` namespace |
| `make logs` | Tail logs from the first pod |
| `make logs-prev` | Tail previous container logs |
| `make debug-pod` | Launch an interactive debug pod |
| `make rebuild-nanoclaw` | Rebuild NanoClaw image without cache |
| `make clean` | Uninstall Helm release and delete namespace |
| `make clean-pods` | Delete all pods in the namespace |
| `make nuke` | `clean` + delete the Minikube cluster |

## Project Structure

```
harry-botter/
├── docker/           # Dockerfiles (base NanoClaw, orchestrator)
├── infra/            # Minikube setup, Helm charts
│   ├── minikube/     # Minikube bootstrap scripts
│   └── helm/         # Helm charts
├── orchestrator/     # Harry Botter master app (Node.js/TypeScript)
│   └── src/
├── k8s/              # Raw K8s manifests (base + overlays)
├── scripts/          # Utility scripts
├── docs/             # Design docs, ADRs
├── Makefile          # Top-level commands
└── README.md
```

## Target

- 500 users
- Minikube (PoC)
- Per-user BYOK Anthropic keys + org-shared fallback
- Option C data persistence (in-container + configurable retention)
