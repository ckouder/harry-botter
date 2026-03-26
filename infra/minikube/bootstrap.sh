#!/usr/bin/env bash
# Harry Botter — Minikube Bootstrap Script
# Idempotent: safe to re-run
set -euo pipefail

# Configurable via environment
MINIKUBE_MEMORY="${MINIKUBE_MEMORY:-6g}"
MINIKUBE_CPUS="${MINIKUBE_CPUS:-4}"
MINIKUBE_DRIVER="${MINIKUBE_DRIVER:-docker}"
NAMESPACE="harrybotter"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "🚀 Harry Botter Infrastructure Bootstrap"
echo "   Memory: $MINIKUBE_MEMORY | CPUs: $MINIKUBE_CPUS | Driver: $MINIKUBE_DRIVER"

# --- 1. Start Minikube (idempotent) ---
if minikube status --format='{{.Host}}' 2>/dev/null | grep -q "Running"; then
    echo "✅ Minikube already running"
else
    echo "🔧 Starting Minikube..."
    minikube start \
        --memory="$MINIKUBE_MEMORY" \
        --cpus="$MINIKUBE_CPUS" \
        --driver="$MINIKUBE_DRIVER"
    echo "✅ Minikube started"
fi

# --- 2. Enable addons (idempotent) ---
echo "📦 Enabling addons..."
for addon in metrics-server ingress; do
    if minikube addons list -o json | grep -q "\"$addon\":{\"Status\":\"enabled\""; then
        echo "   ✅ $addon already enabled"
    else
        minikube addons enable "$addon"
        echo "   ✅ $addon enabled"
    fi
done

# --- 3. Create namespace (idempotent) ---
echo "📁 Creating namespace $NAMESPACE..."
kubectl apply -f "$PROJECT_ROOT/k8s/base/namespace.yaml"
echo "✅ Namespace $NAMESPACE ready"

# --- 4. Apply ResourceQuota ---
echo "📊 Applying ResourceQuota..."
kubectl apply -f "$PROJECT_ROOT/k8s/base/resource-quota.yaml"
echo "✅ ResourceQuota applied"

# --- 5. Apply RBAC ---
echo "🔐 Applying RBAC..."
kubectl apply -f "$PROJECT_ROOT/k8s/base/rbac.yaml"
echo "✅ RBAC applied"

# --- 6. Apply NetworkPolicy ---
echo "🔒 Applying NetworkPolicies..."
kubectl apply -f "$PROJECT_ROOT/k8s/base/network-policy.yaml"
echo "✅ NetworkPolicies applied"

# --- 7. Verify cluster health ---
echo "🏥 Verifying cluster health..."
kubectl cluster-info
kubectl get nodes
kubectl get namespace "$NAMESPACE"
kubectl get resourcequota -n "$NAMESPACE"
echo ""
echo "✅ Harry Botter infrastructure bootstrapped successfully!"
