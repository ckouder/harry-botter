# Harry Botter — NanoClaw Runner for Slack
SHELL := /bin/bash

# Minikube config (override via env)
MINIKUBE_MEMORY ?= 6g
MINIKUBE_CPUS ?= 4
MINIKUBE_DRIVER ?= docker
NAMESPACE := harrybotter

# Use minikube's docker env to build images directly — no registry push needed.
# Images built inside minikube's docker daemon are immediately available to pods.
IMAGE_NANOCLAW := harrybotter/nanoclaw-base:latest
IMAGE_ORCHESTRATOR := harrybotter/orchestrator:latest

.PHONY: bootstrap build deploy test clean

## === M0: Infrastructure Bootstrap ===

bootstrap: minikube-start namespace base-image helm-init
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
		docker build -t $(IMAGE_NANOCLAW) -f docker/Dockerfile.nanoclaw-base .
	@echo "✅ Base image built: $(IMAGE_NANOCLAW)"

helm-init:
	@echo "📊 Initializing Helm charts..."
	@echo "✅ Helm charts ready"

## === Build ===

build: build-orchestrator build-nanoclaw
	@echo "✅ All images built"

build-orchestrator:
	eval $$(minikube docker-env) && \
		docker build -t $(IMAGE_ORCHESTRATOR) -f docker/Dockerfile.orchestrator orchestrator/

build-nanoclaw:
	eval $$(minikube docker-env) && \
		docker build -t $(IMAGE_NANOCLAW) -f docker/Dockerfile.nanoclaw-base .

## === Deploy ===

deploy:
	helm upgrade --install harrybotter infra/helm/harrybotter \
		--namespace $(NAMESPACE) \
		--create-namespace

## === M1: Single Pod Test ===

test-pod:
	@echo "🧪 Running M1 single pod test..."
	./scripts/deploy-test-pod.sh

test-pod-keep:
	@echo "🧪 Running M1 single pod test (no cleanup)..."
	./scripts/deploy-test-pod.sh --no-cleanup

## === Test ===

test:
	@echo "Running integration tests..."
	cd orchestrator && npm test

## === Clean ===

clean:
	helm uninstall harrybotter --namespace $(NAMESPACE) || true
	kubectl delete namespace $(NAMESPACE) || true

nuke: clean
	minikube delete
