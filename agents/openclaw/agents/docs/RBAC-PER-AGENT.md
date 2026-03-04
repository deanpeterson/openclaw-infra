# Per-Agent RBAC

This directory implements **per-agent RBAC** - each agent gets its own ServiceAccount and permissions, even when running in the same pod.

## Architecture

```
OpenClaw Pod
├── Agent: resource_optimizer
│   └── Uses: resource-optimizer-sa token
│       └── Permissions: Read-only in resource-demo namespace
└── Agent: mlops_monitor
    └── Uses: mlops-monitor-sa token (future)
        └── Permissions: Read-only in demo-mlflow-agent-tracing namespace
```

## Security Benefits

✅ **Principle of Least Privilege** - Each agent only has permissions it needs
✅ **Blast Radius Limitation** - Compromised agent can't access other namespaces
✅ **Audit Trail** - ServiceAccount tokens show which agent made requests
✅ **Revocable** - Can disable one agent's access without affecting others
✅ **No Pod-Wide Permissions** - Main openclaw pod runs with minimal permissions

## How It Works

### 1. Create ServiceAccount + RBAC

```yaml
ServiceAccount: resource-optimizer-sa
  ↓
Secret: resource-optimizer-sa-token (long-lived token)
  ↓
RoleBinding: grants resource-demo-reader role
  ↓
Role: resource-demo-reader (read-only in resource-demo namespace)
```

### 2. Extract and Store Token

```bash
# Get token from secret
TOKEN=$(oc get secret resource-optimizer-sa-token -n openclaw \
  -o jsonpath='{.data.token}' | base64 -d)

# Save to agent's .env file
echo "OC_TOKEN=$TOKEN" >> ~/.openclaw/workspace-resource-optimizer/.env
echo "OC_SERVER=https://kubernetes.default.svc" >> ~/.openclaw/workspace-resource-optimizer/.env
```

### 3. Agent Uses Token with Kubernetes API

```bash
# Agent reads .env
source ~/.openclaw/workspace-resource-optimizer/.env

# Uses token to call Kubernetes API directly (no oc/kubectl binary needed!)
K8S_API="https://kubernetes.default.svc"

curl -s -H "Authorization: Bearer $OC_TOKEN" \
  --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  "$K8S_API/api/v1/namespaces/resource-demo/pods" | jq .

# Get metrics
curl -s -H "Authorization: Bearer $OC_TOKEN" \
  --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  "$K8S_API/apis/metrics.k8s.io/v1beta1/namespaces/resource-demo/pods" | jq .
```

**Why Kubernetes API instead of oc/kubectl?**
- ✅ No binary dependencies (just curl + jq)
- ✅ More portable across container images
- ✅ Direct access to structured JSON
- ✅ Easier to parse programmatically

## Deployment

### resource-optimizer (Read resource-demo namespace)

```bash
cd agents/openclaw/agents

# Create RBAC and inject token
./setup-resource-optimizer-rbac.sh
```

This script:
1. Creates ServiceAccount + Secret + Role + RoleBinding
2. Waits for token generation
3. Extracts token
4. Updates agent's .env file
5. Verifies permissions work

### Future: mlops-monitor (Read MLFlow namespace)

```bash
# Similar pattern - to be created:
./setup-mlops-monitor-rbac.sh
```

## RBAC Resources

### resource-optimizer

**File:** `resource-optimizer-rbac.yaml`

**ServiceAccount:** `resource-optimizer-sa` (openclaw namespace)
**Secret:** `resource-optimizer-sa-token`
**Role:** `resource-demo-reader` (resource-demo namespace)
**Permissions:**
- Read pods, pvcs, deployments, statefulsets, replicasets
- Read metrics (for `oc adm top pods`)
- **NO** write, delete, update, patch

**RoleBinding:** Grants resource-optimizer-sa → resource-demo-reader

## Security Considerations

### Token Storage

- ✅ Tokens stored in agent's .env file (inside pod filesystem)
- ✅ .env not exposed outside pod (read via oc exec only)
- ✅ Tokens are long-lived but revocable
- ⚠️ If pod is compromised, attacker gets agent's token (but not other agents')

### Permissions Scope

