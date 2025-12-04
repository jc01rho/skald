# GitHub Actions Workflow Fix for UI Build

## Current Issue
The GitHub Actions workflow at `.github/workflows/build-ui-for-k8s.yml` builds with `VITE_API_HOST=` (empty string), which causes the frontend to fall back to `http://localhost:8080`.

## Required Change

**File: `.github/workflows/build-ui-for-k8s.yml`**
**Line: 60**

Change from:
```yaml
          build-args: |
            VITE_API_HOST=
            VITE_IS_SELF_HOSTED_DEPLOY=true
```

To:
```yaml
          build-args: |
            VITE_API_HOST=/api
            VITE_IS_SELF_HOSTED_DEPLOY=true
```

Also update line 75 in the summary:
```yaml
          echo "- VITE_API_HOST: /api" >> $GITHUB_STEP_SUMMARY
```

## Why This Fix Works

1. **Build Time**: VITE bakes environment variables into the JavaScript at build time
2. **Frontend Code**: The code uses `import.meta.env.VITE_API_HOST || 'http://localhost:3000'`
3. **Empty String Problem**: JavaScript treats `""` (empty string) as falsy, so it falls back to localhost
4. **Solution**: Use `VITE_API_HOST="/api"` so the frontend makes relative requests to `/api/*`
5. **Nginx Proxy**: Nginx proxies `/api/*` to `api-service:8000` in the cluster

## How to Apply

### Method 1: Manual Edit (Quick)
```bash
# Edit the file directly
nano /home/sparrow/git/skald/.github/workflows/build-ui-for-k8s.yml

# Find line 60 and change:
VITE_API_HOST=
# to:
VITE_API_HOST=/api

# Commit and push
git add .github/workflows/build-ui-for-k8s.yml
git commit -m "fix: Set VITE_API_HOST to /api for K8s builds"
git push origin main
```

### Method 2: Use This Exact Diff
```bash
cd /home/sparrow/git/skald
cat << 'EOF' | patch .github/workflows/build-ui-for-k8s.yml
--- a/.github/workflows/build-ui-for-k8s.yml
+++ b/.github/workflows/build-ui-for-k8s.yml
@@ -57,7 +57,7 @@
           labels: ${{ steps.meta.outputs.labels }}
           platforms: linux/amd64
           build-args: |
-            VITE_API_HOST=
+            VITE_API_HOST=/api
             VITE_IS_SELF_HOSTED_DEPLOY=true
           cache-from: type=gha
           cache-to: type=gha,mode=max
@@ -72,7 +72,7 @@
           echo '```' >> $GITHUB_STEP_SUMMARY
           echo "" >> $GITHUB_STEP_SUMMARY
           echo "**Build Arguments:**" >> $GITHUB_STEP_SUMMARY
-          echo "- VITE_API_HOST: (empty string)" >> $GITHUB_STEP_SUMMARY
+          echo "- VITE_API_HOST: /api" >> $GITHUB_STEP_SUMMARY
           echo "- VITE_IS_SELF_HOSTED_DEPLOY: true" >> $GITHUB_STEP_SUMMARY
           echo "" >> $GITHUB_STEP_SUMMARY
           echo "**Next Steps:**" >> $GITHUB_STEP_SUMMARY
EOF

git add .github/workflows/build-ui-for-k8s.yml
git commit -m "fix: Set VITE_API_HOST to /api for K8s builds"
git push origin main
```

## Trigger New Build

After pushing the fix:

### Option 1: Automatic (on push to main)
The workflow will automatically trigger when you push to main if frontend files changed.

### Option 2: Manual Trigger
```bash
cd /home/sparrow/git/skald/k8s
./trigger-build.sh
```

Or via GitHub UI:
1. Go to https://github.com/jc01rho/skald/actions
2. Click "Build UI for Kubernetes"
3. Click "Run workflow"
4. Select branch: main
5. Image tag: k8s-latest (or your preferred tag)
6. Click "Run workflow"

## Deploy New Image

Once the build completes:

```bash
cd /home/sparrow/git/skald/k8s

# Pull the latest image (it will use the tag from ui-deployment.yaml)
kubectl rollout restart deployment/ui -n skald

# Or explicitly set the image if using a specific tag
kubectl set image deployment/ui ui=ghcr.io/jc01rho/skald-ui:k8s-latest -n skald

# Watch the rollout
kubectl rollout status deployment/ui -n skald

# Verify
kubectl get pods -n skald -l component=ui
```

## Verification

After deployment, open the UI in your browser:
1. Open browser console (F12)
2. Go to Network tab
3. Try to sign up
4. You should see requests to `/api/user/` (relative path)
5. You should NOT see `http://localhost:8080/api/user/`

## Timeline

1. **Edit workflow file**: 2 minutes
2. **Push to GitHub**: 1 minute
3. **Trigger build**: 1 minute
4. **Build completes**: 5-10 minutes
5. **Deploy to cluster**: 2 minutes
6. **Total**: ~15-20 minutes

---

## Related Files
- Source: `.github/workflows/build-ui-for-k8s.yml`
- Local build script: `k8s/build-ui-for-k8s.sh` (already fixed)
- Trigger script: `k8s/trigger-build.sh`
- Deployment: `k8s/ui-deployment.yaml`
