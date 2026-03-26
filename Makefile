# Harry Botter — NanoClaw Runner for Slack
SHELL := /bin/bash

# Minikube config (override via env)
MINIKUBE_MEMORY ?= 6g
MINIKUBE_CPUS ?= 4
MINIKUBE_DRIVER ?= docker
NAMESPACE := harrybotter

# Use minikube's docker env to build images directly — no registry push needed.
IMAGE_NANOCLAW := harrybotter/nanoclaw-base:latest
IMAGE_ORCHESTRATOR := harrybotter/orchestrator:latest

# Ngrok config (override via env)
NGROK_PORT ?= 3001

.PHONY: bootstrap build deploy test clean dev tunnel setup

## === Quick Start (full local dev setup) ===

setup: bootstrap build
	@echo ""
	@echo "✅ Setup complete. Next steps:"
	@echo "   1. cp orchestrator/.env.example orchestrator/.env"
	@echo "   2. Fill in Slack tokens in orchestrator/.env"
	@echo "   3. make tunnel    (in one terminal)"
	@echo "   4. make dev       (in another terminal)"
	@echo "   5. /harrybotter create in Slack"

## === Development ===

run:
	@echo "🚀 Starting Harry Botter (requires minikube running + .env configured)..."
	@echo "   Event gateway: http://localhost:$${EVENT_GATEWAY_PORT:-3001}"
	@echo "   Run 'make tunnel' in another terminal for public HTTPS URL"
	cd orchestrator && npm run dev

dev: run

tunnel:
	@echo "🌐 Starting ngrok tunnel on port $(NGROK_PORT)..."
	@echo "   Copy the https URL to EVENT_GATEWAY_URL in orchestrator/.env"
	ngrok http $(NGROK_PORT)

## === M0: Infrastructure Bootstrap ===

bootstrap: minikube-start namespace base-image
	@echo "✅ Harry Botter infrastructure bootstrapped"

minikube-start:
	@echo "🚀 Starting Minikube..."
	minikube start \
		--memory=$(MINIKUBE_MEMORY) \
		--cpus=$(MINIKUBE_CPUS) \
		--driver=$(MINIKUBE_DRIVER) \
		--addons=metrics-server,ingress
	@echo "✅ Minikube running"

namespace:
	@echo "📁 Creating namespace $(NAMESPACE)..."
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f k8s/base/resource-quota.yaml
	@echo "✅ Namespace $(NAMESPACE) ready"

base-image:
	@echo "🐳 Building NanoClaw base image (inside minikube docker)..."
	eval $$(minikube docker-env) && \
		docker build --no-cache -t $(IMAGE_NANOCLAW) -f docker/Dockerfile.nanoclaw-base .
	@echo "✅ Base image built: $(IMAGE_NANOCLAW)"

## === Build ===

build: build-orchestrator build-nanoclaw
	@echo "✅ All images built"

build-orchestrator:
	eval $$(minikube docker-env) && \
		docker build -t $(IMAGE_ORCHESTRATOR) -f docker/Dockerfile.orchestrator orchestrator/

build-nanoclaw:
	eval $$(minikube docker-env) && \
		docker build --no-cache -t $(IMAGE_NANOCLAW) -f docker/Dockerfile.nanoclaw-base .

rebuild-nanoclaw:
	@echo "🔄 Rebuilding NanoClaw image (no cache)..."
	eval $$(minikube docker-env) && \
		docker build --no-cache -t $(IMAGE_NANOCLAW) -f docker/Dockerfile.nanoclaw-base .
	@echo "✅ Image rebuilt. Delete old pods to pick up changes:"
	@echo "   kubectl delete pod -n $(NAMESPACE) --all"

## === Deploy ===

deploy: helm-adopt
	helm upgrade --install harrybotter infra/helm/harrybotter \
		--namespace $(NAMESPACE) \
		--create-namespace

helm-adopt:
	@echo "🏷️  Labeling existing resources for Helm adoption..."
	@kubectl label namespace $(NAMESPACE) app.kubernetes.io/managed-by=Helm --overwrite 2>/dev/null || true
	@kubectl annotate namespace $(NAMESPACE) meta.helm.sh/release-name=harrybotter meta.helm.sh/release-namespace=$(NAMESPACE) --overwrite 2>/dev/null || true
	@kubectl label resourcequota harrybotter-quota -n $(NAMESPACE) app.kubernetes.io/managed-by=Helm --overwrite 2>/dev/null || true
	@kubectl annotate resourcequota harrybotter-quota -n $(NAMESPACE) meta.helm.sh/release-name=harrybotter meta.helm.sh/release-namespace=$(NAMESPACE) --overwrite 2>/dev/null || true

## === Debugging ===

pods:
	kubectl get pods -n $(NAMESPACE) -o wide

logs:
	@pod=$$(kubectl get pods -n $(NAMESPACE) -o name | head -1); \
	if [ -z "$$pod" ]; then echo "No pods found"; exit 1; fi; \
	kubectl logs -n $(NAMESPACE) $$pod --tail=50

logs-prev:
	@pod=$$(kubectl get pods -n $(NAMESPACE) -o name | head -1); \
	if [ -z "$$pod" ]; then echo "No pods found"; exit 1; fi; \
	kubectl logs -n $(NAMESPACE) $$pod --previous --tail=50

debug-pod:
	kubectl run debug --rm -it -n $(NAMESPACE) \
		--image=$(IMAGE_NANOCLAW) \
		--overrides='{"spec":{"containers":[{"name":"debug","image":"$(IMAGE_NANOCLAW)","imagePullPolicy":"Never","command":["/bin/bash"],"stdin":true,"tty":true,"resources":{"requests":{"cpu":"100m","memory":"256Mi"},"limits":{"cpu":"500m","memory":"512Mi"}}}]}}' \
		-- /bin/bash

## === Test ===

test:
	@echo "Running unit tests..."
	cd orchestrator && npm test

test-pod:
	@echo "🧪 Running single pod test..."
	./scripts/deploy-test-pod.sh

## === Clean ===

clean:
	helm uninstall harrybotter --namespace $(NAMESPACE) || true
	kubectl delete namespace $(NAMESPACE) || true

clean-pods:
	kubectl delete pod -n $(NAMESPACE) --all

nuke: clean
	minikube delete