- ✅ Read-only (cannot modify resources)
- ✅ Namespace-scoped (cannot access other namespaces)
- ✅ Resource-limited (only pods, pvcs, deployments - not secrets, configmaps)
- ❌ Cannot list nodes, namespaces, cluster-wide resources

### OpenShift vs Kubernetes

**OpenShift 4.11+:** ServiceAccount tokens are NOT auto-created. You must create a Secret with type `kubernetes.io/service-account-token` and annotation `kubernetes.io/service-account.name`.

**Kubernetes:** ServiceAccount tokens may be auto-created (deprecated in 1.24+, use TokenRequest API).

Our approach works on both!

## Verification

```bash
# Check ServiceAccount exists
oc get sa resource-optimizer-sa -n openclaw

# Check token secret exists
oc get secret resource-optimizer-sa-token -n openclaw

# Check RoleBinding
oc get rolebinding resource-optimizer-reader-binding -n resource-demo

# Test permissions from inside pod using Kubernetes API
POD=$(oc get pods -n openclaw -l app=openclaw -o jsonpath='{.items[0].metadata.name}')
oc exec -n openclaw $POD -c gateway -- bash -c '
  source ~/.openclaw/workspace-resource-optimizer/.env
  K8S_API="https://kubernetes.default.svc"
  curl -s -H "Authorization: Bearer $OC_TOKEN" \
    --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    "$K8S_API/api/v1/namespaces/resource-demo/pods" | jq ".items[].metadata.name"
'
```

## Troubleshooting

### "Forbidden" errors

Agent is trying to access resources it doesn't have permission for:
- Check RoleBinding exists: `oc get rolebinding -n resource-demo`
- Check Role permissions: `oc get role resource-demo-reader -n resource-demo -o yaml`
- Verify correct namespace: Agent can only access `resource-demo`

### "Unauthorized" errors

Token is invalid or not being used:
- Check .env file has OC_TOKEN: `oc exec ... -- cat ~/.openclaw/workspace-resource-optimizer/.env`
- Verify token is valid: `oc whoami --token=$TOKEN`
- Check agent is sourcing .env before running oc commands

### Token not generated

Secret doesn't have token:
- Check secret exists: `oc get secret resource-optimizer-sa-token -n openclaw`
- Check annotation: `oc get secret resource-optimizer-sa-token -n openclaw -o yaml`
- Should have: `kubernetes.io/service-account.name: resource-optimizer-sa`

## Extending to Other Agents

### Pattern for mlops-monitor

```yaml
# mlops-monitor-rbac.yaml
ServiceAccount: mlops-monitor-sa (openclaw namespace)
Secret: mlops-monitor-sa-token
Role: mlflow-reader (demo-mlflow-agent-tracing namespace)
  - Read pods, logs
  - Read jobs (for experiment tracking)
RoleBinding: mlops-monitor-sa → mlflow-reader
```

```bash
# setup-mlops-monitor-rbac.sh
# Same pattern as resource-optimizer
```

### Pattern for generic agent

1. Identify what namespace(s) agent needs to access
2. Identify what resources agent needs to read
3. Create ServiceAccount in openclaw namespace
4. Create Role in target namespace (not openclaw!)
5. Create RoleBinding: ServiceAccount → Role
6. Extract token, save to agent's .env
7. Update agent's AGENTS.md with oc command pattern

## Best Practices

✅ **Namespace-scoped Roles** - Use Role (not ClusterRole) whenever possible
✅ **Read-only by default** - Only grant write if absolutely necessary
✅ **Minimal resource list** - Only include resources agent actually uses
✅ **Document permissions** - RBAC files should have clear comments
✅ **Test denials** - Verify agent CANNOT do things it shouldn't
✅ **Rotate tokens** - Recreate secrets periodically (invalidates old tokens)

❌ **Don't use pod's ServiceAccount** - Creates pod-wide permissions
❌ **Don't grant cluster-wide access** - Use namespaced Roles, not ClusterRoles
❌ **Don't include secrets/configmaps** - Unless agent truly needs them
❌ **Don't grant write without review** - Agents should be read-only by default

---

**Per-agent RBAC**: True least privilege for AI agents! 🔐
