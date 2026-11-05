#!/usr/bin/env python3
"""Invoke the idjag_whoami AgentCore runtime with a real ID-JAG.

With OAuth inbound auth (customJWTAuthorizer), boto3 cannot invoke the runtime —
the request must be raw HTTPS with manual SigV4 signing (skill gotcha 24). The
whoami handler decodes the token and answers with its claims.

Usage: deploy/agentcore/invoke-runtime.sh <id-jag>   (the ID-JAG, from run-live)
Env:   AWS_PROFILE (default agent-toolkit)
"""
import json
import os
import sys
import urllib.request

import boto3
import botocore.auth
import botocore.awsrequest

REGION = "us-east-2"
RUNTIME_ID = "idjag_whoami-DeGrxBCh6e"

token = sys.argv[1] if len(sys.argv) > 1 else ""
if not token.count(".") == 2:
    sys.exit("usage: invoke-runtime.sh <id-jag>  (a JWT, e.g. the live run's leg 1 access_token)")

url = f"https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{RUNTIME_ID}/invocations"
payload = json.dumps({"access_token": token}).encode()

session = boto3.Session(region_name=REGION, profile_name=os.environ.get("AWS_PROFILE", "agent-toolkit"))
credentials = session.get_credentials().get_frozen_credentials()

aws_request = botocore.awsrequest.AWSRequest(
    method="POST", url=url,
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",  # the runtime authorizer validates THIS
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "i" * 40,  # >= 33 chars (gotcha 26)
    },
    data=payload,
)
botocore.auth.SigV4Auth(credentials, "bedrock-agentcore", REGION).add_auth(aws_request)
prepared = aws_request.prepare()

req = urllib.request.Request(url, headers=dict(prepared.headers), data=payload, method="POST")
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        print(r.read().decode())
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()[:400]}", file=sys.stderr)
    sys.exit(1)
