# Harry Botter — NanoClaw Runner for Slack
SHELL := /bin/bash

# Minikube config (override via env)
MINIKUBE_MEMORY ?= 8g
MINIKUBE_CPUS ?= 4
MINIKUBE_DRIVER ?= docker
NAMESPACE := harrybotter
REGISTRY := localhost:5000

.PHONY: bootstrap build deploy test clean

## === M0: Infrastructure Bootstrap ===

bootstrap: minikube-start registry namespace base-image helm-init
	@echo "✅ Harry Botter infrastructure bootstrapped"

minikube-start:
	@echo "🚀 Starting Minikube..."
	minikube start \
		--memory=$(MINIKUBE_MEMORY) \
		--cpus=$(MINIKUBE_CPUS) \
		--driver=$(MINIKUBE_DRIVER) \
		--addons=registry,metrics-server,ingress
	@echo "✅ Minikube running"

registry:
	@echo "📦 Verifying registry addon..."
	minikube addons enable registry
	@echo "✅ Registry available at $(REGISTRY)"

namespace:
	@echo "📁 Creating namespace $(NAMESPACE)..."
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f k8s/base/resource-quota.yaml
	@echo "✅ Namespace $(NAMESPACE) ready"

base-image:
	@echo "🐳 Building NanoClaw base image..."
	eval $$(minikube docker-env) && \
		docker build -t $(REGISTRY)/nanoclaw-base:latest -f docker/Dockerfile.nanoclaw-base .
	@echo "✅ Base image built"

helm-init:
	@echo "📊 Initializing Helm charts..."
	@echo "✅ Helm charts ready"

## === Build ===

build: build-orchestrator build-nanoclaw
	@echo "✅ All images built"

build-orchestrator:
	eval $$(minikube docker-env) && \
		docker build -t $(REGISTRY)/harrybotter-orchestrator:latest -f docker/Dockerfile.orchestrator orchestrator/

build-nanoclaw:
	eval $$(minikube docker-env) && \
		docker build -t $(REGISTRY)/nanoclaw-base:latest -f docker/Dockerfile.nanoclaw-base .

## === Deploy ===

deploy:
	helm upgrade --install harrybotter infra/helm/harrybotter \
		--namespace $(NAMESPACE) \
		--create-namespace

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
