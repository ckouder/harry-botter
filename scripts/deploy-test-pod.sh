#!/bin/bash
# deploy-test-pod.sh — Deploy a single NanoClaw test pod to verify K8s setup
# Usage: ./scripts/deploy-test-pod.sh [--no-cleanup]
set -euo pipefail

NAMESPACE="harrybotter"
POD_NAME="nanoclaw-test"
SERVICE_NAME="nanoclaw-test"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NO_CLEANUP=0

for arg in "$@"; do
  case "$arg" in
    --no-cleanup) NO_CLEANUP=1 ;;
  esac
done

cleanup() {
  if [ "$NO_CLEANUP" = "1" ]; then
    echo "⏭️  Skipping cleanup (--no-cleanup). Remove manually:"
    echo "   kubectl delete pod $POD_NAME -n $NAMESPACE"
    echo "   kubectl delete service $SERVICE_NAME -n $NAMESPACE"
    echo "   kubectl delete secret nanoclaw-secrets -n $NAMESPACE"
    return
  fi
  echo ""
  echo "🧹 Cleaning up..."
  kubectl delete service "$SERVICE_NAME" -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
  kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found --grace-period=5 2>/dev/null || true
  kubectl delete secret nanoclaw-secrets -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
  echo "✅ Cleanup complete"
}

# Cleanup on exit unless --no-cleanup
if [ "$NO_CLEANUP" = "0" ]; then
  trap cleanup EXIT
fi

echo "========================================="
echo "  M1 — Single NanoClaw Pod Test Deploy"
echo "========================================="
echo ""

# 0. Preflight: check minikube / kubectl
echo "🔍 Preflight checks..."
if ! command -v kubectl &>/dev/null; then
  echo "❌ kubectl not found. Install it first."
  exit 1
fi

if ! kubectl cluster-info &>/dev/null; then
  echo "❌ No Kubernetes cluster reachable. Start minikube first: make bootstrap"
  exit 1
fi

# Ensure namespace exists
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - 2>/dev/null

echo "✅ Cluster reachable, namespace $NAMESPACE exists"
echo ""

# 1. Create test secret (dummy key for validation)
echo "🔑 Creating test secret..."
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-sk-ant-test-placeholder-key}"
kubectl create secret generic nanoclaw-secrets \
  --namespace="$NAMESPACE" \
  --from-literal=anthropic-api-key="$ANTHROPIC_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "✅ Secret created"
echo ""

# 2. Apply pod template
echo "🚀 Deploying test pod..."
kubectl apply -f "$PROJECT_DIR/k8s/base/nanoclaw-pod-template.yaml"
echo "✅ Pod manifest applied"
echo ""

# 3. Apply service
echo "🌐 Creating service..."
kubectl apply -f "$PROJECT_DIR/k8s/base/nanoclaw-service.yaml"
echo "✅ Service created"
echo ""

# 4. Wait for pod readiness
echo "⏳ Waiting for pod to be ready (timeout: 120s)..."
if kubectl wait --for=condition=Ready pod/"$POD_NAME" \
  -n "$NAMESPACE" --timeout=120s 2>/dev/null; then
  echo "✅ Pod is ready!"
else
  echo "⚠️  Pod did not become ready within 120s"
  echo ""
  echo "📋 Pod status:"
  kubectl describe pod "$POD_NAME" -n "$NAMESPACE" 2>/dev/null | tail -30
  echo ""
  echo "📜 Pod logs:"
  kubectl logs "$POD_NAME" -n "$NAMESPACE" --tail=50 2>/dev/null || echo "(no logs)"
  exit 1
fi
echo ""

# 5. Show pod info
echo "📋 Pod status:"
kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o wide
echo ""

# 6. Show logs
echo "📜 Pod logs (last 20 lines):"
kubectl logs "$POD_NAME" -n "$NAMESPACE" --tail=20
echo ""

# 7. Test healthcheck endpoints
echo "🏥 Testing health endpoints..."

# Port-forward in background
kubectl port-forward pod/"$POD_NAME" 13000:3000 -n "$NAMESPACE" &
PF_PID=$!
sleep 2

HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" http://localhost:13000/health 2>/dev/null || echo -e "\n000")
HEALTH_CODE=$(echo "$HEALTH_RESPONSE" | tail -1)
HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | head -1)

echo "  GET /health → $HEALTH_CODE"
echo "  Response: $HEALTH_BODY"

READY_RESPONSE=$(curl -s -w "\n%{http_code}" http://localhost:13000/ready 2>/dev/null || echo -e "\n000")
READY_CODE=$(echo "$READY_RESPONSE" | tail -1)
READY_BODY=$(echo "$READY_RESPONSE" | head -1)

echo "  GET /ready  → $READY_CODE"
echo "  Response: $READY_BODY"

# Kill port-forward
kill "$PF_PID" 2>/dev/null || true
wait "$PF_PID" 2>/dev/null || true
echo ""

# 8. Validate results
PASS=0
FAIL=0

if [ "$HEALTH_CODE" = "200" ]; then
  echo "✅ Health check passed"
  PASS=$((PASS + 1))
else
  echo "❌ Health check failed (expected 200, got $HEALTH_CODE)"
  FAIL=$((FAIL + 1))
fi

if [ "$READY_CODE" = "200" ] || [ "$READY_CODE" = "503" ]; then
  echo "✅ Readiness check responded (code: $READY_CODE)"
  PASS=$((PASS + 1))
else
  echo "❌ Readiness check failed (expected 200 or 503, got $READY_CODE)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

echo ""
echo "🎉 M1 test passed — NanoClaw pod runs in K8s!"
