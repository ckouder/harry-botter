# M1 — Single NanoClaw Pod (Manual Deploy)

Proves a single NanoClaw (OpenClaw) instance can run inside a K8s pod with health checks.

## Prerequisites

- Minikube running (`make bootstrap` or `minikube start`)
- `kubectl` configured
- NanoClaw base image built (`make build-nanoclaw`)

## Quick Test

```bash
# Run the automated test script
./scripts/deploy-test-pod.sh

# Keep the pod running after test (skip cleanup)
./scripts/deploy-test-pod.sh --no-cleanup
```

## What It Does

1. Creates a `nanoclaw-secrets` Secret (uses `ANTHROPIC_API_KEY` env var or placeholder)
2. Deploys `nanoclaw-test` pod from `k8s/base/nanoclaw-pod-template.yaml`
3. Creates a ClusterIP service for internal access
4. Waits for pod readiness (120s timeout)
5. Tests health endpoints via port-forward:
   - `GET /health` → 200 with `{status: "healthy", uptime: ...}`
   - `GET /ready` → 200 (ready) or 503 (not yet initialized)
6. Cleans up (unless `--no-cleanup`)

## Manual Steps

### Deploy

```bash
# Create namespace
kubectl create namespace harrybotter --dry-run=client -o yaml | kubectl apply -f -

# Create secret
kubectl create secret generic nanoclaw-secrets \
  --namespace=harrybotter \
  --from-literal=anthropic-api-key="$ANTHROPIC_API_KEY"

# Deploy pod + service
kubectl apply -f k8s/base/nanoclaw-pod-template.yaml
kubectl apply -f k8s/base/nanoclaw-service.yaml

# Wait for ready
kubectl wait --for=condition=Ready pod/nanoclaw-test -n harrybotter --timeout=120s
```

### Verify

```bash
# Check pod status
kubectl get pod nanoclaw-test -n harrybotter

# Check logs
kubectl logs nanoclaw-test -n harrybotter

# Port-forward and test health
kubectl port-forward pod/nanoclaw-test 3000:3000 -n harrybotter &
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

### Cleanup

```bash
kubectl delete pod nanoclaw-test -n harrybotter
kubectl delete service nanoclaw-test -n harrybotter
kubectl delete secret nanoclaw-secrets -n harrybotter
```

## Pod Spec Summary

| Property | Value |
|----------|-------|
| Image | `localhost:5000/nanoclaw-base:latest` |
| CPU request/limit | 100m / 500m |
| Memory request/limit | 256Mi / 512Mi |
| Health port | 3000 |
| Liveness | HTTP GET /health (10s initial, 15s period) |
| Readiness | HTTP GET /ready (5s initial, 10s period) |
| Security | runAsNonRoot, readOnlyRootFilesystem, drop ALL caps |
| Volumes | emptyDir for /data and /tmp |
| Grace period | 30s |

## Architecture

```
┌─────────────────────────────────┐
│  nanoclaw-test pod              │
│                                 │
│  ┌───────────────────────────┐  │
│  │  entrypoint.sh            │  │
│  │  ├─ healthcheck-server.js │  │  ← :3000 /health, /ready
│  │  └─ openclaw gateway      │  │  ← NanoClaw instance
│  └───────────────────────────┘  │
│                                 │
│  Volumes:                       │
│  /data  (emptyDir)              │
│  /tmp   (emptyDir)              │
└─────────────────────────────────┘
```

## Next: M2

With M1 validated, M2 builds the Harry Botter orchestrator that programmatically creates these pods per-user via the Slack Manifest API.
