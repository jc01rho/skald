# Quick Fix: UI API Path Issue - Complete Solution

## Problem
Frontend making requests to `http://localhost:8080/api/user/` instead of `/api/user/`

## Root Cause
GitHub Actions builds UI with `VITE_API_HOST=""` (empty), frontend treats empty string as falsy → falls back to localhost

## ✅ Solution Applied

### Files Fixed in k8s Directory
1. ✅ `k8s/build-ui-for-k8s.sh` - Changed `VITE_API_HOST=""` to `VITE_API_HOST="/api"`

### Files That Need Manual Fix
1. ⚠️ `.github/workflows/build-ui-for-k8s.yml` - Line 60: Change `VITE_API_HOST=` to `VITE_API_HOST=/api`

## Quick Steps to Fix

### Step 1: Fix GitHub Actions Workflow
```bash
cd /home/sparrow/git/skald

# Edit the file
nano .github/workflows/build-ui-for-k8s.yml

# Change line 60 from:
#   VITE_API_HOST=
# to:
#   VITE_API_HOST=/api

# Save and commit
git add .github/workflows/build-ui-for-k8s.yml
git commit -m "fix: Set VITE_API_HOST to /api for K8s builds"
git push origin main
```

### Step 2: Trigger New Build
```bash
cd /home/sparrow/git/skald/k8s
./trigger-build.sh
```

### Step 3: Deploy New Image
```bash
# After build completes (~10 minutes)
kubectl rollout restart deployment/ui -n skald
kubectl rollout status deployment/ui -n skald
```

### Step 4: Verify
Open browser → UI → Check console → API calls should go to `/api/*` not `localhost:8080`

---

## Alternative: Quick Test with Local Build

If you have Docker available locally:
```bash
cd /home/sparrow/git/skald
IMAGE_TAG=test-fix PUSH_IMAGE=true ./k8s/build-ui-for-k8s.sh
kubectl set image deployment/ui ui=ghcr.io/jc01rho/skald-ui:test-fix -n skald
```

---

## Why This Works

| Stage | What Happens |
|-------|--------------|
| **Build Time** | Vite bakes `VITE_API_HOST="/api"` into JavaScript |
| **Runtime** | Frontend uses `/api` for all requests (relative path) |
| **Nginx** | Proxies `/api/*` to `api-service.skald.svc.cluster.local:8000/api/` |
| **Result** | No CORS, no localhost, works perfectly ✅ |

---

## Documentation
- Detailed GitHub Actions fix: `GITHUB-ACTIONS-FIX.md`
- Complete K8s alignment: `DOCKER-COMPOSE-PARITY.md`
- UI rebuild guide: `UI-API-PATH-FIX.md`

---

**Status**: Waiting for GitHub Actions workflow fix + rebuild
**ETA**: ~15-20 minutes after workflow fix is pushed
