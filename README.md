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
make bootstrap    # Stand up Minikube + all infra
make build        # Build all Docker images
make deploy       # Deploy orchestrator to K8s
make test         # Run integration tests
```

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
