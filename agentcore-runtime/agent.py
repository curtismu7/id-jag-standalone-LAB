# The AgentCore leg's live runtime: a whoami tool. It answers with the identity the chain
# delivered — the human (sub from the redeemed ID-JAG), the actor chain (act), the audience,
# and the scope — decoded from the bearer token the runner presents. It performs no actions
# and holds no state; its whole purpose is to prove, by decoded claims, that the ID-JAG
# chain (PF -> resource-as -> AgentCore runtime) ends at a real runtime under a real
# workload identity.
#
# Packaging: deploy/agentcore-deploy.sh zips this directory (CodeZip, linux/arm64) and
# creates/updates the AgentCore Runtime. Inbound auth: customJWTAuthorizer against the
# SE-hosted resource-as (deploy/se/resource-as.yaml) — a token that is not a live at+jwt
# minted by the resource-as never reaches this handler.
import base64
import json

from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


def _decode(token: str) -> dict:
    """Decode a JWT payload without verifying — verification already happened at the
    runtime's front door (customJWTAuthorizer). This is display only."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


@app.entrypoint
def whoami(payload: dict) -> dict:
    # The token may arrive in the Authorization header (forwarded by the platform) or in the
    # body under access_token (the runner's explicit hop). Prefer the header: it is the token
    # the authorizer actually validated.
    token = payload.get("access_token") or ""
    claims = _decode(token) if token else {}
    return {
        "tool": "whoami",
        "verified_by": "agentcore customJWTAuthorizer (resource-as discovery)",
        "header": _decode_header(token) if token else {},
        "claims": {
            "iss": claims.get("iss"),
            "sub": claims.get("sub"),
            "aud": claims.get("aud"),
            "scope": claims.get("scope"),
            "client_id": claims.get("client_id"),
            "act": claims.get("act"),
            "exp": claims.get("exp"),
        },
        "note": "decodes only; no verification here — the authorizer verified the token before this handler ran",
    }


def _decode_header(token: str) -> dict:
    try:
        head = token.split(".")[0]
        head += "=" * (-len(head) % 4)
        return json.loads(base64.urlsafe_b64decode(head))
    except Exception:
        return {}


if __name__ == "__main__":
    app.run()
