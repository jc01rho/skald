# UI API Path Fix - Quick Rebuild Guide

## Problem
The UI is making requests to `http://localhost:8080/api/user/` instead of using the relative path `/api/user/`.

## Root Cause
The current UI Docker image was built with `VITE_API_HOST=""` (empty string), which the frontend JavaScript treats as falsy, causing it to fall back to the hardcoded `LOCAL_URL`.

## Solution
Build with `VITE_API_HOST="/api"` instead of empty string.

---

## Quick Fix (Local Build & Deploy)

### Step 1: Build UI Image Locally
```bash
cd /home/sparrow/git/skald

# Build withnew configuration
IMAGE_TAG=k8s-proxy PUSH_IMAGE=false ./k8s/build-ui-for-k8s.sh
```

### Step 2: Test Locally (Optional)
```bash
# Run the container to verify
docker run -p 8080:80 ghcr.io/jc01rho/skald-ui:k8s-proxy

# In browser, check: http://localhost:8080
# Open console and verify API calls go to /api/ not localhost
```

### Step 3: Push to Registry
```bash
docker push ghcr.io/jc01rho/skald-ui:k8s-proxy
```

### Step 4: Update Deployment
```bash
cd /home/sparrow/git/skald/k8s

# Update image tag
kubectl set image deployment/ui ui=ghcr.io/jc01rho/skald-ui:k8s-proxy -n skald

# Watch rollout
kubectl rollout status deployment/ui -n skald

# Verify pods are running
kubectl get pods -n skald -l component=ui
```

### Step 5: Test
Open your browser to the UI URL and check:
- Open browser console
- Try to sign up
- Verify the request goes to `/api/user/` (same origin) instead of `http://localhost:8080`

---

## Alternative: Use GitHub Actions (Recommended for Production)

The build script has been updated, so you can trigger a GitHub Actions rebuild:

```bash
cd /home/sparrow/git/skald/k8s
./trigger-build.sh
```

Wait for the build to complete, then:
```bash
kubectl rollout restart deployment/ui -n skald
```

---

## What Changed

**File: `/home/sparrow/git/skald/k8s/build-ui-for-k8s.sh`**
```diff
- --build-arg VITE_API_HOST="" \
+ --build-arg VITE_API_HOST="/api" \
```

This change ensures:
1. VITE bakes `/api` into the frontend code at build time
2. All API calls go to `/api/*` (same origin)
3. Nginx proxy forwards `/api/*` to the API service at port 8000
4. No CORS issues, no localhost fallback

---

## Verification

After deploying, check the browser console:
```javascript
// Should see requests like:
// POST /api/user/
// GET /api/health
// NOT: http://localhost:8080/api/user/
```

---

## Files Modified
- `/home/sparrow/git/skald/k8s/build-ui-for-k8s.sh` - Changed VITE_API_HOST build arg
